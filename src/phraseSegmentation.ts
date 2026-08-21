// ─── lib/musicology/phraseSegmentation.ts ────────────────────────────────────
// Phrase boundaries via fermata. Ported from
// scripts/music21/extract-bach-chorales.py:find_phrase_boundaries (lines 75–110).
//
// Bach chorales mark phrase ends with fermatas in the soprano. After Phase 0,
// the parser captures fermatas, so this module just walks the soprano voice
// (voice = 1) and collects the unique fermata measures.
//
// Fallback: when no fermatas are present (e.g., orchestral movements without
// fermata-marked phrases), the whole piece is treated as a single phrase. The
// caller can then run a different segmentation (e.g., key-based or
// cadence-based) over the long phrase.

import type { Score, PhraseRange } from './types.js';

/**
 * Identify phrase boundaries in `score` using fermatas in the soprano voice.
 *
 * Returns 1-based phrase ranges. The first phrase starts at the score's first
 * non-pickup measure; each subsequent phrase begins at the measure immediately
 * after the previous fermata. The final phrase always extends to the end of
 * the score (last fermata's measure or `score.measureCount`).
 */
export function findPhraseBoundaries(score: Score): PhraseRange[] {
  // Soprano = the highest staff, conventionally voice 1 in our adapter.
  const sopranoFermataMeasures: number[] = [];
  const seen = new Set<number>();
  for (const note of score.notes) {
    if (note.voice !== 1) continue;
    if (!note.fermata) continue;
    if (seen.has(note.measure)) continue;
    seen.add(note.measure);
    sopranoFermataMeasures.push(note.measure);
  }
  sopranoFermataMeasures.sort((a, b) => a - b);

  // No fermatas → whole piece is one phrase.
  if (sopranoFermataMeasures.length === 0) {
    return [
      {
        index: 1,
        measureStart: minMeasure(score),
        measureEnd: maxMeasure(score),
        fermataMeasures: [],
      },
    ];
  }

  const phrases: PhraseRange[] = [];
  let start = minMeasure(score);
  let phraseIdx = 1;
  for (const fm of sopranoFermataMeasures) {
    if (fm < start) continue;
    phrases.push({
      index: phraseIdx++,
      measureStart: start,
      measureEnd: fm,
      fermataMeasures: [fm],
    });
    start = fm + 1;
  }

  // If the soprano keeps singing past the last fermata, append a tail phrase.
  const last = maxMeasure(score);
  if (start <= last) {
    phrases.push({
      index: phraseIdx,
      measureStart: start,
      measureEnd: last,
      fermataMeasures: [],
    });
  }

  return phrases;
}

function minMeasure(score: Score): number {
  let m = Infinity;
  for (const n of score.notes) if (n.measure < m) m = n.measure;
  return m === Infinity ? 1 : m;
}

function maxMeasure(score: Score): number {
  let m = 0;
  for (const n of score.notes) if (n.measure > m) m = n.measure;
  return m || score.measureCount || 1;
}
