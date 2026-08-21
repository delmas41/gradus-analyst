import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeScore, compositionDataToScore, parseXmlString } from '../dist/index.js';

/**
 * These run against a MusicXML string defined here rather than a fixture file,
 * so the package can be verified anywhere it is installed — no corpus, no
 * Python, no network.
 */

/** I – IV – V7 – I in C major, four-part, one chord per bar. */
const CADENCE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    ${[
      ['C', 'E', 'G', 'C'],
      ['C', 'F', 'A', 'F'],
      ['B', 'F', 'G', 'G'],
      ['C', 'E', 'G', 'C'],
    ]
      .map(
        (chord, i) => `<measure number="${i + 1}">
      ${i === 0 ? '<attributes><divisions>1</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>' : ''}
      ${chord
        .map(
          (step, j) =>
            `<note>${j > 0 ? '<chord/>' : ''}<pitch><step>${step}</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note>`,
        )
        .join('')}
    </measure>`,
      )
      .join('')}
  </part>
</score-partwise>`;

test('detects the key of a plain C major progression', async () => {
  const score = parseXmlString(CADENCE_XML);
  const analysis = analyzeScore(score);
  assert.equal(analysis.overallKey?.key, 'C major');
  assert.ok((analysis.overallKeyConfidence ?? 0) > 0.5, 'confidence should be meaningful');
});

test('reads Roman numerals, opening and closing on the tonic', async () => {
  const score = parseXmlString(CADENCE_XML);
  const { chordAnalyses } = analyzeScore(score);
  assert.ok(chordAnalyses.length >= 4, 'one reading per chord at least');
  assert.equal(chordAnalyses[0].primary, 'I');
  assert.equal(chordAnalyses[chordAnalyses.length - 1].primary, 'I');
});

test('accepts a flat note list without any MusicXML', () => {
  // The other way in: whatever an editor already holds in memory.
  const score = compositionDataToScore({
    notes: [
      { pitch: 'C4', duration: 4, beat: 1, measure: 1, voice: 1 },
      { pitch: 'E4', duration: 4, beat: 1, measure: 1, voice: 2 },
      { pitch: 'G4', duration: 4, beat: 1, measure: 1, voice: 3 },
      { pitch: 'G4', duration: 4, beat: 1, measure: 2, voice: 1 },
      { pitch: 'B4', duration: 4, beat: 1, measure: 2, voice: 2 },
      { pitch: 'D5', duration: 4, beat: 1, measure: 2, voice: 3 },
    ],
    timeSignature: [4, 4],
    keySignature: 'C major',
  });
  const analysis = analyzeScore(score);
  assert.ok(analysis.chordAnalyses.length > 0, 'should analyze a hand-built score');
  assert.equal(analysis.chordAnalyses[0].primary, 'I');
});

test('runs with no Node-only globals — the package is runtime-agnostic', async () => {
  // The reason this library exists rather than shelling out to music21: it has
  // to work in a browser, a Worker and an edge function. A Node builtin
  // creeping into the analyzer would break all three silently, since the test
  // suite itself runs in Node and would never notice.
  const { readdirSync, readFileSync } = await import('node:fs');
  const dir = new URL('../dist/', import.meta.url).pathname;
  const offenders = readdirSync(dir)
    .filter((f) => f.endsWith('.js'))
    .filter((f) => /require\(["']node:|from ["']node:(fs|path|os|child_process)/.test(readFileSync(dir + f, 'utf8')));
  assert.deepEqual(offenders, [], 'no analyzer module may import a Node builtin');
});
