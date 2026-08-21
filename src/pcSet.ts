// ─── lib/musicology/pcSet.ts ─────────────────────────────────────────────────
// Pitch-class set theory primitives.
//
//   normalForm(pcs)     → most-compact rotation (Forte/Rahn)
//   primeForm(pcs)      → normal form vs its inversion, "most left-packed"
//   intervalVector(pcs) → 6-element vector of interval-class counts
//   forteName(prime)    → '3-1', '4-Z29', etc., or null if unknown
//
// The Forte catalog covers all 224 prime forms (cardinality 0–12). We use
// Rahn's "most left-packed" tiebreaker, which is the convention Music21 uses.
//
// Catalog source: Allen Forte, *The Structure of Atonal Music* (1973),
// reproduced in Joseph Straus, *Introduction to Post-Tonal Theory* (3rd ed.,
// 2005), Appendix A. Z-related pairs are cross-referenced.

import type { ForteEntry } from './types.js';

// ─── Normal form ─────────────────────────────────────────────────────────────

/** Sort, dedupe pcs to canonical 0..11 ascending. */
function sortDedupe(pcs: number[]): number[] {
  return Array.from(new Set(pcs.map(p => ((p % 12) + 12) % 12))).sort((a, b) => a - b);
}

/** Rotate a sorted pc array so element `start` is first; subsequent elements
 *  are wrapped through the octave. */
function rotateAt(sorted: number[], start: number): number[] {
  const n = sorted.length;
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(sorted[(start + i) % n]);
  return out;
}

/** Span from first element of a rotation to the last (mod 12). */
function rotationSpan(rot: number[]): number {
  const last = rot[rot.length - 1] - rot[0];
  return ((last % 12) + 12) % 12;
}

/** Compare two rotations; the more compact one (smaller span overall, smaller
 *  intervals first when ties at outer span) is "smaller". */
function rotationLess(a: number[], b: number[]): boolean {
  const sa = rotationSpan(a);
  const sb = rotationSpan(b);
  if (sa !== sb) return sa < sb;
  // Tie on outer span — break by comparing inner spans from front.
  for (let len = a.length - 1; len >= 1; len--) {
    const innerA = ((a[len - 1] - a[0]) % 12 + 12) % 12;
    const innerB = ((b[len - 1] - b[0]) % 12 + 12) % 12;
    if (innerA !== innerB) return innerA < innerB;
  }
  // Final tie — pick smaller starting pc.
  return a[0] < b[0];
}

/**
 * Forte/Rahn normal form. Returns the rotation that is most compact (smallest
 * span from first to last element, with ties broken left-packed).
 */
export function normalForm(pcs: number[]): number[] {
  const u = sortDedupe(pcs);
  if (u.length === 0) return [];
  let best = rotateAt(u, 0);
  for (let i = 1; i < u.length; i++) {
    const cand = rotateAt(u, i);
    if (rotationLess(cand, best)) best = cand;
  }
  return best;
}

// ─── Prime form ──────────────────────────────────────────────────────────────

function transposeToZero(rot: number[]): number[] {
  const offset = rot[0];
  return rot.map(p => ((p - offset) % 12 + 12) % 12);
}

function invert(pcs: number[]): number[] {
  return pcs.map(p => ((-p) % 12 + 12) % 12);
}

/**
 * Prime form. Computed as min(normalForm(set), normalForm(inverse(set))) per
 * Rahn's "most left-packed" rule, with both transposed to 0.
 */
export function primeForm(pcs: number[]): number[] {
  const nf = normalForm(pcs);
  if (nf.length === 0) return [];
  const fwd = transposeToZero(nf);
  const inv = transposeToZero(normalForm(invert(pcs)));
  // Pick the more-compact of the two: same span (always 0 → outer), so compare
  // element-by-element.
  for (let i = 0; i < Math.min(fwd.length, inv.length); i++) {
    if (fwd[i] !== inv[i]) return fwd[i] < inv[i] ? fwd : inv;
  }
  return fwd;
}

// ─── Interval vector ─────────────────────────────────────────────────────────

/** 6-element vector of interval-class counts: [ic1, ic2, ic3, ic4, ic5, ic6]. */
export function intervalVector(pcs: number[]): number[] {
  const u = sortDedupe(pcs);
  const ic = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < u.length; i++) {
    for (let j = i + 1; j < u.length; j++) {
      const d = ((u[j] - u[i]) % 12 + 12) % 12;
      const interval = d > 6 ? 12 - d : d;
      if (interval >= 1 && interval <= 6) ic[interval - 1]++;
    }
  }
  return ic;
}

