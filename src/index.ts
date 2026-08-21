// ─── lib/maestroAnalyst/index.ts ─────────────────────────────────────────────
// Barrel entry point for the native musicology core.
//
//   const result = analyzeScore(score);
//
// `analyzeScore` (and `inferSubmissionHints`) live in ./analyze — this file is
// re-exports only. Client components that don't parse MusicXML files should
// import from the CONCRETE modules ('./analyze', './scoreModel') rather than
// this barrel: the barrel re-exports ./xmlParser, whose static jszip import
// (~94KB) would otherwise ride into any bundle that touches it.

export { analyzeScore, inferSubmissionHints } from './analyze.js';
export type { AnalyzeScoreOptions, SubmissionHints } from './analyze.js';

// Re-exports for convenience — consumers can import from index instead of
// reaching into individual module files.
export { chordify } from './chordify.js';
export { analyzeKey, analyzeKeyAt, analyzeKeyTrajectory, analyzeKeyRegionTrajectory, analyzeNotesKey, correlateKey, classifyKeyChange, detectModulations, detectKeySections, annotateRecapVariants, annotatePivotChords } from './keyDetection.js';
export { findPhraseBoundaries } from './phraseSegmentation.js';
export { analyzeChord, identifyChord } from './romanNumeral.js';
export type { ChordIdentity } from './romanNumeral.js';
export { detectPedalRuns, pedalPcByChordIndex, pedalDegreeLabel, applyPedalReading } from './pedalPoint.js';
export type { PedalRun } from './pedalPoint.js';
export { classifyCadence, classifyCadences } from './cadence.js';
export { scoreFromParseResult, compositionDataToScore, noteEntriesToScore } from './scoreModel.js';
export type * from './types.js';

// ── V2: Range validation ──────────────────────────────────────────────────────
export { validateRanges, getInstrumentRange } from './rangeValidation.js';
export type { RangeWarning, InstrumentRange } from './rangeValidation.js';

// ── V2: Enharmonic spelling ───────────────────────────────────────────────────
export { reSpellNote, enharmonicAlternate, enharmonicAlternateName, preferredSpelling } from './enharmonicSpelling.js';

// ── V2: XML / MXL parsing ─────────────────────────────────────────────────────
export { parseXmlString, parseMxlBuffer, parseXmlToRaw, parseMxlToRaw } from './xmlParser.js';

// ── V2: Extended pitch utilities ──────────────────────────────────────────────
export { midiToPitch, intervalName, transposePitch, letterIndex, letterFromIndex } from './pitch.js';
