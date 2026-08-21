import { test } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';

/**
 * The MXL decompression cap. Zip inflation is attacker-controlled
 * amplification (deflate reaches ~1000:1), so parseMXL takes
 * { maxDecompressedBytes } and aborts DURING inflation — not by trusting the
 * zip directory's declared sizes — throwing MxlDecompressionLimitError.
 *
 * The parser module is public API via the `gradus-analyst/musicxml/parser`
 * subpath (the analyst barrel's parseMxlBuffer covers the trusted-file case
 * and takes no options). Importing by self-reference here proves the exports
 * map actually exposes it — a plain relative import would pass even if the
 * subpath were missing.
 */

const SMALL_XML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1"><measure number="1">
    <attributes><divisions>1</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
    <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note>
  </measure></part>
</score-partwise>`;

const CONTAINER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<container><rootfiles><rootfile full-path="score.xml"/></rootfiles></container>`;

async function buildMxl() {
  const zip = new JSZip();
  zip.file('META-INF/container.xml', CONTAINER_XML);
  zip.file('score.xml', SMALL_XML);
  return zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' });
}

test('the musicxml/parser subpath is exported and parses uncapped', async () => {
  const { parseMXL } = await import('gradus-analyst/musicxml/parser');
  const result = await parseMXL(await buildMxl());
  assert.equal(result.measures.length, 1);
  assert.equal(result.measures[0].parts[0].notes[0].pitch, 'C4');
});

test('maxDecompressedBytes aborts inflation with MxlDecompressionLimitError', async () => {
  const { parseMXL, MxlDecompressionLimitError } = await import('gradus-analyst/musicxml/parser');
  const mxl = await buildMxl();
  await assert.rejects(
    () => parseMXL(mxl, { maxDecompressedBytes: 16 }),
    (err) => err instanceof MxlDecompressionLimitError,
    'a 16-byte cap must reject this archive during inflation',
  );
  // The same archive under a generous cap parses fine — the cap is a limit,
  // not a mode switch.
  const ok = await parseMXL(mxl, { maxDecompressedBytes: 10_000_000 });
  assert.equal(ok.measures.length, 1);
});