// ─── Forte catalog ───────────────────────────────────────────────────────────
//
// Each entry: forte name, prime form (as comma-joined string for indexing),
// interval vector, Z-relation partner if any. The catalog covers cardinalities
// 0–12; the 0-set and 12-set are degenerate (always present); we list
// cardinality 1–11 explicitly.
//
// Z-related pairs (different prime forms with identical IVs):
//   4-Z15 ↔ 4-Z29; 5-Z12 ↔ 5-Z36; 5-Z17 ↔ 5-Z37; 5-Z18 ↔ 5-Z38;
//   6-Z3 ↔ 6-Z36; 6-Z4 ↔ 6-Z37; 6-Z6 ↔ 6-Z38; 6-Z10 ↔ 6-Z39;
//   6-Z11 ↔ 6-Z40; 6-Z12 ↔ 6-Z41; 6-Z13 ↔ 6-Z42; 6-Z17 ↔ 6-Z43;
//   6-Z19 ↔ 6-Z44; 6-Z23 ↔ 6-Z45; 6-Z24 ↔ 6-Z46; 6-Z25 ↔ 6-Z47;
//   6-Z26 ↔ 6-Z48; 6-Z28 ↔ 6-Z49; 6-Z29 ↔ 6-Z50;
//   7-Z12 ↔ 7-Z36; 7-Z17 ↔ 7-Z37; 7-Z18 ↔ 7-Z38;
//   8-Z15 ↔ 8-Z29.

interface CatalogRow {
  forteName: string;
  primeForm: number[];
  intervalVector: number[];
  zRelated?: string;
}

