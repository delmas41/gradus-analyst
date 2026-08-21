// ─── lib/maestroAnalyst/xmlParser.ts ─────────────────────────────────────────
// Public XML parsing API for the maestroAnalyst module set.
//
// Wraps the low-level lib/musicxml/parser.ts functions and converts the
// ParseResult into the maestroAnalyst Score type via scoreFromParseResult().
//
// Consumers import from here (or from the index re-export) rather than
// reaching directly into lib/musicxml, keeping the boundary clean.

import { parseMusicXML, parseMXL } from './musicxml/parser.js';
import { scoreFromParseResult } from './scoreModel.js';
import type { Score } from './types.js';
import type { ParseResult } from './musicxml/types.js';

/**
 * Parse a raw MusicXML string (score-partwise format) into a maestroAnalyst
 * Score. Throws if the string is not valid score-partwise MusicXML.
 *
 * @example
 *   const score = parseXmlString(fs.readFileSync('bach.xml', 'utf8'));
 *   const analysis = analyzeScore(score);
 */
export function parseXmlString(xml: string): Score {
  const parsed: ParseResult = parseMusicXML(xml);
  return scoreFromParseResult(parsed);
}

/**
 * Parse a .mxl buffer (ZIP-compressed MusicXML) into a maestroAnalyst Score.
 * Accepts a Uint8Array or ArrayBuffer. Node's Buffer is a Uint8Array,
 * so `fs.readFileSync(...)` can be passed straight in.
 *
 * @example
 *   const buf = fs.readFileSync('bach.mxl');
 *   const score = await parseMxlBuffer(buf);
 */
export async function parseMxlBuffer(buf: Uint8Array | ArrayBuffer): Promise<Score> {
  // JSZip inside parseMXL accepts ArrayBuffer; coerce Buffer/Uint8Array.
  const ab: ArrayBuffer =
    buf instanceof ArrayBuffer
      ? buf
      : (buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);

  const parsed: ParseResult = await parseMXL(ab);
  return scoreFromParseResult(parsed);
}

/**
 * Low-level: parse MusicXML/MXL and return the raw ParseResult without
 * converting to a Score. Useful when you need the measure/part structure
 * directly (e.g., for per-measure Claude context strings).
 *
 * @example
 *   const { metadata, measures } = parseXmlToRaw(xml);
 */
export function parseXmlToRaw(xml: string): ParseResult {
  return parseMusicXML(xml);
}

/**
 * Low-level async variant for .mxl buffers → raw ParseResult.
 */
export async function parseMxlToRaw(buf: Uint8Array | ArrayBuffer): Promise<ParseResult> {
  const ab: ArrayBuffer =
    buf instanceof ArrayBuffer
      ? buf
      : (buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
  return parseMXL(ab);
}
