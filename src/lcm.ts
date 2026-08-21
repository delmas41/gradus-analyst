// ─── lib/maestroAnalyst/lcm.ts ───────────────────────────────────────────────
// Distance-from-home as a number, applied at three structural levels.
//
// Euler's *gradus suavitatis* (1739) in the Stolzenburg (2015) simplification:
// for two pitches in the simplest just-intonation ratio, the LCM of the two
// integers is the consonance measure. Lower = more consonant / closer to home.
// See V1 §3.4 of the thesis ("the LCM measure of §3.4 is Euler's gradus
// suavitatis in its Stolzenburg simplification").
//
// Three levels:
//   pitchLcm(pitch, tonic)        — single pitch vs local tonic
//   chordRootLcm(rootPc, tonic)   — chord root vs local tonic
//   regionLcm(localKey, homeKey)  — local tonic vs home tonic
//   chordInternalLcm(pcs)         — chord's own vertical dissonance
//
// Inputs are pitch classes (0..11) where possible, to keep the math
// spelling-agnostic. Wrappers that take note names use namePc() from pitch.ts.
//
// Pure module. No external deps beyond pitch.ts. Zero API cost.

import { namePc } from './pitch.js';

/**
 * Canonical LCM measure for each chromatic interval (0..11 semitones above
 * a tonic). Drawn from V1 §3.4's table. Lower = closer to home.
 *
 * The values reflect the *simplest* just-intonation ratio between the two
 * pitches, which is the listener's most-likely interpretation in a tonal
 * context. For context-dependent intervals (the minor 7th can be heard as
 * 4:7 in V⁷ context vs 9:16 diatonically), this table picks the diatonic
 * reading. The chord-internal helper handles the V⁷ partial-7 case.
 *
 * Interval semantics:
 *   0  unison (1:1)            LCM 1
 *   1  minor 2nd (15:16)       LCM 240
 *   2  major 2nd (8:9)         LCM 72
 *   3  minor 3rd (5:6)         LCM 30
 *   4  major 3rd (4:5)         LCM 20
 *   5  perfect 4th (3:4)       LCM 12
 *   6  tritone (5:7 just)      LCM 35
 *   7  perfect 5th (2:3)       LCM 6
 *   8  minor 6th (5:8)         LCM 40
 *   9  major 6th (3:5)         LCM 15
 *  10  minor 7th (9:16)        LCM 144 — diatonic reading
 *  11  major 7th (8:15)        LCM 120 — leading-tone position
 */
export const INTERVAL_LCM: Record<number, number> = {
  0: 1,
  1: 240,
  2: 72,
  3: 30,
  4: 20,
  5: 12,
  6: 35,
  7: 6,
  8: 40,
  9: 15,
  10: 144,
  11: 120,
};

/** Chromatic interval in semitones from `tonicPc` up to `pitchPc`, in [0, 11]. */
function chromaticInterval(pitchPc: number, tonicPc: number): number {
  return ((pitchPc - tonicPc) % 12 + 12) % 12;
}

/**
 * LCM distance of a sounding pitch from a tonic. Both passed as pitch classes
 * (0..11). Tonic is the reference (lcm 1); pitch sits somewhere on the gradient.
 */
export function pitchLcmFromPc(pitchPc: number, tonicPc: number): number {
  const iv = chromaticInterval(pitchPc, tonicPc);
  return INTERVAL_LCM[iv];
}

/**
 * Convenience wrapper that takes pitch and tonic as letter+accidental names
 * ("C", "G", "F#", "Bb"). Octave is ignored — LCM is octave-equivalent in this
 * model because perceived gradient position is a pitch-class property.
 */
export function pitchLcm(pitchName: string, tonicName: string): number | null {
  // Strip any trailing octave digits — accept "C4" as well as "C".
  const pStrip = pitchName.replace(/-?\d+$/, '');
  const tStrip = tonicName.replace(/-?\d+$/, '');
  const ppc = namePc(pStrip);
  const tpc = namePc(tStrip);
  if (ppc === null || tpc === null) return null;
  return pitchLcmFromPc(ppc, tpc);
}

