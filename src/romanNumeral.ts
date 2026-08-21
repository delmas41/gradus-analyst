// ─── lib/musicology/romanNumeral.ts ──────────────────────────────────────────
// Chord pcs + local key → Roman-numeral reading(s).
//
// Output uses the curriculum prose vocabulary verbatim. Where a chord has
// multiple valid readings (the Tristan chord, ambiguous augmented sixths) we
// return all of them — the consumer reads `.primary` for a single label or
// `.readings` for the whole list.
//
// Recognized vocabulary (one row per Step it is taught in):
//
//   Step 14–16  Diatonic triads, sevenths, figured-bass inversions
//   Step 22     Secondary dominants V/X, V⁷/X, vii°/X, vii°⁷/X
//   Step 25     Borrowed chords iv (in major), ♭III, ♭VI, ♭VII, i (in major)
//   Step 26     CT°⁷ (common-tone diminished seventh)
//   Step 27     Neapolitan (♭II, ♭II⁶), augmented sixths (It+6, Fr+6, Ger+6)
//   Step 30     Tristan chord (multi-reading)
//
// Modal-color extensions (added when extending the analyst beyond Step 30's
// labeled vocabulary; low-to-medium confidence to keep clean diatonic
// matches preferred):
//   - Dorian ii (minor mode): minor triad or min7 on 2̂ with raised 6̂
//   - Mixolydian v (major mode): minor triad or min7 on 5̂ (♭7̂ flavor)
//   - Lydian ♯IV (major mode): major triad on ♯4̂
//   - Parallel-minor i⁷ (major mode): min7 on tonic
//   - Harmonic-minor vii° (minor mode): diminished triad on raised 7̂
//   - Harmonic-minor vii°⁷ (minor mode): fully-dim seventh on raised 7̂
//
// Incomplete-chord extensions:
//   - 3-of-4 subset of any tonally active seventh in the key
//     (V⁷, vii°⁷, viiø⁷, and their secondary versions)
//   - 2-of-3 subset of any tonally active triad in the key
//   - Basis carries "(implied root missing)" when the root pc is absent,
//     "(incomplete)" otherwise. Confidence ~0.7.
//
// Suspended / added-note chords (voice-leading-derived):
//   - sus2 / sus4 — 3rd replaced by 2 or 4 above a kept 5th
//   - ⁷sus4 / ⁷sus2 — seventh-chord versions with the 3rd replaced
//   - sus2add4 — quartal: root + 2 + 4 + 5 with no 3
//   - add9 / add6 / add4 — diatonic triad with an added non-chord tone
//   - Labels read as e.g. "V⁷sus4/V", "Iadd9", "Vsus4". Bass on the
//     candidate root strongly favors that root; lookahead confirms the
//     suspension when the sus tone resolves by step in the next chord.
//
// Lookahead-based disambiguation:
//   - `analyzeChord` accepts an optional `nextChord` for ambiguity resolution.
//     When a chord has two plausible readings (e.g., Dorian ii⁷ vs passing
//     vii°/V), the next chord's identity is used to pick the right reading.
//
// Cross-key fallback:
//   - When no match is found in the local key, modal and incomplete patterns
//     also try the relative key (major ↔ minor) and, for major mode, the
//     subdominant minor (key's iv as a minor tonic). This catches the common
//     case where Krumhansl placed a passing tonicization in the "wrong" key.
//
// Calibration target: match Music21 on the cases the curriculum teaches.
// Stages IX–X exotic chords return a low-confidence "?" rather than a wrong
// label.

import { pc, namePc, NOTE_NAMES } from './pitch.js';
import { tonicPc, keyMode, parallelKey, relativeKey } from './scale.js';
import type {
  Chord, RomanNumeralReading, ChordAnalysis, Perspectives,
} from './types.js';
import type { TendencyToneTag } from './tendencyTones.js';

// ─── PC-set helpers ──────────────────────────────────────────────────────────

/** Sorted, deduped pc array from a list. */
function uniqPcs(pcs: number[]): number[] {
  return Array.from(new Set(pcs.map(p => ((p % 12) + 12) % 12))).sort((a, b) => a - b);
}

/** Try every pc as the chord root; for each, compute the intervals from root
 *  present in the chord. */
interface ChordIdentity {
  root: number;
  type: 'major' | 'minor' | 'diminished' | 'augmented' | 'dom7' | 'maj7' | 'min7' | 'halfdim7' | 'dim7' | 'minMaj7' | 'unknown';
  intervals: number[];
  inversion: 'root' | '1st' | '2nd' | '3rd';
}

function intervalsFromRoot(pcs: number[], root: number): number[] {
  return pcs.map(p => ((p - root) % 12 + 12) % 12).sort((a, b) => a - b);
}

function classifyTriad(intervals: number[]): ChordIdentity['type'] | null {
  const set = new Set(intervals);
  const has = (i: number) => set.has(i);
  // Triads (3 distinct intervals from root, including root)
  if (has(0) && has(4) && has(7)) return 'major';
  if (has(0) && has(3) && has(7)) return 'minor';
  if (has(0) && has(3) && has(6)) return 'diminished';
  if (has(0) && has(4) && has(8)) return 'augmented';
  return null;
}

function classifySeventh(intervals: number[]): ChordIdentity['type'] | null {
  const set = new Set(intervals);
  const has = (i: number) => set.has(i);
  // Sevenths
  if (has(0) && has(4) && has(7) && has(10)) return 'dom7';
  if (has(0) && has(4) && has(7) && has(11)) return 'maj7';
  if (has(0) && has(3) && has(7) && has(10)) return 'min7';
  if (has(0) && has(3) && has(6) && has(10)) return 'halfdim7';
  if (has(0) && has(3) && has(6) && has(9)) return 'dim7';
  if (has(0) && has(3) && has(7) && has(11)) return 'minMaj7';
  return null;
}

/** Try all 12 pcs as root, score them: best identity = lowest position-in-chord
 *  for the implied root. Bass on the root → root position; bass on the third →
 *  first inversion; etc. */
function inversionFromBass(rootPc: number, bassPc: number, type: ChordIdentity['type']): ChordIdentity['inversion'] {
  const ic = ((bassPc - rootPc) % 12 + 12) % 12;
  // Triads
  if (type === 'major' || type === 'minor' || type === 'diminished' || type === 'augmented') {
    if (ic === 0) return 'root';
    if (ic === 3 || ic === 4) return '1st';
    if (ic === 6 || ic === 7 || ic === 8) return '2nd';
  }
  // Sevenths
  if (ic === 0) return 'root';
  if (ic === 3 || ic === 4) return '1st';
  if (ic === 6 || ic === 7) return '2nd';
  if (ic === 9 || ic === 10 || ic === 11) return '3rd';
  return 'root';
}

/** The pc-intervals of each triad pattern from the root. */
export const TRIAD_PATTERNS: Record<'major' | 'minor' | 'diminished' | 'augmented', number[]> = {
  major: [0, 4, 7],
  minor: [0, 3, 7],
  diminished: [0, 3, 6],
  augmented: [0, 4, 8],
};

/** The pc-intervals of each seventh-chord pattern from the root. Mirrors the
 *  classifications in `classifySeventh` — exported so chord-tone-completeness
 *  checks (lib/chordCompleteness.ts) share one canonical set of templates. */
export const SEVENTH_PATTERNS: Record<'dom7' | 'maj7' | 'min7' | 'halfdim7' | 'dim7' | 'minMaj7', number[]> = {
  dom7:     [0, 4, 7, 10],
  maj7:     [0, 4, 7, 11],
  min7:     [0, 3, 7, 10],
  halfdim7: [0, 3, 6, 10],
  dim7:     [0, 3, 6, 9],
  minMaj7:  [0, 3, 7, 11],
};

/** Identify a chord's root, type, and inversion. Tries every pc as root and
 *  picks the best fit. The fit is scored by *coverage*: a 4-note seventh that
 *  accounts for all four pcs beats a 3-note triad with one unaccounted note,
 *  even when the triad would be in root position. This prevents the common
 *  mis-classification where (e.g.) G♯-B-D-E in A minor reads as G♯ diminished
 *  triad (root inversion) instead of E dominant 7 (first inversion). */
function identifyChord(pcs: number[], bassPc: number | null): ChordIdentity {
  const u = uniqPcs(pcs);
  let best: ChordIdentity = {
    root: u[0] ?? 0,
    type: 'unknown',
    intervals: [],
    inversion: 'root',
  };
  let bestScore = -1;

  for (const candidate of u) {
    const intervals = intervalsFromRoot(u, candidate);
    const intervalSet = new Set(intervals);

    // Try seventh classifications first — they account for 4 pcs.
    let type: ChordIdentity['type'] | null = null;
    let coverage = 0;
    if (u.length >= 4) {
      type = classifySeventh(intervals);
      if (type) coverage = 4;
    }

    // Fall back to triad classification (3 pcs accounted for; any extra pcs
    // are treated as added tones / NCTs).
    if (!type) {
      type = classifyTriad(intervals.filter(i => i === 0 || i === 3 || i === 4 || i === 6 || i === 7 || i === 8));
      if (type && (type === 'major' || type === 'minor' || type === 'diminished' || type === 'augmented')) {
        const pattern = TRIAD_PATTERNS[type];
        coverage = pattern.filter(p => intervalSet.has(p)).length;
      }
    }

    if (!type) continue;
    const inv = bassPc !== null ? inversionFromBass(candidate, bassPc, type) : 'root';

    // Score: complete coverage dominates; tie-break by preferring root inversion.
    const score = coverage * 10 + (inv === 'root' ? 1 : 0);
    if (score > bestScore) {
      best = { root: candidate, type, intervals, inversion: inv };
      bestScore = score;
    }
  }
  return best;
}

// ─── Roman-numeral string formatting ─────────────────────────────────────────

/** Convert a triad type + scale degree number to lower/upper-case RN. */
function rnTriadCase(degree: number, type: ChordIdentity['type']): string {
  const arabic = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII'][degree] ?? '?';
  if (type === 'minor' || type === 'diminished' || type === 'halfdim7' || type === 'min7' || type === 'minMaj7') {
    return arabic.toLowerCase();
  }
  return arabic;
}

