// ─── lib/musicology/scoreModel.ts ────────────────────────────────────────────
// Adapter: lib/musicxml/types.ts ParseResult → lib/musicology/types.ts Score.
//
// This is the single bridge between the MusicXML parser and the analyzer
// modules. Every analyzer module consumes a `Score`, never a `ParseResult`
// directly. Keeping the parser-shape and analyzer-shape decoupled means we
// can swap parsers (or feed synthetic test data) without touching analyzers.

import type { ParseResult, ParsedNote, ParsedPartMeasure } from './musicxml/types.js';
import { pitchToMidi } from './pitch.js';
import type { Score, Note, PartInfo, KeyEvent, TimeEvent } from './types.js';

const FIFTHS_TO_KEY_NAME: Record<number, string> = {
  [-7]: 'Cb', [-6]: 'Gb', [-5]: 'Db', [-4]: 'Ab', [-3]: 'Eb', [-2]: 'Bb',
  [-1]: 'F',  [0]: 'C',   [1]: 'G',   [2]: 'D',   [3]: 'A',   [4]: 'E',
  [5]: 'B',   [6]: 'F#',  [7]: 'C#',
};

const MINOR_FIFTHS_TO_KEY: Record<number, string> = {
  [-7]: 'Ab', [-6]: 'Eb', [-5]: 'Bb', [-4]: 'F',  [-3]: 'C',  [-2]: 'G',
  [-1]: 'D',  [0]: 'A',   [1]: 'E',   [2]: 'B',   [3]: 'F#',  [4]: 'C#',
  [5]: 'G#',  [6]: 'D#',  [7]: 'A#',
};

function keyName(fifths: number, mode: string): string {
  const m = (mode ?? 'major').toLowerCase();
  const root = m === 'minor'
    ? (MINOR_FIFTHS_TO_KEY[fifths] ?? '?')
    : (FIFTHS_TO_KEY_NAME[fifths] ?? '?');
  return `${root} ${m}`;
}

function tieDirectionFrom(p: ParsedNote): 'start' | 'stop' | 'both' | undefined {
  // Prefer the parser-set direction; fall back to bare `isTied` (which we
  // can't disambiguate further — treat as 'start').
  if (p.tieDirection) return p.tieDirection;
  if (p.isTied) return 'start';
  return undefined;
}

function noteFromParsed(
  p: ParsedNote,
  measure: number,
  partId: string,
  partName: string,
  partIdx: number,
): Note {
  const pitch = p.isRest ? 'rest' : p.pitch;
  return {
    pitch,
    midi: pitchToMidi(pitch),
    duration: p.beats,
    // beatPosition is 1-based in the parser; default to 1 for rests/edge cases.
    beat: typeof p.beatPosition === 'number' ? p.beatPosition : 1,
    measure,
    // SATB convention: each part is one global voice (1 = soprano, 4 = bass).
    // Per-part `<voice>` numbers (used for piano-style multi-voice parts) are
    // mostly a Phase 1+ concern; for now we use partIdx + 1.
    voice: partIdx + 1,
    staff: p.staff,
    partId,
    partName,
    isRest: p.isRest,
    isChordMember: p.isChordMember,
    tieDirection: tieDirectionFrom(p),
    fermata: p.fermata,
    tuplet: p.tuplet,
    dynamic: p.dynamic,
    articulation: p.articulation,
  };
}

function compareNotes(a: Note, b: Note): number {
  if (a.measure !== b.measure) return a.measure - b.measure;
  if (a.beat !== b.beat) return a.beat - b.beat;
  return a.voice - b.voice;
}

/**
 * Build a unified `Score` from a `ParseResult`. The order of operations:
 *   1. Walk every part's measure list, collect notes with global voice = part index.
 *   2. Detect key and time signature changes (at measure-1 of part 0, plus any
 *      mid-piece changes the parser captured).
 *   3. Sort the flat note list deterministically by (measure, beat, voice).
 */
