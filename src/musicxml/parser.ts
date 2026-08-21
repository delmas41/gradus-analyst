import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import type {
  ParseResult,
  ParsedMeasure,
  ParsedPartMeasure,
  ParsedNote,
  ScoreMetadata,
} from './types.js';

// ── Pitch helpers ───────────────────────────────────────────────────────────

const STEP_TO_NAME: Record<string, string> = {
  C: 'C', D: 'D', E: 'E', F: 'F', G: 'G', A: 'A', B: 'B',
};

function pitchToString(pitchNode: Record<string, unknown>, transpose?: { diatonic: number; chromatic: number; octaveChange: number }): string {
  const stepName = String(pitchNode.step);
  const alter = Number(pitchNode.alter || 0);
  const octave = Number(pitchNode.octave ?? 4);

  if (!transpose || (transpose.diatonic === 0 && transpose.chromatic === 0 && transpose.octaveChange === 0)) {
    let accidental = '';
    if (alter === 1) accidental = '#';
    else if (alter === -1) accidental = 'b';
    else if (alter === 2) accidental = '##';
    else if (alter === -2) accidental = 'bb';
    return `${stepName}${accidental}${octave}`;
  }

  // Apply transposition: shift diatonic step by `diatonic`, then re-derive alter so the
  // total semitone shift equals `chromatic`. Octave changes per `octaveChange` and via
  // diatonic step wrap.
  const STEPS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
  const STEP_SEMI: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const startIdx = STEPS.indexOf(stepName);
  if (startIdx < 0) return `${stepName}${octave}`;

  const newStepIdx = startIdx + transpose.diatonic;
  const octaveShift = Math.floor(newStepIdx / 7) + (transpose.octaveChange || 0);
  const wrappedIdx = ((newStepIdx % 7) + 7) % 7;
  const newStep = STEPS[wrappedIdx];
  const newOctave = octave + octaveShift;

  // Original concert semitone = (octave * 12) + step + alter (relative)
  // Transposed semitone = original + chromatic + 12*octaveChange
  // We need newAlter such that newStep + newAlter (within new octave) matches that semitone.
  const originalSemi = octave * 12 + STEP_SEMI[stepName] + alter;
  const targetSemi = originalSemi + transpose.chromatic + 12 * (transpose.octaveChange || 0);
  const newStepSemi = newOctave * 12 + STEP_SEMI[newStep];
  let newAlter = targetSemi - newStepSemi;
  // Clamp to ±2
  if (newAlter > 2) newAlter = 2;
  if (newAlter < -2) newAlter = -2;

  let accidental = '';
  if (newAlter === 1) accidental = '#';
  else if (newAlter === -1) accidental = 'b';
  else if (newAlter === 2) accidental = '##';
  else if (newAlter === -2) accidental = 'bb';
  return `${newStep}${accidental}${newOctave}`;
}

// ── Key signature helpers ───────────────────────────────────────────────────

const MAJOR_KEYS = ['Cb','Gb','Db','Ab','Eb','Bb','F','C','G','D','A','E','B','F#','C#'];
const MINOR_KEYS = ['Ab','Eb','Bb','F','C','G','D','A','E','B','F#','C#','G#','D#','A#'];

function fifthsToKey(fifths: number, mode?: string): string {
  const idx = fifths + 7; // -7 maps to index 0
  if (mode === 'minor') {
    return `${MINOR_KEYS[idx] || '?'} minor`;
  }
  return `${MAJOR_KEYS[idx] || '?'} major`;
}

// ── XML parsing ─────────────────────────────────────────────────────────────

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: (name) => {
    // Force arrays for elements that can repeat
    return [
      'part', 'measure', 'note',
      'score-part', 'direction', 'direction-type',
      'dynamics', 'words', 'articulations',
    ].includes(name);
  },
  parseTagValue: true,
  trimValues: true,
});

export interface MxlParseOptions {
  /**
   * Cap on the DECOMPRESSED size of any entry read from the archive.
   *
   * Zip inflation is attacker-controlled amplification: deflate reaches about
   * 1000:1, so a 2 MB upload can expand toward 2 GB in a single string. Callers
   * reading trusted local files (the score-page generator, the sketchbook
   * importer) pass nothing and behave exactly as before; the public
   * /api/v1/engraving/check route caps at 100 MB — the largest real score in
   * the catalog (Holst, complete) inflates to 57 MB, so every legitimate score
   * clears the cap with 2x headroom. Enforced DURING inflation via JSZip's
   * internal stream, not by trusting the zip directory's declared sizes, which
   * a hostile archive simply lies about.
   */
  maxDecompressedBytes?: number;
}

