// ─── lib/musicology/chordify.ts ──────────────────────────────────────────────
// Score → vertical chord stream at every unique onset.
//
// Algorithm:
//   1. Convert each note's (measure, beat) to a global quarter-note offset.
//      Time-signature changes are honored — measure N's start offset depends
//      on the cumulative beats-per-measure up to N - 1.
//   2. Collect distinct onset times from all non-rest notes.
//   3. For each onset, find every note whose [start, start + duration)
//      contains the onset. Those pitches are the vertical sonority.
//   4. NCT filtering — three heuristics from Aldwell/Schachter Ch. 6
//      (passing/neighbor tones, accented & unaccented dissonance):
//
//        a. A tone whose duration is meaningfully shorter than the prevailing
//           chord-tone duration AND lands on a metrically weak beat is
//           suspect.
//        b. A tone that is dissonant against the bass AND resolves by step
//           into the next onset's chord is suspect.
//        c. A suspect tone is only marked as NCT if removing it yields a
//           plausible consonant chord (residual contains a major / minor /
//           diminished triad or seventh).
//
//      NCTs are flagged on the Onset (`suspectNcts`) but NOT removed from
//      `pitches`. The Roman-numeral analyzer in Phase 2 can read either the
//      raw or filtered pitch set depending on what it is doing.
//
// What this module does NOT do:
//   - voice tracking across onsets (Phase 1's chordify is voice-agnostic)
//   - chord labeling (Phase 2's romanNumeral.ts)
//   - cadence detection (Phase 2's cadence.ts)

import type { Note, Score, Onset, Chord, ChordStream, TimeEvent } from './types.js';

// ─── Time geometry ───────────────────────────────────────────────────────────

/**
 * Compute a measure's start offset in quarter-note beats from the beginning
 * of the piece. Handles time-signature changes.
 */
function measureStartOffsets(score: Score): Map<number, number> {
  const out = new Map<number, number>();
  const lastMeasure = score.measureCount || score.notes.reduce((m, n) => Math.max(m, n.measure), 1);

  // Walk time signatures, building cumulative offset per measure.
  // Default 4/4 if none specified.
  const tsList: TimeEvent[] = score.timeSignatures.length
    ? score.timeSignatures
    : [{ measure: 1, beat: 1, beats: 4, beatType: 4 }];

  // Each entry's quarters-per-measure.
  function quartersPerMeasureFor(ts: TimeEvent): number {
    return (ts.beats / ts.beatType) * 4;
  }

  let offset = 0;
  for (let m = 1; m <= lastMeasure; m++) {
    out.set(m, offset);
    // Find the last time signature whose `measure <= m`
    let active = tsList[0];
    for (const ts of tsList) {
      if (ts.measure <= m) active = ts;
    }
    offset += quartersPerMeasureFor(active);
  }
  return out;
}

/** Quarter-note offset of a (measure, beat) pair. */
function globalOffset(
  measure: number,
  beat: number,
  measureStarts: Map<number, number>,
): number {
  const start = measureStarts.get(measure);
  if (start === undefined) return 0;
  // beat is 1-based quarter-note beats; subtract 1 to get the offset within the measure.
  return start + Math.max(0, beat - 1);
}

// ─── Onset extraction ────────────────────────────────────────────────────────

const APPROX_EPS = 1e-6;

interface NoteWithOffset {
  note: Note;
  start: number;
  end: number;
  pc: number;
}

function withOffsets(notes: Note[], measureStarts: Map<number, number>): NoteWithOffset[] {
  const out: NoteWithOffset[] = [];
  for (const n of notes) {
    if (n.isRest || n.midi === null) continue;
    const start = globalOffset(n.measure, n.beat, measureStarts);
    const end = start + n.duration;
    out.push({
      note: n,
      start,
      end,
      pc: ((n.midi % 12) + 12) % 12,
    });
  }
  return out;
}

/** True if pitch class `pc` is dissonant against bass `bassPc`. */
function isDissonantAgainstBass(pc: number, bassPc: number | null): boolean {
  if (bassPc === null) return false;
  const ic = ((pc - bassPc) % 12 + 12) % 12;
  // 1, 2, 6, 10, 11 are dissonant intervals (m2/M2/tritone/m7/M7).
  return ic === 1 || ic === 2 || ic === 6 || ic === 10 || ic === 11;
}

