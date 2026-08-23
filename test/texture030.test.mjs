import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyMeasureTextures, analyzeNotesKey, detectKeySections, analyzeScore } from '../dist/index.js';

/**
 * Analyst 0.3.0 — the three adjudication-driven features from the 2026-08
 * harmony review: per-onset texture (bare fifths/unisons must not read as
 * chords), score-spelled key names (no "F# major" over a flat-spelled Db
 * zone), and cadential sponsorship on windowed key sections (statistics
 * alone do not establish a key).
 *
 * Ported from the in-repo suite (__tests__/lib/maestroAnalyst/
 * texture030.test.ts), including the independent-audit repros D1/D2/D3/D5.
 */

const PITCH_MIDI = {
  D2: 38, A2: 45, D3: 50, F3: 53, G3: 55, 'G#3': 56, A3: 57, Bb3: 58, B3: 59,
  C4: 60, 'C#4': 61, Db4: 61, D4: 62, Eb4: 63, E4: 64, F4: 65, 'F#4': 66,
  Gb4: 66, G4: 67, Ab4: 68, A4: 69, Bb4: 70, B4: 71,
  C5: 72, Db5: 73, D5: 74, Eb5: 75, E5: 76, F5: 77, Gb5: 78, G5: 79, Ab5: 80, A5: 81,
};

function note(measure, beat, pitch, duration = 1, voice = 1) {
  const midi = PITCH_MIDI[pitch];
  if (midi === undefined) throw new Error(`unmapped pitch ${pitch}`);
  return { pitch, midi, duration, beat, measure, voice, partId: `P${voice}`, partName: `V${voice}`, isRest: false };
}

function score(notes, measureCount) {
  return {
    parts: [{ id: 'P1', name: 'V1' }, { id: 'P2', name: 'V2' }],
    notes, measureCount, divisions: 480,
    keySignatures: [], timeSignatures: [],
  };
}

// ---------------------------------------------------------------- texture

test('texture: bare octave-fifths read bare-fifth, never chordal (B9/i mm.39-47 class)', () => {
  const s = score([
    note(1, 1, 'D2', 4, 1), note(1, 1, 'A2', 4, 2),
    note(1, 1, 'D3', 4, 3), note(1, 1, 'A3', 4, 4),
  ], 1);
  const [t] = classifyMeasureTextures(s);
  assert.equal(t.texture, 'bare-fifth');
  assert.equal(t.maxSimultaneousPcs, 2);
});

test('texture: a melodic line is unison even when it visits many pcs (bar-level-count trap)', () => {
  const s = score([note(1, 1, 'C4'), note(1, 2, 'D4'), note(1, 3, 'E4'), note(1, 4, 'F4')], 1);
  const [t] = classifyMeasureTextures(s);
  assert.equal(t.texture, 'unison');
  assert.equal(t.maxSimultaneousPcs, 1);
  assert.equal(t.distinctPcsInBar, 4);
});

test('texture: octave-doubled lines read octaves (B1/i mm.34-43 unison-line class)', () => {
  const s = score([
    note(1, 1, 'C4', 1, 1), note(1, 1, 'C5', 1, 2),
    note(1, 2, 'D4', 1, 1), note(1, 2, 'D5', 1, 2),
    note(1, 3, 'E4', 1, 1), note(1, 3, 'E5', 1, 2),
    note(1, 4, 'G4', 1, 1), note(1, 4, 'G5', 1, 2),
  ], 1);
  const [t] = classifyMeasureTextures(s);
  assert.equal(t.texture, 'octaves');
  assert.equal(t.maxSimultaneousPcs, 1);
});

test('texture: a bare minor third reads bare-third (B2/iii m.18 pivot dyad)', () => {
  const s = score([note(1, 1, 'D4', 4, 1), note(1, 1, 'F4', 4, 2)], 1);
  assert.equal(classifyMeasureTextures(s)[0].texture, 'bare-third');
});

