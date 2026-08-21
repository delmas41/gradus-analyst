// ─── lib/maestroAnalyst/reduction.ts ─────────────────────────────────────────
// Voice-redistribution layer: collapses an orchestral Score into a
// piano-reduction-shaped Score. Produces per-onset chords with named voices
// (Soprano, Inner1..N, Bass), so the same harmony is carried by the smallest
// number of voices that preserves every distinct sounding pitch class.
//
// Goal: lose orchestrational doubling and section unisons; keep all harmonic
// content. Useful for:
//   - the LCM visualizer (per-voice pitch lines stay legible at orchestra scale)
//   - a scrolling "piano-reduction" visual rendered via verovio
//   - any analyzer pass that wants harmonic skeleton instead of doublings
//
// Algorithm:
//   1. chordify(score) — already deduplicates PCs per onset and identifies bass
//   2. Per onset: bass = lowest sounding pitch, melody = highest sounding pitch,
//      inner voices = remaining distinct PCs voiced from the source pitches
//      (closest to register midpoint between bass and melody)
//   3. Octave doublings collapse for free (chordify already deduped pcs)
//
// Pure module. No external deps beyond sibling analyst modules.

import type {
  Note,
  Score,
  Chord,
  ChordStream,
  PartInfo,
} from './types.js';
import { chordify } from './chordify.js';
import { pitchToMidi, pc as pitchPc } from './pitch.js';

export interface ReductionOptions {
  /** Hard cap on total voices per chord. If a chord has more distinct PCs
   *  than this, evenly-spaced inner voices are kept and the rest dropped.
   *  Default Infinity (keep every distinct PC). */
  maxVoices?: number;
  /** Drop tones the chordifier flagged as suspect non-chord tones (passing,
   *  neighbor, etc.) before voicing. Default false (keep everything sounding). */
  filterNcts?: boolean;
}

export interface ReducedVoiceNote {
  pitch: string;
  midi: number;
  pc: number;
}

export interface ReducedChord {
  measure: number;
  beat: number;
  durationToNext: number;
  bass: ReducedVoiceNote;
  /** Inner voices sorted ascending by MIDI. Empty for unisons / two-pitch
   *  events / events where every PC is covered by bass and melody. */
  inner: ReducedVoiceNote[];
  melody: ReducedVoiceNote;
  /** All distinct sounding PCs at this onset — for downstream LCM math. */
  pcs: number[];
  /** Original Chord this was reduced from (for traceability). */
  source: Chord;
}

export interface ReducedScore {
  /** A new Score with parts ['Soprano', 'Inner1', …, 'Inner(maxN)', 'Bass'].
   *  Suitable input to analyzeScore(); also serializable to MusicXML by future
   *  callers. Inner voice slots that aren't used at a given onset simply have
   *  no note at that onset. */
  score: Score;
  /** Per-event reduction with explicit voice assignments. */
  events: ReducedChord[];
  /** Original chord stream from chordify. */
  source: ChordStream;
  /** Voice-count statistics across the whole reduction. Useful for sanity-
   *  checking how dense the piece is. */
  voiceCountStats: { min: number; max: number; mean: number };
}

// ─── Per-chord reduction ─────────────────────────────────────────────────────

function pitchToReducedNote(pitch: string): ReducedVoiceNote | null {
  const midi = pitchToMidi(pitch);
  const p = pitchPc(pitch);
  if (midi === null || p === null) return null;
  return { pitch, midi, pc: p };
}