/** Inversion suffix (figured-bass numerals).  */
function figuredBassFor(type: ChordIdentity['type'], inv: ChordIdentity['inversion']): string {
  const isSeventh = type === 'dom7' || type === 'maj7' || type === 'min7' || type === 'halfdim7' || type === 'dim7' || type === 'minMaj7';
  if (!isSeventh) {
    if (inv === '1st') return '6';
    if (inv === '2nd') return '64';
    return '';
  }
  if (inv === 'root') return '7';
  if (inv === '1st') return '65';
  if (inv === '2nd') return '43';
  if (inv === '3rd') return '42';
  return '7';
}

/** Render figured bass with Unicode superscripts: '6/5' → '⁶⁄₅', '6' → '⁶'.
 *  We keep the simple '7' form since the curriculum prose uses 'V⁷' rather
 *  than 'V⁷' with explicit small-7. */
function unicodeFigured(fb: string): string {
  const SUPER: Record<string, string> = {
    '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
    '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
  };
  if (fb === '') return '';
  if (fb === '7') return '⁷';
  if (fb === '6') return '⁶';
  if (fb === '64') return '⁶⁄₄';
  if (fb === '65') return '⁶⁄₅';
  if (fb === '43') return '⁴⁄₃';
  if (fb === '42') return '⁴⁄₂';
  return Array.from(fb).map(c => SUPER[c] ?? c).join('');
}

const DIM_SYMBOL = '°';
const HALFDIM_SYMBOL = 'ø';
const FLAT = '♭';

/** Curriculum-friendly Unicode RN; ASCII-safe form for grep. */
function formatRn(
  prefix: string,        // '♭' or '' or 'CT' or 'It+' / 'Fr+' / 'Ger+'
  numeral: string,       // 'I'/'i'/'V'/'vi'/'N'/etc.
  qualitySymbol: string, // '°' / 'ø' / '+' or ''
  figured: string,       // '7' / '64' / etc.
  secondary?: string,    // 'V' or 'vi' if this is V/V style — appended after '/'
): { rn: string; rnAscii: string } {
  const rn = `${prefix}${numeral}${qualitySymbol}${unicodeFigured(figured)}${secondary ? `/${secondary}` : ''}`;
  // ASCII version: strip Unicode, replace symbols
  const asciiQuality = qualitySymbol
    .replace(DIM_SYMBOL, 'o')
    .replace(HALFDIM_SYMBOL, 'h')
    .replace('+', '+');
  const asciiPrefix = prefix.replace(FLAT, 'b');
  const rnAscii = `${asciiPrefix}${numeral}${asciiQuality}${figured}${secondary ? `/${secondary}` : ''}`;
  return { rn, rnAscii };
}

// ─── Roman-numeral analyzer ──────────────────────────────────────────────────

/** Major-key diatonic triads expected at each scale degree. */
const MAJOR_DIATONIC: Array<{ deg: number; type: ChordIdentity['type'] }> = [
  { deg: 1, type: 'major' },
  { deg: 2, type: 'minor' },
  { deg: 3, type: 'minor' },
  { deg: 4, type: 'major' },
  { deg: 5, type: 'major' },
  { deg: 6, type: 'minor' },
  { deg: 7, type: 'diminished' },
];

/** Minor-key diatonic (natural minor) triads. The harmonic-minor V is
 *  reached as a chromatic adjustment rather than a separate row.  */
const MINOR_DIATONIC: Array<{ deg: number; type: ChordIdentity['type'] }> = [
  { deg: 1, type: 'minor' },
  { deg: 2, type: 'diminished' },
  { deg: 3, type: 'major' },     // bIII
  { deg: 4, type: 'minor' },
  { deg: 5, type: 'minor' },     // natural; also 'major' for harmonic minor
  { deg: 6, type: 'major' },     // bVI
  { deg: 7, type: 'major' },     // bVII (natural)
];

/** Major scale ascending pcs from tonic. */
function majorScalePcsFrom(tonicPc: number): number[] {
  return [0, 2, 4, 5, 7, 9, 11].map(i => ((tonicPc + i) % 12 + 12) % 12);
}

/** Natural minor scale ascending pcs from tonic. */
function minorScalePcsFrom(tonicPc: number): number[] {
  return [0, 2, 3, 5, 7, 8, 10].map(i => ((tonicPc + i) % 12 + 12) % 12);
}

/** Returns the diatonic scale degree (1..7) of a pitch class in a key, or 0 if
 *  the pc is non-diatonic. */
function degreeOf(pc0: number, key: string): number {
  const t = tonicPc(key);
  if (t === null) return 0;
  const mode = keyMode(key);
  const scale = mode === 'minor' ? minorScalePcsFrom(t) : majorScalePcsFrom(t);
  const idx = scale.indexOf(pc0);
  return idx >= 0 ? idx + 1 : 0;
}

/** Check whether a pc set could be a diatonic triad/seventh in `key`. */
function tryDiatonic(
  ident: ChordIdentity,
  key: string,
): { reading: RomanNumeralReading; tendencyTones: TendencyToneTag[] } | null {
  const mode = keyMode(key);
  const expected = mode === 'minor' ? MINOR_DIATONIC : MAJOR_DIATONIC;
  const t = tonicPc(key);
  if (t === null) return null;

  // Harmonic-minor vii° / vii°⁷ — built on the RAISED 7̂, which is pc (t+11)%12.
  // The raised 7̂ is not in the natural-minor scale, so `degreeOf` returns 0.
  // Recognize it explicitly here before bailing out.
  const raisedSeventhPc = ((t + 11) % 12 + 12) % 12;
  const isHarmonicMinorViiRaised = mode === 'minor'
    && ident.root === raisedSeventhPc
    && (ident.type === 'diminished' || ident.type === 'dim7');
  if (isHarmonicMinorViiRaised) {
    const qualitySymbol = ident.type === 'dim7' ? DIM_SYMBOL : DIM_SYMBOL;
    const figured = figuredBassFor(ident.type, ident.inversion);
    const { rn, rnAscii } = formatRn('', 'vii', qualitySymbol, figured);
    return {
      reading: {
        rn, rnAscii,
        inversion: ident.inversion,
        localKey: key,
        confidence: 0.9,
        basis: `Harmonic-minor vii${qualitySymbol}${ident.type === 'dim7' ? '⁷' : ''} on raised 7̂ in ${key}`,
      },
      tendencyTones: ['leading-tone-minor'],
    };
  }

  const rootDeg = degreeOf(ident.root, key);
  if (rootDeg === 0) return null;

  const expectedRow = expected.find(r => r.deg === rootDeg);
  // Allow the harmonic-minor V (major triad / dom7 on degree 5).
  const isHarmonicMinorV = mode === 'minor' && rootDeg === 5
    && (ident.type === 'major' || ident.type === 'dom7');
  // Allow vii° in minor (built on raised 7̂ — but our "natural minor" lists 7 as major,
  // so a diminished triad on the raised 7 needs special handling).
  const isHarmonicMinorVii = mode === 'minor' && rootDeg === 7
    && ident.type === 'diminished';
  // Picardy third: in minor, a *major* triad on 1̂ is the tonic with the
  // raised 3̂ — universal in Bach's minor-key chorale endings, common
  // through the early Baroque. Label as `I` (uppercase = major triad)
  // in the minor key. Recognize this here so that trySecondary's V/IV
  // (which would also match a D major triad in D minor) is not preferred.
  const isPicardyTonic = mode === 'minor' && rootDeg === 1
    && (ident.type === 'major' || ident.type === 'dom7');

  if (!expectedRow && !isHarmonicMinorV && !isHarmonicMinorVii && !isPicardyTonic) return null;

  const matchesType = (expectedRow && expectedRow.type === ident.type)
    || isHarmonicMinorV
    || isHarmonicMinorVii
    || isPicardyTonic
    // Allow seventh-chord version of any expected triad.
    || (expectedRow && (
        (expectedRow.type === 'major' && ident.type === 'maj7') ||
        (expectedRow.type === 'major' && ident.type === 'dom7') ||
        (expectedRow.type === 'minor' && ident.type === 'min7') ||
        (expectedRow.type === 'diminished' && (ident.type === 'halfdim7' || ident.type === 'dim7'))
       ));
  if (!matchesType) return null;

  const numeral = rnTriadCase(rootDeg, ident.type);
  let qualitySymbol = '';
  if (ident.type === 'diminished') qualitySymbol = DIM_SYMBOL;
  else if (ident.type === 'dim7') qualitySymbol = DIM_SYMBOL;
  else if (ident.type === 'halfdim7') qualitySymbol = HALFDIM_SYMBOL;
  else if (ident.type === 'augmented') qualitySymbol = '+';
  const figured = figuredBassFor(ident.type, ident.inversion);
  const { rn, rnAscii } = formatRn('', numeral, qualitySymbol, figured);
  const tendencyTones = tendencyTonesForDiatonic(rootDeg, ident.type, mode ?? 'major');
  const basis = isPicardyTonic
    ? `Picardy third — major tonic triad on 1̂ in ${key}`
    : `Diatonic ${ident.type} on ${rootDeg}̂ in ${key}`;
  return {
    reading: {
      rn, rnAscii,
      inversion: ident.inversion,
      localKey: key,
      confidence: 0.9,
      basis,
    },
    tendencyTones,
  };
}

/** Tendency-tone tags drawn from voiceLeadingTendencyTones.ts. Conservative —
 *  only emit a tag when the chord obviously contains the named pull. */
function tendencyTonesForDiatonic(
  rootDeg: number,
  type: ChordIdentity['type'],
  mode: string,
): TendencyToneTag[] {
  const tags: TendencyToneTag[] = [];
  // V, V7, vii° all carry the leading-tone pull.
  if (rootDeg === 5 && (type === 'major' || type === 'dom7')) {
    tags.push(mode === 'minor' ? 'leading-tone-minor' : 'leading-tone');
    if (type === 'dom7') tags.push('chordal-seventh');
  }
  if (rootDeg === 7 && (type === 'diminished' || type === 'halfdim7' || type === 'dim7')) {
    tags.push(mode === 'minor' ? 'leading-tone-minor' : 'leading-tone');
  }
  return tags;
}

// ─── Secondary dominants (Step 22) ───────────────────────────────────────────

/** Targets X for which V/X / vii°/X make sense (excluding I, since V/I = V). */
// Secondary-target descriptor: which target chord, what offset from the
// home tonic, and which secondary types (V/X vs vii°/X) are idiomatic.
// In major Bach chorale practice all five diatonic non-tonic targets accept
// both V/X and vii°/X. In minor practice only V allows both — the other
// minor-mode targets (iv, III, VI, ♭VII) accept V/X but not vii°/X, because
// a fully-diminished vii° rooted on a chromatic-to-the-home-key pitch is
// almost never the right reading; that pitch pattern is far more often an
// incomplete vii°⁷/V in the home key.
interface SecondaryTargetSpec {
  label: string;          // 'V', 'iv', 'III', 'vi', '♭VII', etc.
  offset: number;         // semitones above the home tonic
  allowV: boolean;        // allow V/X and V⁷/X matches
  allowVii: boolean;      // allow vii°/X and vii°⁷/X matches
}

