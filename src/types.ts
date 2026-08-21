// ─── lib/musicology/types.ts ─────────────────────────────────────────────────
// The single source of truth for the native musicology core.
//
// These types are the analyzer-facing shape that the modules in lib/musicology/
// produce and consume. They are deliberately decoupled from the MusicXML parser
// shapes in lib/musicxml/types.ts — the bridge between the two lives in
// lib/musicology/scoreModel.ts.
//
// The vocabulary here matches the tendency-tone curriculum prose in
// content/lessons/Step{14..40}.tsx. Cadence and mode names match the names
// the lessons teach. Roman-numeral output is curriculum-friendly:
//   "V/V", "vii°/vi", "♭III", "♭II⁶", "It+6", "Fr+6", "Ger+6", "CT°⁷"
// with `rnAscii` providing a grep-safe alternative.

import type { TendencyToneTag } from './tendencyTones.js';

// ─── Note + score events ─────────────────────────────────────────────────────

/**
 * A single sounding note as the analyzer sees it. Produced by `scoreModel.ts`
 * from the lower-level `ParsedNote` in lib/musicxml/types.ts.
 *
 * Beat positions are 1-based quarter-note beats within the measure, post-
 * `<backup>`/`<forward>` accumulation, so that piano scores with multiple
 * voices per part land correctly on shared metric grid points.
 */
export interface Note {
  pitch: string;          // "C4", "F#5", "Bb3"; "rest" for rests
  midi: number | null;    // MIDI number; null for rests
  duration: number;       // in quarter-note beats (whole = 4, eighth = 0.5)
  beat: number;           // 1-based quarter-beat onset within the measure
  measure: number;        // 1-based
  voice: number;          // 1-based; soprano = 1 in SATB
  staff?: number;         // 1 = upper, 2 = lower (piano scores)
  partId: string;         // MusicXML part id ("P1", "P2", …)
  partName: string;       // display name
  isRest: boolean;
  isChordMember?: boolean;
  tieDirection?: 'start' | 'stop' | 'both';
  fermata?: boolean;      // a fermata sits over this note
  tuplet?: { actual: number; normal: number };
  dynamic?: string;
  articulation?: string;
}

/** A single event time inside a part. The analyzer does not normally
 *  need this directly — Onset (below) is what chordify produces. */
export interface ScoreEvent {
  measure: number;
  beat: number;
  notes: Note[];      // notes that start at this exact onset (chord members share a ScoreEvent)
}

/** Section-level metadata that can change over the course of a piece. */
export interface KeyEvent {
  measure: number;
  beat: number;
  key: string;        // "C major", "Bb major", "A minor"
  fifths: number;     // -7 to 7
  mode: 'major' | 'minor' | string;  // string for modal pieces
}

export interface TimeEvent {
  measure: number;
  beat: number;
  beats: number;        // numerator
  beatType: number;     // denominator
}

/** A part within the score (instrument or voice). */
export interface PartInfo {
  id: string;
  name: string;
  staffCount?: number;
  isTransposing?: boolean;
}

/** The unified analyzer input. Built once from a ParseResult by scoreModel.ts.
 *  Every analyzer module takes this as its primary argument. */
export interface Score {
  parts: PartInfo[];
  notes: Note[];                  // flat, sorted by (measure, beat, voice)
  keySignatures: KeyEvent[];      // initial signature plus any mid-piece changes
  timeSignatures: TimeEvent[];
  measureCount: number;
  divisions: number;              // MusicXML divisions per quarter note
  title?: string;
  composer?: string;
}

// ─── Chordify output ─────────────────────────────────────────────────────────

/**
 * A single vertical sonority — all pitches sounding at one onset, including
 * tones held over from a previous onset. Chordify produces a stream of these.
 */
export interface Onset {
  measure: number;
  beat: number;
  pitches: string[];              // sounding spelled pitches (no duplicates)
  pcs: number[];                  // pitch classes (0..11), de-duplicated
  bassPitch: string | null;       // lowest sounding pitch
  bassPc: number | null;
  /** Tones the chordifier flagged as likely non-chord tones. Kept for the
   *  consumer's use — they are NOT removed from `pitches`. */
  suspectNcts: string[];
  durationToNext: number;         // quarter-note beats until the next onset
}

/** A chord identified by chordify after NCT filtering. Has its `pitches` minus
 *  any tones the heuristic ruled out. */