function reduceChord(chord: Chord, opts: ReductionOptions): ReducedChord | null {
  // chordify guarantees pitches are sorted ascending by MIDI and deduped.
  const sourcePitches = chord.pitches
    .map(pitchToReducedNote)
    .filter((n): n is ReducedVoiceNote => n !== null);
  if (sourcePitches.length === 0) return null;

  // Optionally drop NCT-flagged tones. Fall back to all sounding pitches if
  // filtering would empty the chord.
  const ncts = opts.filterNcts
    ? new Set(chord.onset.suspectNcts)
    : new Set<string>();
  const usable = (() => {
    if (ncts.size === 0) return sourcePitches;
    const filtered = sourcePitches.filter(n => !ncts.has(n.pitch));
    return filtered.length > 0 ? filtered : sourcePitches;
  })();

  const bass = usable[0];
  const melody = usable[usable.length - 1];

  // Distinct inner PCs: every PC not covered by bass or melody.
  const allPcs = Array.from(new Set(usable.map(n => n.pc)));
  const innerPcs = allPcs.filter(p => p !== bass.pc && p !== melody.pc);

  // For each inner PC, pick the source pitch closest to register midpoint.
  // This preserves the composer's spelling (no synthetic pitches) and keeps
  // each inner voice in a sensible register.
  const midpoint = (bass.midi + melody.midi) / 2;
  const inner: ReducedVoiceNote[] = [];
  for (const ipc of innerPcs) {
    const candidates = usable.filter(n => n.pc === ipc);
    if (candidates.length === 0) continue;
    let best = candidates[0];
    let bestDist = Math.abs(best.midi - midpoint);
    for (const c of candidates) {
      const d = Math.abs(c.midi - midpoint);
      if (d < bestDist) {
        best = c;
        bestDist = d;
      }
    }
    inner.push(best);
  }
  inner.sort((a, b) => a.midi - b.midi);

  // Optional cap: keep evenly-spaced inner voices.
  if (opts.maxVoices !== undefined) {
    const totalCap = Math.max(2, opts.maxVoices);
    const innerCap = totalCap - 2;
    if (inner.length > innerCap) {
      const keep: ReducedVoiceNote[] = [];
      const step = (inner.length - 1) / Math.max(1, innerCap - 1);
      if (innerCap === 1) {
        keep.push(inner[Math.floor(inner.length / 2)]);
      } else {
        for (let i = 0; i < innerCap; i++) {
          keep.push(inner[Math.round(i * step)]);
        }
      }
      inner.splice(0, inner.length, ...keep);
    }
  }

  return {
    measure: chord.measure,
    beat: chord.beat,
    durationToNext: chord.durationToNext,
    bass,
    inner,
    melody,
    pcs: chord.pcs,
    source: chord,
  };
}

// ─── Score reconstruction ────────────────────────────────────────────────────

/**
 * Build the reduced Score's parts list. Parts are top-to-bottom display order:
 *   index 0: Soprano  (always present, voice 1)
 *   index 1..maxInner: Inner(maxInner) … Inner1 (voice 2 .. maxInner+1)
 *   last index: Bass (always present, voice maxInner+2)
 *
 * Inner voice numbering: voice 2 = highest inner (closest to soprano),
 * voice (maxInner+1) = lowest inner (closest to bass). This matches
 * SATB convention where soprano = 1, alto = 2, tenor = 3, bass = 4.
 */
function buildParts(maxInner: number): PartInfo[] {
  const parts: PartInfo[] = [{ id: 'P1', name: 'Soprano' }];
  // Inner voices, named highest-to-lowest. With maxInner=2: ['Inner2','Inner1'].
  // With maxInner=1: just ['Inner'].
  for (let i = maxInner; i >= 1; i--) {
    parts.push({
      id: `P${parts.length + 1}`,
      name: maxInner === 1 ? 'Inner' : `Inner${i}`,
    });
  }
  parts.push({ id: `P${parts.length + 1}`, name: 'Bass' });
  return parts;
}

function noteForVoice(
  v: ReducedVoiceNote,
  measure: number,
  beat: number,
  duration: number,
  voice: number,
  partId: string,
  partName: string,
): Note {
  return {
    pitch: v.pitch,
    midi: v.midi,
    duration,
    beat,
    measure,
    voice,
    partId,
    partName,
    isRest: false,
  };
}

/**
 * Chordify sets the last event's durationToNext to 0 because there's no
 * succeeding onset to measure against. For our emitted Score we need a
 * positive duration (otherwise the notes have zero length and re-chordify
 * drops them). Use the remainder of the last event's measure based on the
 * active time signature.
 */