const SECONDARY_TARGETS_MAJOR: SecondaryTargetSpec[] = [
  { label: 'V',  offset: 7, allowV: true, allowVii: true },
  { label: 'vi', offset: 9, allowV: true, allowVii: true },
  { label: 'IV', offset: 5, allowV: true, allowVii: true },
  { label: 'ii', offset: 2, allowV: true, allowVii: true },
  { label: 'iii', offset: 4, allowV: true, allowVii: true },
];

const SECONDARY_TARGETS_MINOR: SecondaryTargetSpec[] = [
  // V is first so its V/V and vii°/V are tried before any other secondary
  // match, preserving the idiomatic reading of D#°⁷-shaped chords as
  // vii°⁷/V (the dominant-tonicizing chord) in minor mode.
  { label: 'V',    offset: 7,  allowV: true, allowVii: true  },
  { label: 'iv',   offset: 5,  allowV: true, allowVii: false },
  { label: 'III',  offset: 3,  allowV: true, allowVii: false },
  { label: 'VI',   offset: 8,  allowV: true, allowVii: false },
  // ♭VII catches C-E-G-B♭ in G minor (V⁷/♭VII = the chromatic IV-with-
  // raised-3rd that previously fell through to "?").
  { label: '♭VII', offset: 10, allowV: true, allowVii: false },
];

function trySecondary(
  ident: ChordIdentity,
  key: string,
): { reading: RomanNumeralReading; tendencyTones: TendencyToneTag[] } | null {
  const t = tonicPc(key);
  const mode = keyMode(key);
  if (t === null) return null;

  const targets = mode === 'minor' ? SECONDARY_TARGETS_MINOR : SECONDARY_TARGETS_MAJOR;

  for (const target of targets) {
    const targetPc = ((t + target.offset) % 12 + 12) % 12;
    // V/X — major triad or dom7 whose root is a fifth above target X.
    if (target.allowV) {
      const expectedRoot = ((targetPc + 7) % 12 + 12) % 12;
      if (ident.root === expectedRoot && (ident.type === 'major' || ident.type === 'dom7')) {
        const figured = figuredBassFor(ident.type, ident.inversion);
        const numeral = ident.type === 'dom7' ? 'V' : 'V';
        const { rn, rnAscii } = formatRn('', numeral, '', figured, target.label);
        return {
          reading: {
            rn, rnAscii,
            inversion: ident.inversion,
            localKey: key,
            confidence: 0.85,
            basis: `Secondary dominant — ${ident.type === 'dom7' ? 'V⁷' : 'V'} of ${target.label}`,
          },
          tendencyTones: ['temporary-leading-tone', ...(ident.type === 'dom7' ? ['temporary-chordal-seventh' as TendencyToneTag] : [])],
        };
      }
    }
    // vii°/X — diminished triad or fully-dim seventh whose root is a half-
    // step below target X. Only enabled where it's idiomatic for the mode
    // (always in major; only V-as-target in minor).
    if (target.allowVii) {
      if (ident.root === ((targetPc + 11) % 12 + 12) % 12
          && (ident.type === 'diminished' || ident.type === 'dim7' || ident.type === 'halfdim7')) {
        const figured = figuredBassFor(ident.type, ident.inversion);
        const numeral = 'vii';
        const sym = ident.type === 'halfdim7' ? HALFDIM_SYMBOL : DIM_SYMBOL;
        const { rn, rnAscii } = formatRn('', numeral, sym, figured, target.label);
        return {
          reading: {
            rn, rnAscii,
            inversion: ident.inversion,
            localKey: key,
            confidence: 0.8,
            basis: `Secondary leading-tone chord — vii${sym} of ${target.label}`,
          },
          tendencyTones: ['temporary-leading-tone'],
        };
      }
    }
  }
  return null;
}

// ─── Borrowed chords (Step 25) and Neapolitan (Step 27) ──────────────────────

function tryBorrowed(
  ident: ChordIdentity,
  key: string,
): { reading: RomanNumeralReading; tendencyTones: TendencyToneTag[] } | null {
  const t = tonicPc(key);
  const mode = keyMode(key);
  if (t === null || mode !== 'major') return null;

  // The parallel mode's diatonic chords map to specific borrowings:
  //   iv (in major)        : minor triad on 4̂
  //   ♭III                  : major triad on ♭3̂
  //   ♭VI                   : major triad on ♭6̂
  //   ♭VII                  : major triad on ♭7̂
  //   i (parallel-minor i)  : minor triad on tonic
  //   ♭II / Neapolitan      : major triad on ♭2̂
  const offset = ((ident.root - t) % 12 + 12) % 12;

  // iv in major
  if (offset === 5 && ident.type === 'minor') {
    const figured = figuredBassFor(ident.type, ident.inversion);
    const { rn, rnAscii } = formatRn('', 'iv', '', figured);
    return {
      reading: {
        rn, rnAscii,
        inversion: ident.inversion,
        localKey: key,
        confidence: 0.8,
        basis: `Borrowed iv (subdominant minor in major) — adds ♭6̂ pull`,
      },
      tendencyTones: ['phrygian-pull'],
    };
  }
  // ♭III
  if (offset === 3 && ident.type === 'major') {
    const figured = figuredBassFor(ident.type, ident.inversion);
    const { rn, rnAscii } = formatRn(FLAT, 'III', '', figured);
    return {
      reading: {
        rn, rnAscii,
        inversion: ident.inversion,
        localKey: key,
        confidence: 0.8,
        basis: `Borrowed ♭III from parallel minor`,
      },
      tendencyTones: [],
    };
  }
  // ♭VI
  if (offset === 8 && ident.type === 'major') {
    const figured = figuredBassFor(ident.type, ident.inversion);
    const { rn, rnAscii } = formatRn(FLAT, 'VI', '', figured);
    return {
      reading: {
        rn, rnAscii,
        inversion: ident.inversion,
        localKey: key,
        confidence: 0.85,
        basis: `Borrowed ♭VI from parallel minor — chromatic mediant`,
      },
      tendencyTones: ['phrygian-pull'],
    };
  }
  // ♭VII
  if (offset === 10 && ident.type === 'major') {
    const figured = figuredBassFor(ident.type, ident.inversion);
    const { rn, rnAscii } = formatRn(FLAT, 'VII', '', figured);
    return {
      reading: {
        rn, rnAscii,
        inversion: ident.inversion,
        localKey: key,
        confidence: 0.8,
        basis: `Borrowed ♭VII from parallel minor`,
      },
      tendencyTones: [],
    };
  }
  // viiø⁷ / vi-halfdim from parallel minor in major mode. The chord
  // shape "halfdim7 rooted on 6̂" (= A-C-Eb-G in C major) is the
  // borrowed-from-minor seventh chord on the submediant. Bach uses this
  // routinely in major chorales as a pre-dominant predominant.
  // Distinguish from vii°/X secondaries by REQUIRING the root to be on
  // the diatonic 6̂ pc (not a chromatic root) — that's what makes it
  // a "vi" borrowing rather than a secondary leading-tone of some target.
  if (offset === 9 && ident.type === 'halfdim7') {
    const figured = figuredBassFor(ident.type, ident.inversion);
    const { rn, rnAscii } = formatRn('', 'vi', HALFDIM_SYMBOL, figured);
    return {
      reading: {
        rn, rnAscii,
        inversion: ident.inversion,
        localKey: key,
        confidence: 0.8,
        basis: `Borrowed viø⁷ — half-diminished submediant from parallel minor`,
      },
      tendencyTones: [],
    };
  }
  // ii halfdim7 from parallel minor (iiø⁷): half-diminished on 2̂. Common
  // pre-dominant in major mode as a minor-mode borrowing. e.g. D-F-Ab-C
  // in C major = iiø⁷ borrowed from C minor's iiø⁷.
  if (offset === 2 && ident.type === 'halfdim7') {
    const figured = figuredBassFor(ident.type, ident.inversion);
    const { rn, rnAscii } = formatRn('', 'ii', HALFDIM_SYMBOL, figured);
    return {
      reading: {
        rn, rnAscii,
        inversion: ident.inversion,
        localKey: key,
        confidence: 0.8,
        basis: `Borrowed iiø⁷ — half-diminished supertonic from parallel minor`,
      },
      tendencyTones: [],
    };
  }
  // i (parallel-minor tonic in major) — minor triad or min7
  if (offset === 0 && (ident.type === 'minor' || ident.type === 'min7')) {
    const figured = figuredBassFor(ident.type, ident.inversion);
    const { rn, rnAscii } = formatRn('', 'i', '', figured);
    const seventhMark = ident.type === 'min7' ? '⁷' : '';
    return {
      reading: {
        rn, rnAscii,
        inversion: ident.inversion,
        localKey: key,
        confidence: 0.7,
        basis: `Parallel-minor i${seventhMark} — minor tonic in major mode`,
      },
      tendencyTones: [],
    };
  }
  // ♭II (Neapolitan): major triad on ♭2̂. ♭II⁶ (first inversion) is the
  // textbook voicing.
  if (offset === 1 && ident.type === 'major') {
    const figured = figuredBassFor(ident.type, ident.inversion);
    const { rn, rnAscii } = formatRn(FLAT, 'II', '', figured);
    return {
      reading: {
        rn, rnAscii,
        inversion: ident.inversion,
        localKey: key,
        confidence: 0.85,
        basis: `Neapolitan — ♭II${ident.inversion === '1st' ? '⁶' : ''}, major triad on ♭2̂`,
      },
      tendencyTones: [],
    };
  }
  return null;
}

/** Same as tryBorrowed but for minor keys — Neapolitan, borrowed major IV
 *  (parallel-major mixture). The major-IV-in-minor pattern is common in
 *  Bach chorales: a major triad on 4̂, often in 1st inversion with the
 *  raised 6̂ in the bass moving to V. */