/** Thrown when an archive entry inflates past `maxDecompressedBytes`. */
export class MxlDecompressionLimitError extends Error {
  constructor(cap: number) {
    super(`Compressed archive entry inflates past the ${Math.round(cap / 1e6)} MB decompression limit`);
    this.name = 'MxlDecompressionLimitError';
  }
}

/**
 * `internalStream` is documented public JSZip API (streaming inflation with
 * pause/resume) but the typings bundled with jszip 3.10 omit it — verified
 * present at runtime. Typed narrowly here rather than casting to `any`, so a
 * future JSZip upgrade that really removes it fails compilation in one place.
 */
interface JSZipStreaming {
  internalStream(type: 'uint8array'): {
    on(event: 'data', cb: (chunk: Uint8Array) => void): void;
    on(event: 'error', cb: (err: Error) => void): void;
    on(event: 'end', cb: () => void): void;
    pause(): void;
    resume(): void;
  };
}

/** Inflate one zip entry to text, aborting the moment the cap is exceeded. */
function inflateCapped(file: JSZip.JSZipObject, cap: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    let done = false;
    const stream = (file as unknown as JSZipStreaming).internalStream('uint8array');
    stream.on('data', (chunk: Uint8Array) => {
      if (done) return;
      total += chunk.length;
      if (total > cap) {
        done = true;
        stream.pause();
        reject(new MxlDecompressionLimitError(cap));
        return;
      }
      chunks.push(chunk);
    });
    stream.on('error', (err: Error) => {
      if (!done) { done = true; reject(err); }
    });
    stream.on('end', () => {
      if (done) return;
      done = true;
      const buf = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) { buf.set(c, off); off += c.length; }
      resolve(new TextDecoder().decode(buf));
    });
    stream.resume();
  });
}

/**
 * Parse a .mxl (compressed MusicXML) buffer into structured data.
 */
export async function parseMXL(buffer: ArrayBuffer, opts?: MxlParseOptions): Promise<ParseResult> {
  const zip = await JSZip.loadAsync(buffer);
  const cap = opts?.maxDecompressedBytes;
  const read = (file: JSZip.JSZipObject): Promise<string> =>
    cap ? inflateCapped(file, cap) : file.async('string');

  // Find the rootfile from META-INF/container.xml, or fall back to first .xml
  let xmlContent: string | null = null;

  const containerFile = zip.file('META-INF/container.xml');
  if (containerFile) {
    const containerXml = await read(containerFile);
    const container = xmlParser.parse(containerXml);
    const rootfiles = container?.container?.rootfiles?.rootfile;
    const rootfilePath = Array.isArray(rootfiles)
      ? rootfiles[0]?.['@_full-path']
      : rootfiles?.['@_full-path'];
    if (rootfilePath) {
      const rootFile = zip.file(rootfilePath);
      if (rootFile) {
        xmlContent = await read(rootFile);
      }
    }
  }

  // Fallback: find any .xml file that isn't container.xml
  if (!xmlContent) {
    for (const [path, file] of Object.entries(zip.files)) {
      if (path.endsWith('.xml') && !path.includes('META-INF') && !file.dir) {
        xmlContent = await read(file);
        break;
      }
    }
  }

  if (!xmlContent) {
    throw new Error('No MusicXML file found in MXL archive');
  }

  return parseMusicXML(xmlContent);
}

/**
 * Parse raw MusicXML string into structured data.
 */
