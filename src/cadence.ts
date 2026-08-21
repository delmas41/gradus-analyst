// ─── lib/musicology/cadence.ts ───────────────────────────────────────────────
// Phrase-end cadence classifier. Names match the curriculum prose verbatim:
//   PAC | IAC | HC | DC | Plagal | Phrygian | unclear
//
// Classification logic ported from
//   scripts/music21/extract-bach-chorales.py:detect_cadence (lines 160–209)
// with one refinement: PAC-vs-IAC discrimination uses the soprano's scale
// degree at the final chord (1̂ → PAC, otherwise IAC).
//
// The classifier reads ChordAnalyses (which already carry RN labels) plus
// the soprano voice's pitch at the final chord. It does not re-run the RN
// analyzer — that is Phase 2a's job.

import type { ChordAnalysis, Cadence, CadenceType, PhraseRange, Score, Note } from './types.js';
import { tonicPc, keyMode } from './scale.js';
import { pc as pitchPc } from './pitch.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function lowerStripFigure(rn: string): string {
  // "V⁷" → "v"; "♭II⁶" → "♭ii"; "vii°⁷/V" → "vii"
  // Strip secondary marker first.
  const main = rn.split('/')[0];
  // Strip Unicode and ASCII figured-bass / superscripts.
  return main
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, '')
    .replace(/[⁄]/g, '')
    .replace(/[°ø+]/g, '')
    .replace(/[0-9]/g, '')
    .toLowerCase();
}

function rnHasInversionSix(rn: string): boolean {
  return /⁶|6(?!\d)/.test(rn);
}

/** Does the RN string carry ANY inversion-indicating figured-bass digits?
 *  Used to gate strict-PAC: a true PAC requires both V and I in root
 *  position. ⁶, ⁶⁄₄, ⁶⁄₅, ⁴⁄₃, ⁴⁄₂ all indicate inversion. The literal
 *  ⁷ digit on its own (root-position seventh chord) does NOT indicate
 *  inversion — V⁷ → I is still PAC-eligible if the soprano lands on 1̂. */
function rnHasInversionFigure(rn: string): boolean {
  // Strip a secondary-function tail like /V before checking.
  const main = rn.split('/')[0];
  // Check for any non-seventh figured-bass marker.
  // ⁶ (1st inv triad), ⁶⁄₄ (2nd inv triad), ⁶⁄₅ (1st inv 7), ⁴⁄₃ (2nd inv 7),
  // ⁴⁄₂ or ² (3rd inv 7).
  if (/⁶|⁴|²(?![⁰¹²³⁴⁵⁶⁷⁸⁹])/.test(main)) return true;
  // ASCII forms: "6", "64", "65", "43", "42", "2"
  // Bare "7" is NOT inversion (V7 root position).
  if (/(?<!\d)6(?!\d)/.test(main)) return true;
  if (/(?<!\d)64\b/.test(main) || /(?<!\d)65\b/.test(main) ||
      /(?<!\d)43\b/.test(main) || /(?<!\d)42\b/.test(main)) return true;
  return false;
}

function isVchord(rn: string): boolean {
  const stripped = lowerStripFigure(rn);
  return stripped === 'v' || stripped.startsWith('v') && !stripped.startsWith('vi') && !stripped.startsWith('vii');
}

function isIchord(rn: string): boolean {
  const stripped = lowerStripFigure(rn);
  return stripped === 'i' && !stripped.startsWith('ii');
}

function isVIchord(rn: string): boolean {
  const stripped = lowerStripFigure(rn);
  return stripped === 'vi';
}

function isIVchord(rn: string): boolean {
  const stripped = lowerStripFigure(rn);
  return stripped === 'iv';
}

/** Soprano scale degree at the final chord. Returns 1..7 (1̂ = tonic) or null. */
function sopranoFinalDegree(
  score: Score,
  measure: number,
  key: string,
): number | null {
  const t = tonicPc(key);
  if (t === null) return null;
  // Soprano = voice 1 at the end of `measure`.
  const measureNotes = score.notes
    .filter(n => n.voice === 1 && n.measure === measure && !n.isRest && n.midi !== null);
  if (measureNotes.length === 0) return null;
  // Last note in the measure (largest beat).
  const last: Note = measureNotes.reduce((a, b) => (b.beat >= a.beat ? b : a));
  const lastPc = pitchPc(last.pitch);
  if (lastPc === null) return null;
  const offset = ((lastPc - t) % 12 + 12) % 12;
  // Map offset to scale degree. We lookup in major or minor, harmonic-minor 7
  // is allowed.
  const mode = keyMode(key);
  const map: Record<number, number> = mode === 'minor'
    ? { 0: 1, 2: 2, 3: 3, 5: 4, 7: 5, 8: 6, 10: 7, 11: 7 }
    : { 0: 1, 2: 2, 4: 3, 5: 4, 7: 5, 9: 6, 11: 7 };
  return map[offset] ?? null;
}