export function scoreFromParseResult(parsed: ParseResult): Score {
  const { metadata, measures } = parsed;
  const parts: PartInfo[] = metadata.partIds.map((id, i) => ({
    id,
    name: metadata.partNames[i] ?? `Part ${i + 1}`,
  }));

  // Resolve key/time signatures. ParsedPartMeasure carries them on every measure
  // (the parser repeats the "current" value each measure), so a *change* is
  // detectable as: key on measure N differs from key on measure N - 1.
  const keySignatures: KeyEvent[] = [];
  const timeSignatures: TimeEvent[] = [];

  let prevKey = '';
  let prevTime = '';
  for (const m of measures) {
    const part0 = m.parts[0];
    if (!part0) continue;
    const k = part0.keySignature ?? '';
    const t = part0.timeSignature ?? '';
    if (k && k !== prevKey) {
      // Re-derive fifths and mode from the current measure's keySig/keyMode.
      const fifths = typeof part0.keySig === 'number' ? part0.keySig : 0;
      const mode = part0.keyMode ?? 'major';
      keySignatures.push({
        measure: m.number,
        beat: 1,
        key: k,
        fifths,
        mode,
      });
      prevKey = k;
    }
    if (t && t !== prevTime) {
      const parts2 = t.split('/');
      const beats = parseInt(parts2[0], 10) || 4;
      const beatType = parseInt(parts2[1], 10) || 4;
      timeSignatures.push({ measure: m.number, beat: 1, beats, beatType });
      prevTime = t;
    }
  }

  // Emit notes in flat form, sorted.
  const notes: Note[] = [];
  for (const m of measures) {
    m.parts.forEach((pm: ParsedPartMeasure, partIdx) => {
      for (const pn of pm.notes) {
        notes.push(noteFromParsed(pn, m.number, pm.partId, pm.partName, partIdx));
      }
    });
  }
  notes.sort(compareNotes);

  return {
    parts,
    notes,
    keySignatures,
    timeSignatures,
    measureCount: metadata.totalMeasures,
    divisions: metadata.divisions,
    title: metadata.title,
    composer: metadata.composer,
  };
}

/**
 * Convenience wrapper. If callers pass a Buffer or string, they should
 * use parseMusicXML / parseMXL from lib/musicxml/parser.ts first, then call
 * this. We keep this layer as a pure adapter — no I/O.
 */
export function isScore(x: unknown): x is Score {
  return !!(x && typeof x === 'object'
    && Array.isArray((x as Score).notes)
    && Array.isArray((x as Score).parts)
    && Array.isArray((x as Score).keySignatures));
}

/**
 * Adapter: lib/maestroCritiqueAnalyzer.ts CompositionData → Score.
 * The critique route receives a simple flat note list; this lets us run the
 * full musicology pipeline over the same input without round-tripping
 * through MusicXML.
 */
export interface CompositionDataInput {
  notes: Array<{
    pitch: string;
    duration: number;
    beat: number;
    measure: number;
    voice: number;
    dynamic?: string;
  }>;
  timeSignature: [number, number];
  keySignature: string;
  voiceCount: number;
  instrument?: string;
  instruments?: string[];
}

