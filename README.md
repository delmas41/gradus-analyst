# gradus-analyst

**The Gradus Harmonic Analyzer** — music theory analysis in TypeScript. Roman
numerals, key detection, modulation and cadence classification, voice-leading
checks — from MusicXML or from a plain list of notes. The same engine powers the
`theory_*` tools in the [@gradusmusic/notation-mcp](https://www.npmjs.com/package/@gradusmusic/notation-mcp)
MCP server; this package is the library form.

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
analysis.keySections;       // sustained modulations, with pivots, recap links, sponsorship
analysis.chordAnalyses[n].pedal;  // { pc: 0, degree: '1' } on slices over a pedal point
analysis.textures;          // per-measure: 'chordal' | 'unison' | 'octaves' | 'bare-fifth' | ...
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
| **Hierarchical key** | Global key → sustained sections → per-phrase, with isolated short excursions smoothed out. Long spans with no fermatas to segment on get a Viterbi-smoothed per-measure region tier instead of inheriting the global key. Key names follow the score's spelling — a flat-spelled D♭ zone is `Gb major`, never `F# major` |
| **Modulation** | Section boundaries, the pivot chord that links them, and recapitulation variants matched by transposed pitch-class profile. Each section reports `sponsorship`: `'cadential'` when a real dominant-with-leading-tone verticality lands on its tonic inside the section, `'unsponsored'` when the key is asserted by pitch statistics alone |
| **Texture** | Per-measure classification from per-onset verticality: `chordal`, `unison`, `octaves`, `bare-fifth`, `bare-third`, `dyad`, `silence`. A bar that never stacks two pitch classes is a line, and its Roman numeral is advisory |
| **Pedal points** | Detected by divergence, not sustain: a bass pitch class held (or re-struck — timpani count) while the harmony above moves away from it. On those slices the reading is the upper structure, with the pedal reported alongside as `pedal: { pc, degree }` — never folded into a wrong inversion |
| **Cadences** | PAC, IAC, HC, DC, Plagal, Phrygian, per phrase |
| **Tendency tones** | Leading tones, chordal sevenths, suspensions, cadential 6-4, pedal points — tagged per chord |
| **Voice leading** | Parallel fifths and octaves, voice crossing, leap analysis |
| **Modes** | Dorian, Phrygian, Lydian, Mixolydian, Aeolian, Locrian |
| **Also** | Pitch-class set utilities, enharmonic respelling, per-instrument range validation |

### Pedal points

A chord-template match cannot read a pedal point: aggregate every sounding
pitch over a sustained foreign bass and you get either a wrong inversion or an
unlabelable cluster. This library detects the pedal first and then reads the
upper structure as the chord — in the opening of Beethoven's First (mm. 33–38,
cellos, basses and timpani holding C while the harmony above alternates tonic
and dominant), the dominant bars come back as `V` with
`pedal: { pc: 0, degree: '1' }`, the "V (ped 1)" convention, rather than as a
mystery chord over a wrong bass. The definition is the divergence, not the
sustain: four bars of root-position tonic is not a pedal, and neither is a
walking bass. music21's Roman-numeral path has no equivalent of this — a
factual gap as of music21 9.x, easy to check against your own scores rather
than taking this paragraph's word for it.

### Bare textures

The dual failure mode: a bar of octave 8ths on D and A — Beethoven's Ninth
opens with ten of them — satisfies a "D5" chord template, and a one-voice
arpeggio visits three pitch classes without ever sounding two at once. Both
would come back labelled as chords from any bar-level pitch aggregate.
`analysis.textures` classifies every measure from its **per-onset**
verticality instead: what actually sounds together, weighted by duration. A
bar that never stacks two pitch classes is `unison` or `octaves`; two classes
a fifth apart are `bare-fifth`; the Roman numeral for such bars is still
emitted but should be treated as advisory — prose built on these readings
renders them "(unison)", "(bare 5th)", not as chords. The classifications
were adjudicated against a 384-item human review of orchestral scores
(Beethoven, Brahms, Bruckner, Dvořák, Tchaikovsky symphonies) before
shipping.

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

### Parsing untrusted uploads

Zip inflation is attacker-controlled amplification — deflate reaches roughly
1000:1, so a 2 MB upload can expand toward 2 GB in a single string. When the
`.mxl` comes from an upload rather than your own disk, use the parser subpath
and cap the decompression:

```ts
import { parseMXL, MxlDecompressionLimitError } from 'gradus-analyst/musicxml/parser';

const raw = await parseMXL(arrayBuffer, { maxDecompressedBytes: 100_000_000 });
// throws MxlDecompressionLimitError the moment an entry inflates past the cap —
// enforced during inflation, not by trusting the zip directory's declared sizes
```

`parseMxlBuffer` from the main entry stays option-free and is fine for trusted
local files.

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

Gradus is a music-composition curriculum for homeschool families; it builds and gives away free music tools for AI agents. This
library ([gradusmusic.com](https://gradusmusic.com)) is the analysis engine
extracted from that curriculum, where it reads student work and checks the
hand-authored score analyses. It is the same code, not a reimplementation.

MIT licensed.
