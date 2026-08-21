// ─── lib/maestroAnalyst/pedalPoint.ts ────────────────────────────────────────
// Pedal-point detection + pedal-aware chord reading.
//
// A pedal point is a bass PITCH CLASS sustained (or re-struck — Beethoven's
// timpani) across a run of onsets WHILE the harmony above moves to chords
// the bass does not belong to. The definition is the divergence, not the
// sustain: a root-position tonic held for four bars of I is NOT a pedal —
// the bass is the chord root throughout. The canonical shape (Beethoven 1
// mvt 1, mm. 33-37): cellos, basses, and timpani hold C while horns,
// trumpets, and winds sound a complete G⁷ above. The correct reading is V⁷
// with a tonic pedal — "V7 (ped 1)" in the project's annotation convention
// (never a slash: "V7/C" would collide with secondary-function syntax).
//
// Why this module exists: chordify is voice-agnostic — it aggregates every
// sounding pitch into one pc set. A sustained foreign bass either drives the
// template match to '?' or to a wrong chord (the C under G⁷ used to read as
// a root-position V⁷ only by the grace of coverage scoring, with the bass
// unexplained and the inversion wrong). Dominant pedals (5̂ held under
// shifting harmony, ubiquitous in retransitions) are even more common than
// tonic pedals.
//
// Two-stage design:
//   1. detectPedalRuns — run-level detection over the raw chord stream.
//   2. applyPedalReading — per-slice re-analysis inside a confirmed run:
//      template-match the pc set EXCLUDING the pedal pc, unless the pedal
//      is a chord tone of the full sonority's best match (a tonic pedal
//      under a I slice is just I; under IV⁶⁄₄ it is the chord fifth and the
//      full reading already explains the bass).
//
// Output is ADDITIVE ONLY: a score with no confirmed pedal run produces
// identical ChordAnalysis output to the pre-pedal analyzer. On pedal slices
// the optional `pedal` field appears, `'pedal-point'` joins tendencyTones,
// and the primary reading may improve (upper structure instead of '?').

import type { Chord, ChordAnalysis, Onset } from './types.js';
import type { TendencyToneTag } from './tendencyTones.js';
import {
  analyzeChord, identifyChord, TRIAD_PATTERNS, SEVENTH_PATTERNS,
} from './romanNumeral.js';
import type { AnalyzeChordOptions, ChordIdentity } from './romanNumeral.js';
import { pc } from './pitch.js';
import { tonicPc, keyMode } from './scale.js';

// ─── Detection thresholds ────────────────────────────────────────────────────
// Tuned against the synthetic fixtures in __tests__/lib/maestroAnalyst/
// pedalPoint.test.ts and the Beethoven 1 mvt 1 mm. 33-37 real case.

/** A run must have at least this many slices when it crosses a barline… */
const MIN_RUN_SLICES = 2;
/** …or this many slices when it sits inside a single measure. Keeps a
 *  half-measure suspension mass from reading as a pedal. */
const MIN_RUN_SLICES_SAME_MEASURE = 4;
/** The chord-tone-only confirmation path (no truly foreign slice — the
 *  "pedal ⁶⁄₄" shape, I–IV⁶⁄₄–I over 1̂) needs a slightly longer run, so a
 *  two-slice cadential ⁶⁄₄ straddling a barline is not promoted to a pedal. */
const MIN_NONROOT_ONLY_SLICES = 3;

/** A maximal run of consecutive chord-stream slices sharing one bass pc,
 *  confirmed as a pedal point. Indices are into `chordStream.chords`. */
export interface PedalRun {
  startIndex: number;   // inclusive
  endIndex: number;     // inclusive
  pc: number;           // the sustained bass pitch class (0..11)
}

/** Chord tones of an identified chord as a pc set, or null when the
 *  identity is 'unknown'. Template tones come from the same canonical
 *  pattern tables the classifier matched against. */
function chordTonePcs(ident: ChordIdentity): Set<number> | null {
  const pattern =
    (TRIAD_PATTERNS as Record<string, number[]>)[ident.type]
    ?? (SEVENTH_PATTERNS as Record<string, number[]>)[ident.type]
    ?? null;
  if (!pattern) return null;
  return new Set(pattern.map(i => ((ident.root + i) % 12 + 12) % 12));
}

/**
 * How one slice relates to the sustained pc:
 *   'root'          — the pedal pc IS the root of the best full-set match.
 *                     Four bars of root-position I never confirm a pedal.
 *   'chord-tone'    — the pedal pc is a tone (3rd/5th/7th) of the match but
 *                     not its root — the pedal-⁶⁄₄ shape.
 *   'foreign-clear' — the pedal pc is no tone of the match (or nothing
 *                     matched) AND the upper structure alone is a complete
 *                     triad/seventh. The Beethoven G⁷-over-C slice.
 *   'inconclusive'  — none of the above (bare bass, cluster, dyad above).
 *                     Never confirms; never blocks.
 */
