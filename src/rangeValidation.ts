// ─── lib/maestroAnalyst/rangeValidation.ts ───────────────────────────────────
// Instrument range validation. Checks each note in a Score against its part's
// instrument range and returns warnings for out-of-range pitches.
//
// Ranges are practical (comfortable) concert-pitch MIDI ranges, not absolute
// extremes. Severity:
//   'error'  — note is > 1 semitone outside the practical range
//   'warn'   — note is at the very boundary (within 1 semitone of the limit)

import type { Score } from './types.js';
import { pitchToMidi } from './pitch.js';

export interface InstrumentRange {
  name: string;
  min: number;   // lowest practical MIDI note (concert pitch)
  max: number;   // highest practical MIDI note (concert pitch)
}

export interface RangeWarning {
  measure: number;
  beat: number;
  pitch: string;
  midi: number;
  partId: string;
  instrumentName: string;
  min: number;
  max: number;
  severity: 'warn' | 'error';
}

// Practical ranges in concert pitch. Keys are lowercase partial-match tokens.
// If a part name contains any token, that range applies. First match wins.
const INSTRUMENT_RANGES: Array<InstrumentRange & { tokens: string[] }> = [
  // ── Strings ──────────────────────────────────────────────────────────────
  { name: 'Violin',       tokens: ['violin'],        min: 55,  max: 103 }, // G3–B7
  { name: 'Viola',        tokens: ['viola'],          min: 48,  max: 91  }, // C3–G6
  { name: 'Cello',        tokens: ['cello', 'violoncello'], min: 36, max: 76 }, // C2–E5
  { name: 'Double Bass',  tokens: ['bass', 'contrabass', 'double bass'], min: 28, max: 60 }, // E1–C4 (sounds 8vb)
  { name: 'Harp',         tokens: ['harp'],           min: 24,  max: 103 }, // C1–B7
  // ── Woodwinds ─────────────────────────────────────────────────────────────
  { name: 'Flute',        tokens: ['flute'],          min: 60,  max: 98  }, // C4–D7
  { name: 'Piccolo',      tokens: ['piccolo'],        min: 74,  max: 108 }, // D5–C8 (sounds 8va)
  { name: 'Oboe',         tokens: ['oboe'],           min: 58,  max: 91  }, // Bb3–G6
  { name: 'English Horn', tokens: ['english horn', 'cor anglais'], min: 52, max: 81 }, // E3–A5
  { name: 'Clarinet',     tokens: ['clarinet'],       min: 50,  max: 94  }, // D3–Bb6 (concert)
  { name: 'Bass Clarinet',tokens: ['bass clarinet'],  min: 38,  max: 77  }, // Bb1–F5 (concert)
  { name: 'Bassoon',      tokens: ['bassoon'],        min: 34,  max: 75  }, // Bb1–Eb5
  { name: 'Contrabassoon',tokens: ['contrabassoon', 'contra bassoon'], min: 22, max: 53 }, // Bb0–F3
  { name: 'Soprano Sax',  tokens: ['soprano sax'],   min: 56,  max: 89  }, // Ab3–F6 (concert)
  { name: 'Alto Sax',     tokens: ['alto sax'],       min: 49,  max: 80  }, // Db3–Ab5 (concert)
  { name: 'Tenor Sax',    tokens: ['tenor sax'],      min: 44,  max: 76  }, // Ab2–E5 (concert)
  { name: 'Baritone Sax', tokens: ['baritone sax', 'bari sax'], min: 36, max: 68 }, // C2–Ab4 (concert)
  // ── Brass ─────────────────────────────────────────────────────────────────
  { name: 'Horn',         tokens: ['horn', 'french horn'], min: 34, max: 77 }, // Bb1–F5 (concert)
  { name: 'Trumpet',      tokens: ['trumpet'],        min: 55,  max: 82  }, // G3–Bb5 (concert)
  { name: 'Trombone',     tokens: ['trombone'],       min: 40,  max: 72  }, // E2–C5
  { name: 'Bass Trombone',tokens: ['bass trombone'],  min: 34,  max: 67  }, // Bb1–G4
  { name: 'Tuba',         tokens: ['tuba'],           min: 28,  max: 58  }, // E1–Bb3
  { name: 'Euphonium',    tokens: ['euphonium', 'baritone horn'], min: 34, max: 70 }, // Bb1–Bb4
  // ── Keyboard / Pitched Percussion ─────────────────────────────────────────
  { name: 'Piano',        tokens: ['piano'],          min: 21,  max: 108 }, // A0–C8
  { name: 'Organ',        tokens: ['organ'],          min: 24,  max: 96  }, // C1–C7
  { name: 'Harpsichord',  tokens: ['harpsichord'],    min: 29,  max: 89  }, // F1–F6
  { name: 'Celesta',      tokens: ['celesta'],        min: 60,  max: 108 }, // C4–C8 (sounds 8va)
  { name: 'Marimba',      tokens: ['marimba'],        min: 45,  max: 96  }, // A2–C7
  { name: 'Xylophone',    tokens: ['xylophone'],      min: 65,  max: 108 }, // F4–C8 (sounds 8va)
  { name: 'Vibraphone',   tokens: ['vibraphone', 'vibes'], min: 53, max: 89 }, // F3–F6
  { name: 'Glockenspiel', tokens: ['glockenspiel', 'bells'], min: 79, max: 108 }, // G5–C8 (sounds 2 8va)
  { name: 'Timpani',      tokens: ['timpani'],        min: 40,  max: 65  }, // E2–F4
  // ── Voice ─────────────────────────────────────────────────────────────────
  { name: 'Soprano',      tokens: ['soprano'],        min: 60,  max: 81  }, // C4–A5
  { name: 'Mezzo-Soprano',tokens: ['mezzo'],          min: 57,  max: 79  }, // A3–G5
  { name: 'Alto',         tokens: ['alto', 'contralto'], min: 53, max: 74 }, // F3–D5
  { name: 'Tenor',        tokens: ['tenor'],          min: 48,  max: 69  }, // C3–A4
  { name: 'Baritone',     tokens: ['baritone'],       min: 45,  max: 67  }, // A2–G4
  { name: 'Bass',         tokens: ['bass voice', 'basso'], min: 40, max: 64 }, // E2–E4
];