/**
 * Chord-root distance from local tonic, same gradient as pitchLcm but
 * named to make the structural level explicit (chord-level vs pitch-level).
 */
export function chordRootLcm(rootPc: number, tonicPc: number): number {
  return pitchLcmFromPc(rootPc, tonicPc);
}

/**
 * Distance between two keys' tonics on the same gradient. This is the
 * region-level LCM — the modulation distance.
 *
 * Mode (major/minor) does not enter the calculation directly; the gradient
 * is between pitch classes. A modulation from C major to A minor and one
 * from C major to A major both produce the same region LCM (15), because
 * the *home position has shifted* by the same gradient amount in both cases.
 * The mode-of-the-new-region is a separate fact recorded alongside.
 */
export function regionLcm(localTonicName: string, homeTonicName: string): number | null {
  return pitchLcm(localTonicName, homeTonicName);
}

/**
 * The chord's own internal dissonance, independent of its position in any
 * key. A close-position major triad is 60; a dominant seventh is 420; a
 * diminished seventh is much higher. This complements the chord-root LCM
 * (which says "how far the chord is from home") with "how dense the chord
 * is in itself".
 *
 * Approach: map the pitch-class set against canonical small-integer ratios
 * keyed by interval structure. We pattern-match the most common chord types
 * and return their stable LCM values from V1 §3.4. Unknown patterns return
 * null (caller can fall back to chord-root LCM only).
 *
 * The LCM values returned here match the table in §3.4:
 *   major triad (4:5:6) close position           60
 *   minor triad (10:12:15) close position        60
 *   dominant seventh (4:5:6:7)                  420
 *   diminished triad (5:6:7) just               210
 *   augmented triad (16:20:25)                  400
 *   diminished seventh (125:150:180:216)     27,000
 *   half-diminished seventh (5:6:7:9)          1,260
 *   minor seventh (10:12:15:18)               (we approximate; see below)
 */
export function chordInternalLcm(pcs: number[]): number | null {
  if (pcs.length === 0) return null;

  // Normalize: distinct pitch classes only, sorted.
  const set = Array.from(new Set(pcs.map(p => ((p % 12) + 12) % 12))).sort((a, b) => a - b);

  // Intervals from the lowest pc, mod 12. This is the prime-form-ish signature
  // we'll pattern-match against.
  const sig = (root: number) => set.map(p => ((p - root) + 12) % 12).sort((a, b) => a - b).join(',');

  // Try each pc as root; the canonical chord signatures are listed under their
  // root's perspective. A diminished seventh is symmetric so any rotation matches.
  for (const root of set) {
    const s = sig(root);
    switch (s) {
      case '0,4,7':         return 60;     // major triad
      case '0,3,7':         return 60;     // minor triad
      case '0,3,6':         return 210;    // diminished triad
      case '0,4,8':         return 400;    // augmented triad
      case '0,4,7,10':      return 420;    // dominant seventh
      case '0,4,7,11':      return 1800;   // major seventh (close packing) — provisional
      case '0,3,7,10':      return 1260;   // minor seventh — same as half-dim approximation
      case '0,3,6,10':      return 1260;   // half-diminished seventh
      case '0,3,6,9':       return 27000;  // fully diminished seventh
    }
  }
  return null;
}

/**
 * Total LCM signature for a sounding pitch collection against a local tonic.
 * Returns one number per pitch in the collection, plus a summary (sum, max,
 * mean) for convenience in time-series plotting.
 */
export interface PitchSetLcm {
  perPitch: { pitchPc: number; lcm: number }[];
  sum: number;
  max: number;
  mean: number;
}

export function pitchSetLcm(pcs: number[], tonicPc: number): PitchSetLcm {
  const perPitch = pcs.map(pc => {
    const norm = ((pc % 12) + 12) % 12;
    return { pitchPc: norm, lcm: pitchLcmFromPc(norm, tonicPc) };
  });
  const lcms = perPitch.map(p => p.lcm);
  const sum = lcms.reduce((a, b) => a + b, 0);
  const max = lcms.length ? Math.max(...lcms) : 0;
  const mean = lcms.length ? sum / lcms.length : 0;
  return { perPitch, sum, max, mean };
}