// ─── Classifier ──────────────────────────────────────────────────────────────

/** Classify the cadence at the end of `phrase`, given the chord analyses
 *  whose `measure` falls within the phrase. */
export function classifyCadence(
  phrase: PhraseRange,
  chordAnalyses: ChordAnalysis[],
  score: Score,
  key: string,
): Cadence {
  const phraseChords = chordAnalyses.filter(
    c => c.measure >= phrase.measureStart && c.measure <= phrase.measureEnd,
  );
  if (phraseChords.length < 2) {
    return {
      type: 'unclear',
      measure: phrase.measureEnd,
      beat: 1,
      sopranoFinalDegree: null,
      penultimate: phraseChords[0]?.primary ?? '',
      final: '',
      basis: 'fewer than 2 chords in phrase',
    };
  }

  const final = phraseChords[phraseChords.length - 1];
  const pen = phraseChords[phraseChords.length - 2];
  const penRn = pen.primary;
  const finRn = final.primary;
  const sopDeg = sopranoFinalDegree(score, final.measure, key);
  const mode = keyMode(key) ?? 'major';

  // Phrygian: minor key, iv⁶ → V.
  if (mode === 'minor' && lowerStripFigure(penRn) === 'iv' && rnHasInversionSix(penRn) && isVchord(finRn)) {
    return {
      type: 'Phrygian',
      measure: final.measure, beat: final.beat,
      sopranoFinalDegree: sopDeg,
      penultimate: penRn, final: finRn,
      basis: `iv⁶ → V in minor — Phrygian half cadence (♭6̂ → 5̂ in bass)`,
    };
  }

  // Plagal: IV → I.
  if (isIVchord(penRn) && isIchord(finRn)) {
    return {
      type: 'Plagal',
      measure: final.measure, beat: final.beat,
      sopranoFinalDegree: sopDeg,
      penultimate: penRn, final: finRn,
      basis: `IV → I — plagal cadence`,
    };
  }

  // Half cadence: anything → V.
  if (isVchord(finRn)) {
    return {
      type: 'HC',
      measure: final.measure, beat: final.beat,
      sopranoFinalDegree: sopDeg,
      penultimate: penRn, final: finRn,
      basis: `${penRn} → ${finRn} — half cadence (ends on V)`,
    };
  }

  // Deceptive: V → vi.
  if (isVchord(penRn) && isVIchord(finRn)) {
    return {
      type: 'DC',
      measure: final.measure, beat: final.beat,
      sopranoFinalDegree: sopDeg,
      penultimate: penRn, final: finRn,
      basis: `V → vi — deceptive cadence`,
    };
  }

  // Authentic: V → I or i. PAC requires:
  //   - root-position V (penRn has no inversion figure like ⁶ or ⁶⁄₄)
  //   - root-position I (finRn has no inversion figure)
  //   - soprano on 1̂
  // Any of these failing demotes to IAC. This is the textbook definition;
  // the earlier code only checked the soprano. With this refinement, a
  // V⁶ → I or V → I⁶ now correctly counts as IAC even when the soprano
  // lands on 1̂.
  if (isVchord(penRn) && isIchord(finRn)) {
    const penIsRootPos = !rnHasInversionFigure(penRn);
    const finIsRootPos = !rnHasInversionFigure(finRn);
    const isPac = sopDeg === 1 && penIsRootPos && finIsRootPos;
    const t: CadenceType = isPac ? 'PAC' : 'IAC';
    let reason: string;
    if (isPac) {
      reason = `V → I, soprano on 1̂, both root-position — perfect authentic cadence`;
    } else {
      const flaws: string[] = [];
      if (!penIsRootPos) flaws.push('V inverted');
      if (!finIsRootPos) flaws.push('I inverted');
      if (sopDeg !== 1) flaws.push(`soprano on ${sopDeg ?? '?'}̂`);
      reason = `V → I (${flaws.join(', ')}) — imperfect authentic cadence`;
    }
    return {
      type: t,
      measure: final.measure, beat: final.beat,
      sopranoFinalDegree: sopDeg,
      penultimate: penRn, final: finRn,
      basis: reason,
    };
  }

  return {
    type: 'unclear',
    measure: final.measure, beat: final.beat,
    sopranoFinalDegree: sopDeg,
    penultimate: penRn, final: finRn,
    basis: `${penRn} → ${finRn} — does not match a standard cadence pattern`,
  };
}

/** Convenience: classify cadences for every phrase in a list. */
export function classifyCadences(
  phrases: PhraseRange[],
  chordAnalyses: ChordAnalysis[],
  score: Score,
  key: string,
): Cadence[] {
  return phrases.map(p => classifyCadence(p, chordAnalyses, score, key));
}
