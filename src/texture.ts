// ─── lib/maestroAnalyst/texture.ts ───────────────────────────────────────────
// Per-measure texture classification from PER-ONSET verticality.
//
// Motivation (the 2026-08 harmony-review adjudication): a bar of bare D–A
// octaves accumulates 2+ distinct pitch classes over its span, so bar-level
// pc counting reads it as "has harmony" — and the Roman-numeral layer then
// happily labels a unison line with whatever triad contains it. Eight claims
// of a modulation itinerary sat on nine bars of open fifths in Beethoven 9/i
// because nothing in the pipeline knew the bars had no verticality at all.
//
// The fix is to measure simultaneity, not accumulation: at each onset, how
// many distinct pitch classes are actually SOUNDING together? A melody is a
// sequence of 1-pc onsets no matter how many pcs it visits. The measure's
// texture is classified from the maximum simultaneous pc count across its
// onsets, weighted so that one incidental dyad inside an octave passage does
// not promote the bar to "chordal".
//
// Consumers: the Roman-numeral reading should be treated as advisory when
// texture is not 'chordal' — the review conventions render these bars as
// "<RN> (unison)" / "<RN> (bare 5th)" / NC, never as full chord claims.

import type { Note, Score } from './types.js';

const pcOfMidi = (midi: number): number => ((midi % 12) + 12) % 12;

export type MeasureTexture =
  | 'silence'      // no sounding notes
  | 'unison'       // never more than one pc at once, single register
  | 'octaves'      // never more than one pc at once, doubled across octaves
  | 'bare-fifth'   // two pcs a perfect fifth/fourth apart dominate
  | 'bare-third'   // two pcs a third apart dominate
  | 'dyad'         // two simultaneous pcs, other interval
  | 'chordal';     // three or more simultaneous pcs

export interface TextureReading {
  measure: number;
  texture: MeasureTexture;
  /** Highest count of distinct pcs sounding at any onset in the measure. */
  maxSimultaneousPcs: number;
  /** Distinct pcs accumulated across the whole measure (the old, misleading
   *  number — kept so consumers can see the gap between the two). */
  distinctPcsInBar: number;
}

interface Sounding {
  startAbs: number; // measure*1000 + beat, a simple total order within a piece
  endAbs: number;
  pc: number;
  midi: number;
}

/** Distinct-pc count sounding at instant t (start-inclusive, end-exclusive). */
function pcsAt(sounds: Sounding[], t: number): Set<number> {
  const out = new Set<number>();
  for (const s of sounds) if (s.startAbs <= t && t < s.endAbs) out.add(s.pc);
  return out;
}

export function classifyMeasureTextures(score: Score): TextureReading[] {
  const byMeasure = new Map<number, Note[]>();
  let lastMeasure = score.measureCount || 0;
  let firstMeasure = 1;
  for (const n of score.notes) {
    if (n.isRest || n.midi === null) continue;
    if (!byMeasure.has(n.measure)) byMeasure.set(n.measure, []);
    byMeasure.get(n.measure)!.push(n);
    if (n.measure > lastMeasure) lastMeasure = n.measure;
    if (n.measure < firstMeasure) firstMeasure = n.measure; // pickup m.0
  }

  const readings: TextureReading[] = [];
  for (let m = firstMeasure; m <= lastMeasure; m++) {
    const notes = byMeasure.get(m) ?? [];
    if (notes.length === 0) {
      readings.push({ measure: m, texture: 'silence', maxSimultaneousPcs: 0, distinctPcsInBar: 0 });
      continue;
    }
    const sounds: Sounding[] = notes.map((n) => ({
      startAbs: n.measure * 1000 + n.beat,
      endAbs: n.measure * 1000 + n.beat + Math.max(n.duration, 0.001),
      pc: pcOfMidi(n.midi!),
      midi: n.midi!,
    }));
    const onsets = [...new Set(sounds.map((s) => s.startAbs))].sort((a, b) => a - b);

    // Time-weighted census of simultaneous-pc counts: each onset's count is
    // weighted by the span until the next onset, so a single passing dyad
    // cannot outvote a bar of octaves.
    let maxSim = 0;
    const weightBySim = new Map<number, number>();
    const pairWeights = new Map<string, number>(); // interval-class weights for 2-pc spans
    for (let i = 0; i < onsets.length; i++) {
      const t = onsets[i];
      const span = (i + 1 < onsets.length ? onsets[i + 1] : Math.max(...sounds.map((s) => s.endAbs))) - t;
      const sounding = pcsAt(sounds, t);
      const k = sounding.size;
      if (k > maxSim) maxSim = k;
      weightBySim.set(k, (weightBySim.get(k) ?? 0) + span);
      if (k === 2) {
        const [a, b] = [...sounding];
        const ic = Math.min((a - b + 12) % 12, (b - a + 12) % 12);
        pairWeights.set(String(ic), (pairWeights.get(String(ic)) ?? 0) + span);
      }
    }
    const distinctPcsInBar = new Set(sounds.map((s) => s.pc)).size;
    const total = [...weightBySim.values()].reduce((a, b) => a + b, 0) || 1;
    const w3plus = [...weightBySim.entries()].filter(([k]) => k >= 3).reduce((a, [, w]) => a + w, 0);
    const w2 = weightBySim.get(2) ?? 0;

    let texture: MeasureTexture;
    if (w3plus / total >= 0.25) {
      // Real verticality for at least a quarter of the bar → chordal.
      texture = 'chordal';
    } else if (w2 / total >= 0.5) {
      // Two-pc spans dominate: classify the dyad by its heaviest interval class.
      const top = [...pairWeights.entries()].sort((a, b) => b[1] - a[1])[0];
      const ic = top ? Number(top[0]) : -1;
      texture = ic === 5 ? 'bare-fifth' : ic === 3 || ic === 4 ? 'bare-third' : 'dyad';
    } else {
      // Line territory: at most one pc at a time (or nearly so). 'octaves'
      // means the SAME pc doubled SIMULTANEOUSLY an octave or more apart —
      // a melody that merely crosses a register boundary, or revisits a pc
      // in another octave later in the bar, is a unison line.
      const simOctaves = sounds.some((a) =>
        sounds.some((b) => a !== b && a.pc === b.pc && Math.abs(a.midi - b.midi) >= 12
          && a.startAbs < b.endAbs - 1e-6 && b.startAbs < a.endAbs - 1e-6));
      texture = simOctaves ? 'octaves' : 'unison';
    }
    readings.push({ measure: m, texture, maxSimultaneousPcs: maxSim, distinctPcsInBar });
  }
  return readings;
}