export interface Chord {
  measure: number;
  beat: number;
  pitches: string[];
  pcs: number[];
  bassPitch: string | null;
  bassPc: number | null;
  durationToNext: number;
  /** The Onset this chord was derived from (1:1). Useful for diagnostics. */
  onset: Onset;
}

export interface ChordStream {
  onsets: Onset[];
  chords: Chord[];
}

// ─── Roman-numeral analysis ──────────────────────────────────────────────────

/**
 * One reading of a chord. A clearly-functional diatonic chord has a single
 * reading at confidence 1.0; the Tristan chord (Step 30) returns multiple
 * readings because the curriculum prose treats the ambiguity as the point.
 */
export interface RomanNumeralReading {
  /** Curriculum-friendly Unicode form: "V/V", "vii°⁷/V", "♭II⁶", "It+6",
   *  "Fr+6", "Ger+6", "CT°⁷". Always matches the prose in
   *  content/lessons/Step{14..40}.tsx. */
  rn: string;
  /** ASCII form for grep / log lines: "V/V", "viio7/V", "bII6", "It+6",
   *  "Fr+6", "Ger+6", "CTo7". */
  rnAscii: string;
  /** root | 1st | 2nd | 3rd inversion. */
  inversion: 'root' | '1st' | '2nd' | '3rd';
  /** Local tonal center for this reading. */
  localKey: string;
  /** 0..1 — 1.0 means the analyzer is sure. */
  confidence: number;
  /** Human-readable reason in one short sentence: "PC set matches Ger+6
   *  with bass on ♭6̂". */
  basis: string;
}

/**
 * Three perspectives the curriculum disambiguates with: a held tone that is
 * the chordal seventh vertically, a passing tone horizontally, and 4̂ tonally
 * gets all three labels. Only populated when more than one perspective gives
 * a meaningfully different reading.
 *
 * See CLAUDE.md "Harmony Curriculum: Tendency-Tone Approach" → "Three
 * perspectives — disambiguation language, not curriculum axis".
 */
export interface Perspectives {
  tonal?: string;       // "leading-tone (7̂→1̂ in C major)"
  vertical?: string;    // "chordal seventh of V⁷"
  horizontal?: string;  // "passing tone between 5 and 3"
}

export interface ChordAnalysis {
  measure: number;
  beat: number;
  pitches: string[];
  pcSet: number[];                    // normal-form pc set
  /** Top reading. Equivalent to `readings[0].rn`. */
  primary: string;
  /** Top reading's basis (mirrors `readings[0].basis`). */
  primaryBasis: string;
  /** Chord root as a pitch class (0..11), as identified by the analyzer's
   *  pc-set matching. For secondary-dominant readings like "V⁷/V", this is
   *  the *local* chord root (the chord itself), not the tonicized degree. */
  rootPc: number;
  readings: RomanNumeralReading[];
  tendencyTones: TendencyToneTag[];   // drawn from voiceLeadingTendencyTones.ts
  perspectives: Perspectives;
}

// ─── Cadence + phrase + mode ─────────────────────────────────────────────────

/**
 * Cadence types the curriculum prose teaches. Names match the lessons exactly
 * (Step 14.4 introduces PAC/HC/IAC/Plagal/Phrygian; Step 14.5 introduces DC).
 */
export type CadenceType =
  | 'PAC'        // perfect authentic
  | 'IAC'        // imperfect authentic
  | 'HC'         // half cadence
  | 'DC'         // deceptive
  | 'Plagal'     // IV → I
  | 'Phrygian'   // iv⁶ → V in minor
  | 'unclear';

export interface Cadence {
  type: CadenceType;
  measure: number;          // measure where the final chord lands
  beat: number;
  /** Soprano scale degree at the final chord (1..7). Used to discriminate
   *  PAC (=1) from IAC. */
  sopranoFinalDegree: number | null;
  /** Last two RN readings as plain strings. */
  penultimate: string;
  final: string;
  /** Short human-readable reason for the classification. */
  basis: string;
}

export interface PhraseRange {
  index: number;             // 1-based phrase index
  measureStart: number;
  measureEnd: number;
  /** Phrase-end fermata locations, if any. Some phrases end on barlines or
   *  at the last measure without a fermata; the array can be empty. */
  fermataMeasures: number[];
}

/** The seven church modes plus Ionian/Aeolian (the modal homonyms of major /
 *  natural-minor). Used by the modal analyzer in Stage VIII. */
