// ─── lib/musicology/scale.ts ─────────────────────────────────────────────────
// Scale and key-signature primitives. Moved out of lib/maestroCritiqueAnalyzer.ts.
//
// `getScalePcs("C major")` → { 0, 2, 4, 5, 7, 9, 11 }
// `isDiatonic("F#4", scalePcs)` → false  (when scalePcs is C major's set)

import { NOTE_NAMES, normAcc, pc } from './pitch.js';

/**
 * Mode → ascending interval pattern from the tonic, in semitones.
 * The seven church modes plus harmonic-minor (added because the curriculum
 * teaches it as the canonical minor-mode dominant-cadence form).
 */
export const MODE_INTERVALS: Record<string, number[]> = {
  major:           [0, 2, 4, 5, 7, 9, 11],
  ionian:          [0, 2, 4, 5, 7, 9, 11],
  minor:           [0, 2, 3, 5, 7, 8, 10],
  aeolian:         [0, 2, 3, 5, 7, 8, 10],
  dorian:          [0, 2, 3, 5, 7, 9, 10],
  phrygian:        [0, 1, 3, 5, 7, 8, 10],
  lydian:          [0, 2, 4, 6, 7, 9, 11],
  mixolydian:      [0, 2, 4, 5, 7, 9, 10],
  locrian:         [0, 1, 3, 5, 6, 8, 10],
  'harmonic minor': [0, 2, 3, 5, 7, 8, 11],
  'melodic minor':  [0, 2, 3, 5, 7, 9, 11],
};

/**
 * Parse a key string like "C major" / "Bb minor" / "D Dorian" and return the
 * set of pitch classes in that key. Falls back to C major for unparseable
 * inputs — callers should treat the result as advisory.
 */
export function getScalePcs(keySignature: string): Set<number> {
  const m = keySignature.trim().match(/^([A-G](?:##|#|bb|b)?)\s+(.+)$/i);
  if (!m) return new Set(MODE_INTERVALS.major.map(i => i % 12));
  const rootName = m[1];
  const rootIdx = NOTE_NAMES.indexOf(normAcc(rootName));
  const mode = m[2].toLowerCase();
  const intervals = MODE_INTERVALS[mode] ?? MODE_INTERVALS.major;
  return new Set(intervals.map(i => ((rootIdx + i) % 12 + 12) % 12));
}

/** True if `pitch`'s pitch class is in `scalePcs`. */
export function isDiatonic(pitch: string, scalePcs: Set<number>): boolean {
  const p = pc(pitch);
  return p !== null && scalePcs.has(p);
}

// ─── Key arithmetic ──────────────────────────────────────────────────────────

/** Tonic pitch class of a key string ("C major" → 0, "A minor" → 9). */
export function tonicPc(keySignature: string): number | null {
  const m = keySignature.trim().match(/^([A-G](?:##|#|bb|b)?)\s+/);
  if (!m) return null;
  const idx = NOTE_NAMES.indexOf(normAcc(m[1]));
  return idx >= 0 ? idx : null;
}

/** "major" | "minor" | "dorian" | … from a key string. Lowercased. */
export function keyMode(keySignature: string): string | null {
  const m = keySignature.trim().match(/^[A-G](?:##|#|bb|b)?\s+(.+)$/i);
  return m ? m[1].toLowerCase() : null;
}

/** Scale degree (1..7) of a pitch class within a key, or null if not diatonic. */
export function scaleDegree(pitch: string, keySignature: string): number | null {
  const p = pc(pitch);
  if (p === null) return null;
  const root = tonicPc(keySignature);
  if (root === null) return null;
  const mode = keyMode(keySignature) ?? 'major';
  const intervals = MODE_INTERVALS[mode] ?? MODE_INTERVALS.major;
  const offset = ((p - root) % 12 + 12) % 12;
  const i = intervals.indexOf(offset);
  return i >= 0 ? i + 1 : null;
}

/** Parallel-mode key string. Major ↔ minor on the same tonic.
 *  "C major" → "C minor"; "A minor" → "A major". Returns null for modes. */
export function parallelKey(keySignature: string): string | null {
  const mode = keyMode(keySignature);
  if (mode === 'major') return keySignature.replace(/major\s*$/i, 'minor');
  if (mode === 'minor') return keySignature.replace(/minor\s*$/i, 'major');
  return null;
}

/** Relative-mode key string. C major → A minor; A minor → C major. */
export function relativeKey(keySignature: string): string | null {
  const mode = keyMode(keySignature);
  const root = tonicPc(keySignature);
  if (mode === null || root === null) return null;
  if (mode === 'major') {
    const newRoot = ((root - 3) % 12 + 12) % 12;
    return `${NOTE_NAMES[newRoot]} minor`;
  }
  if (mode === 'minor') {
    const newRoot = ((root + 3) % 12 + 12) % 12;
    return `${NOTE_NAMES[newRoot]} major`;
  }
  return null;
}
