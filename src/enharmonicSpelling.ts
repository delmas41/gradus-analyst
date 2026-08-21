// ─── lib/maestroAnalyst/enharmonicSpelling.ts ────────────────────────────────
// Smart enharmonic spelling utilities. Chooses the spelling that best fits a
// key context — i.e., the one whose pitch class is diatonic to the key, or
// the one consistent with the key's accidental preference (sharps vs flats).

import { pitchToMidi, pitchLetter, pitchAccidental, pitchOctave, pc } from './pitch.js';
import { getScalePcs } from './scale.js';

// ─── Enharmonic alternates ────────────────────────────────────────────────────
// Only lists pairs that are genuinely useful in tonal music.
// Naturals (G, D, A…) are intentionally absent — their double-accidental
// equivalents (F##, C##…) are essentially never used.

const ENHARMONIC_PAIRS: Record<string, string> = {
  // sharps ↔ flats (common pairs)
  'C#': 'Db', 'Db': 'C#',
  'D#': 'Eb', 'Eb': 'D#',
  'F#': 'Gb', 'Gb': 'F#',
  'G#': 'Ab', 'Ab': 'G#',
  'A#': 'Bb', 'Bb': 'A#',
  // edge naturals ↔ accidentals
  'E':  'Fb', 'Fb': 'E',
  'B':  'Cb', 'Cb': 'B',
  'E#': 'F',  'F':  'E#',
  'B#': 'C',  'C':  'B#',
};

// ─── Key accidental preference ────────────────────────────────────────────────

const SHARP_KEYS = new Set(['G','D','A','E','B','F#','C#']);
const FLAT_KEYS  = new Set(['F','Bb','Eb','Ab','Db','Gb','Cb']);

/**
 * Return the enharmonic alternate for a note-name (no octave), e.g.:
 *   "F#" → "Gb"    "Gb" → "F#"    "Cb" → "B"    "E#" → "F"
 * Returns null if no practically-useful alternate exists (e.g. "G", "D", "A").
 */
export function enharmonicAlternateName(name: string): string | null {
  return ENHARMONIC_PAIRS[name] ?? null;
}

/**
 * Return the enharmonic alternate for a full pitch string (with octave).
 * Octave is adjusted for octave-crossing cases: Cb4 → B3, B#4 → C5.
 * Returns null if no useful alternate exists.
 */
export function enharmonicAlternate(pitch: string): string | null {
  if (pitch === 'R' || pitch === 'rest') return null;
  const letter = pitchLetter(pitch);
  const acc    = pitchAccidental(pitch);
  const octave = pitchOctave(pitch);
  if (letter === null || acc === null || octave === null) return pitch;

  const name = letter + acc;
  const altName = ENHARMONIC_PAIRS[name];
  if (!altName) return null;

  const altLetter = altName.match(/^([A-G])/)?.[1];
  if (!altLetter) return null;

  let altOctave = octave;
  if (letter === 'C' && (acc === 'b' || acc === 'bb') && altLetter === 'B') altOctave -= 1;
  if (letter === 'B' && (acc === '#' || acc === '##') && altLetter === 'C') altOctave += 1;
  // E#4 → F4 and B#4 → C5: the altLetter check above covers B#→C.
  // F4 → E#4 (same octave unless F is at a C-crossing, which it isn't).

  return `${altName}${altOctave}`;
}

// ─── Spelling candidates per pitch class ──────────────────────────────────────
// [flatSpelling, sharpSpelling]:
//   flatSpelling  — preferred in flat keys (or neutral for naturals)
//   sharpSpelling — preferred in sharp keys
// When both slots are the same the note is a natural with no common alternate.