type SliceRole = 'root' | 'chord-tone' | 'foreign-clear' | 'inconclusive';

function classifySlice(
  chord: Chord,
  pedalPc: number,
): { role: SliceRole; harmonyId: string | null } {
  const ident = identifyChord(chord.pcs, chord.bassPc);
  const tones = chordTonePcs(ident);
  if (tones && tones.has(pedalPc)) {
    return {
      role: ident.root === pedalPc ? 'root' : 'chord-tone',
      harmonyId: `${ident.root}:${ident.type}`,
    };
  }
  // The pedal is not a tone of the best full-set match. Only a CLEAR upper
  // structure confirms — a lone bass note or an unclassifiable cluster
  // above must not promote a run to a pedal.
  const upperPcs = chord.pcs.filter(p => p !== pedalPc);
  if (upperPcs.length >= 3) {
    const upperIdent = identifyChord(upperPcs, null);
    if (upperIdent.type !== 'unknown') {
      return { role: 'foreign-clear', harmonyId: `${upperIdent.root}:${upperIdent.type}` };
    }
  }
  return { role: 'inconclusive', harmonyId: tones ? `${ident.root}:${ident.type}` : null };
}

/**
 * Find confirmed pedal runs in a chord stream.
 *
 * A run = maximal consecutive slices sharing a (non-null) bass pc. It is
 * confirmed as a pedal when it is long enough (≥ 2 slices crossing a
 * barline, or ≥ 4 slices within one measure) AND the harmony above diverges
 * from the bass at least once:
 *
 *   - any 'foreign-clear' slice confirms outright (the canonical pedal:
 *     the bass is not in the chord at all), OR
 *   - a 'chord-tone' slice confirms when the run also shows ≥ 2 distinct
 *     harmonies and spans ≥ 2 measures with ≥ 3 slices (the pedal-⁶⁄₄
 *     shape — I–IV⁶⁄₄–I over a tonic pedal — where the sustained pc stays
 *     a chord tone but stops being the root). The extra length requirement
 *     keeps an ordinary cadential ⁶⁄₄ out.
 *
 * Negative cases pinned by tests: root-position I held for four bars (bass
 * is the root throughout — no divergence), and a walking bass (runs of one
 * slice — no sustain).
 */
export function detectPedalRuns(chords: Chord[]): PedalRun[] {
  const runs: PedalRun[] = [];
  let i = 0;
  while (i < chords.length) {
    const bassPc = chords[i].bassPc;
    if (bassPc === null) { i++; continue; }
    let j = i;
    while (j + 1 < chords.length && chords[j + 1].bassPc === bassPc) j++;

    const count = j - i + 1;
    const measureSpan = chords[j].measure - chords[i].measure + 1;
    const sizeOk =
      (count >= MIN_RUN_SLICES && measureSpan >= 2)
      || count >= MIN_RUN_SLICES_SAME_MEASURE;

    if (sizeOk) {
      let anyForeign = false;
      let anyNonRootChordTone = false;
      const harmonies = new Set<string>();
      for (let k = i; k <= j; k++) {
        const { role, harmonyId } = classifySlice(chords[k], bassPc);
        if (harmonyId) harmonies.add(harmonyId);
        if (role === 'foreign-clear') anyForeign = true;
        if (role === 'chord-tone') anyNonRootChordTone = true;
      }
      const confirmed =
        anyForeign
        || (anyNonRootChordTone
            && harmonies.size >= 2
            && count >= MIN_NONROOT_ONLY_SLICES
            && measureSpan >= 2);
      if (confirmed) runs.push({ startIndex: i, endIndex: j, pc: bassPc });
    }
    i = j + 1;
  }
  return runs;
}

/** Flatten runs into a chord-index → pedal-pc lookup for the analysis loop. */
export function pedalPcByChordIndex(runs: PedalRun[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const run of runs) {
    for (let i = run.startIndex; i <= run.endIndex; i++) out.set(i, run.pc);
  }
  return out;
}

// ─── Degree labeling ─────────────────────────────────────────────────────────

// Scale-degree label per semitone offset from the tonic, key-relative — the
// form the annotation convention prefers ("ped 1", "ped 5", "ped b3").
const MAJOR_DEGREE_LABELS = ['1', 'b2', '2', 'b3', '3', '4', '#4', '5', 'b6', '6', 'b7', '7'];
// Minor labels follow the natural-minor scale (3 = ♭3 of the parallel major
// is just "3" in minor); 11 semitones is the raised leading tone.
const MINOR_DEGREE_LABELS = ['1', 'b2', '2', '3', '#3', '4', '#4', '5', '6', '#6', '7', '#7'];