/**
 * Look up the practical range for an instrument by part name.
 * Matches case-insensitively on any token, preferring the LONGEST matching
 * token across all entries (most specific wins). This avoids greedy collisions
 * from short tokens — e.g. "Bassoon", "Bass Clarinet", and "Bass Trombone" must
 * not resolve to Double Bass just because they contain "bass". Returns null if
 * no token matches.
 */
export function getInstrumentRange(partName: string): InstrumentRange | null {
  const lower = partName.toLowerCase();
  let best: (InstrumentRange & { tokens: string[] }) | null = null;
  let bestLen = 0;
  for (const entry of INSTRUMENT_RANGES) {
    for (const t of entry.tokens) {
      if (t.length > bestLen && lower.includes(t)) {
        best = entry;
        bestLen = t.length;
      }
    }
  }
  return best ? { name: best.name, min: best.min, max: best.max } : null;
}

/**
 * Check every non-rest note in a Score against its part's instrument range.
 * Returns an array of RangeWarning for out-of-range or boundary notes.
 * Parts whose instrument cannot be identified are silently skipped.
 */
export function validateRanges(score: Score): RangeWarning[] {
  const warnings: RangeWarning[] = [];
  const rangeCache = new Map<string, InstrumentRange | null>();

  for (const note of score.notes) {
    if (note.isRest || note.pitch === 'rest' || note.pitch === 'R') continue;

    // Look up range for this part (cache to avoid repeated scans)
    if (!rangeCache.has(note.partId)) {
      const part = score.parts.find(p => p.id === note.partId);
      rangeCache.set(note.partId, part ? getInstrumentRange(part.name) : null);
    }
    const range = rangeCache.get(note.partId);
    if (!range) continue;

    const midi = note.midi ?? pitchToMidi(note.pitch);
    if (midi === null) continue;

    const belowBy = range.min - midi;   // positive = below range
    const aboveBy = midi - range.max;   // positive = above range

    const violation = belowBy > 0 ? belowBy : aboveBy > 0 ? aboveBy : 0;
    if (violation === 0) continue;

    warnings.push({
      measure: note.measure,
      beat: note.beat,
      pitch: note.pitch,
      midi,
      partId: note.partId,
      instrumentName: range.name,
      min: range.min,
      max: range.max,
      severity: violation > 1 ? 'error' : 'warn',
    });
  }

  return warnings;
}