function tryBorrowedMinor(
  ident: ChordIdentity,
  key: string,
): { reading: RomanNumeralReading; tendencyTones: TendencyToneTag[] } | null {
  const t = tonicPc(key);
  const mode = keyMode(key);
  if (t === null || mode !== 'minor') return null;
  const offset = ((ident.root - t) % 12 + 12) % 12;

  // ♭II in minor — same pc as in major (root a half step above tonic).
  if (offset === 1 && ident.type === 'major') {
    const figured = figuredBassFor(ident.type, ident.inversion);
    const { rn, rnAscii } = formatRn(FLAT, 'II', '', figured);
    return {
      reading: {
        rn, rnAscii,
        inversion: ident.inversion,
        localKey: key,
        confidence: 0.85,
        basis: `Neapolitan ♭II in minor`,
      },
      tendencyTones: [],
    };
  }

  // Borrowed-major IV — major triad on 4̂ (parallel-major mixture). Bach's
  // standard "raised 6̂ in the bass moving to V" pattern; the chord is
  // diatonically minor (iv) but the third has been raised to the major-mode
  // value, producing a major triad. With the third in the bass (1st inv),
  // this is the classic IV⁶-to-V approach. Triad form preferred to V/♭VII
  // (which is the same pc set without the 7th) because Bach uses IV-borrowed
  // far more often than a bare V triad tonicizing the subtonic.
  if (offset === 5 && ident.type === 'major') {
    const figured = figuredBassFor(ident.type, ident.inversion);
    const { rn, rnAscii } = formatRn('', 'IV', '', figured);
    return {
      reading: {
        rn, rnAscii,
        inversion: ident.inversion,
        localKey: key,
        confidence: 0.85,
        basis: `Borrowed IV — major triad on 4̂ from parallel major in ${key}`,
      },
      tendencyTones: [],
    };
  }

  // Borrowed-major IV⁷ — same idea but with the major-7th added. Less
  // common than the bare triad but appears in late-Romantic chorales.
  if (offset === 5 && ident.type === 'maj7') {
    const figured = figuredBassFor(ident.type, ident.inversion);
    const { rn, rnAscii } = formatRn('', 'IV', '', figured);
    return {
      reading: {
        rn, rnAscii,
        inversion: ident.inversion,
        localKey: key,
        confidence: 0.78,
        basis: `Borrowed IVmaj⁷ from parallel major in ${key}`,
      },
      tendencyTones: [],
    };
  }

  return null;
}

// ─── Modal color (Dorian, Lydian, Mixolydian) ────────────────────────────────

/**
 * Modal-color chords — non-functional modal flavors that show up inside an
 * otherwise major/minor passage. These are conservative: each pattern requires
 * the characteristic mode-defining alteration to be present in the chord
 * itself, so they fire on actual Dorian/Lydian/Mixolydian color rather than
 * stylistic mode-mixture.
 *
 * Patterns recognized:
 *   - Dorian ii (minor mode): minor triad or min7 on 2̂. In natural minor, ii
 *     is diminished (B-D-F in A minor); a minor triad on 2̂ (B-D-F♯) means
 *     6̂ has been raised — the Dorian fingerprint.
 *   - Mixolydian v (major mode): minor triad or min7 on 5̂. In major, V is
 *     major (E-G♯-B in A major); a minor triad on 5̂ (E-G-B) means 7̂ has
 *     been lowered — the Mixolydian fingerprint.
 *   - Lydian ♯IV (major mode): major triad on ♯4̂. In major, ♯4̂ is not
 *     diatonic, but the chord built on it (D♯-F##-A♯ in A major) gives a
 *     bright lifted-fourth color.
 *   - Phrygian ♭II is already covered by tryBorrowed / tryBorrowedMinor (the
 *     Neapolitan). Verified: both major-mode and minor-mode cases land there.
 */
function tryModalColor(
  ident: ChordIdentity,
  key: string,
  pcs: number[],
): { reading: RomanNumeralReading; tendencyTones: TendencyToneTag[] } | null {
  const t = tonicPc(key);
  const mode = keyMode(key);
  if (t === null) return null;
  const offset = ((ident.root - t) % 12 + 12) % 12;
  const pcSet = new Set(pcs);

  // Dorian ii: minor triad / min7 on 2̂ in minor mode, with raised 6̂ present.
  if (mode === 'minor' && offset === 2
      && (ident.type === 'minor' || ident.type === 'min7')) {
    const raisedSix = ((t + 9) % 12 + 12) % 12;
    if (pcSet.has(raisedSix)) {
      const figured = figuredBassFor(ident.type, ident.inversion);
      const seventhMark = ident.type === 'min7' ? '⁷' : '';
      const { rn, rnAscii } = formatRn('', 'ii', '', figured);
      return {
        reading: {
          rn, rnAscii,
          inversion: ident.inversion,
          localKey: key,
          confidence: 0.75,
          basis: `Dorian ii${seventhMark} — minor supertonic with raised 6̂ in ${key}`,
        },
        tendencyTones: [],
      };
    }
  }

  // Mixolydian v: minor triad / min7 on 5̂ in major mode. The chord contains
  // ♭7̂ rather than the diatonic 7̂ — that's the Mixolydian fingerprint.
  if (mode === 'major' && offset === 7
      && (ident.type === 'minor' || ident.type === 'min7')) {
    const flatSeven = ((t + 10) % 12 + 12) % 12;
    if (pcSet.has(flatSeven)) {
      const figured = figuredBassFor(ident.type, ident.inversion);
      const seventhMark = ident.type === 'min7' ? '⁷' : '';
      const { rn, rnAscii } = formatRn('', 'v', '', figured);
      return {
        reading: {
          rn, rnAscii,
          inversion: ident.inversion,
          localKey: key,
          confidence: 0.7,
          basis: `Mixolydian v${seventhMark} — minor dominant with ♭7̂ in ${key}`,
        },
        tendencyTones: [],
      };
    }
  }

  // Lydian ♯IV: major triad on ♯4̂ in major mode. The chord's root is the
  // raised 4̂ pc; the chord itself uses pcs alien to the parent major scale.
  if (mode === 'major' && offset === 6 && ident.type === 'major') {
    const figured = figuredBassFor(ident.type, ident.inversion);
    const numeral = '♯IV';
    const rn = `${numeral}${unicodeFigured(figured)}`;
    const rnAscii = `#IV${figured}`;
    return {
      reading: {
        rn, rnAscii,
        inversion: ident.inversion,
        localKey: key,
        confidence: 0.65,
        basis: `Lydian ♯IV — major triad on raised 4̂ in ${key}`,
      },
      tendencyTones: [],
    };
  }

  return null;
}

// ─── Suspended and added-note chords ─────────────────────────────────────────

/**
 * Recognize suspended and added-note chords whose underlying triad/seventh
 * sits inside the chord but is decorated with a 2, 4, 6, or some combination.
 * These usually arise from voice leading — a 4 holding over from the previous
 * chord (sus4), a 2 that resolves up to the 3 (sus2), or an added tone that
 * never resolves but enriches the harmony (add9, add6).
 *
 * Patterns recognized (per candidate root):
 *
 *   sus2       : root + 2 + 5                  (no 3) — Csus2
 *   sus4       : root + 4 + 5                  (no 3) — Csus4
 *   ⁷sus4      : root + 4 + 5 + ♭7             (no 3) — C⁷sus4
 *   ⁷sus2      : root + 2 + 5 + ♭7             (no 3) — C⁷sus2
 *   sus2add4   : root + 2 + 4 + 5              (no 3) — Csus2add4 (quartal)
 *   add9       : root + 2 + 3 + 5              (3 kept) — Cadd9
 *   add6       : root + 3 + 5 + 6              (3 kept) — Cadd6 / C6
 *   add4       : root + 3 + 4 + 5              (3 kept) — Cadd4 (rare)
 *
 * Bass on the candidate root is a strong indicator. When a lookahead chord is
 * available, the function also confirms the suspension by checking that the
 * sus tone resolves by step (typically 4→3 down, 2→3 up).
 *
 * The label is built by inserting the sus/add suffix into whatever Roman
 * numeral tryDiatonic/trySecondary would have given for the chord's
 * underlying triad or seventh. So V⁷ with sus4 reads as "V⁷sus4"; V⁷ of V
 * with sus4 reads as "V⁷sus4/V".
 */