const CANDIDATES: Record<number, [string, string]> = {
  0:  ['C',  'C'],    // C natural — B# is essentially never used
  1:  ['Db', 'C#'],
  2:  ['D',  'D'],    // natural
  3:  ['Eb', 'D#'],
  4:  ['E',  'E'],    // natural — Fb only in Cb major (handled via diatonic check)
  5:  ['F',  'F'],    // natural — E# only in B#/very rare contexts
  6:  ['Gb', 'F#'],
  7:  ['G',  'G'],    // natural
  8:  ['Ab', 'G#'],
  9:  ['A',  'A'],    // natural
  10: ['Bb', 'A#'],
  11: ['Cb', 'B'],    // Cb in flat keys (Cb major), B everywhere else
};

/**
 * For a pitch class (0..11) and a key string, return the preferred note-name
 * (no octave), e.g.:
 *   preferredSpelling(6, "F major")  → "Gb"
 *   preferredSpelling(6, "G major")  → "F#"
 *   preferredSpelling(0, "C major")  → "C"
 *
 * Algorithm:
 *   1. If one spelling is diatonic and the other is not, return the diatonic one.
 *   2. If one spelling is a natural (no accidental) and the other has one, prefer natural.
 *   3. Use the key's accidental preference (sharp keys → sharpSpelling, flat keys → flatSpelling).
 *   4. Default: sharpSpelling.
 */
export function preferredSpelling(pitchClass: number, keyContext: string): string {
  const scalePcs = getScalePcs(keyContext);
  const [flat, sharp] = CANDIDATES[pitchClass] ?? ['C', 'C'];

  if (flat === sharp) return flat; // natural note — no choice needed

  const isDia = (name: string): boolean => {
    const m = pitchToMidi(`${name}4`);
    if (m === null) return false;
    return scalePcs.has(((m % 12) + 12) % 12);
  };

  const flatDia  = isDia(flat);
  const sharpDia = isDia(sharp);

  if (flatDia && !sharpDia) return flat;
  if (sharpDia && !flatDia) return sharp;

  // Both or neither diatonic — tiebreak by key accidental preference.
  const root = keyContext.trim().match(/^([A-G](?:##|#|bb|b)?)/)?.[1] ?? 'C';
  if (SHARP_KEYS.has(root)) return sharp;
  if (FLAT_KEYS.has(root))  return flat;
  return sharp; // default: sharps for C major / unrecognised keys
}

/**
 * Re-spell a full pitch string for the given key context.
 * Returns the input pitch unchanged if it is already the preferred spelling,
 * or if the pitch is a rest or unrecognised.
 *
 * Examples:
 *   reSpellNote("F#4", "F major") → "Gb4"
 *   reSpellNote("Gb4", "G major") → "F#4"
 *   reSpellNote("Cb4", "B major") → "B3"
 *   reSpellNote("C4",  "C major") → "C4"  (unchanged)
 */
export function reSpellNote(pitch: string, keyContext: string): string {
  if (pitch === 'R' || pitch === 'rest') return pitch;
  const letter = pitchLetter(pitch);
  const acc    = pitchAccidental(pitch);
  const octave = pitchOctave(pitch);
  if (letter === null || acc === null || octave === null) return pitch;

  const midiVal = pitchToMidi(pitch);
  if (midiVal === null) return pitch;
  const pitchClass = ((midiVal % 12) + 12) % 12;

  const preferred = preferredSpelling(pitchClass, keyContext);
  const currentName = letter + acc;
  if (preferred === currentName) return pitch;

  const prefLetter = preferred.match(/^([A-G])/)?.[1];
  if (!prefLetter) return pitch;

  let newOctave = octave;
  // Octave-crossing adjustments
  if (letter === 'C' && (acc === 'b' || acc === 'bb') && prefLetter === 'B') newOctave -= 1;
  if (letter === 'B' && (acc === '#' || acc === '##') && prefLetter === 'C') newOctave += 1;
  if (currentName === 'C' && preferred === 'B#') newOctave -= 1;
  if (currentName === 'B' && preferred === 'Cb') newOctave += 1;

  return `${preferred}${newOctave}`;
}
