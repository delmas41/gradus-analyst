// ── MusicXML Parser Types ───────────────────────────────────────────────────

/** A single note extracted from MusicXML */
export interface ParsedNote {
  pitch: string;        // e.g. "C4", "Bb3", "rest"
  duration: number;     // in divisions (MusicXML native unit)
  beats: number;        // duration in beats (computed from divisions)
  type: string;         // "quarter", "half", "whole", "eighth", etc.
  voice: number;
  staff?: number;
  isRest: boolean;
  isTied?: boolean;
  isChordMember?: boolean;
  dynamic?: string;     // "pp", "mf", "ff", etc.
  articulation?: string;
  // ─── Added 2026-05-07 for the native musicology core ──────────────────────
  /** 1-based quarter-note beat position within this measure. Accumulated from
   *  preceding note durations within the part. Does NOT account for
   *  `<backup>` / `<forward>` — single-voice-per-part scores (SATB chorales)
   *  are accurate; piano scores with multiple voices per part may be off. */
  beatPosition?: number;
  /** True if the note has a `<fermata/>` in `<notations>`. Required for
   *  phrase segmentation (Bach chorale phrases end on fermatas). */
  fermata?: boolean;
  /** Refined direction. `<tie type="start"/>` and `<tie type="stop"/>` may
   *  both appear on a single note; that becomes 'both'. */
  tieDirection?: 'start' | 'stop' | 'both';
  /** Tuplet info from `<time-modification>`: e.g. triplets are
   *  { actual: 3, normal: 2 }. */
  tuplet?: { actual: number; normal: number };
}

/** A single measure extracted from MusicXML, per part */
export interface ParsedPartMeasure {
  partId: string;
  partName: string;
  notes: ParsedNote[];
  clef?: string;
  keySignature?: string;   // e.g. "C major", "G minor"
  keySig?: number;         // fifths value (-7 to 7)
  keyMode?: string;        // "major" or "minor"
  timeSignature?: string;  // e.g. "4/4", "3/4"
  tempo?: number;          // BPM if present
  tempoText?: string;      // e.g. "Allegro con brio"
  dynamics?: string[];     // dynamics markings in this measure
  directions?: string[];   // text directions, rehearsal marks, etc.
}

/** A full measure across all parts */
export interface ParsedMeasure {
  number: number;
  parts: ParsedPartMeasure[];
  /** Condensed text summary for Claude context window */
  claudeContext: string;
}

/** Metadata extracted from the MusicXML header */
export interface ScoreMetadata {
  title?: string;
  composer?: string;
  partNames: string[];
  partIds: string[];
  divisions: number;       // divisions per quarter note
  totalMeasures: number;
  keySignature?: string;
  timeSignature?: string;
}

/** Full parse result */
export interface ParseResult {
  metadata: ScoreMetadata;
  measures: ParsedMeasure[];
}

// The Gradus application types that followed here — Firestore documents and
// upload/analyze request shapes — are deliberately not part of this package.
// They describe how one app stores scores, not how MusicXML is parsed.