function trySuspendedOrAdded(
  pcs: number[],
  bassPc: number | null,
  key: string,
  nextChordPcs: number[] | null,
): { reading: RomanNumeralReading; tendencyTones: TendencyToneTag[] } | null {
  const u = uniqPcs(pcs);
  if (u.length < 3 || u.length > 4) return null;
  // Bass-on-root requirement: a sus/add label is musically appropriate when
  // the listener hears the candidate root as the bass. Without this, the
  // pc-set {C,E,G,A} would label as Iadd6 even when bass=A (where vi⁷ is the
  // correct functional reading). We let tryDiatonic handle inversions and
  // restrict sus/add to bass-rooted sonorities.
  if (bassPc === null) return null;

  interface Candidate {
    rootPc: number;
    suffix: string;                  // 'sus2', 'sus4', 'add9', 'add6', '⁷sus4', etc.
    suffixAscii: string;             // ASCII version without ⁷
    coreType: 'major' | 'minor' | 'dom7' | 'min7' | 'maj7';
    susTonePc: number | null;        // pc of the suspended tone (for lookahead check)
    score: number;
  }

  let best: Candidate | null = null;

  for (const candidateRoot of u) {
    // Bass-on-root requirement (see comment above): only consider the bass
    // pc as a candidate root. This prevents stealing functional labels like
    // ii⁷ from chords that just happen to share their pc-set with an
    // inverted add6 chord.
    if (candidateRoot !== bassPc) continue;

    const intervals = new Set(u.map(p => ((p - candidateRoot) % 12 + 12) % 12));
    if (!intervals.has(0)) continue;

    const has2 = intervals.has(2);
    const hasMinor3 = intervals.has(3);
    const hasMajor3 = intervals.has(4);
    const has3 = hasMinor3 || hasMajor3;
    const has4 = intervals.has(5);
    const has5 = intervals.has(7);
    const has6 = intervals.has(9);
    const hasFlat7 = intervals.has(10);
    const hasMaj7 = intervals.has(11);

    // The chord must have a recognizable "underlying" core: either has 3 (then
    // we're adding an extra tone) or has 5 with one of 2/4 (then we're sus).
    let suffix = '';
    let suffixAscii = '';
    let coreType: Candidate['coreType'] | null = null;
    let susTonePc: number | null = null;
    let baseScore = 0;

    if (!has3 && has5) {
      // SUSPENDED chord: no 3, has 5, and one of {2, 4}.
      if (has2 && has4) {
        suffix = 'sus2add4';
        suffixAscii = 'sus2add4';
        coreType = hasFlat7 ? 'dom7' : 'major';
        susTonePc = (candidateRoot + 5) % 12;  // the 4 resolves first
        baseScore = 10;
      } else if (has4) {
        suffix = hasFlat7 ? '⁷sus4' : hasMaj7 ? 'maj⁷sus4' : 'sus4';
        suffixAscii = hasFlat7 ? '7sus4' : hasMaj7 ? 'maj7sus4' : 'sus4';
        coreType = hasFlat7 ? 'dom7' : hasMaj7 ? 'maj7' : 'major';
        susTonePc = (candidateRoot + 5) % 12;
        baseScore = 20;
      } else if (has2) {
        suffix = hasFlat7 ? '⁷sus2' : 'sus2';
        suffixAscii = hasFlat7 ? '7sus2' : 'sus2';
        coreType = hasFlat7 ? 'dom7' : 'major';
        susTonePc = (candidateRoot + 2) % 12;
        baseScore = 16;
      }
    } else if (has3 && has5) {
      // ADD chord: 3 stays; we add a non-chord-tone color.
      if (has2 && !has6) {
        suffix = 'add9';
        suffixAscii = 'add9';
        coreType = hasMajor3
          ? (hasFlat7 ? 'dom7' : hasMaj7 ? 'maj7' : 'major')
          : (hasFlat7 ? 'min7' : 'minor');
        baseScore = 12;
      } else if (has6 && !has2 && !has4) {
        // Before labeling as add6, check whether the M6 note forms a recognized
        // seventh chord when treated as root. Algebraic identity:
        //   major triad + M6 above root  = min7  in 1st inversion (root = M6 note)
        //   minor triad + M6 above root  = ø7    in 1st inversion (root = M6 note)
        // In baroque/classical style the seventh-chord reading is always preferred
        // over add6 when the identity holds. Only fall through to add6 when
        // the intervals from the M6 note do NOT form a recognized seventh.
        const m6Root = (candidateRoot + 9) % 12;
        const m6Intervals = u.map(p => ((p - m6Root) % 12 + 12) % 12).sort((a, b) => a - b);
        const m6SeventhType = classifySeventh(m6Intervals);
        if (m6SeventhType !== null) {
          // The pc-set is better read as a seventh chord in inversion — skip
          // add6 and let tryDiatonic / trySecondary handle it instead.
          continue;
        }
        suffix = 'add6';
        suffixAscii = 'add6';
        coreType = hasMajor3
          ? (hasFlat7 ? 'dom7' : 'major')
          : (hasFlat7 ? 'min7' : 'minor');
        baseScore = 10;
      } else if (has4 && !has2) {
        suffix = 'add4';
        suffixAscii = 'add4';
        coreType = hasMajor3 ? 'major' : 'minor';
        baseScore = 8;
      }
    }

    if (!coreType) continue;

    let score = baseScore;
    if (bassPc === candidateRoot) score += 12;  // strong preference when bass = root

    // Lookahead bonus: did the sus tone resolve by step?
    if (susTonePc !== null && nextChordPcs) {
      const resolved = nextChordPcs.some(np => {
        const ic = ((np - susTonePc!) % 12 + 12) % 12;
        return ic === 1 || ic === 2 || ic === 10 || ic === 11;
      });
      if (resolved) score += 6;
    }

    if (!best || score > best.score) {
      best = {
        rootPc: candidateRoot,
        suffix, suffixAscii,
        coreType,
        susTonePc,
        score,
      };
    }
  }

  if (!best) return null;

  // Resolve the underlying chord's Roman numeral via tryDiatonic / trySecondary.
  const isSeventhCore = best.coreType === 'dom7' || best.coreType === 'min7' || best.coreType === 'maj7';
  const coreIdent: ChordIdentity = {
    root: best.rootPc,
    type: best.coreType,
    intervals: [],
    inversion: 'root',
  };
  const dia = tryDiatonic(coreIdent, key);
  const sec = trySecondary(coreIdent, key);
  const baseReading = dia?.reading ?? sec?.reading;

  // If neither diatonic nor secondary recognized the underlying chord, fall
  // back to writing the literal pc-name (e.g., "Csus4") rather than refusing
  // to label.
  //
  // The label rebuilder splits the base RN into (numeral-part, /target?) so
  // we can strip the figured-bass marker (⁷) cleanly and re-insert the suffix
  // without leaving behind a leftover ⁷. Example: "V⁷/V" + "⁷sus4" should
  // produce "V⁷sus4/V", not "V⁷⁷sus4/V".
  let coreRn: string;
  let coreRnAscii: string;
  if (baseReading) {
    coreRn = baseReading.rn;
    coreRnAscii = baseReading.rnAscii;
  } else {
    coreRn = NOTE_NAMES[best.rootPc];
    coreRnAscii = NOTE_NAMES[best.rootPc];
  }

  const suffixCarriesSeventh = best.suffix.startsWith('⁷') || best.suffix.startsWith('maj⁷');

  // Split into (numeral, target)
  const slashIdx = coreRn.indexOf('/');
  let head = slashIdx > 0 ? coreRn.slice(0, slashIdx) : coreRn;
  const tail = slashIdx > 0 ? coreRn.slice(slashIdx) : '';
  const slashIdxA = coreRnAscii.indexOf('/');
  let headA = slashIdxA > 0 ? coreRnAscii.slice(0, slashIdxA) : coreRnAscii;
  const tailA = slashIdxA > 0 ? coreRnAscii.slice(slashIdxA) : '';

  // Strip figured-bass marker from head if the suffix carries its own ⁷.
  if (suffixCarriesSeventh) {
    head = head.replace(/⁷$/, '');
    headA = headA.replace(/7$/, '');
  }

  const rn = head + best.suffix + tail;
  const rnAscii = headA + best.suffixAscii + tailA;

  // Tendency-tone tags: suspensions usually count as suspension-4-3 (or the
  // 9-8 / 2-3 family); add chords carry no tendency-tone pull.
  const tendencyTones: TendencyToneTag[] = best.suffix.includes('sus4')
    ? ['suspension-4-3']
    : best.suffix.includes('sus2')
      ? ['suspension-9-8']
      : [];

  return {
    reading: {
      rn, rnAscii,
      inversion: 'root',
      localKey: key,
      confidence: 0.72,
      basis: `${rn} — ${best.suffix.includes('sus') ? 'suspended-note' : 'added-note'} chord${isSeventhCore ? ' (seventh)' : ''} in ${key}`,
    },
    tendencyTones,
  };
}

// ─── Incomplete chords ───────────────────────────────────────────────────────

/**
 * Catalog the tonally active seventh chords in a key (V⁷, vii°⁷/viiø⁷, and
 * their secondary leading-tone / V⁷ partners). Used by tryIncompleteSeventh.
 *
 * Each entry has the full 4-pc set plus enough metadata to render the RN if
 * a 3-of-4 subset is found.
 */
interface SeventhTemplate {
  rootPc: number;
  pcs: number[];                          // 4 pcs of the full seventh
  // dom7 / dim7 / halfdim7 are the V⁷-family and vii°⁷-family seventh types.
  // maj7 / min7 are needed for the wider diatonic-seventh catalog (I⁷, ii⁷,
  // iii⁷, IV⁷, vi⁷ in major; i⁷, III⁷, iv⁷, VI⁷ in minor).
  type: 'dom7' | 'dim7' | 'halfdim7' | 'maj7' | 'min7';
  numeral: string;                        // 'I' / 'ii' / 'V' / 'vii' / etc.
  quality: '' | typeof DIM_SYMBOL | typeof HALFDIM_SYMBOL;
  secondaryTarget?: string;               // 'V', 'vi', etc., when this is a secondary
  tendencyTones: TendencyToneTag[];
  priority: number;                       // higher = preferred
}

