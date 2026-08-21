// ─── lib/musicology/voiceLeading.ts ──────────────────────────────────────────
// Consolidated voice-leading primitives. Most of these were previously
// inlined in lib/maestroCritiqueAnalyzer.ts; they are reproduced here so
// downstream callers (the critique analyzer, future Maestro tools, and the
// L2 verifier) can share one canonical implementation.
//
// Behavioral parity with the analyzer's previous inline versions is the
// rule for Phase 4 — the numeric outputs (parallel-5th counts, Tymoczko VL
// distance, motif similarities) must match what the analyzer produced
// before the move.

import type { NoteData } from './noteData.js';
import { pitchToMidi, semiAbs, signed } from './pitch.js';

// ─── Voice grouping helpers ──────────────────────────────────────────────────

export function byVoice(notes: NoteData[]): Map<number, NoteData[]> {
  const m = new Map<number, NoteData[]>();
  for (const n of notes) {
    if (!m.has(n.voice)) m.set(n.voice, []);
    m.get(n.voice)!.push(n);
  }
  return m;
}

export function realNotes(notes: NoteData[]): NoteData[] {
  return notes.filter(n => n.pitch !== 'R');
}

/**
 * Pair up notes that occur at the same beat in two voices. Used when
 * counting parallel intervals or tracking voice motion between adjacent
 * "harmonic" beats.
 */
export function alignedPairs(vA: NoteData[], vB: NoteData[]): Array<[NoteData, NoteData]> {
  const pairs: Array<[NoteData, NoteData]> = [];
  for (const a of vA) {
    const b = vB.find(n => n.measure === a.measure && Math.abs(n.beat - a.beat) < 0.01);
    if (b) pairs.push([a, b]);
  }
  return pairs;
}

// ─── Motion type ─────────────────────────────────────────────────────────────

export type MotionType = 'parallel' | 'contrary' | 'oblique' | 'similar';

export function motionType(
  a1: string, a2: string,
  b1: string, b2: string,
): MotionType | null {
  const d1 = signed(a1, a2), d2 = signed(b1, b2);
  if (d1 === null || d2 === null) return null;
  if (d1 === 0 && d2 === 0) return 'oblique';
  if (d1 === 0 || d2 === 0) return 'oblique';
  if (Math.sign(d1) !== Math.sign(d2)) return 'contrary';
  // Same direction — distinguish parallel from similar.
  const st1 = Math.abs(signed(a1, b1) ?? 0) % 12;
  const st2 = Math.abs(signed(a2, b2) ?? 0) % 12;
  return st1 === st2 ? 'parallel' : 'similar';
}

// ─── Parallel detection ──────────────────────────────────────────────────────

export interface ParallelEvent {
  voiceA: number;
  voiceB: number;
  measureA: number; beatA: number;
  measureB: number; beatB: number;
  intervalSemis: number; // 0 = octave; 7 = perfect fifth
  kind: 'P5' | 'P8';
}

export interface VoiceCrossingEvent {
  voiceA: number; // upper voice expected
  voiceB: number; // lower voice expected — but its midi exceeds A's
  measure: number;
  beat: number;
}

export interface ParallelDetectionResult {
  parallel5ths: ParallelEvent[];
  parallel8ves: ParallelEvent[];
  voiceCrossings: VoiceCrossingEvent[];
}

/**
 * Detect parallel 5ths/8ves between every pair of adjacent voices, and voice
 * crossings (upper voice midi < lower voice midi at a given beat). Mirrors
 * the inline detection in maestroCritiqueAnalyzer.dim17.
 */
