import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeScore, chordify, detectPedalRuns, pedalDegreeLabel } from '../dist/index.js';
import { pitchToMidi } from '../dist/pitch.js';

/**
 * Pedal-point detection. The rule under test (src/pedalPoint.ts):
 *
 *   A pedal is a bass pc sustained across slices WHILE the upper harmony
 *   diverges from it. The divergence — not the sustain — is the definition.
 *
 * Fixtures are built in code, same as the rest of this suite — no corpus, no
 * network. They are ports of the fixtures the analyzer was developed against
 * in its home repository.
 */

/** One measure of whole-note chords: every pitch sounds beats 1-4. */
function bar(measure, pitches) {
  return pitches.map((p, i) => ({
    pitch: p,
    midi: pitchToMidi(p),
    duration: 4,
    beat: 1,
    measure,
    voice: i + 1,
    partId: 'P1',
    partName: 'Fixture',
    isRest: false,
  }));
}

function scoreFromBars(bars, key = 'C major') {
  const notes = [];
  bars.forEach((pitches, i) => notes.push(...bar(i + 1, pitches)));
  return {
    parts: [{ id: 'P1', name: 'Fixture' }],
    notes,
    keySignatures: [{ measure: 1, beat: 1, key, fifths: 0, mode: key.endsWith('minor') ? 'minor' : 'major' }],
    timeSignatures: [{ measure: 1, beat: 1, beats: 4, beatType: 4 }],
    measureCount: bars.length,
    divisions: 1,
  };
}

test('pedal (a): a complete G⁷ over a sustained C reads V⁷ with a tonic pedal', () => {
  // m1: I establishes home; mm. 2-4: G⁷ complete above the held C;
  // m5: I resolves. The bass pc never moves.
  const score = scoreFromBars([
    ['C3', 'C4', 'E4', 'G4'],
    ['C3', 'G3', 'B3', 'D4', 'F4'],
    ['C3', 'G3', 'B3', 'D4', 'F4'],
    ['C3', 'G3', 'B3', 'D4', 'F4'],
    ['C3', 'C4', 'E4', 'G4'],
  ]);
  const analysis = analyzeScore(score);
  const m3 = analysis.chordAnalyses.find((c) => c.measure === 3);
  assert.ok(m3, 'measure 3 must produce a chord analysis');
  assert.deepEqual(m3.pedal, { pc: 0, degree: '1' });
  // The upper structure is the chord: V⁷ in root position, not '?'.
  assert.equal(m3.readings[0].rnAscii, 'V7');
  assert.equal(m3.readings[0].inversion, 'root');
  assert.ok(m3.tendencyTones.includes('pedal-point'));
  // The slice still describes what actually sounds — pedal included.
  assert.ok(m3.pcSet.includes(0));
});

test('pedal (b): I – IV⁶⁄₄ – I over a tonic pedal, pedal reported on the middle slice', () => {
  const score = scoreFromBars([
    ['C3', 'C4', 'E4', 'G4'],
    ['C3', 'C4', 'F4', 'A4'], // F-A-C over the held C: IV with the pedal as chord fifth
    ['C3', 'C4', 'E4', 'G4'],
  ]);
  const analysis = analyzeScore(score);
  const [m1, m2, m3] = [1, 2, 3].map((m) => analysis.chordAnalyses.find((c) => c.measure === m));
  assert.equal(m1.readings[0].rnAscii, 'I');
  assert.match(m2.readings[0].rnAscii, /^IV/);
  assert.equal(m3.readings[0].rnAscii, 'I');
  assert.deepEqual(m2.pedal, { pc: 0, degree: '1' });
  assert.ok(m2.tendencyTones.includes('pedal-point'));
});