function buildSeventhCatalog(key: string): SeventhTemplate[] {
  const t = tonicPc(key);
  const mode = keyMode(key);
  if (t === null) return [];
  const cands: SeventhTemplate[] = [];

  // V⁷ on 5̂
  const vRoot = (t + 7) % 12;
  cands.push({
    rootPc: vRoot,
    pcs: [vRoot, (vRoot + 4) % 12, (vRoot + 7) % 12, (vRoot + 10) % 12],
    type: 'dom7',
    numeral: 'V', quality: '',
    tendencyTones: mode === 'minor'
      ? ['leading-tone-minor', 'chordal-seventh']
      : ['leading-tone', 'chordal-seventh'],
    priority: 100,
  });

  // vii°⁷ (minor — raised 7̂) or viiø⁷ (major — diatonic 7̂)
  if (mode === 'minor') {
    const viiRoot = (t + 11) % 12;
    cands.push({
      rootPc: viiRoot,
      pcs: [viiRoot, (viiRoot + 3) % 12, (viiRoot + 6) % 12, (viiRoot + 9) % 12],
      type: 'dim7',
      numeral: 'vii', quality: DIM_SYMBOL,
      tendencyTones: ['leading-tone-minor'],
      priority: 90,
    });
  } else {
    const viiRoot = (t + 11) % 12;
    cands.push({
      rootPc: viiRoot,
      pcs: [viiRoot, (viiRoot + 3) % 12, (viiRoot + 6) % 12, (viiRoot + 10) % 12],
      type: 'halfdim7',
      numeral: 'vii', quality: HALFDIM_SYMBOL,
      tendencyTones: ['leading-tone'],
      priority: 90,
    });
  }

  // Other diatonic sevenths: I⁷ / Imaj⁷, ii⁷, iii⁷, IV⁷ / IVmaj⁷, vi⁷ in major;
  // i⁷ / imaj⁷, iiø⁷, III⁷ (Picardy-tonicizing), iv⁷, VI⁷ / VImaj⁷ in minor.
  // These are weak-attractor sevenths — they don't carry tendency-tone pulls
  // like V⁷ or vii°⁷, but they appear regularly in Bach chorales as
  // *incomplete* 3-pc subsets (e.g. vi7 missing its 3rd) and the analyzer
  // needs to recognize them rather than fall through to "?".
  //
  // Priority is lower than V⁷ / vii°⁷ so the strong sevenths still win when
  // pc sets are ambiguous, but higher than the secondary-dominant family
  // because diatonic readings should beat secondary readings by default.
  //
  // The chord-quality assumption is the *natural* diatonic seventh for each
  // degree (e.g. ii in major → min7, vi in major → min7, IV in major →
  // maj7, V in minor → dom7 via harmonic minor). For Bach chorales these
  // are almost always the right call.

  type DiatonicRow = {
    degree: number;
    offset: number;       // semitones above tonic for the root
    type: 'dom7' | 'maj7' | 'min7' | 'halfdim7';
    numeral: string;      // uppercase = major triad core, lowercase = minor
    quality: '' | typeof HALFDIM_SYMBOL;
    priority: number;
  };

  const majorDiatonicSevenths: DiatonicRow[] = [
    { degree: 1, offset: 0,  type: 'maj7',     numeral: 'I',   quality: '',                priority: 85 },
    { degree: 2, offset: 2,  type: 'min7',     numeral: 'ii',  quality: '',                priority: 82 },
    { degree: 3, offset: 4,  type: 'min7',     numeral: 'iii', quality: '',                priority: 78 },
    { degree: 4, offset: 5,  type: 'maj7',     numeral: 'IV',  quality: '',                priority: 84 },
    { degree: 6, offset: 9,  type: 'min7',     numeral: 'vi',  quality: '',                priority: 82 },
  ];

  // In minor we list the *natural-minor* sevenths plus the harmonic-minor
  // alterations. Bach overwhelmingly uses these:
  //   i7 (min-maj7 is rare; min7 is standard for the chorale literature)
  //   iiø7 (half-diminished)
  //   III7 (major triad + maj7) — Picardy-context only; same as V7 of vi
  //   iv7 (min7)
  //   VI7 (major-maj7) — same as IV in relative major
  //   VII (the natural-minor 7̂ chord, not the dim7) handled separately
  const minorDiatonicSevenths: DiatonicRow[] = [
    { degree: 1, offset: 0,  type: 'min7',     numeral: 'i',   quality: '',                priority: 85 },
    { degree: 2, offset: 2,  type: 'halfdim7', numeral: 'ii',  quality: HALFDIM_SYMBOL,    priority: 82 },
    { degree: 3, offset: 3,  type: 'maj7',     numeral: 'III', quality: '',                priority: 78 },
    { degree: 4, offset: 5,  type: 'min7',     numeral: 'iv',  quality: '',                priority: 84 },
    { degree: 6, offset: 8,  type: 'maj7',     numeral: 'VI',  quality: '',                priority: 80 },
    { degree: 7, offset: 10, type: 'dom7',     numeral: 'VII', quality: '',                priority: 78 },
  ];

  const rows = mode === 'minor' ? minorDiatonicSevenths : majorDiatonicSevenths;

  for (const row of rows) {
    const rootPc = (t + row.offset) % 12;
    let third: number, fifth: number, seventh: number;
    switch (row.type) {
      case 'dom7':     third = 4; fifth = 7;  seventh = 10; break;
      case 'maj7':     third = 4; fifth = 7;  seventh = 11; break;
      case 'min7':     third = 3; fifth = 7;  seventh = 10; break;
      case 'halfdim7': third = 3; fifth = 6;  seventh = 10; break;
    }
    cands.push({
      rootPc,
      pcs: [rootPc, (rootPc + third) % 12, (rootPc + fifth) % 12, (rootPc + seventh) % 12],
      type: row.type,
      numeral: row.numeral,
      quality: row.quality,
      tendencyTones: [],   // weak-attractor sevenths carry no pull tags
      priority: row.priority,
    });
  }

  // Secondary V⁷/X and vii°⁷/X for each target. The diminished 7th is
  // symmetric in pc-set space, so vii°⁷/V, vii°⁷/iii, etc. share the same pcs
  // when the targets line up — priority distinguishes them so the most
  // common reading wins (V > vi > IV > iii > ii).
  const SECONDARY_OFFSETS: Record<string, number> = { ii: 2, iii: 4, IV: 5, V: 7, vi: 9 };
  const SECONDARY_PRIORITIES: Record<string, number> = { V: 75, vi: 65, IV: 60, iii: 55, ii: 50 };
  for (const target of Object.keys(SECONDARY_OFFSETS)) {
    const targetPc = (t + SECONDARY_OFFSETS[target]) % 12;
    const basePri = SECONDARY_PRIORITIES[target];
    // V⁷/X
    const vxRoot = (targetPc + 7) % 12;
    cands.push({
      rootPc: vxRoot,
      pcs: [vxRoot, (vxRoot + 4) % 12, (vxRoot + 7) % 12, (vxRoot + 10) % 12],
      type: 'dom7',
      numeral: 'V', quality: '',
      secondaryTarget: target,
      tendencyTones: ['temporary-leading-tone', 'temporary-chordal-seventh'],
      priority: basePri,
    });
    // vii°⁷/X — fully diminished seventh whose root is a half-step below target.
    const vxxRoot = (targetPc + 11) % 12;
    cands.push({
      rootPc: vxxRoot,
      pcs: [vxxRoot, (vxxRoot + 3) % 12, (vxxRoot + 6) % 12, (vxxRoot + 9) % 12],
      type: 'dim7',
      numeral: 'vii', quality: DIM_SYMBOL,
      secondaryTarget: target,
      tendencyTones: ['temporary-leading-tone'],
      priority: basePri + 5,  // slight nudge over V⁷/X when both match
    });
  }

  return cands;
}

/**
 * Match a 3-pc chord against the 4-pc seventh chords tonally active in `key`.
 * When `pcs` is a 3-of-4 subset of some tonally active seventh, label as that
 * seventh with "(implied root missing)" or "(incomplete)" in the basis, at
 * confidence 0.7. Returns null when no clean subset match exists.
 */
function tryIncompleteSeventh(
  pcs: number[],
  bassPc: number | null,
  key: string,
): { reading: RomanNumeralReading; tendencyTones: TendencyToneTag[] } | null {
  const u = uniqPcs(pcs);
  if (u.length !== 3) return null;

  const cands = buildSeventhCatalog(key);
  if (cands.length === 0) return null;
  const pcSet = new Set(u);

  let bestCand: SeventhTemplate | null = null;
  let bestScore = -1;
  for (const cand of cands) {
    const candSet = new Set(cand.pcs);
    let allMatch = true;
    for (const p of u) {
      if (!candSet.has(p)) { allMatch = false; break; }
    }
    if (!allMatch) continue;

    // Score: priority, plus bonus when bass is in the chord.
    let score = cand.priority;
    if (bassPc !== null && candSet.has(bassPc)) score += 5;
    if (score > bestScore) {
      bestScore = score;
      bestCand = cand;
    }
  }

  if (!bestCand) return null;

  const inv: ChordIdentity['inversion'] = bassPc !== null
    ? inversionFromBass(bestCand.rootPc, bassPc, bestCand.type)
    : 'root';
  const figured = figuredBassFor(bestCand.type, inv);
  const { rn, rnAscii } = formatRn('', bestCand.numeral, bestCand.quality, figured, bestCand.secondaryTarget);

  const isMissingRoot = !pcSet.has(bestCand.rootPc);
  const note = isMissingRoot ? '(implied root missing)' : '(incomplete)';

  return {
    reading: {
      rn, rnAscii,
      inversion: inv,
      localKey: key,
      confidence: 0.7,
      basis: `${rn} ${note} in ${key}`,
    },
    tendencyTones: bestCand.tendencyTones,
  };
}

/**
 * Catalog the diatonic triads (plus harmonic-minor V / vii°) in a key. Used
 * by tryIncompleteTriad.
 */
interface TriadTemplate {
  rootPc: number;
  pcs: number[];                          // 3 pcs of the full triad
  type: 'major' | 'minor' | 'diminished' | 'augmented';
  numeral: string;
  quality: '' | typeof DIM_SYMBOL;
  tendencyTones: TendencyToneTag[];
  priority: number;
}

function buildTriadCatalog(key: string): TriadTemplate[] {
  const t = tonicPc(key);
  const mode = keyMode(key);
  if (t === null) return [];
  const out: TriadTemplate[] = [];

  const expected = mode === 'minor' ? MINOR_DIATONIC : MAJOR_DIATONIC;
  const intervals = mode === 'minor' ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11];

  for (const { deg, type } of expected) {
    const rootPc = (t + intervals[deg - 1]) % 12;
    const third = type === 'minor' || type === 'diminished' ? 3 : 4;
    const fifth = type === 'diminished' ? 6 : 7;
    const numeral = rnTriadCase(deg, type);
    const quality = type === 'diminished' ? DIM_SYMBOL : '';
    out.push({
      rootPc,
      pcs: [rootPc, (rootPc + third) % 12, (rootPc + fifth) % 12],
      type: type as 'major' | 'minor' | 'diminished',
      numeral, quality,
      tendencyTones: tendencyTonesForDiatonic(deg, type, mode ?? 'major'),
      priority: deg === 1 ? 100 : deg === 5 ? 95 : deg === 4 ? 85 : 70,
    });
  }

  // Harmonic-minor V (major triad on 5̂ in minor)
  if (mode === 'minor') {
    const vRoot = (t + 7) % 12;
    out.push({
      rootPc: vRoot,
      pcs: [vRoot, (vRoot + 4) % 12, (vRoot + 7) % 12],
      type: 'major',
      numeral: 'V', quality: '',
      tendencyTones: ['leading-tone-minor'],
      priority: 95,
    });
    // Harmonic-minor vii° (diminished triad on raised 7̂)
    const viiRoot = (t + 11) % 12;
    out.push({
      rootPc: viiRoot,
      pcs: [viiRoot, (viiRoot + 3) % 12, (viiRoot + 6) % 12],
      type: 'diminished',
      numeral: 'vii', quality: DIM_SYMBOL,
      tendencyTones: ['leading-tone-minor'],
      priority: 80,
    });
  }

  return out;
}

/**
 * Match a 2-pc chord against the 3-pc diatonic triads in `key`. When `pcs` is
 * a 2-of-3 subset of some tonally active triad, label as that triad with
 * "(incomplete)" / "(implied root missing)" in the basis at confidence 0.65.
 *
 * Conservative: only 2-of-3 subsets are accepted; 1-pc sets are too ambiguous
 * to label.
 */