/** True if a pc set forms a recognizable consonant chord — major/minor/dim
 *  triad or any seventh. Used as the residual check in NCT filtering. */
function isPlausibleChord(pcs: number[]): boolean {
  if (pcs.length < 2) return false;
  // Try every pc as root; check which intervals from root are present.
  const set = new Set(pcs);
  for (const root of pcs) {
    const ic = (pc: number) => ((pc - root) % 12 + 12) % 12;
    const has = (interval: number) => Array.from(set).some(p => ic(p) === interval);

    const hasMajor3 = has(4);
    const hasMinor3 = has(3);
    const hasPerfect5 = has(7);
    const hasDim5 = has(6);
    const hasAug5 = has(8);
    const hasMinor7 = has(10);
    const hasMajor7 = has(11);
    const hasDim7 = has(9);

    // Major triad: M3 + P5
    if (hasMajor3 && hasPerfect5) return true;
    // Minor triad: m3 + P5
    if (hasMinor3 && hasPerfect5) return true;
    // Diminished: m3 + d5
    if (hasMinor3 && hasDim5) return true;
    // Augmented: M3 + #5
    if (hasMajor3 && hasAug5) return true;
    // Sevenths: any triad-like + a 7th
    if ((hasMajor3 || hasMinor3) && (hasPerfect5 || hasDim5)
        && (hasMinor7 || hasMajor7 || hasDim7)) return true;
    // Bare fifth (open fifth) — common in early music, count as plausible.
    if (hasPerfect5 && set.size === 2) return true;
  }
  return false;
}

/** Strong beat = beats 1 and 3 in 4/4, beat 1 in 3/4, etc. Heuristic only. */
function isStrongBeat(beat: number, beatsPerMeasure: number): boolean {
  // Always true on downbeat. In simple meters, also true on the median beat.
  if (Math.abs(beat - 1) < APPROX_EPS) return true;
  if (beatsPerMeasure === 4 && Math.abs(beat - 3) < APPROX_EPS) return true;
  if (beatsPerMeasure === 6 && Math.abs(beat - 4) < APPROX_EPS) return true;
  return false;
}

function activeTimeSig(measure: number, score: Score): TimeEvent {
  let active: TimeEvent = { measure: 1, beat: 1, beats: 4, beatType: 4 };
  for (const ts of score.timeSignatures) {
    if (ts.measure <= measure) active = ts;
  }
  return active;
}

// ─── Main ────────────────────────────────────────────────────────────────────

/**
 * Build the chord stream for `score`. Each onset is a vertical sonority
 * carrying both its raw `pitches` and a `suspectNcts` list flagged by the
 * heuristic. NCTs are NOT removed from `pitches`.
 */