export function parseMusicXML(xml: string): ParseResult {
  const doc = xmlParser.parse(xml);
  const scorePartwise = doc['score-partwise'];
  if (!scorePartwise) {
    throw new Error('Not a valid score-partwise MusicXML document');
  }

  // ── Extract metadata ──────────────────────────────────────────────────

  const work = scorePartwise.work;
  const identification = scorePartwise.identification;
  const partListRaw = scorePartwise['part-list']?.['score-part'] || [];
  const partList = Array.isArray(partListRaw) ? partListRaw : [partListRaw];

  const partNames: string[] = [];
  const partIds: string[] = [];
  for (const sp of partList) {
    partIds.push(sp['@_id'] || `P${partIds.length + 1}`);
    partNames.push(sp['part-name'] || `Part ${partNames.length + 1}`);
  }

  let composer: string | undefined;
  if (identification?.creator) {
    const creators = Array.isArray(identification.creator)
      ? identification.creator
      : [identification.creator];
    const composerEntry = creators.find(
      (c: Record<string, unknown>) => c['@_type'] === 'composer'
    );
    composer = composerEntry?.['#text'] || composerEntry || creators[0]?.['#text'] || String(creators[0]);
  }

  const title = work?.['work-title'] || scorePartwise['movement-title'] || undefined;

  // ── Parse parts and measures ──────────────────────────────────────────

  const partsRaw = scorePartwise.part || [];
  const parts = Array.isArray(partsRaw) ? partsRaw : [partsRaw];

  // Find total measure count from first part
  const firstPartMeasures = Array.isArray(parts[0]?.measure) ? parts[0].measure : [parts[0]?.measure].filter(Boolean);
  const totalMeasures = firstPartMeasures.length;

  // Defaults
  let globalDivisions = 1;
  let globalKeyFifths = 0;
  let globalKeyMode = 'major';
  let globalTimeBeats = '4';
  let globalTimeBeatType = '4';

  // Build measure-indexed structure
  const measuresMap = new Map<number, ParsedPartMeasure[]>();

  for (let pIdx = 0; pIdx < parts.length; pIdx++) {
    const part = parts[pIdx];
    const partId = partIds[pIdx] || `P${pIdx + 1}`;
    const partName = partNames[pIdx] || `Part ${pIdx + 1}`;
    const rawMeasures = Array.isArray(part.measure) ? part.measure : [part.measure].filter(Boolean);

    let currentDivisions = globalDivisions;
    let currentKeyFifths = globalKeyFifths;
    let currentKeyMode = globalKeyMode;
    let currentTimeBeats = globalTimeBeats;
    let currentTimeBeatType = globalTimeBeatType;
    let currentClef = '';
    let currentTempo: number | undefined;
    let currentTempoText: string | undefined;
    let currentTranspose: { diatonic: number; chromatic: number; octaveChange: number } | undefined;

    for (const mRaw of rawMeasures) {
      const mNum = Number(mRaw['@_number']) || 0;
      if (!measuresMap.has(mNum)) {
        measuresMap.set(mNum, []);
      }

      const notes: ParsedNote[] = [];
      const dynamics: string[] = [];
      const directions: string[] = [];
      let measureClef = currentClef;
      let measureKey = currentKeyFifths;
      let measureKeyMode = currentKeyMode;
      let measureTime = `${currentTimeBeats}/${currentTimeBeatType}`;
      let measureTempo = currentTempo;
      let measureTempoText = currentTempoText;

      // Process attributes (key, time, clef, divisions)
      const attrs = mRaw.attributes;
      if (attrs) {
        if (attrs.divisions) {
          currentDivisions = Number(attrs.divisions);
          if (pIdx === 0) globalDivisions = currentDivisions;
        }
        if (attrs.key) {
          const k = Array.isArray(attrs.key) ? attrs.key[0] : attrs.key;
          currentKeyFifths = Number(k.fifths ?? 0);
          currentKeyMode = k.mode || 'major';
          measureKey = currentKeyFifths;
          measureKeyMode = currentKeyMode;
          if (pIdx === 0) {
            globalKeyFifths = currentKeyFifths;
            globalKeyMode = currentKeyMode;
          }
        }
        if (attrs.time) {
          const t = Array.isArray(attrs.time) ? attrs.time[0] : attrs.time;
          currentTimeBeats = String(t.beats ?? '4');
          currentTimeBeatType = String(t['beat-type'] ?? '4');
          measureTime = `${currentTimeBeats}/${currentTimeBeatType}`;
          if (pIdx === 0) {
            globalTimeBeats = currentTimeBeats;
            globalTimeBeatType = currentTimeBeatType;
          }
        }
        if (attrs.clef) {
          const c = Array.isArray(attrs.clef) ? attrs.clef[0] : attrs.clef;
          const sign = c.sign || 'G';
          const line = c.line || (sign === 'F' ? 4 : 2);
          measureClef = `${sign}${line}`;
          currentClef = measureClef;
        }
        if (attrs.transpose) {
          const tp = Array.isArray(attrs.transpose) ? attrs.transpose[0] : attrs.transpose;
          currentTranspose = {
            diatonic: Number(tp.diatonic ?? 0),
            chromatic: Number(tp.chromatic ?? 0),
            octaveChange: Number(tp['octave-change'] ?? 0),
          };
        }
      }

      // Process directions (tempo, dynamics text, rehearsal marks)
      const dirArr = Array.isArray(mRaw.direction) ? mRaw.direction : mRaw.direction ? [mRaw.direction] : [];
      for (const dir of dirArr) {
        // Tempo
        if (dir.sound?.['@_tempo']) {
          measureTempo = Number(dir.sound['@_tempo']);
          currentTempo = measureTempo;
        }
        // Direction types
        const dtArr = Array.isArray(dir['direction-type']) ? dir['direction-type'] : dir['direction-type'] ? [dir['direction-type']] : [];
        for (const dt of dtArr) {
          // Dynamics
          if (dt.dynamics) {
            const dynArr = Array.isArray(dt.dynamics) ? dt.dynamics : [dt.dynamics];
            for (const d of dynArr) {
              // Dynamics are encoded as empty child elements: <dynamics><ff/></dynamics>
              const keys = Object.keys(d).filter(k => !k.startsWith('@_'));
              dynamics.push(...keys);
            }
          }
          // Words (tempo text, expression marks)
          if (dt.words) {
            const wordsArr = Array.isArray(dt.words) ? dt.words : [dt.words];
            for (const w of wordsArr) {
              const raw = typeof w === 'string' ? w : (typeof w === 'object' && w !== null ? (w['#text'] ?? '') : w);
              const text = String(raw ?? '').trim();
              if (text) {
                directions.push(text);
                // Check if this is a tempo marking
                if (/allegro|andante|adagio|presto|moderato|largo|vivace|lento/i.test(text)) {
                  measureTempoText = text;
                  currentTempoText = text;
                }
              }
            }
          }
          // Rehearsal marks
          if (dt.rehearsal) {
            const r = typeof dt.rehearsal === 'string' ? dt.rehearsal : dt.rehearsal['#text'] || '';
            if (r) directions.push(`[${r}]`);
          }
        }
      }

      // Process notes
      const noteArr = Array.isArray(mRaw.note) ? mRaw.note : mRaw.note ? [mRaw.note] : [];
      // Track 1-based quarter-beat position within this measure. Accumulated
      // from each non-chord-member note's duration. Chord members share the
      // beat position of the preceding note.
      let beatPos = 1;
      let lastBeats = 0;
      for (const n of noteArr) {
        const isRest = n.rest !== undefined;
        const isChordMember = n.chord !== undefined;
        const duration = Number(n.duration || 0);
        const voice = Number(n.voice || 1);
        const staff = n.staff ? Number(n.staff) : undefined;
        const type = n.type || 'quarter';
        const beatsValue = currentDivisions > 0 ? duration / currentDivisions : 0;

        let pitch = 'rest';
        if (!isRest && n.pitch) {
          pitch = pitchToString(n.pitch, currentTranspose);
        }

        // Note-level dynamics
        let dynamic: string | undefined;
        if (n.dynamics) {
          dynamic = String(n.dynamics);
        }

        // Articulations
        let articulation: string | undefined;
        if (n.notations?.articulations) {
          const artKeys = Object.keys(
            Array.isArray(n.notations.articulations)
              ? n.notations.articulations[0]
              : n.notations.articulations
          ).filter(k => !k.startsWith('@_'));
          if (artKeys.length) articulation = artKeys.join(', ');
        }

        const isTied = n.tie !== undefined || n.notations?.tied !== undefined;

        // Refined tie direction. `<tie>` can appear once or twice on a note;
        // a stop+start pair (a tie passing through this note) becomes 'both'.
        let tieDirection: 'start' | 'stop' | 'both' | undefined;
        if (n.tie !== undefined) {
          const ties = Array.isArray(n.tie) ? n.tie : [n.tie];
          const types = ties.map((t: Record<string, unknown> | string) =>
            typeof t === 'string' ? '' : String(t['@_type'] ?? '')
          ).filter(Boolean);
          const hasStart = types.includes('start');
          const hasStop = types.includes('stop');
          if (hasStart && hasStop) tieDirection = 'both';
          else if (hasStart) tieDirection = 'start';
          else if (hasStop) tieDirection = 'stop';
        }

        // Fermata flag. `<notations><fermata/></notations>` — empty element,
        // so we test for the key's existence rather than its value.
        const fermata = n.notations
          && (n.notations.fermata !== undefined
              || (Array.isArray(n.notations) && n.notations.some((x: Record<string, unknown>) => x.fermata !== undefined)));

        // Tuplet info from `<time-modification>`. Triplet = 3:2, quintuplet = 5:4, etc.
        let tuplet: { actual: number; normal: number } | undefined;
        const tm = n['time-modification'];
        if (tm) {
          const actualNotes = Number(tm['actual-notes']);
          const normalNotes = Number(tm['normal-notes']);
          if (actualNotes > 0 && normalNotes > 0) {
            tuplet = { actual: actualNotes, normal: normalNotes };
          }
        }

        // Beat-position accounting. A chord-member shares the previous note's
        // beat position; a sequential note advances by the previous note's
        // duration in beats.
        let thisBeatPos: number;
        if (isChordMember) {
          thisBeatPos = beatPos;
        } else {
          beatPos += lastBeats;
          thisBeatPos = beatPos;
          lastBeats = beatsValue;
        }

        notes.push({
          pitch,
          duration,
          beats: beatsValue,
          type,
          voice,
          staff,
          isRest,
          isTied: isTied || undefined,
          isChordMember: isChordMember || undefined,
          dynamic,
          articulation,
          beatPosition: thisBeatPos,
          fermata: fermata ? true : undefined,
          tieDirection,
          tuplet,
        });
      }

      const partMeasure: ParsedPartMeasure = {
        partId,
        partName,
        notes,
        clef: measureClef || undefined,
        keySignature: fifthsToKey(measureKey, measureKeyMode),
        keySig: measureKey,
        keyMode: measureKeyMode,
        timeSignature: measureTime,
        tempo: measureTempo,
        tempoText: measureTempoText,
        dynamics: dynamics.length > 0 ? dynamics : undefined,
        directions: directions.length > 0 ? directions : undefined,
      };

      measuresMap.get(mNum)!.push(partMeasure);
    }
  }

  // ── Build sorted measures array with Claude context ───────────────────

  const sortedNumbers = Array.from(measuresMap.keys()).sort((a, b) => a - b);

  const measures: ParsedMeasure[] = sortedNumbers.map((num) => {
    const partMeasures = measuresMap.get(num)!;
    return {
      number: num,
      parts: partMeasures,
      claudeContext: buildClaudeContext(num, partMeasures),
    };
  });

  const metadata: ScoreMetadata = {
    title,
    composer: typeof composer === 'string' ? composer : undefined,
    partNames,
    partIds,
    divisions: globalDivisions,
    totalMeasures,
    keySignature: fifthsToKey(globalKeyFifths, globalKeyMode),
    timeSignature: `${globalTimeBeats}/${globalTimeBeatType}`,
  };

  return { metadata, measures };
}