function tryIncompleteTriad(
  pcs: number[],
  bassPc: number | null,
  key: string,
): { reading: RomanNumeralReading; tendencyTones: TendencyToneTag[] } | null {
  const u = uniqPcs(pcs);
  if (u.length !== 2) return null;

  const cands = buildTriadCatalog(key);
  if (cands.length === 0) return null;
  const pcSet = new Set(u);

  let bestCand: TriadTemplate | null = null;
  let bestScore = -1;
  for (const cand of cands) {
    const candSet = new Set(cand.pcs);
    let allMatch = true;
    for (const p of u) {
      if (!candSet.has(p)) { allMatch = false; break; }
    }
    if (!allMatch) continue;

    let score = cand.priority;
    if (bassPc !== null && candSet.has(bassPc)) score += 5;
    if (bassPc !== null && bassPc === cand.rootPc) score += 5; // bass on root
    if (score > bestScore) {
      bestScore = score;
      bestCand = cand;
    }
  }

  if (!bestCand) return null;

  const inv: ChordIdentity['inversion'] = bassPc !== null
    ? inversionFromBass(bestCand.rootPc, bassPc, bestCand.type)
    : 'root';
  const figured = figuredBassFor(bestCand.type, inv);
  const { rn, rnAscii } = formatRn('', bestCand.numeral, bestCand.quality, figured);

  const isMissingRoot = !pcSet.has(bestCand.rootPc);
  const note = isMissingRoot ? '(implied root missing)' : '(incomplete)';

  return {
    reading: {
      rn, rnAscii,
      inversion: inv,
      localKey: key,
      confidence: 0.65,
      basis: `${rn} ${note} in ${key}`,
    },
    tendencyTones: bestCand.tendencyTones,
  };
}

/**
 * Single-pitch "chord" — treat the lone pitch as the root of an implied
 * diatonic chord at that scale degree. This is the right answer for pickup
 * beats and fermata holds where only one voice sounds: in C major a single
 * C implies I, a single G implies V, etc.
 *
 * Conservative: the pitch must be diatonic to the key (or the raised 7̂ in
 * minor — which carries the harmonic-minor V). Chromatic single pitches
 * remain "?" because labeling a single accidental note with a chord would
 * over-claim function from too little information.
 *
 * Note on the "first chord" concern: this does NOT affect global-key
 * detection. Key estimation in keyDetection.ts runs Krumhansl over the
 * whole piece (or the whole phrase). This handler only fires AFTER the key
 * is already known, and only assigns a label to a single-pitch position
 * once we already know what key we're in.
 */
function trySingleNoteRoot(
  pcs: number[],
  bassPc: number | null,
  key: string,
): { reading: RomanNumeralReading; tendencyTones: TendencyToneTag[] } | null {
  const u = uniqPcs(pcs);
  if (u.length !== 1) return null;

  const cands = buildTriadCatalog(key);
  if (cands.length === 0) return null;

  // Find the triad in the catalog whose root is the lone pitch.
  const pc = u[0];
  const match = cands.find(c => c.rootPc === pc);
  if (!match) return null;   // chromatic single pitch — too little info

  const inv: ChordIdentity['inversion'] = 'root';   // bass = root = the lone pitch
  const figured = figuredBassFor(match.type, inv);
  const { rn, rnAscii } = formatRn('', match.numeral, match.quality, figured);

  return {
    reading: {
      rn, rnAscii,
      inversion: inv,
      localKey: key,
      confidence: 0.55,   // low — we're inferring from one pitch
      basis: `${rn} implied — single-pitch root on ${match.numeral === 'I' || match.numeral === 'i' ? '1̂' : match.numeral === 'V' || match.numeral === 'v' ? '5̂' : 'scale degree'} in ${key}`,
    },
    tendencyTones: match.tendencyTones,
  };
}

// ─── Augmented sixths (Step 27) ──────────────────────────────────────────────

/**
 * Augmented sixth chords share two pitches: ♭6̂ (in the bass) and ♯4̂ (the
 * upward-pulling chromatic note). They differ in the third pitch:
 *   It+6: ♭6̂, 1̂, ♯4̂        (3 distinct pcs)
 *   Fr+6: ♭6̂, 1̂, 2̂, ♯4̂     (4 pcs — adds 2̂)
 *   Ger+6: ♭6̂, 1̂, ♭3̂, ♯4̂  (4 pcs — adds ♭3̂)
 */
function tryAugmentedSixth(
  pcs: number[],
  bassPc: number | null,
  key: string,
): { reading: RomanNumeralReading; tendencyTones: TendencyToneTag[] } | null {
  const t = tonicPc(key);
  if (t === null) return null;
  const flat6 = ((t + 8) % 12 + 12) % 12;
  const sharp4 = ((t + 6) % 12 + 12) % 12;
  const tonic = t;
  const flat3 = ((t + 3) % 12 + 12) % 12;
  const two = ((t + 2) % 12 + 12) % 12;

  const set = new Set(pcs);
  if (!set.has(flat6) || !set.has(sharp4) || !set.has(tonic)) return null;
  // Bass should be ♭6̂; if we don't know the bass, we still allow it but with
  // lower confidence.
  const bassMatches = bassPc === null || bassPc === flat6;
  if (!bassMatches) return null;

  // Italian: exactly {♭6̂, 1̂, ♯4̂} (3 distinct pcs)
  if (set.size === 3 && !set.has(flat3) && !set.has(two)) {
    const { rn, rnAscii } = formatRn('', 'It+6', '', '');
    return {
      reading: {
        rn, rnAscii,
        inversion: 'root',
        localKey: key,
        confidence: 0.9,
        basis: `Italian augmented sixth — ♭6̂ + 1̂ + ♯4̂`,
      },
      tendencyTones: ['phrygian-pull', 'temporary-leading-tone'],
    };
  }
  // French: 4 pcs incl. 2̂
  if (set.size === 4 && set.has(two) && !set.has(flat3)) {
    const { rn, rnAscii } = formatRn('', 'Fr+6', '', '');
    return {
      reading: {
        rn, rnAscii,
        inversion: 'root',
        localKey: key,
        confidence: 0.9,
        basis: `French augmented sixth — ♭6̂ + 1̂ + 2̂ + ♯4̂`,
      },
      tendencyTones: ['phrygian-pull', 'temporary-leading-tone'],
    };
  }
  // German: 4 pcs incl. ♭3̂
  if (set.size === 4 && set.has(flat3) && !set.has(two)) {
    const { rn, rnAscii } = formatRn('', 'Ger+6', '', '');
    return {
      reading: {
        rn, rnAscii,
        inversion: 'root',
        localKey: key,
        confidence: 0.9,
        basis: `German augmented sixth — ♭6̂ + 1̂ + ♭3̂ + ♯4̂`,
      },
      tendencyTones: ['phrygian-pull', 'temporary-leading-tone'],
    };
  }
  return null;
}

// ─── CT°⁷ (Step 26) and Tristan (Step 30) ────────────────────────────────────

/** Common-tone diminished seventh: a fully-diminished seventh that shares one
 *  common tone with the next chord, while the other three notes resolve
 *  chromatically into the next chord's tones. Requires lookahead. */
function tryCommonToneDim7(
  pcs: number[],
  key: string,
  nextPcs: number[] | null,
): { reading: RomanNumeralReading; tendencyTones: TendencyToneTag[] } | null {
  // Need a fully-diminished seventh first.
  const u = uniqPcs(pcs);
  if (u.length !== 4) return null;
  // Check intervals: every adjacent pc differs by 3 semitones.
  for (let i = 0; i < 12; i++) {
    const stack = [(i) % 12, (i + 3) % 12, (i + 6) % 12, (i + 9) % 12].sort((a, b) => a - b);
    if (stack.every((p, idx) => p === u[idx])) {
      // It's a dim7. Check common-tone-with-next.
      if (nextPcs && nextPcs.length > 0) {
        const common = u.filter(p => nextPcs.includes(p));
        const nonCommon = u.filter(p => !nextPcs.includes(p));
        if (common.length === 1 && nonCommon.length === 3) {
          // Each non-common tone must resolve by half-step (semitone-1) to a next-chord tone.
          const allChromatic = nonCommon.every(p =>
            nextPcs.some(np => Math.abs((np - p + 12) % 12) === 1
                            || Math.abs((np - p + 12) % 12) === 11),
          );
          if (allChromatic) {
            const { rn, rnAscii } = formatRn('CT', '', DIM_SYMBOL, '7');
            return {
              reading: {
                rn, rnAscii,
                inversion: 'root',
                localKey: key,
                confidence: 0.85,
                basis: `Common-tone diminished seventh — one common tone, three chromatic neighbors`,
              },
              tendencyTones: ['chromatic-neighbor'],
            };
          }
        }
      }
    }
  }
  return null;
}

/** Tristan-pattern: a half-diminished seventh (or its enharmonic Fr+6
 *  spelling) at a moment whose resolution treats one of the four pitches as
 *  a chordal seventh of a following V⁷-like chord. Returns multiple readings
 *  because the curriculum prose treats the ambiguity as the point. */
function tryTristanReading(
  pcs: number[],
  bassPc: number | null,
  key: string,
): RomanNumeralReading[] | null {
  // Detect a half-diminished seventh (m3 + d5 + m7 from root).
  const u = uniqPcs(pcs);
  if (u.length !== 4) return null;
  for (const root of u) {
    const ic = u.map(p => ((p - root) % 12 + 12) % 12).sort((a, b) => a - b);
    if (ic[0] === 0 && ic[1] === 3 && ic[2] === 6 && ic[3] === 10) {
      // Half-dim seventh on root.
      const readings: RomanNumeralReading[] = [];
      const halfDimAscii = `${NOTE_NAMES[root]}h7`;
      readings.push({
        rn: `${NOTE_NAMES[root]}${HALFDIM_SYMBOL}⁷`,
        rnAscii: halfDimAscii,
        inversion: bassPc === root ? 'root'
                  : bassPc === ((root + 3) % 12) ? '1st'
                  : bassPc === ((root + 6) % 12) ? '2nd'
                  : '3rd',
        localKey: key,
        confidence: 0.6,
        basis: `Half-diminished seventh on ${NOTE_NAMES[root]}`,
      });
      // Fr+6 reading — only if bass = ♭6̂ of `key`.
      const t = tonicPc(key);
      if (t !== null && bassPc === ((t + 8) % 12) && new Set(u).has(((t + 6) % 12))) {
        readings.push({
          rn: 'Fr+6',
          rnAscii: 'Fr+6',
          inversion: 'root',
          localKey: key,
          confidence: 0.55,
          basis: `Reads as French augmented sixth in ${key} (bass = ♭6̂; ♯4̂ present)`,
        });
      }
      // V⁷♭5 reading — alternate spelling for the same pc set.
      readings.push({
        rn: `V⁷♭5`,
        rnAscii: 'V7b5',
        inversion: 'root',
        localKey: key,
        confidence: 0.45,
        basis: `Reads as altered dominant seventh (V⁷♭5) — Wagner's deliberate ambiguity`,
      });
      return readings;
    }
  }
  return null;
}