/** Scale-degree label of a pedal pc in the local key ("1", "5", "b3"…). */
export function pedalDegreeLabel(pedalPc: number, key: string): string {
  const t = tonicPc(key);
  if (t === null) return String(((pedalPc % 12) + 12) % 12);
  const offset = ((pedalPc - t) % 12 + 12) % 12;
  const labels = keyMode(key) === 'minor' ? MINOR_DEGREE_LABELS : MAJOR_DEGREE_LABELS;
  return labels[offset];
}

// ─── Per-slice pedal-aware reading ───────────────────────────────────────────

/** The upper structure of a pedal slice: the chord minus the pedal pc.
 *  Null when nothing meaningful is left (a bare pedal, or pedal + one
 *  doubling).
 *
 *  The bass handed to the re-match is the upper structure's identified ROOT
 *  when it has one, not its lowest sounding pitch. A pedal suspends
 *  figured-bass logic — the true bass IS the pedal, so the voicing of the
 *  parts above carries no inversion meaning. Beethoven 1's mm. 35-36 put a
 *  bassoon F below the horns' G: reading that as V⁴⁄₂ would mistake an
 *  inner-voice registration for a bass function. The convention is
 *  "V7 (ped 1)" — the upper harmony named by root. */
function upperStructureChord(chord: Chord, pedalPc: number): Chord | null {
  const upperPcs = chord.pcs.filter(p => p !== pedalPc);
  if (upperPcs.length < 2) return null;
  const upperPitches = chord.pitches.filter(p => pc(p) !== pedalPc);
  if (upperPitches.length === 0) return null;
  // chordify sorts `pitches` ascending by midi — prefer the lowest
  // occurrence of the identified root; fall back to the lowest pitch when
  // the upper structure has no template identity.
  const upperIdent = identifyChord(upperPcs, null);
  const rootPitch = upperIdent.type !== 'unknown'
    ? upperPitches.find(p => pc(p) === upperIdent.root)
    : undefined;
  const bassPitch = rootPitch ?? upperPitches[0];
  const bassPc = pc(bassPitch);
  const onset: Onset = {
    ...chord.onset,
    pitches: upperPitches,
    pcs: upperPcs,
    bassPitch,
    bassPc,
  };
  return {
    measure: chord.measure,
    beat: chord.beat,
    pitches: upperPitches,
    pcs: upperPcs,
    bassPitch,
    bassPc,
    durationToNext: chord.durationToNext,
    onset,
  };
}

/**
 * Re-read one slice inside a confirmed pedal run.
 *
 * The chord-tone exception first: when the pedal pc is a tone of the full
 * sonority's best template match AND that match produced a real reading,
 * the full reading already explains the bass — keep it (a tonic pedal
 * under a I slice is just I). Otherwise the pedal was distorting the
 * match: re-analyze the upper structure with the pedal excluded and take
 * that reading when it lands. Either way the slice reports the pedal in
 * the new optional `pedal` field and carries the 'pedal-point' tag.
 *
 * The returned analysis keeps the SLICE's identity — measure, beat,
 * pitches, and pcSet describe what actually sounds (pedal included) even
 * when the harmonic reading comes from the upper structure.
 */
export function applyPedalReading(
  chord: Chord,
  fullAnalysis: ChordAnalysis,
  pedalPc: number,
  opts: AnalyzeChordOptions,
): ChordAnalysis {
  const degree = pedalDegreeLabel(pedalPc, opts.key);
  const pedal = { pc: pedalPc, degree };
  const withPedalTag = (tags: TendencyToneTag[]): TendencyToneTag[] =>
    tags.includes('pedal-point') ? tags : [...tags, 'pedal-point'];

  const ident = identifyChord(chord.pcs, chord.bassPc);
  const tones = chordTonePcs(ident);
  const pedalIsChordTone = tones !== null && tones.has(pedalPc);
  if (pedalIsChordTone && fullAnalysis.primary !== '?') {
    return { ...fullAnalysis, pedal, tendencyTones: withPedalTag(fullAnalysis.tendencyTones) };
  }

  // Foreign pedal — the upper structure is the chord.
  const upper = upperStructureChord(chord, pedalPc);
  if (upper) {
    const upperAnalysis = analyzeChord(upper, opts);
    if (upperAnalysis.primary !== '?') {
      const readings = upperAnalysis.readings.map((r, i) =>
        i === 0
          ? { ...r, basis: `${r.basis} — over a sustained pedal (ped ${degree})` }
          : r,
      );
      return {
        ...upperAnalysis,
        measure: chord.measure,
        beat: chord.beat,
        pitches: chord.pitches,
        pcSet: chord.pcs,
        primaryBasis: readings[0].basis,
        readings,
        pedal,
        tendencyTones: withPedalTag(upperAnalysis.tendencyTones),
      };
    }
  }

  // Nothing better than the full reading — keep it, but still report the
  // pedal so consumers know the bass is a sustained non-chord tone.
  return { ...fullAnalysis, pedal, tendencyTones: withPedalTag(fullAnalysis.tendencyTones) };
}