export function compositionDataToScore(data: CompositionDataInput): Score {
  // Map fifths from the key signature string for the KeyEvent's `fifths` field.
  const FIFTHS_FROM_KEY: Record<string, number> = {
    'Cb': -7, 'Gb': -6, 'Db': -5, 'Ab': -4, 'Eb': -3, 'Bb': -2,
    'F':  -1, 'C':   0, 'G':   1, 'D':   2, 'A':   3, 'E':   4,
    'B':   5, 'F#':  6, 'C#':  7,
  };
  const m = data.keySignature.match(/^([A-G](?:##|#|bb|b)?)\s+(major|minor|.+)$/i);
  const root = m?.[1] ?? 'C';
  const mode = (m?.[2] ?? 'major').toLowerCase();
  const fifths = FIFTHS_FROM_KEY[root] ?? 0;

  const notes: Note[] = data.notes
    .filter(n => n.pitch !== 'R' && n.pitch !== 'rest')
    .map((n, i) => ({
      pitch: n.pitch,
      midi: pitchToMidi(n.pitch),
      duration: n.duration,
      beat: n.beat,
      measure: n.measure,
      voice: n.voice,
      partId: `V${n.voice}`,
      partName: `Voice ${n.voice}`,
      isRest: false,
      dynamic: n.dynamic,
    } satisfies Note))
    // Stable sort by (measure, beat, voice).
    .sort((a, b) => a.measure - b.measure || a.beat - b.beat || a.voice - b.voice);

  const measureCount = notes.length > 0
    ? Math.max(...notes.map(n => n.measure))
    : 1;

  const partsMap = new Map<number, PartInfo>();
  for (const n of data.notes) {
    if (!partsMap.has(n.voice)) {
      partsMap.set(n.voice, { id: `V${n.voice}`, name: `Voice ${n.voice}` });
    }
  }
  const parts = Array.from(partsMap.values()).sort((a, b) => a.id.localeCompare(b.id));

  return {
    parts,
    notes,
    keySignatures: [{
      measure: 1, beat: 1,
      key: data.keySignature,
      fifths,
      mode,
    }],
    timeSignatures: [{
      measure: 1, beat: 1,
      beats: data.timeSignature[0],
      beatType: data.timeSignature[1],
    }],
    measureCount,
    divisions: 1,
  };
}

// ─── NoteEntry[][] adapter (teacherContext.ts) ───────────────────────────────

/**
 * NoteEntry is the format the in-app composition tools save and pass to the
 * Maestro chat: per-voice arrays of `{ idx, dur }` where `idx` is a diatonic
 * index from C4 (idx 0 = C4, idx 1 = D4, …, idx 7 = C5) and `dur` is in
 * quarter-note beats.
 *
 * The default key is C major. Callers in non-C lessons should override.
 */
export interface NoteEntry { idx: number; dur: number }

export interface NoteEntriesToScoreOptions {
  keySignature?: string;            // "C major" by default
  timeSignature?: [number, number]; // [4, 4] by default
}

const DIATONIC_NAMES_C_MAJOR = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];

function idxToPitch(idx: number): string {
  const octaveOffset = Math.floor(idx / 7);
  const degree = ((idx % 7) + 7) % 7;
  const octave = 4 + octaveOffset;
  return `${DIATONIC_NAMES_C_MAJOR[degree]}${octave}`;
}

export function noteEntriesToScore(
  voices: NoteEntry[][],
  opts: NoteEntriesToScoreOptions = {},
): Score {
  const keySignature = opts.keySignature ?? 'C major';
  const [beatsPerMeasure, beatType] = opts.timeSignature ?? [4, 4];

  const FIFTHS_FROM_KEY: Record<string, number> = {
    'Cb': -7, 'Gb': -6, 'Db': -5, 'Ab': -4, 'Eb': -3, 'Bb': -2,
    'F':  -1, 'C':   0, 'G':   1, 'D':   2, 'A':   3, 'E':   4,
    'B':   5, 'F#':  6, 'C#':  7,
  };
  const m = keySignature.match(/^([A-G](?:##|#|bb|b)?)\s+(major|minor|.+)$/i);
  const root = m?.[1] ?? 'C';
  const mode = (m?.[2] ?? 'major').toLowerCase();
  const fifths = FIFTHS_FROM_KEY[root] ?? 0;

  const notes: Note[] = [];
  voices.forEach((voice, voiceIdx) => {
    let measure = 1;
    let beat = 1;
    for (const entry of voice) {
      const pitch = idxToPitch(entry.idx);
      notes.push({
        pitch,
        midi: pitchToMidi(pitch),
        duration: entry.dur,
        beat,
        measure,
        voice: voiceIdx + 1,
        partId: `V${voiceIdx + 1}`,
        partName: `Voice ${voiceIdx + 1}`,
        isRest: false,
      });
      // Advance the cursor.
      beat += entry.dur;
      while (beat > beatsPerMeasure) {
        beat -= beatsPerMeasure;
        measure++;
      }
    }
  });
  notes.sort((a, b) =>
    a.measure - b.measure || a.beat - b.beat || a.voice - b.voice,
  );

  const measureCount = notes.length > 0 ? Math.max(...notes.map(n => n.measure)) : 1;
  const parts: PartInfo[] = voices.map((_, i) => ({
    id: `V${i + 1}`,
    name: `Voice ${i + 1}`,
  }));

  return {
    parts,
    notes,
    keySignatures: [{ measure: 1, beat: 1, key: keySignature, fifths, mode }],
    timeSignatures: [{ measure: 1, beat: 1, beats: beatsPerMeasure, beatType }],
    measureCount,
    divisions: 1,
  };
}