// ─── Top-level analyzer ──────────────────────────────────────────────────────

export interface AnalyzeChordOptions {
  /** Local key for the chord. Required. */
  key: string;
  /** Optional: pcs of the next chord for CT°⁷ detection and lookahead
   *  disambiguation. */
  nextChordPcs?: number[];
  /** Optional: full next chord (used by lookahead disambiguation when a
   *  Dorian ii⁷ / vii°/V passing-chord ambiguity needs the next chord's
   *  identity to resolve). When omitted, lookahead disambiguation is skipped
   *  and the analyzer falls back to its default confidence-based ranking. */
  nextChord?: Chord;
  /** Optional: explicitly request Tristan readings. The analyzer always tries
   *  this; the option is here for callers that want to disable the multi-
   *  reading return for half-diminished sevenths in non-Wagnerian contexts. */
  enableTristanReading?: boolean;
}

/**
 * Run all the key-dependent classifiers in one pass. Returns the first match
 * (if any) plus its tendency tones. `priority` decides which check wins when
 * multiple fire (diatonic > secondary > borrowed > modal > incomplete-seventh
 * > incomplete-triad). The caller wraps this in cross-key retries.
 */
function tryAllInKey(
  ident: ChordIdentity,
  pcs: number[],
  bassPc: number | null,
  key: string,
  nextChordPcs: number[] | null,
): { reading: RomanNumeralReading; tendencyTones: TendencyToneTag[] } | null {
  // Sus/add runs first because it's gated on bass=root: it only fires when
  // the listener hears the chord as rooted at the bass, which is the case
  // where Iadd9 / V⁷sus4 / Iadd6 are the musically right label. For inverted
  // chords (bass on the third or fifth), sus/add skips itself and tryDiatonic
  // gets a chance to label it as a clean functional chord (e.g., vi⁷ in 1st
  // inversion).
  // tryBorrowedMinor runs BEFORE trySecondary because in minor keys
  // common Bach patterns like "major triad on 4̂" (= borrowed-major IV)
  // collide with secondary-dominant patterns (= V/♭VII = same pcs). The
  // borrowed-IV reading is far more common in tonal Bach practice, so
  // it should win when both could match. tryBorrowedMinor is a no-op in
  // major mode, so this ordering doesn't change major-mode behavior.
  return trySuspendedOrAdded(pcs, bassPc, key, nextChordPcs)
      ?? tryDiatonic(ident, key)
      ?? tryBorrowedMinor(ident, key)
      ?? trySecondary(ident, key)
      ?? tryBorrowed(ident, key)
      ?? tryModalColor(ident, key, pcs)
      ?? tryIncompleteSeventh(pcs, bassPc, key)
      ?? tryIncompleteTriad(pcs, bassPc, key)
      ?? trySingleNoteRoot(pcs, bassPc, key);   // last resort — 1-pc chords
}

/**
 * Disambiguate between two competing readings when lookahead context is
 * available. Specifically: when one reading is a Dorian ii⁷ and another is a
 * passing vii°/V, the next chord's identity is the deciding factor:
 *   resolves to V → Dorian ii⁷ (functional)
 *   resolves to I/i⁶ → passing chord (chromatic neighbor)
 *
 * This helper takes the existing readings list and, when the lookahead pulls
 * a specific reading forward, bumps its confidence so the sort puts it first.
 * The two readings remain in `readings[]` so a consumer can still inspect
 * both interpretations.
 */
function disambiguateWithLookahead(
  readings: RomanNumeralReading[],
  key: string,
  nextChord: Chord | null,
): void {
  if (!nextChord) return;
  if (readings.length === 0) return;

  const t = tonicPc(key);
  if (t === null) return;
  const nextRootPcs = nextChord.pcs;
  const nextSet = new Set(nextRootPcs);

  // Resolution targets:
  //   - V root pc = (t + 7) % 12 (with V's third = (t + 11) %12 for major V).
  //   - I/i root pc = t.
  const vPc = (t + 7) % 12;
  const vThirdMajor = (t + 11) % 12;  // raised 7̂ in minor = major-V third
  const iPc = t;

  // Heuristic: next chord "is V" if pc-set strongly includes vPc + leading tone.
  const nextLooksLikeV = nextSet.has(vPc) && nextSet.has(vThirdMajor);
  const nextLooksLikeI = nextSet.has(iPc) && !nextSet.has(vPc);

  for (const r of readings) {
    // Dorian ii / ii⁷ reading: bump if next chord looks like V.
    if (/^ii(⁷|⁶|⁶⁄₅)?$/.test(r.rn) && nextLooksLikeV) {
      r.confidence = Math.min(0.95, r.confidence + 0.15);
      r.basis += ' — confirmed by resolution to V';
    }
    // vii°/V reading: bump if next chord looks like V; demote if next chord
    // looks like I/i (in which case the passing reading is preferred).
    if (/^vii.*\/V$/.test(r.rn) || /^V.*\(implied root missing\)/.test(r.basis)) {
      if (nextLooksLikeV) {
        r.confidence = Math.min(0.95, r.confidence + 0.1);
      } else if (nextLooksLikeI) {
        r.confidence = Math.max(0.3, r.confidence - 0.2);
        r.basis += ' — would resolve to V but next chord is I/i (passing chord reading also plausible)';
      }
    }
  }
}

export function analyzeChord(
  chord: Chord,
  opts: AnalyzeChordOptions,
): ChordAnalysis {
  const { key, nextChordPcs, nextChord, enableTristanReading = true } = opts;
  const pcs = chord.pcs;
  const bassPc = chord.bassPc;

  const ident = identifyChord(pcs, bassPc);
  const readings: RomanNumeralReading[] = [];
  const tendencyTones: TendencyToneTag[] = [];

  // 1. Augmented sixth — pc-set match takes priority over bare RN matching
  //    because aug-sixths look superficially like dom7 chords.
  const aug = tryAugmentedSixth(pcs, bassPc, key);
  if (aug) {
    readings.push(aug.reading);
    tendencyTones.push(...aug.tendencyTones);
  }

  // 2. Common-tone dim7 — needs lookahead.
  const ct = tryCommonToneDim7(pcs, key, nextChordPcs ?? null);
  if (ct) {
    readings.push(ct.reading);
    tendencyTones.push(...ct.tendencyTones);
  }

  // 3-7. Run all the key-dependent classifiers in the local key.
  if (readings.length === 0) {
    const match = tryAllInKey(ident, pcs, bassPc, key, nextChordPcs ?? null);
    if (match) {
      readings.push(match.reading);
      tendencyTones.push(...match.tendencyTones);
    }
  }

  // 8. Cross-key fallback. When the local key didn't yield a match, try
  //    related keys — most often the relative key (a Krumhansl misjudgement
  //    that places a passing tonicization in the wrong relative pair), and
  //    for major mode, the subdominant minor (where a bare diminished triad
  //    can be vii°⁷/V incomplete of that local tonic).
  if (readings.length === 0) {
    const relKey = relativeKey(key);
    if (relKey) {
      const match = tryModalColor(ident, relKey, pcs)
                ?? trySuspendedOrAdded(pcs, bassPc, relKey, nextChordPcs ?? null)
                ?? tryIncompleteSeventh(pcs, bassPc, relKey)
                ?? tryIncompleteTriad(pcs, bassPc, relKey);
      if (match) {
        match.reading.basis += ` — borrowed from relative ${relKey}`;
        readings.push(match.reading);
        tendencyTones.push(...match.tendencyTones);
      }
    }
  }
  if (readings.length === 0) {
    const mode = keyMode(key);
    if (mode === 'major') {
      const t = tonicPc(key);
      if (t !== null) {
        // Subdominant-as-minor: e.g., in E major also try A minor.
        const subRoot = (t + 5) % 12;
        const subKey = `${NOTE_NAMES[subRoot]} minor`;
        const match = trySuspendedOrAdded(pcs, bassPc, subKey, nextChordPcs ?? null)
                  ?? tryIncompleteSeventh(pcs, bassPc, subKey)
                  ?? tryIncompleteTriad(pcs, bassPc, subKey);
        if (match) {
          match.reading.basis += ` — tonicization of ${subKey}`;
          readings.push(match.reading);
          tendencyTones.push(...match.tendencyTones);
        }
      }
    }
  }

  // 9. Tristan reading (multi-reading) — only when nothing else matched AND
  //    we have a half-diminished seventh.
  if (enableTristanReading && readings.length === 0) {
    const tristan = tryTristanReading(pcs, bassPc, key);
    if (tristan) {
      readings.push(...tristan);
    }
  }

  // 10. Fallback: report pcs and a low-confidence "?" reading.
  if (readings.length === 0) {
    const pcNames = pcs.map(p => NOTE_NAMES[p]).join('-');
    readings.push({
      rn: '?',
      rnAscii: '?',
      inversion: 'root',
      localKey: key,
      confidence: 0.1,
      basis: `Unrecognized chord {${pcNames}} in ${key}`,
    });
  }

  // 11. Lookahead disambiguation — re-rank readings when the next chord
  //     resolves ambiguity. No-op when nextChord is omitted.
  disambiguateWithLookahead(readings, key, nextChord ?? null);

  // Sort by confidence descending.
  readings.sort((a, b) => b.confidence - a.confidence);
  const primary = readings[0];

  // Three-perspective tagging. We populate `vertical` and `tonal` for any
  // chord with a defined RN; `horizontal` is left to consumers that have line
  // context (chordify alone cannot determine it).
  const perspectives: Perspectives = {};
  if (primary.rn !== '?') {
    perspectives.vertical = `Chord: ${primary.rn} in ${primary.localKey}`;
    perspectives.tonal = primary.basis;
  }

  return {
    measure: chord.measure,
    beat: chord.beat,
    pitches: chord.pitches,
    pcSet: pcs,
    primary: primary.rn,
    primaryBasis: primary.basis,
    rootPc: ident.root,
    readings,
    tendencyTones: Array.from(new Set(tendencyTones)),
    perspectives,
  };
}

// Re-export so callers can import directly from this module.
export { pc, namePc };

// Suppress unused-import warnings for items kept available to consumers.
void pc; void namePc; void parallelKey;