test('pedal (c): a dominant pedal — shifting harmony over sustained 5̂ — reads degree "5"', () => {
  const score = scoreFromBars([
    ['G2', 'G3', 'B3', 'D4'],       // V (bass is the root — no divergence yet)
    ['G2', 'C4', 'E4', 'G4'],       // I⁶⁄₄ over the pedal (chord tone, not root)
    ['G2', 'D4', 'F4', 'A4'],       // ii above — G is foreign to D minor
    ['G2', 'G3', 'B3', 'D4', 'F4'], // V⁷
  ]);
  const analysis = analyzeScore(score);
  const m3 = analysis.chordAnalyses.find((c) => c.measure === 3);
  assert.deepEqual(m3.pedal, { pc: 7, degree: '5' });
  assert.equal(m3.readings[0].rnAscii, 'ii'); // upper structure, root position
  const m2 = analysis.chordAnalyses.find((c) => c.measure === 2);
  // Chord-tone exception: the full reading (I⁶⁄₄) already explains the bass.
  assert.equal(m2.readings[0].rnAscii, 'I64');
  assert.deepEqual(m2.pedal, { pc: 7, degree: '5' });
});

test('pedal (d) NEGATIVE: four bars of root-position I is not a pedal', () => {
  const score = scoreFromBars([
    ['C3', 'C4', 'E4', 'G4'],
    ['C3', 'E4', 'G4', 'C5'],
    ['C3', 'G4', 'C5', 'E5'],
    ['C3', 'C4', 'E4', 'G4'],
  ]);
  assert.deepEqual(detectPedalRuns(chordify(score).chords), []);
  const analysis = analyzeScore(score);
  for (const c of analysis.chordAnalyses) {
    assert.equal(c.pedal, undefined);
    assert.ok(!c.tendencyTones.includes('pedal-point'));
  }
});

test('pedal (e) NEGATIVE: a walking bass is not a pedal', () => {
  const score = scoreFromBars([
    ['C3', 'C4', 'E4', 'G4'],
    ['D3', 'D4', 'F4', 'A4'],
    ['E3', 'E4', 'G4', 'C5'],
    ['F3', 'F4', 'A4', 'C5'],
  ]);
  assert.deepEqual(detectPedalRuns(chordify(score).chords), []);
  const analysis = analyzeScore(score);
  for (const c of analysis.chordAnalyses) assert.equal(c.pedal, undefined);
});

test('pedal (f) NEGATIVE: a one-measure cadential ⁶⁄₄ is not promoted to a pedal', () => {
  // Bass G under I⁶⁄₄ then V, both inside one measure (two half-note slices),
  // framed by root-position chords on other bass notes.
  const half = (pitches, measure, beat) =>
    pitches.map((p, i) => ({
      pitch: p, midi: pitchToMidi(p), duration: 2, beat, measure,
      voice: i + 1, partId: 'P1', partName: 'Fixture', isRest: false,
    }));
  const notes = [
    ...bar(1, ['C3', 'C4', 'E4', 'G4']),
    ...half(['G2', 'C4', 'E4', 'G4'], 2, 1),
    ...half(['G2', 'G3', 'B3', 'D4'], 2, 3),
    ...bar(3, ['C3', 'C4', 'E4', 'G4']),
  ];
  const score = {
    parts: [{ id: 'P1', name: 'Fixture' }],
    notes,
    keySignatures: [{ measure: 1, beat: 1, key: 'C major', fifths: 0, mode: 'major' }],
    timeSignatures: [{ measure: 1, beat: 1, beats: 4, beatType: 4 }],
    measureCount: 3,
    divisions: 1,
  };
  assert.deepEqual(detectPedalRuns(chordify(score).chords), []);
});

test('pedalDegreeLabel labels diatonic and chromatic degrees key-relatively', () => {
  assert.equal(pedalDegreeLabel(0, 'C major'), '1');
  assert.equal(pedalDegreeLabel(7, 'C major'), '5');
  assert.equal(pedalDegreeLabel(3, 'C major'), 'b3');
  assert.equal(pedalDegreeLabel(9, 'A minor'), '1');
  assert.equal(pedalDegreeLabel(4, 'A minor'), '5');
  assert.equal(pedalDegreeLabel(0, 'A minor'), '3');
});
