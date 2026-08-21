// ─── lib/musicology/pitch.ts ─────────────────────────────────────────────────
// Pitch-string primitives. Moved out of lib/maestroCritiqueAnalyzer.ts so
// every analyzer module can share one canonical implementation.
//
// Pitch-string format throughout the analyzer:
//   "C4"  "F#5"  "Bb3"  "Bbb3" (double-flat)  "C##5" (double-sharp)
//   "rest" or "R" for rests
//
// MIDI numbers follow the standard convention: C4 = 60, C-1 = 0.

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** Enharmonic equivalents for pitch-class arithmetic. Does NOT preserve
 *  spelling — caller is responsible for keeping the original string when
 *  spelling matters (e.g., for accidental-consistency checks). */
const ENHARMONIC: Record<string, string> = {
  Db: 'C#', Eb: 'D#', Fb: 'E', Gb: 'F#', Ab: 'G#', Bb: 'A#', Cb: 'B',
};

function normAcc(n: string): string {
  return ENHARMONIC[n] ?? n;
}

/**
 * Convert a pitch string to MIDI. Returns null for rests ("R" / "rest") and
 * malformed input. Handles single and double accidentals.
 */
export function pitchToMidi(pitch: string): number | null {
  if (pitch === 'R' || pitch === 'rest') return null;
  // Match: optional letter A-G, optional accidental (#, ##, b, bb), octave (with optional minus).
  const m = pitch.match(/^([A-G])(##|#|bb|b)?(-?\d+)$/);
  if (!m) return null;
  const step = m[1];
  const acc = m[2] ?? '';
  const octave = parseInt(m[3], 10);

  // Step semitone offsets within an octave (C = 0)
  const STEP_SEMI: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  let semi = STEP_SEMI[step];
  if (acc === '#') semi += 1;
  else if (acc === '##') semi += 2;
  else if (acc === 'b') semi -= 1;
  else if (acc === 'bb') semi -= 2;

  return (octave + 1) * 12 + semi;
}

/** Pitch class (0..11) of a pitch string, or null for rests. */
export function pc(pitch: string): number | null {
  const m = pitchToMidi(pitch);
  return m !== null ? ((m % 12) + 12) % 12 : null;
}

/** Absolute interval in semitones between two pitches. Null if either is a rest. */
export function semiAbs(a: string, b: string): number | null {
  const ma = pitchToMidi(a), mb = pitchToMidi(b);
  return ma !== null && mb !== null ? Math.abs(mb - ma) : null;
}

/** Signed interval (b minus a). Null if either is a rest. */
export function signed(a: string, b: string): number | null {
  const ma = pitchToMidi(a), mb = pitchToMidi(b);
  return ma !== null && mb !== null ? mb - ma : null;
}

/** Re-exports of internal constants for callers that need them. */
export { NOTE_NAMES, ENHARMONIC, normAcc };

// ─── Extended pitch utilities ─────────────────────────────────────────────────

const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'] as const;

/** Index of a diatonic letter: C→0, D→1, E→2, F→3, G→4, A→5, B→6. */
export function letterIndex(letter: string): number {
  const i = LETTERS.indexOf(letter as typeof LETTERS[number]);
  return i >= 0 ? i : 0;
}

/** Letter from a diatonic index (mod 7): 0→"C", 7→"C", -1→"B". */
export function letterFromIndex(idx: number): string {
  return LETTERS[((idx % 7) + 7) % 7];
}

/** Convert a MIDI number to a pitch string. C4 = 60.
 *  @param preferFlats  If true, uses flat names for black keys (Db, Eb…).
 *                      Default false (sharps: C#, D#…).
 */
export function midiToPitch(midi: number, preferFlats = false): string {
  const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const FLAT_NAMES  = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
  const names = preferFlats ? FLAT_NAMES : SHARP_NAMES;
  const pc12  = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1;
  return `${names[pc12]}${octave}`;
}

// Semitone lookup for the 13 standard interval qualities within one octave.
const INTERVAL_NAMES: Record<number, string> = {
  0:  'P1',
  1:  'm2',
  2:  'M2',
  3:  'm3',
  4:  'M3',
  5:  'P4',
  6:  'A4',  // tritone — also d5; A4 is the conventional label
  7:  'P5',
  8:  'm6',
  9:  'M6',
  10: 'm7',
  11: 'M7',
  12: 'P8',
};

/**
 * Return an interval quality+number label for a semitone count.
 * Compound intervals (> 12 semitones) are reduced to their simple equivalent
 * with an "+" suffix indicating the octave displacement, e.g. 14 → "M2+8".
 * Returns "?" for negative inputs.
 */
export function intervalName(semitones: number): string {
  if (semitones < 0) return '?';
  if (semitones <= 12) return INTERVAL_NAMES[semitones] ?? '?';
  const octaves = Math.floor(semitones / 12);
  const simple  = semitones % 12;
  const base    = INTERVAL_NAMES[simple] ?? '?';
  return `${base}+${octaves * 8}`;
}

/**
 * Transpose a pitch string by `semitones` semitones.
 * @param preferFlats  Passed through to midiToPitch for black-key spelling.
 * Returns "rest" / "R" unchanged.
 */
export function transposePitch(pitch: string, semitones: number, preferFlats = false): string {
  if (pitch === 'R' || pitch === 'rest') return pitch;
  const midi = pitchToMidi(pitch);
  if (midi === null) return pitch;
  return midiToPitch(midi + semitones, preferFlats);
}

// ─── Spelling helpers ────────────────────────────────────────────────────────

/** Letter (C, D, E, F, G, A, B) of a pitch string. */
export function pitchLetter(pitch: string): string | null {
  if (pitch === 'R' || pitch === 'rest') return null;
  const m = pitch.match(/^([A-G])/);
  return m ? m[1] : null;
}

/** Accidental ("", "#", "##", "b", "bb") of a pitch string. */
export function pitchAccidental(pitch: string): string | null {
  if (pitch === 'R' || pitch === 'rest') return null;
  const m = pitch.match(/^[A-G](##|#|bb|b)?/);
  return m ? (m[1] ?? '') : null;
}

/** Octave of a pitch string. */
export function pitchOctave(pitch: string): number | null {
  if (pitch === 'R' || pitch === 'rest') return null;
  const m = pitch.match(/^[A-G](?:##|#|bb|b)?(-?\d+)$/);
  return m ? parseInt(m[1], 10) : null;
}

/** Pitch class of a letter+accidental name (no octave), e.g. "C#" → 1. */
export function namePc(name: string): number | null {
  const STEP_SEMI: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const m = name.match(/^([A-G])(##|#|bb|b)?$/);
  if (!m) return null;
  let semi = STEP_SEMI[m[1]];
  const acc = m[2] ?? '';
  if (acc === '#') semi += 1;
  else if (acc === '##') semi += 2;
  else if (acc === 'b') semi -= 1;
  else if (acc === 'bb') semi -= 2;
  return ((semi % 12) + 12) % 12;
}