test('texture: real triads read chordal, empty bars read silence', () => {
  const s = score([
    note(1, 1, 'C4', 4, 1), note(1, 1, 'E4', 4, 2), note(1, 1, 'G4', 4, 3),
    note(3, 1, 'F4', 4, 1), note(3, 1, 'A4', 4, 2), note(3, 1, 'C5', 4, 3),
  ], 3);
  assert.deepEqual(classifyMeasureTextures(s).map((t) => t.texture), ['chordal', 'silence', 'chordal']);
});

test('texture: one passing dyad inside an octave bar does not promote the texture', () => {
  const s = score([
    note(1, 1, 'C4', 1, 1), note(1, 1, 'C5', 1, 2),
    note(1, 2, 'D4', 1, 1), note(1, 2, 'D5', 1, 2),
    note(1, 3, 'E4', 1, 1), note(1, 3, 'E5', 1, 2),
    note(1, 4, 'E4', 0.5, 1), note(1, 4, 'G4', 0.5, 2),
    note(1, 4.5, 'C4', 0.5, 1), note(1, 4.5, 'C5', 0.5, 2),
  ], 1);
  assert.ok(['octaves', 'unison'].includes(classifyMeasureTextures(s)[0].texture));
});

test('texture audit D1: a single line crossing the C register boundary is unison, not octaves', () => {
  const s = score([note(1, 1, 'A3'), note(1, 2, 'B3'), note(1, 3, 'C4'), note(1, 4, 'D4')], 1);
  assert.equal(classifyMeasureTextures(s)[0].texture, 'unison');
});

test('texture audit D1: a one-voice arpeggio revisiting its pc an octave up is unison', () => {
  const s = score([note(1, 1, 'C4'), note(1, 2, 'E4'), note(1, 3, 'G4'), note(1, 4, 'C5')], 1);
  assert.equal(classifyMeasureTextures(s)[0].texture, 'unison');
});

test('texture audit D5: trailing empty measures and pickups get entries', () => {
  const withTrailing = { ...score([note(1, 1, 'C4', 4, 1), note(1, 1, 'E4', 4, 2), note(1, 1, 'G4', 4, 3)], 1), measureCount: 3 };
  const ts = classifyMeasureTextures(withTrailing);
  assert.deepEqual(ts.map((t) => t.measure), [1, 2, 3]);
  assert.equal(ts[2].texture, 'silence');
  const withPickup = score([note(0, 4, 'C4'), note(1, 1, 'D4'), note(1, 2, 'E4')], 1);
  assert.equal(classifyMeasureTextures(withPickup)[0].measure, 0);
});

test('texture rides along on analyzeScore as analysis.textures', () => {
  const s = score([note(1, 1, 'D2', 4, 1), note(1, 1, 'A2', 4, 2)], 1);
  const analysis = analyzeScore(s);
  assert.equal(analysis.textures?.[0]?.texture, 'bare-fifth');
});

// ------------------------------------------------- score-spelled key names