export type ModeName =
  | 'Ionian'
  | 'Dorian'
  | 'Phrygian'
  | 'Lydian'
  | 'Mixolydian'
  | 'Aeolian'
  | 'Locrian';

export interface ModalAnalysis {
  mode: ModeName;
  finalPitch: string;
  ambitus: { lowest: string; highest: string };
  basis: string;
}

// ─── PC set theory (Stages IX–X) ─────────────────────────────────────────────

/**
 * One row in the 224-entry Forte catalog. Prime form is canonical.
 * Z-related pairs share an interval vector; the prime form distinguishes them.
 */
export interface ForteEntry {
  forteName: string;            // "3-1", "4-Z29", "6-30"
  primeForm: number[];          // ascending pcs from 0
  intervalVector: number[];     // 6-element vector: [ic1, ic2, ic3, ic4, ic5, ic6]
  cardinality: number;          // 0..12
  zRelated?: string;            // partner's forte name, if any
}

// ─── The unified analysis result ─────────────────────────────────────────────

/**
 * What `analyzeScore()` returns — the top-level entry point in
 * lib/musicology/index.ts. Consumers (the critique route, check-l2-analysis,
 * Maestro context builders) read whichever fields they need.
 */
/**
 * A sustained run of measures that lives in a key other than the global key
 * — the structural modulation level between "whole-piece key" and
 * "per-phrase key". Detected by a wide-window Krumhansl scan that requires
 * a minimum span AND a confidence advantage over the global key. Examples:
 * Group 2 of a sonata exposition (often the relative major or dominant for
 * 40+ bars), a development episode, a recapitulation of Group 2 in the
 * tonic-major variant. NOT used for brief tonicizations — those are caught
 * by phrase-mode.
 */
export interface KeySection {
  /** First measure of the section (inclusive). */
  measureStart: number;
  /** Last measure of the section (inclusive). */
  measureEnd: number;
  /** The key the section lives in — e.g. "Eb major", "G minor". */
  key: string;
  /** Krumhansl confidence at the section's centerline. 0..1. */
  confidence: number;
  /** One-sentence reason this section was identified. */
  basis: string;
  /** Identifier of another section this one is a recap-variant of —
   *  set when the analyzer detects that this section is the same
   *  thematic material as an earlier section, transposed. Format:
   *  "section-N" where N is the 0-based index of the earlier section. */
  recapOf?: string;
  /** Transposition interval (semitones) from `recapOf` section to this
   *  one. Beethoven 5's m305-375 (C major) is the recap of m61-127
   *  (E♭ major) transposed down a major third = -4 semitones. */
  recapTransposition?: number;
  /** Measure where the modulation INTO this section was bridged by a
   *  pivot chord — a chord that is diatonic in both the previous key
   *  area and this section's key. The pivot is typically a few measures
   *  BEFORE measureStart. Null when the modulation is by direct shift,
   *  enharmonic respelling, or when the analyzer can't identify a clean
   *  pivot. */
  pivotMeasure?: number;
  /** Functional reading of the pivot chord in the section's key —
   *  e.g. "ii in Eb major" (= vi in C minor as preceding home).
   *  Useful pedagogically: it's the chord that BECOMES new-key meaning. */
  pivotChordInNewKey?: string;
  /** Same chord's reading in the PREVIOUS key area. */
  pivotChordInOldKey?: string;
}

export interface ScoreAnalysis {
  score: Score;
  chordStream: ChordStream;
  /** Whole-piece Krumhansl winner. */
  overallKey: KeyEvent;
  overallKeyConfidence: number;
  /** Sustained non-home key regions. Empty for pieces that never sustain a
   *  modulation (most Bach chorales fall here — brief tonicizations are
   *  handled at the phrase level instead). Populated by the wide-window
   *  detector in keyDetection.ts. */
  keySections: KeySection[];
  /** Per-measure local-key estimates from the windowed analysis. */
  localKeys: Array<{ measure: number; key: string; confidence: number }>;
  phrases: PhraseRange[];
  /** One per chord in `chordStream.chords`. */
  chordAnalyses: ChordAnalysis[];
  /** One per phrase end. */
  cadences: Cadence[];
  /** Optional — populated only when the modal analyzer is run. */
  modes?: Array<{ phraseIndex: number; analysis: ModalAnalysis }>;
}