const CATALOG: CatalogRow[] = [
  // ── Cardinality 1 ────────────────────────────────────────────────────────
  { forteName: '1-1', primeForm: [0], intervalVector: [0,0,0,0,0,0] },

  // ── Cardinality 2 ────────────────────────────────────────────────────────
  { forteName: '2-1', primeForm: [0,1], intervalVector: [1,0,0,0,0,0] },
  { forteName: '2-2', primeForm: [0,2], intervalVector: [0,1,0,0,0,0] },
  { forteName: '2-3', primeForm: [0,3], intervalVector: [0,0,1,0,0,0] },
  { forteName: '2-4', primeForm: [0,4], intervalVector: [0,0,0,1,0,0] },
  { forteName: '2-5', primeForm: [0,5], intervalVector: [0,0,0,0,1,0] },
  { forteName: '2-6', primeForm: [0,6], intervalVector: [0,0,0,0,0,1] },

  // ── Cardinality 3 ────────────────────────────────────────────────────────
  { forteName: '3-1', primeForm: [0,1,2], intervalVector: [2,1,0,0,0,0] },
  { forteName: '3-2', primeForm: [0,1,3], intervalVector: [1,1,1,0,0,0] },
  { forteName: '3-3', primeForm: [0,1,4], intervalVector: [1,0,1,1,0,0] },
  { forteName: '3-4', primeForm: [0,1,5], intervalVector: [1,0,0,1,1,0] },
  { forteName: '3-5', primeForm: [0,1,6], intervalVector: [1,0,0,0,1,1] },
  { forteName: '3-6', primeForm: [0,2,4], intervalVector: [0,2,0,1,0,0] },
  { forteName: '3-7', primeForm: [0,2,5], intervalVector: [0,1,1,0,1,0] },
  { forteName: '3-8', primeForm: [0,2,6], intervalVector: [0,1,0,1,0,1] },
  { forteName: '3-9', primeForm: [0,2,7], intervalVector: [0,1,0,0,2,0] },
  { forteName: '3-10', primeForm: [0,3,6], intervalVector: [0,0,2,0,0,1] },
  { forteName: '3-11', primeForm: [0,3,7], intervalVector: [0,0,1,1,1,0] },
  { forteName: '3-12', primeForm: [0,4,8], intervalVector: [0,0,0,3,0,0] },

  // ── Cardinality 4 ────────────────────────────────────────────────────────
  { forteName: '4-1', primeForm: [0,1,2,3], intervalVector: [3,2,1,0,0,0] },
  { forteName: '4-2', primeForm: [0,1,2,4], intervalVector: [2,2,1,1,0,0] },
  { forteName: '4-3', primeForm: [0,1,3,4], intervalVector: [2,1,2,1,0,0] },
  { forteName: '4-4', primeForm: [0,1,2,5], intervalVector: [2,1,1,1,1,0] },
  { forteName: '4-5', primeForm: [0,1,2,6], intervalVector: [2,1,0,1,1,1] },
  { forteName: '4-6', primeForm: [0,1,2,7], intervalVector: [2,1,0,0,2,1] },
  { forteName: '4-7', primeForm: [0,1,4,5], intervalVector: [2,0,1,2,1,0] },
  { forteName: '4-8', primeForm: [0,1,5,6], intervalVector: [2,0,0,1,2,1] },
  { forteName: '4-9', primeForm: [0,1,6,7], intervalVector: [2,0,0,0,2,2] },
  { forteName: '4-10', primeForm: [0,2,3,5], intervalVector: [1,2,2,0,1,0] },
  { forteName: '4-11', primeForm: [0,1,3,5], intervalVector: [1,2,1,1,1,0] },
  { forteName: '4-12', primeForm: [0,2,3,6], intervalVector: [1,1,2,1,0,1] },
  { forteName: '4-13', primeForm: [0,1,3,6], intervalVector: [1,1,2,0,1,1] },
  { forteName: '4-14', primeForm: [0,2,3,7], intervalVector: [1,1,1,1,2,0] },
  { forteName: '4-Z15', primeForm: [0,1,4,6], intervalVector: [1,1,1,1,1,1], zRelated: '4-Z29' },
  { forteName: '4-16', primeForm: [0,1,5,7], intervalVector: [1,1,0,1,2,1] },
  { forteName: '4-17', primeForm: [0,3,4,7], intervalVector: [1,0,2,2,1,0] },
  { forteName: '4-18', primeForm: [0,1,4,7], intervalVector: [1,0,2,1,1,1] },
  { forteName: '4-19', primeForm: [0,1,4,8], intervalVector: [1,0,1,3,1,0] },
  { forteName: '4-20', primeForm: [0,1,5,8], intervalVector: [1,0,1,2,2,0] },
  { forteName: '4-21', primeForm: [0,2,4,6], intervalVector: [0,3,0,2,0,1] },
  { forteName: '4-22', primeForm: [0,2,4,7], intervalVector: [0,2,1,1,2,0] },
  { forteName: '4-23', primeForm: [0,2,5,7], intervalVector: [0,2,1,0,3,0] },
  { forteName: '4-24', primeForm: [0,2,4,8], intervalVector: [0,2,0,3,0,1] },
  { forteName: '4-25', primeForm: [0,2,6,8], intervalVector: [0,2,0,2,0,2] },
  { forteName: '4-26', primeForm: [0,3,5,8], intervalVector: [0,1,2,1,2,0] },
  { forteName: '4-27', primeForm: [0,2,5,8], intervalVector: [0,1,2,1,1,1] },
  { forteName: '4-28', primeForm: [0,3,6,9], intervalVector: [0,0,4,0,0,2] },
  { forteName: '4-Z29', primeForm: [0,1,3,7], intervalVector: [1,1,1,1,1,1], zRelated: '4-Z15' },

  // ── Cardinality 5 ────────────────────────────────────────────────────────
  { forteName: '5-1', primeForm: [0,1,2,3,4], intervalVector: [4,3,2,1,0,0] },
  { forteName: '5-2', primeForm: [0,1,2,3,5], intervalVector: [3,3,2,1,1,0] },
  { forteName: '5-3', primeForm: [0,1,2,4,5], intervalVector: [3,2,2,2,1,0] },
  { forteName: '5-4', primeForm: [0,1,2,3,6], intervalVector: [3,2,2,1,1,1] },
  { forteName: '5-5', primeForm: [0,1,2,3,7], intervalVector: [3,2,1,1,2,1] },
  { forteName: '5-6', primeForm: [0,1,2,5,6], intervalVector: [3,1,1,2,2,1] },
  { forteName: '5-7', primeForm: [0,1,2,6,7], intervalVector: [3,1,0,1,3,2] },
  { forteName: '5-8', primeForm: [0,2,3,4,6], intervalVector: [2,3,2,2,0,1] },
  { forteName: '5-9', primeForm: [0,1,2,4,6], intervalVector: [2,3,1,2,1,1] },
  { forteName: '5-10', primeForm: [0,1,3,4,6], intervalVector: [2,2,3,1,1,1] },
  { forteName: '5-11', primeForm: [0,2,3,4,7], intervalVector: [2,2,2,2,2,0] },
  { forteName: '5-Z12', primeForm: [0,1,3,5,6], intervalVector: [2,2,2,1,2,1], zRelated: '5-Z36' },
  { forteName: '5-13', primeForm: [0,1,2,4,8], intervalVector: [2,2,1,3,1,1] },
  { forteName: '5-14', primeForm: [0,1,2,5,7], intervalVector: [2,2,1,1,3,1] },
  { forteName: '5-15', primeForm: [0,1,2,6,8], intervalVector: [2,2,0,2,2,2] },
  { forteName: '5-16', primeForm: [0,1,3,4,7], intervalVector: [2,1,3,2,1,1] },
  { forteName: '5-Z17', primeForm: [0,1,3,4,8], intervalVector: [2,1,2,3,2,0], zRelated: '5-Z37' },
  { forteName: '5-Z18', primeForm: [0,1,4,5,7], intervalVector: [2,1,2,2,2,1], zRelated: '5-Z38' },
  { forteName: '5-19', primeForm: [0,1,3,6,7], intervalVector: [2,1,2,1,2,2] },
  { forteName: '5-20', primeForm: [0,1,3,7,8], intervalVector: [2,1,1,2,3,1] },
  { forteName: '5-21', primeForm: [0,1,4,5,8], intervalVector: [2,0,2,4,2,0] },
  { forteName: '5-22', primeForm: [0,1,4,7,8], intervalVector: [2,0,2,3,2,1] },
  { forteName: '5-23', primeForm: [0,2,3,5,7], intervalVector: [1,3,2,1,3,0] },
  { forteName: '5-24', primeForm: [0,1,3,5,7], intervalVector: [1,3,1,2,2,1] },
  { forteName: '5-25', primeForm: [0,2,3,5,8], intervalVector: [1,2,3,1,2,1] },
  { forteName: '5-26', primeForm: [0,2,4,5,8], intervalVector: [1,2,2,3,1,1] },
  { forteName: '5-27', primeForm: [0,1,3,5,8], intervalVector: [1,2,2,2,3,0] },
  { forteName: '5-28', primeForm: [0,2,3,6,8], intervalVector: [1,2,2,2,1,2] },
  { forteName: '5-29', primeForm: [0,1,3,6,8], intervalVector: [1,2,2,1,3,1] },
  { forteName: '5-30', primeForm: [0,1,4,6,8], intervalVector: [1,2,1,3,2,1] },
  { forteName: '5-31', primeForm: [0,1,3,6,9], intervalVector: [1,1,4,1,1,2] },
  { forteName: '5-32', primeForm: [0,1,4,6,9], intervalVector: [1,1,3,2,2,1] },
  { forteName: '5-33', primeForm: [0,2,4,6,8], intervalVector: [0,4,0,4,0,2] },
  { forteName: '5-34', primeForm: [0,2,4,6,9], intervalVector: [0,3,2,2,2,1] },
  { forteName: '5-35', primeForm: [0,2,4,7,9], intervalVector: [0,3,2,1,4,0] },
  { forteName: '5-Z36', primeForm: [0,1,2,4,7], intervalVector: [2,2,2,1,2,1], zRelated: '5-Z12' },
  { forteName: '5-Z37', primeForm: [0,3,4,5,8], intervalVector: [2,1,2,3,2,0], zRelated: '5-Z17' },
  { forteName: '5-Z38', primeForm: [0,1,2,5,8], intervalVector: [2,1,2,2,2,1], zRelated: '5-Z18' },

  // ── Cardinality 6 ────────────────────────────────────────────────────────
  { forteName: '6-1', primeForm: [0,1,2,3,4,5], intervalVector: [5,4,3,2,1,0] },
  { forteName: '6-2', primeForm: [0,1,2,3,4,6], intervalVector: [4,4,3,2,1,1] },
  { forteName: '6-Z3', primeForm: [0,1,2,3,5,6], intervalVector: [4,3,3,2,2,1], zRelated: '6-Z36' },
  { forteName: '6-Z4', primeForm: [0,1,2,4,5,6], intervalVector: [4,3,2,3,2,1], zRelated: '6-Z37' },
  { forteName: '6-5', primeForm: [0,1,2,3,6,7], intervalVector: [4,2,2,2,3,2] },
  { forteName: '6-Z6', primeForm: [0,1,2,5,6,7], intervalVector: [4,2,1,2,4,2], zRelated: '6-Z38' },
  { forteName: '6-7', primeForm: [0,1,2,6,7,8], intervalVector: [4,2,0,2,4,3] },
  { forteName: '6-8', primeForm: [0,2,3,4,5,7], intervalVector: [3,4,3,2,3,0] },
  { forteName: '6-9', primeForm: [0,1,2,3,5,7], intervalVector: [3,4,2,2,3,1] },
  { forteName: '6-Z10', primeForm: [0,1,3,4,5,7], intervalVector: [3,3,3,3,2,1], zRelated: '6-Z39' },
  { forteName: '6-Z11', primeForm: [0,1,2,4,5,7], intervalVector: [3,3,3,2,3,1], zRelated: '6-Z40' },
  { forteName: '6-Z12', primeForm: [0,1,2,4,6,7], intervalVector: [3,3,2,2,3,2], zRelated: '6-Z41' },
  { forteName: '6-Z13', primeForm: [0,1,3,4,6,7], intervalVector: [3,2,4,2,2,2], zRelated: '6-Z42' },
  { forteName: '6-14', primeForm: [0,1,3,4,5,8], intervalVector: [3,2,3,4,3,0] },
  { forteName: '6-15', primeForm: [0,1,2,4,5,8], intervalVector: [3,2,3,4,2,1] },
  { forteName: '6-16', primeForm: [0,1,4,5,6,8], intervalVector: [3,2,2,4,3,1] },
  { forteName: '6-Z17', primeForm: [0,1,2,4,7,8], intervalVector: [3,2,2,3,3,2], zRelated: '6-Z43' },
  { forteName: '6-18', primeForm: [0,1,2,5,7,8], intervalVector: [3,2,2,2,4,2] },
  { forteName: '6-Z19', primeForm: [0,1,3,4,7,8], intervalVector: [3,1,3,4,3,1], zRelated: '6-Z44' },
  { forteName: '6-20', primeForm: [0,1,4,5,8,9], intervalVector: [3,0,3,6,3,0] },
  { forteName: '6-21', primeForm: [0,2,3,4,6,8], intervalVector: [2,4,2,4,1,2] },
  { forteName: '6-22', primeForm: [0,1,2,4,6,8], intervalVector: [2,4,1,4,2,2] },
  { forteName: '6-Z23', primeForm: [0,2,3,5,6,8], intervalVector: [2,3,4,2,2,2], zRelated: '6-Z45' },
  { forteName: '6-Z24', primeForm: [0,1,3,4,6,8], intervalVector: [2,3,3,3,3,1], zRelated: '6-Z46' },
  { forteName: '6-Z25', primeForm: [0,1,3,5,6,8], intervalVector: [2,3,3,2,4,1], zRelated: '6-Z47' },
  { forteName: '6-Z26', primeForm: [0,1,3,5,7,8], intervalVector: [2,3,2,3,4,1], zRelated: '6-Z48' },
  { forteName: '6-27', primeForm: [0,1,3,4,6,9], intervalVector: [2,2,5,2,2,2] },
  { forteName: '6-Z28', primeForm: [0,1,3,5,6,9], intervalVector: [2,2,4,3,2,2], zRelated: '6-Z49' },
  { forteName: '6-Z29', primeForm: [0,1,3,6,8,9], intervalVector: [2,2,4,2,3,2], zRelated: '6-Z50' },
  { forteName: '6-30', primeForm: [0,1,3,6,7,9], intervalVector: [2,2,4,2,2,3] },
  { forteName: '6-31', primeForm: [0,1,4,5,7,9], intervalVector: [2,2,3,4,3,1] },
  { forteName: '6-32', primeForm: [0,2,4,5,7,9], intervalVector: [1,4,3,2,5,0] },
  { forteName: '6-33', primeForm: [0,2,3,5,7,9], intervalVector: [1,4,3,2,4,1] },
  { forteName: '6-34', primeForm: [0,1,3,5,7,9], intervalVector: [1,4,2,4,2,2] },
  { forteName: '6-35', primeForm: [0,2,4,6,8,10], intervalVector: [0,6,0,6,0,3] },
  { forteName: '6-Z36', primeForm: [0,1,2,3,4,7], intervalVector: [4,3,3,2,2,1], zRelated: '6-Z3' },
  { forteName: '6-Z37', primeForm: [0,1,2,3,4,8], intervalVector: [4,3,2,3,2,1], zRelated: '6-Z4' },
  { forteName: '6-Z38', primeForm: [0,1,2,3,7,8], intervalVector: [4,2,1,2,4,2], zRelated: '6-Z6' },
  { forteName: '6-Z39', primeForm: [0,2,3,4,5,8], intervalVector: [3,3,3,3,2,1], zRelated: '6-Z10' },
  { forteName: '6-Z40', primeForm: [0,1,2,3,5,8], intervalVector: [3,3,3,2,3,1], zRelated: '6-Z11' },
  { forteName: '6-Z41', primeForm: [0,1,2,3,6,8], intervalVector: [3,3,2,2,3,2], zRelated: '6-Z12' },
  { forteName: '6-Z42', primeForm: [0,1,2,3,6,9], intervalVector: [3,2,4,2,2,2], zRelated: '6-Z13' },
  { forteName: '6-Z43', primeForm: [0,1,2,5,6,8], intervalVector: [3,2,2,3,3,2], zRelated: '6-Z17' },
  { forteName: '6-Z44', primeForm: [0,1,2,5,6,9], intervalVector: [3,1,3,4,3,1], zRelated: '6-Z19' },
  { forteName: '6-Z45', primeForm: [0,2,3,4,6,9], intervalVector: [2,3,4,2,2,2], zRelated: '6-Z23' },
  { forteName: '6-Z46', primeForm: [0,1,2,4,6,9], intervalVector: [2,3,3,3,3,1], zRelated: '6-Z24' },
  { forteName: '6-Z47', primeForm: [0,1,2,4,7,9], intervalVector: [2,3,3,2,4,1], zRelated: '6-Z25' },
  { forteName: '6-Z48', primeForm: [0,1,2,5,7,9], intervalVector: [2,3,2,3,4,1], zRelated: '6-Z26' },
  { forteName: '6-Z49', primeForm: [0,1,3,4,7,9], intervalVector: [2,2,4,3,2,2], zRelated: '6-Z28' },
  { forteName: '6-Z50', primeForm: [0,1,4,6,7,9], intervalVector: [2,2,4,2,3,2], zRelated: '6-Z29' },

  // ── Cardinality 7 (complements of 5-* sets) ──────────────────────────────
  { forteName: '7-1', primeForm: [0,1,2,3,4,5,6], intervalVector: [6,5,4,3,2,1] },
  { forteName: '7-2', primeForm: [0,1,2,3,4,5,7], intervalVector: [5,5,4,3,3,1] },
  { forteName: '7-3', primeForm: [0,1,2,3,4,5,8], intervalVector: [5,4,4,4,3,1] },
  { forteName: '7-4', primeForm: [0,1,2,3,4,6,7], intervalVector: [5,4,4,3,3,2] },
  { forteName: '7-5', primeForm: [0,1,2,3,5,6,7], intervalVector: [5,4,3,3,4,2] },
  { forteName: '7-6', primeForm: [0,1,2,3,4,7,8], intervalVector: [5,3,3,4,4,2] },
  { forteName: '7-7', primeForm: [0,1,2,3,6,7,8], intervalVector: [5,3,2,3,5,3] },
  { forteName: '7-8', primeForm: [0,2,3,4,5,6,8], intervalVector: [4,5,4,4,2,2] },
  { forteName: '7-9', primeForm: [0,1,2,3,4,6,8], intervalVector: [4,5,3,4,3,2] },
  { forteName: '7-10', primeForm: [0,1,2,3,4,6,9], intervalVector: [4,4,5,3,3,2] },
  { forteName: '7-11', primeForm: [0,1,3,4,5,6,8], intervalVector: [4,4,4,4,4,1] },
  { forteName: '7-Z12', primeForm: [0,1,2,3,4,7,9], intervalVector: [4,4,4,3,4,2], zRelated: '7-Z36' },
  { forteName: '7-13', primeForm: [0,1,2,4,5,6,8], intervalVector: [4,4,3,5,3,2] },
  { forteName: '7-14', primeForm: [0,1,2,3,5,7,8], intervalVector: [4,4,3,3,5,2] },
  { forteName: '7-15', primeForm: [0,1,2,4,6,7,8], intervalVector: [4,4,2,4,4,3] },
  { forteName: '7-16', primeForm: [0,1,3,4,5,6,9], intervalVector: [4,3,5,4,3,2] },
  { forteName: '7-Z17', primeForm: [0,1,2,4,5,6,9], intervalVector: [4,3,4,5,4,1], zRelated: '7-Z37' },
  { forteName: '7-Z18', primeForm: [0,1,2,3,5,8,9], intervalVector: [4,3,4,4,4,2], zRelated: '7-Z38' },
  { forteName: '7-19', primeForm: [0,1,2,3,6,7,9], intervalVector: [4,3,4,3,4,3] },
  { forteName: '7-20', primeForm: [0,1,2,5,6,7,9], intervalVector: [4,3,3,4,5,2] },
  { forteName: '7-21', primeForm: [0,1,2,4,5,8,9], intervalVector: [4,2,4,6,4,1] },
  { forteName: '7-22', primeForm: [0,1,2,5,6,8,9], intervalVector: [4,2,4,5,4,2] },
  { forteName: '7-23', primeForm: [0,2,3,4,5,7,9], intervalVector: [3,5,4,3,5,1] },
  { forteName: '7-24', primeForm: [0,1,2,3,5,7,9], intervalVector: [3,5,3,4,4,2] },
  { forteName: '7-25', primeForm: [0,2,3,4,6,7,9], intervalVector: [3,4,5,3,4,2] },
  { forteName: '7-26', primeForm: [0,1,3,4,5,7,9], intervalVector: [3,4,4,5,3,2] },
  { forteName: '7-27', primeForm: [0,1,2,4,5,7,9], intervalVector: [3,4,4,4,5,1] },
  { forteName: '7-28', primeForm: [0,1,3,5,6,7,9], intervalVector: [3,4,4,4,3,3] },
  { forteName: '7-29', primeForm: [0,1,2,4,6,7,9], intervalVector: [3,4,4,3,5,2] },
  { forteName: '7-30', primeForm: [0,1,2,4,6,8,9], intervalVector: [3,4,3,5,4,2] },
  { forteName: '7-31', primeForm: [0,1,3,4,6,7,9], intervalVector: [3,3,6,3,3,3] },
  { forteName: '7-32', primeForm: [0,1,3,4,6,8,9], intervalVector: [3,3,5,4,4,2] },
  { forteName: '7-33', primeForm: [0,1,2,4,6,8,10], intervalVector: [2,6,2,6,2,3] },
  { forteName: '7-34', primeForm: [0,1,3,4,6,8,10], intervalVector: [2,5,4,4,4,2] },
  { forteName: '7-35', primeForm: [0,1,3,5,6,8,10], intervalVector: [2,5,4,3,6,1] },
  { forteName: '7-Z36', primeForm: [0,1,2,3,5,6,8], intervalVector: [4,4,4,3,4,2], zRelated: '7-Z12' },
  { forteName: '7-Z37', primeForm: [0,1,3,4,5,7,8], intervalVector: [4,3,4,5,4,1], zRelated: '7-Z17' },
  { forteName: '7-Z38', primeForm: [0,1,2,4,5,7,8], intervalVector: [4,3,4,4,4,2], zRelated: '7-Z18' },

  // ── Cardinality 8 (complements of 4-* sets) ──────────────────────────────
  { forteName: '8-1', primeForm: [0,1,2,3,4,5,6,7], intervalVector: [7,6,5,4,4,2] },
  { forteName: '8-2', primeForm: [0,1,2,3,4,5,6,8], intervalVector: [6,6,5,5,4,2] },
  { forteName: '8-3', primeForm: [0,1,2,3,4,5,6,9], intervalVector: [6,5,6,5,4,2] },
  { forteName: '8-4', primeForm: [0,1,2,3,4,5,7,8], intervalVector: [6,5,5,5,5,2] },
  { forteName: '8-5', primeForm: [0,1,2,3,4,6,7,8], intervalVector: [6,5,4,5,5,3] },
  { forteName: '8-6', primeForm: [0,1,2,3,5,6,7,8], intervalVector: [6,5,4,4,6,3] },
  { forteName: '8-7', primeForm: [0,1,2,3,4,5,8,9], intervalVector: [6,4,5,6,5,2] },
  { forteName: '8-8', primeForm: [0,1,2,3,4,7,8,9], intervalVector: [6,4,4,5,6,3] },
  { forteName: '8-9', primeForm: [0,1,2,3,6,7,8,9], intervalVector: [6,4,4,4,6,4] },
  { forteName: '8-10', primeForm: [0,2,3,4,5,6,7,9], intervalVector: [5,6,6,4,5,2] },
  { forteName: '8-11', primeForm: [0,1,2,3,4,5,7,9], intervalVector: [5,6,5,5,5,2] },
  { forteName: '8-12', primeForm: [0,1,3,4,5,6,7,9], intervalVector: [5,5,6,5,4,3] },
  { forteName: '8-13', primeForm: [0,1,2,3,4,6,7,9], intervalVector: [5,5,6,4,5,3] },
  { forteName: '8-14', primeForm: [0,1,2,4,5,6,7,9], intervalVector: [5,5,5,5,6,2] },
  { forteName: '8-Z15', primeForm: [0,1,2,3,4,6,8,9], intervalVector: [5,5,5,5,5,3], zRelated: '8-Z29' },
  { forteName: '8-16', primeForm: [0,1,2,3,5,7,8,9], intervalVector: [5,5,4,5,6,3] },
  { forteName: '8-17', primeForm: [0,1,3,4,5,6,8,9], intervalVector: [5,4,6,6,5,2] },
  { forteName: '8-18', primeForm: [0,1,2,3,5,6,8,9], intervalVector: [5,4,6,5,5,3] },
  { forteName: '8-19', primeForm: [0,1,2,4,5,6,8,9], intervalVector: [5,4,5,7,5,2] },
  { forteName: '8-20', primeForm: [0,1,2,4,5,7,8,9], intervalVector: [5,4,5,6,6,2] },
  { forteName: '8-21', primeForm: [0,1,2,3,4,6,8,10], intervalVector: [4,7,4,6,4,3] },
  { forteName: '8-22', primeForm: [0,1,2,3,5,6,8,10], intervalVector: [4,6,5,5,6,2] },
  { forteName: '8-23', primeForm: [0,1,2,3,5,7,8,10], intervalVector: [4,6,5,4,7,2] },
  { forteName: '8-24', primeForm: [0,1,2,4,5,6,8,10], intervalVector: [4,6,4,7,4,3] },
  { forteName: '8-25', primeForm: [0,1,2,4,6,7,8,10], intervalVector: [4,6,4,6,4,4] },
  { forteName: '8-26', primeForm: [0,1,2,4,5,7,9,10], intervalVector: [4,5,6,5,6,2] },
  { forteName: '8-27', primeForm: [0,1,2,4,5,7,8,10], intervalVector: [4,5,6,5,5,3] },
  { forteName: '8-28', primeForm: [0,1,3,4,6,7,9,10], intervalVector: [4,4,8,4,4,4] },
  { forteName: '8-Z29', primeForm: [0,1,2,3,5,6,7,9], intervalVector: [5,5,5,5,5,3], zRelated: '8-Z15' },

  // ── Cardinality 9 (complements of 3-* sets) ──────────────────────────────
  { forteName: '9-1', primeForm: [0,1,2,3,4,5,6,7,8], intervalVector: [8,7,6,6,6,3] },
  { forteName: '9-2', primeForm: [0,1,2,3,4,5,6,7,9], intervalVector: [7,7,7,6,6,3] },
  { forteName: '9-3', primeForm: [0,1,2,3,4,5,6,8,9], intervalVector: [7,6,7,7,6,3] },
  { forteName: '9-4', primeForm: [0,1,2,3,4,5,7,8,9], intervalVector: [7,6,6,7,7,3] },
  { forteName: '9-5', primeForm: [0,1,2,3,4,6,7,8,9], intervalVector: [7,6,6,6,7,4] },
  { forteName: '9-6', primeForm: [0,1,2,3,4,5,6,8,10], intervalVector: [6,8,6,7,6,3] },
  { forteName: '9-7', primeForm: [0,1,2,3,4,5,7,8,10], intervalVector: [6,7,7,6,7,3] },
  { forteName: '9-8', primeForm: [0,1,2,3,4,6,7,8,10], intervalVector: [6,7,6,7,6,4] },
  { forteName: '9-9', primeForm: [0,1,2,3,5,6,7,8,10], intervalVector: [6,7,6,6,8,3] },
  { forteName: '9-10', primeForm: [0,1,2,3,4,6,7,9,10], intervalVector: [6,6,8,6,6,4] },
  { forteName: '9-11', primeForm: [0,1,2,3,5,6,7,9,10], intervalVector: [6,6,7,7,7,3] },
  { forteName: '9-12', primeForm: [0,1,2,4,5,6,8,9,10], intervalVector: [6,6,6,9,6,3] },

  // ── Cardinality 10, 11, 12 ───────────────────────────────────────────────
  { forteName: '10-1', primeForm: [0,1,2,3,4,5,6,7,8,9], intervalVector: [9,8,8,8,8,4] },
  { forteName: '10-2', primeForm: [0,1,2,3,4,5,6,7,8,10], intervalVector: [8,9,8,8,8,4] },
  { forteName: '10-3', primeForm: [0,1,2,3,4,5,6,7,9,10], intervalVector: [8,8,9,8,8,4] },
  { forteName: '10-4', primeForm: [0,1,2,3,4,5,6,8,9,10], intervalVector: [8,8,8,9,8,4] },
  { forteName: '10-5', primeForm: [0,1,2,3,4,5,7,8,9,10], intervalVector: [8,8,8,8,9,4] },
  { forteName: '10-6', primeForm: [0,1,2,3,4,6,7,8,9,10], intervalVector: [8,8,8,8,8,5] },
  { forteName: '11-1', primeForm: [0,1,2,3,4,5,6,7,8,9,10], intervalVector: [10,10,10,10,10,5] },
  { forteName: '12-1', primeForm: [0,1,2,3,4,5,6,7,8,9,10,11], intervalVector: [12,12,12,12,12,6] },
];

const PRIME_INDEX = new Map<string, CatalogRow>();
for (const row of CATALOG) PRIME_INDEX.set(row.primeForm.join(','), row);

/** Return the Forte catalog entry for a pc set (any rotation/transposition).
 *  Null if the set is empty or somehow missing from the catalog. */
export function forteEntry(pcs: number[]): ForteEntry | null {
  if (pcs.length === 0) return null;
  if (pcs.length === 12) return { forteName: '12-1', primeForm: CATALOG[CATALOG.length - 1].primeForm, intervalVector: CATALOG[CATALOG.length - 1].intervalVector, cardinality: 12 };
  const pf = primeForm(pcs);
  const row = PRIME_INDEX.get(pf.join(','));
  if (!row) return null;
  return {
    forteName: row.forteName,
    primeForm: row.primeForm,
    intervalVector: row.intervalVector,
    cardinality: row.primeForm.length,
    zRelated: row.zRelated,
  };
}

/** Just the Forte name string ('4-Z29', '6-30', …) or null. */
export function forteName(pcs: number[]): string | null {
  return forteEntry(pcs)?.forteName ?? null;
}