export function detectParallels(notes: NoteData[]): ParallelDetectionResult {
  const voices = byVoice(notes);
  const voiceKeys = Array.from(voices.keys()).sort();
  const parallel5ths: ParallelEvent[] = [];
  const parallel8ves: ParallelEvent[] = [];
  const voiceCrossings: VoiceCrossingEvent[] = [];

  for (let vi = 0; vi < voiceKeys.length - 1; vi++) {
    const vA = realNotes(voices.get(voiceKeys[vi])!);
    const vB = realNotes(voices.get(voiceKeys[vi + 1])!);
    const pairs = alignedPairs(vA, vB);
    for (let i = 0; i < pairs.length - 1; i++) {
      const [a1, b1] = pairs[i];
      const [a2, b2] = pairs[i + 1];
      const mot = motionType(a1.pitch, a2.pitch, b1.pitch, b2.pitch);
      if (mot === 'parallel') {
        const st = semiAbs(a2.pitch, b2.pitch);
        if (st !== null) {
          if (st % 12 === 7) parallel5ths.push({
            voiceA: voiceKeys[vi], voiceB: voiceKeys[vi + 1],
            measureA: a1.measure, beatA: a1.beat,
            measureB: a2.measure, beatB: a2.beat,
            intervalSemis: 7, kind: 'P5',
          });
          if (st % 12 === 0) parallel8ves.push({
            voiceA: voiceKeys[vi], voiceB: voiceKeys[vi + 1],
            measureA: a1.measure, beatA: a1.beat,
            measureB: a2.measure, beatB: a2.beat,
            intervalSemis: 0, kind: 'P8',
          });
        }
      }
      // Voice crossing: voiceKeys[vi] is upper (lower voice number); if the
      // upper note's midi < lower note's midi, voices have crossed.
      const ma2 = pitchToMidi(a2.pitch);
      const mb2 = pitchToMidi(b2.pitch);
      if (ma2 !== null && mb2 !== null
          && voiceKeys[vi] < voiceKeys[vi + 1]
          && ma2 < mb2) {
        voiceCrossings.push({
          voiceA: voiceKeys[vi], voiceB: voiceKeys[vi + 1],
          measure: a2.measure, beat: a2.beat,
        });
      }
    }
  }

  return { parallel5ths, parallel8ves, voiceCrossings };
}

// ─── Tymoczko voice-leading distance ─────────────────────────────────────────

/** Sum of absolute semitone displacement when moving from chordA to chordB.
 *  Same-voice pairs are matched first, then nearest-pitch fallback. */
export function tymoczkoVLDistance(chordA: NoteData[], chordB: NoteData[]): number {
  let dist = 0;
  for (const a of chordA) {
    const ma = pitchToMidi(a.pitch);
    if (ma === null) continue;
    const sameVoice = chordB.find(b => b.voice === a.voice);
    let mb: number | null = null;
    if (sameVoice) {
      mb = pitchToMidi(sameVoice.pitch);
    } else {
      let best = Infinity;
      for (const b of chordB) {
        const m2 = pitchToMidi(b.pitch);
        if (m2 !== null && Math.abs(m2 - ma) < best) {
          best = Math.abs(m2 - ma);
          mb = m2;
        }
      }
    }
    if (mb !== null) dist += Math.abs(mb - ma);
  }
  return dist;
}

// ─── Mongeau-Sankoff melodic similarity ──────────────────────────────────────

/** Weighted edit distance for melodic interval sequences.
 *  Costs:
 *    exact match           : 0
 *    inversion (sign flip) : 0.6
 *    aug/dim by ≤ 1 semi   : 0.5
 *    different note        : 1.5
 *    insert / delete       : 1.0
 */
