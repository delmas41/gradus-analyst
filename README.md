# gradus-analyst

Music theory analysis in TypeScript. Roman numerals, key detection, modulation
and cadence classification, voice-leading checks — from MusicXML or from a plain
list of notes.

```bash
npm i gradus-analyst
```

```ts
import { readFileSync } from 'node:fs';
import { parseMxlBuffer, analyzeScore } from 'gradus-analyst';

const score = await parseMxlBuffer(readFileSync('symphony.mxl'));
const analysis = analyzeScore(score);

analysis.overallKey;        // { key: 'C minor', mode: 'minor', fifths: -3, ... }
analysis.chordAnalyses[0];  // { measure: 1, beat: 1, primary: 'i', tendencyTones: [...], ... }
analysis.cadences;          // [{ measure: 24, type: 'PAC' }, ...]
analysis.keySections;       // sustained modulations, with pivot chords and recap links
```

## Why this and not music21

[music21](https://web.mit.edu/music21/) is excellent and far broader than this.
Reach for it when you want a research toolkit and Python is fine.

This exists for the case music21 cannot serve: analysis that has to run **where
JavaScript runs** — in a browser, a Web Worker, an edge function, a Node
service — with no Python process to shell out to and no install step for your
users. It imports no Node builtins, which is enforced by a test rather than a
promise.

It is also faster by a wide margin: roughly 135 ms for 50 Bach chorales, about
40× music21's `roman.romanNumeralFromChord` on the same corpus.

On agreement, measured against music21 over 804 chord positions in 50 chorales:
exact Roman-numeral match on 65%, and of the disagreements a human adjudicated
40 in this library's favour against 5 for music21, with 46 defensible either way
and 7 that neither tool can label. It also declines to emit the phantom figures
(`IV7642` and similar) that a chord-template match produces on passing-tone
clusters. The benchmark is not published as part of this package — treat these
as the author's numbers on the author's corpus, and rerun them if it matters.

## What it does

| | |
|---|---|
| **Roman numerals** | 40+ chord categories: diatonic triads and sevenths in major and minor, secondary dominants (`V/x`, `V⁷/x`, `vii°/x`), Neapolitan, Italian/French/German augmented sixths, modal mixture, suspended and added-tone chords, incomplete sevenths, Picardy thirds |
| **Key detection** | Krumhansl-Schmuckler with the Aarden-Essen profile, reported with a confidence |
| **Hierarchical key** | Global key → sustained sections → per-phrase, with isolated short excursions smoothed out |
| **Modulation** | Section boundaries, the pivot chord that links them, and recapitulation variants matched by transposed pitch-class profile |
| **Cadences** | PAC, IAC, HC, DC, Plagal, Phrygian, per phrase |
| **Tendency tones** | Leading tones, chordal sevenths, suspensions, cadential 6-4, pedal points — tagged per chord |
| **Voice leading** | Parallel fifths and octaves, voice crossing, leap analysis |
| **Modes** | Dorian, Phrygian, Lydian, Mixolydian, Aeolian, Locrian |
| **Also** | Pitch-class set utilities, enharmonic respelling, per-instrument range validation |

## Three ways in

```ts
import {
  parseXmlString,          // MusicXML text
  parseMxlBuffer,          // compressed .mxl — Uint8Array or ArrayBuffer
  compositionDataToScore,  // a flat list of notes you already have
  analyzeScore,
} from 'gradus-analyst';
```

`compositionDataToScore` is the one to use from an editor: give it
`{ pitch, duration, beat, measure, voice }` per note and it builds the `Score`
that `analyzeScore` reads.

## What it does not do

Not a renderer, not a parser of anything but MusicXML, and not a corpus. It
reads a score and classifies what is there.

Its readings are a strong default, not an oracle. Harmonic analysis has
genuinely disputed cases — a passing chord that is either `IV⁶` or `V⁶⁄₅/V`
depending on how you hear the phrase — and where the reading is contested,
`chordAnalyses[].readings` carries the alternatives with their basis rather than
hiding the choice.

## Roman numeral notation

Output uses the characters the analysis literature uses — `V⁷`, `vii°`, `iiø⁷`,
`♭III`, `It+6`, `Ger+6`, `CT°⁷` — so labels can be printed directly. Every
reading also carries `rnAscii` for grepping and diffing.

## Provenance

Extracted from the analysis core of [Gradus](https://gradusmusic.com), a music
composition curriculum, where it reads student work and checks the curriculum's
own hand-authored score analyses. It is the same code, not a reimplementation.

MIT licensed.