function lastEventDuration(score: Score, lastMeasure: number, lastBeat: number): number {
  let active = { beats: 4, beatType: 4 };
  for (const ts of score.timeSignatures) {
    if (ts.measure <= lastMeasure) active = ts;
  }
  const beatsPerMeasure = active.beats * (4 / active.beatType);
  return Math.max(1, beatsPerMeasure - (lastBeat - 1));
}

export function reduceScore(score: Score, opts: ReductionOptions = {}): ReducedScore {
  const stream = chordify(score);

  const events: ReducedChord[] = [];
  for (const chord of stream.chords) {
    const reduced = reduceChord(chord, opts);
    if (reduced) events.push(reduced);
  }

  // Fix up the last event's duration so emitted notes have positive length.
  if (events.length > 0 && events[events.length - 1].durationToNext === 0) {
    const last = events[events.length - 1];
    events[events.length - 1] = {
      ...last,
      durationToNext: lastEventDuration(score, last.measure, last.beat),
    };
  }

  if (events.length === 0) {
    return {
      score: {
        ...score,
        parts: [{ id: 'P1', name: 'Soprano' }, { id: 'P2', name: 'Bass' }],
        notes: [],
      },
      events: [],
      source: stream,
      voiceCountStats: { min: 0, max: 0, mean: 0 },
    };
  }

  const maxInner = events.reduce((m, e) => Math.max(m, e.inner.length), 0);
  const parts = buildParts(maxInner);
  const sopranoPart = parts[0];
  const bassPart = parts[parts.length - 1];
  const innerParts = parts.slice(1, parts.length - 1); // top-to-bottom (Inner(maxInner) first)

  // Emit notes per event.
  const notes: Note[] = [];
  for (const ev of events) {
    // Soprano = melody, voice 1.
    notes.push(noteForVoice(
      ev.melody,
      ev.measure, ev.beat, ev.durationToNext,
      1, sopranoPart.id, sopranoPart.name,
    ));

    // Inner voices: ev.inner is ascending by MIDI. Highest inner gets voice 2
    // (= innerParts[0], named Inner(maxInner)). Lowest inner gets voice
    // (k+1) where k = ev.inner.length.
    //
    // When ev.inner.length < maxInner, the SLOTS used are voices 2..(k+1),
    // and voices (k+2)..(maxInner+1) simply have no note this onset.
    for (let i = 0; i < ev.inner.length; i++) {
      // ev.inner[i] is the i-th lowest inner. The highest-inner index is
      // ev.inner.length - 1, which maps to voice 2 (innerParts[0]).
      const fromTop = ev.inner.length - 1 - i;
      const voice = 2 + fromTop;
      const part = innerParts[fromTop];
      notes.push(noteForVoice(
        ev.inner[i],
        ev.measure, ev.beat, ev.durationToNext,
        voice, part.id, part.name,
      ));
    }

    // Bass, voice = maxInner + 2.
    notes.push(noteForVoice(
      ev.bass,
      ev.measure, ev.beat, ev.durationToNext,
      maxInner + 2, bassPart.id, bassPart.name,
    ));
  }
  notes.sort((a, b) =>
    a.measure - b.measure || a.beat - b.beat || a.voice - b.voice,
  );

  // Stats.
  const counts = events.map(e => {
    // Bass and melody count as one voice each only if they have distinct PCs;
    // otherwise the unison case where bass.pc === melody.pc is one voice.
    const distinct = new Set<number>([e.bass.pc, e.melody.pc, ...e.inner.map(n => n.pc)]);
    return distinct.size;
  });
  const minV = Math.min(...counts);
  const maxV = Math.max(...counts);
  const meanV = counts.reduce((a, b) => a + b, 0) / counts.length;

  const reducedScore: Score = {
    parts,
    notes,
    keySignatures: score.keySignatures,
    timeSignatures: score.timeSignatures,
    measureCount: score.measureCount,
    divisions: score.divisions,
    title: score.title,
    composer: score.composer,
  };

  return {
    score: reducedScore,
    events,
    source: stream,
    voiceCountStats: { min: minV, max: maxV, mean: meanV },
  };
}