export function mongeauSankoffEditDistance(fragA: number[], fragB: number[]): number {
  const lenA = fragA.length, lenB = fragB.length;
  const dp: number[][] = Array.from({ length: lenA + 1 }, (_, i) =>
    Array.from({ length: lenB + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= lenA; i++) {
    for (let j = 1; j <= lenB; j++) {
      const a = fragA[i - 1], b = fragB[j - 1];
      let sub: number;
      if (a === b) sub = 0;
      else if (a === -b) sub = 0.6;
      else if (Math.abs(Math.abs(a) - Math.abs(b)) <= 1) sub = 0.5;
      else sub = 1.5;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1.0,
        dp[i][j - 1] + 1.0,
        dp[i - 1][j - 1] + sub,
      );
    }
  }
  return dp[lenA][lenB];
}

/** Best-match similarity of any k-window with any other k-window in the
 *  same melody. Returns a normalized 0..1 score (0 = identical, 1 =
 *  unrelated). */
export function mongeauSankoffSelfSimilarity(intervals: number[], k = 4): number {
  if (intervals.length < k * 2) return 1.0;
  let best = Infinity;
  for (let i = 0; i <= intervals.length - k; i++) {
    const fragA = intervals.slice(i, i + k);
    for (let j = 0; j <= intervals.length - k; j++) {
      if (j === i) continue;
      const fragB = intervals.slice(j, j + k);
      const d = mongeauSankoffEditDistance(fragA, fragB);
      if (d < best) best = d;
    }
  }
  return Math.min(best / k, 1.0);
}

// ─── Legacy aliases (for the existing critique analyzer) ─────────────────────
// The analyzer's inline names are kept available so the refactor can swap
// implementations in place. The aliased names match the originals in
// lib/maestroCritiqueAnalyzer.ts before Phase 4.

/** @deprecated Use {@link realNotes}. */
export const real = realNotes;
/** @deprecated Use {@link alignedPairs}. */
export const aligned = alignedPairs;
/** @deprecated Use {@link tymoczkoVLDistance}. */
export const computeVLDistance = tymoczkoVLDistance;
/** @deprecated Use {@link mongeauSankoffEditDistance}. */
export const mongoEditDistance = mongeauSankoffEditDistance;
/** @deprecated Use {@link mongeauSankoffSelfSimilarity}. */
export const mongoSimilarityScore = mongeauSankoffSelfSimilarity;

// ─── Suspension detection ────────────────────────────────────────────────────

export interface Suspension {
  voice: number;
  preparationMeasure: number;
  preparationBeat: number;
  suspensionMeasure: number;
  suspensionBeat: number;
  resolutionMeasure: number;
  resolutionBeat: number;
  /** "4-3", "7-6", "9-8", "2-3" (bass), based on the interval at the
   *  suspension and at the resolution. */
  figure: string;
}

/**
 * Heuristic suspension detection. Looks for: (1) a tone tied or held from a
 * consonant beat into a dissonant beat, (2) the held tone resolves down by
 * step on the next beat. The figure is derived from the interval against
 * the bass at suspension and resolution.
 */
export function detectSuspensions(notes: NoteData[]): Suspension[] {
  const out: Suspension[] = [];
  const voices = byVoice(notes);
  const voiceKeys = Array.from(voices.keys()).sort();
  if (voiceKeys.length < 2) return out;
  // Bass = highest voice number (lowest sounding voice in our convention).
  const bassKey = voiceKeys[voiceKeys.length - 1];
  const bassVoice = realNotes(voices.get(bassKey)!);
  for (const vk of voiceKeys.slice(0, -1)) {
    const upperVoice = realNotes(voices.get(vk)!);
    for (let i = 1; i < upperVoice.length - 1; i++) {
      const prep = upperVoice[i - 1];
      const susp = upperVoice[i];
      const resol = upperVoice[i + 1];
      // Same pitch held = suspension candidate.
      if (susp.pitch !== prep.pitch) continue;
      // Resolution must be down by step.
      const stepDown = signed(susp.pitch, resol.pitch);
      if (stepDown === null || stepDown >= 0 || Math.abs(stepDown) > 2) continue;
      // Find bass note at the suspension's beat.
      const bassAt = bassVoice.find(b => b.measure === susp.measure && Math.abs(b.beat - susp.beat) < 0.01);
      if (!bassAt) continue;
      const ic = semiAbs(bassAt.pitch, susp.pitch);
      const icR = semiAbs(bassAt.pitch, resol.pitch);
      if (ic === null || icR === null) continue;
      // Interval-class numbers above bass (mod 7-ish for figure naming).
      const figureSus = intervalToFigure(ic);
      const figureRes = intervalToFigure(icR);
      if (!figureSus || !figureRes) continue;
      out.push({
        voice: vk,
        preparationMeasure: prep.measure, preparationBeat: prep.beat,
        suspensionMeasure: susp.measure, suspensionBeat: susp.beat,
        resolutionMeasure: resol.measure, resolutionBeat: resol.beat,
        figure: `${figureSus}-${figureRes}`,
      });
    }
  }
  return out;
}

function intervalToFigure(semi: number): string | null {
  const ic = ((semi % 12) + 12) % 12;
  switch (ic) {
    case 0: return '8';
    case 1: case 2: return '9';
    case 3: case 4: return '3';
    case 5: return '4';
    case 6: case 7: return '5';
    case 8: case 9: return '6';
    case 10: case 11: return '7';
  }
  return null;
}

// ─── Imitation detection ─────────────────────────────────────────────────────

/** Find melodic interval-pattern matches between voice A and voice B —
 *  3-interval sequences appearing in both voices (transposition-invariant).
 *  Returns the count of distinct matched patterns. */
export function detectImitation(vA: NoteData[], vB: NoteData[]): number {
  const intsA: number[] = [];
  for (let i = 0; i < vA.length - 1; i++) {
    const d = signed(vA[i].pitch, vA[i + 1].pitch);
    if (d !== null) intsA.push(d);
  }
  const intsB: number[] = [];
  for (let i = 0; i < vB.length - 1; i++) {
    const d = signed(vB[i].pitch, vB[i + 1].pitch);
    if (d !== null) intsB.push(d);
  }
  let count = 0;
  for (let i = 0; i <= intsA.length - 3; i++) {
    const pattern = intsA.slice(i, i + 3).join(',');
    for (let j = 0; j <= intsB.length - 3; j++) {
      if (intsB.slice(j, j + 3).join(',') === pattern) {
        count++;
        break;
      }
    }
  }
  return count;
}