test('spelling: a flat-spelled pc-6 window names Gb, never F# (the Db-zone comedy)', () => {
  const bars = [
    ['Gb4', 'Bb4', 'Db5', 'Gb5'], ['Db4', 'F4', 'Ab4', 'Db5'],
    ['Gb4', 'Db5', 'Bb4', 'Gb5'], ['Ab4', 'Db5', 'F4', 'Ab5'],
  ];
  const notes = [];
  for (let m = 1; m <= 8; m++) bars[m % bars.length].forEach((p, i) => notes.push(note(m, i + 1, p)));
  const est = analyzeNotesKey(notes);
  assert.ok(est);
  if (est.tonicPc === 6) assert.equal(est.key, 'Gb major');
  assert.doesNotMatch(est.key, /#/);
});

test('spelling: conventionally spelled music keeps canonical names', () => {
  const notes = [
    note(1, 1, 'C4'), note(1, 2, 'E4'), note(1, 3, 'G4'), note(1, 4, 'C5'),
    note(2, 1, 'F4'), note(2, 2, 'A4'), note(2, 3, 'C5'), note(2, 4, 'F4'),
    note(3, 1, 'G4'), note(3, 2, 'B4'), note(3, 3, 'D4'), note(3, 4, 'G4'),
    note(4, 1, 'C4'), note(4, 2, 'E4'), note(4, 3, 'G4'), note(4, 4, 'C5'),
  ];
  assert.equal(analyzeNotesKey(notes)?.key, 'C major');
});

// ------------------------------------------------- cadential sponsorship

function longPiece(withCadence) {
  const C_BARS = [['C4', 'E4', 'G4', 'C5'], ['F4', 'A4', 'C5', 'F4'], ['G4', 'B4', 'D4', 'G4']];
  const AM_STAT = [['A4', 'C5', 'E4', 'A4'], ['D4', 'F4', 'A4', 'D5'], ['E4', 'A4', 'C5', 'E4']];
  const notes = [];
  for (let m = 1; m <= 60; m++) C_BARS[m % C_BARS.length].forEach((p, i) => notes.push(note(m, i + 1, p)));
  for (let m = 61; m <= 86; m++) {
    if (withCadence && m === 74) {
      ['E4', 'Ab4', 'B4'].forEach((p, v) => notes.push(note(m, 1, p, 4, v + 1)));
    } else if (withCadence && m === 75) {
      ['A4', 'C5', 'E5'].forEach((p, v) => notes.push(note(m, 1, p, 4, v + 1)));
    } else {
      AM_STAT[m % AM_STAT.length].forEach((p, i) => notes.push(note(m, i + 1, p)));
    }
  }
  return score(notes, 86);
}

const SECTION_OPTS = { windowHalf: 6, minSectionMeasures: 15, deltaOverGlobal: 0.05 };

test('sponsorship: a section with a real V-to-I event is cadential', () => {
  const sections = detectKeySections(longPiece(true), SECTION_OPTS);
  const am = sections.find((s) => s.key.startsWith('A'));
  assert.ok(am);
  assert.equal(am.sponsorship, 'cadential');
  assert.ok(am.sponsorMeasure >= 61);
});

test('sponsorship: a statistics-only section is unsponsored', () => {
  const sections = detectKeySections(longPiece(false), SECTION_OPTS);
  assert.ok(sections.length > 0, 'a trivially-empty run must not pass');
  const am = sections.find((s) => s.key.startsWith('A'));
  assert.ok(am);
  assert.equal(am.sponsorship, 'unsponsored');
});

test('sponsorship audit D2: a lone passing leading tone does not sponsor', () => {
  const base = longPiece(false);
  const passing = [
    note(70, 1, 'E4', 1, 1), note(70, 2, 'E4', 0.5, 1), note(70, 2.5, 'G#3', 0.5, 1),
    note(70, 3, 'A3', 1, 1), note(70, 4, 'E4', 1, 1),
  ];
  const s = { ...base, notes: base.notes.filter((n) => n.measure !== 70).concat(passing) };
  const am = detectKeySections(s, SECTION_OPTS).find((sec) => sec.key.startsWith('A'));
  assert.ok(am);
  assert.equal(am.sponsorship, 'unsponsored');
});

test('sponsorship audit D3: an intra-bar V-to-i cadence sponsors', () => {
  const base = longPiece(false);
  const intra = [
    note(70, 1, 'E4', 2, 1), note(70, 1, 'G#3', 2, 2), note(70, 1, 'B3', 2, 3),
    note(70, 3, 'A3', 2, 1), note(70, 3, 'C4', 2, 2), note(70, 3, 'E4', 2, 3),
  ];
  const s = { ...base, notes: base.notes.filter((n) => n.measure !== 70).concat(intra) };
  const am = detectKeySections(s, SECTION_OPTS).find((sec) => sec.key.startsWith('A'));
  assert.ok(am);
  assert.equal(am.sponsorship, 'cadential');
  assert.equal(am.sponsorMeasure, 70);
});
