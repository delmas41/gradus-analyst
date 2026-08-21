import { readFileSync } from 'node:fs';
import { parseMxlBuffer, analyzeScore } from './dist/index.js';
const score = await parseMxlBuffer(readFileSync(process.argv[2]));
const a = analyzeScore(score);
console.log(JSON.stringify({
  key: a.overallKey, mode: a.overallKeyMode,
  conf: Number((a.overallKeyConfidence ?? 0).toFixed(6)),
  chords: a.chordAnalyses?.length ?? 0,
  phrases: a.phrases?.length ?? 0,
  cadences: (a.cadences ?? []).map(c => `${c.measure}:${c.type}`).slice(0, 25),
  rn: (a.chordAnalyses ?? []).slice(0, 24).map(c => c.primary),
}));