// ── Claude context builder ──────────────────────────────────────────────────

function buildClaudeContext(measureNum: number, parts: ParsedPartMeasure[]): string {
  const lines: string[] = [`M${measureNum}:`];

  for (const part of parts) {
    const noteStrs = part.notes.map((n) => {
      if (n.isRest) return `rest(${n.type})`;
      let s = n.pitch;
      if (n.type !== 'quarter') s += `(${n.type})`;
      if (n.isChordMember) s = `+${s}`;
      if (n.isTied) s += '~';
      if (n.articulation) s += `[${n.articulation}]`;
      return s;
    });

    let partLine = `  ${part.partName}: ${noteStrs.join(' ')}`;

    const extras: string[] = [];
    if (part.dynamics?.length) extras.push(part.dynamics.join(','));
    if (part.directions?.length) extras.push(part.directions.join('; '));
    if (part.tempo) extras.push(`♩=${part.tempo}`);
    if (extras.length) partLine += ` | ${extras.join(' | ')}`;

    lines.push(partLine);
  }

  // Add key/time if changed (check first part)
  const first = parts[0];
  if (first) {
    const meta: string[] = [];
    if (first.keySignature) meta.push(`Key: ${first.keySignature}`);
    if (first.timeSignature) meta.push(`Time: ${first.timeSignature}`);
    if (meta.length) lines.push(`  [${meta.join(', ')}]`);
  }

  return lines.join('\n');
}