export function chordify(score: Score): ChordStream {
  const measureStarts = measureStartOffsets(score);
  const events = withOffsets(score.notes, measureStarts);
  if (events.length === 0) return { onsets: [], chords: [] };

  // Distinct onset times (sorted).
  const startSet = new Set<number>();
  for (const e of events) startSet.add(roundTo(e.start));
  const onsetTimes = Array.from(startSet).sort((a, b) => a - b);

  // Build onsets.
  const onsets: Onset[] = [];
  for (let i = 0; i < onsetTimes.length; i++) {
    const t = onsetTimes[i];
    const tNext = i + 1 < onsetTimes.length ? onsetTimes[i + 1] : null;
    // Notes sounding at this onset — start ≤ t < end.
    const sounding = events.filter(e => e.start <= t + APPROX_EPS && e.end > t + APPROX_EPS);
    if (sounding.length === 0) continue;

    // Lowest sounding pitch = bass.
    let bass: NoteWithOffset = sounding[0];
    for (const e of sounding) {
      if ((e.note.midi ?? Infinity) < (bass.note.midi ?? Infinity)) bass = e;
    }

    // Pitches — preserve spelling order by midi ascending, dedupe.
    const sortedByMidi = [...sounding].sort(
      (a, b) => (a.note.midi ?? 0) - (b.note.midi ?? 0),
    );
    const seenPitch = new Set<string>();
    const pitches: string[] = [];
    for (const e of sortedByMidi) {
      if (!seenPitch.has(e.note.pitch)) {
        pitches.push(e.note.pitch);
        seenPitch.add(e.note.pitch);
      }
    }
    const pcs = Array.from(new Set(sounding.map(e => e.pc))).sort((a, b) => a - b);

    // First note that starts at this onset → measure/beat.
    const startingHere = sounding.find(e => Math.abs(e.start - t) < APPROX_EPS);
    const measure = startingHere?.note.measure ?? sounding[0].note.measure;
    const beat = startingHere?.note.beat ?? 1;
    const durationToNext = tNext !== null ? tNext - t : 0;

    onsets.push({
      measure,
      beat,
      pitches,
      pcs,
      bassPitch: bass.note.pitch,
      bassPc: bass.pc,
      suspectNcts: [],
      durationToNext: durationToNext > 0 ? durationToNext : 0,
    });
  }

  // ── NCT filtering pass ─────────────────────────────────────────────────────
  // For each onset, identify pitches that look like passing/neighbor tones.
  for (let i = 0; i < onsets.length; i++) {
    const o = onsets[i];
    const next = i + 1 < onsets.length ? onsets[i + 1] : null;
    const ts = activeTimeSig(o.measure, score);
    const beatsPerMeasure = ts.beats * (4 / ts.beatType);
    const strong = isStrongBeat(o.beat, beatsPerMeasure);

    const t = onsetTimes[i];
    const sounding = events.filter(e => e.start <= t + APPROX_EPS && e.end > t + APPROX_EPS);
    if (sounding.length < 2) continue;

    const durations = sounding.map(e => e.note.duration).filter(d => d > 0);
    if (durations.length === 0) continue;
    const medianDur = median(durations);
    // Ignore the bass when looking for NCTs — bass is always structural here.
    const candidates = sounding.filter(e => e.pc !== o.bassPc);

    for (const cand of candidates) {
      const dur = cand.note.duration;
      // Heuristic (a) — short duration on weak beat AND dissonant against bass.
      const shortAndWeak =
        dur < medianDur - APPROX_EPS && !strong
        && isDissonantAgainstBass(cand.pc, o.bassPc);

      // Heuristic (b) — resolves by step in the next onset, AND dissonant.
      let resolvesByStep = false;
      if (next && isDissonantAgainstBass(cand.pc, o.bassPc)) {
        // Find any pitch in the next onset whose pc is one or two semitones away.
        const candPc = cand.pc;
        for (const np of next.pcs) {
          const ic = ((np - candPc) % 12 + 12) % 12;
          if (ic === 1 || ic === 2 || ic === 11 || ic === 10) {
            resolvesByStep = true;
            break;
          }
        }
      }

      if (!shortAndWeak && !resolvesByStep) continue;

      // Heuristic (c) — does removing this pitch yield a plausible chord?
      const residualPcs = o.pcs.filter(p => p !== cand.pc);
      if (!isPlausibleChord(residualPcs)) continue;

      if (!o.suspectNcts.includes(cand.note.pitch)) {
        o.suspectNcts.push(cand.note.pitch);
      }
    }
  }

  // Build Chord[] — for now, 1:1 with Onset (the consumer can ignore
  // suspectNcts when it wants the raw vertical, or filter them when it wants
  // the chord-tone-only set).
  const chords: Chord[] = onsets.map(o => ({
    measure: o.measure,
    beat: o.beat,
    pitches: o.pitches,
    pcs: o.pcs,
    bassPitch: o.bassPitch,
    bassPc: o.bassPc,
    durationToNext: o.durationToNext,
    onset: o,
  }));

  return { onsets, chords };
}

// ─── Tiny helpers ────────────────────────────────────────────────────────────

function median(arr: number[]): number {
  const s = [...arr].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return 0;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

function roundTo(x: number, decimals = 6): number {
  const k = 10 ** decimals;
  return Math.round(x * k) / k;
}
