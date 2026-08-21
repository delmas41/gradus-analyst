// ─── lib/musicology/keyDetection.ts ──────────────────────────────────────────
// Key detection via duration-weighted pitch-class profile correlation.
//
// We support three published profile sets and default to Aarden-Essen because
// `score.analyze('key')` in Music21 defaults to it; matching Music21's results
// on Bach chorales is one of Phase 1's gates. Krumhansl-Schmuckler is kept
// available because it is the canonical reference cited by the cognitive-
// psychology literature.
//
// Profiles:
//   - Aarden-Essen (Aarden 2003) — derived from the Essen folksong corpus.
//     Sharply peaked on the tonic and a few stable degrees. Default.
//   - Krumhansl-Schmuckler (Krumhansl 1990, ch. 2) — derived from
//     probe-tone listener experiments. Smoother profile.
//   - Bellman-Budge (Bellman 2005) — symmetric variant with strong tonic.
//
// The algorithm:
//   1. Build a 12-element pitch-class duration profile of the input notes.
//   2. Correlate (Pearson) with each of the 24 transposed profiles
//      (12 major + 12 minor).
//   3. Pick the key whose profile correlates highest. The correlation is the
//      analyzer's confidence (range roughly -0.3 to 0.95 in practice).
//
// Tonicization vs modulation (Step 22 / Step 28 territory):
//   Run windowed analysis across the piece. For a candidate "modulation"
//   from key A to key B at measure m, the change is a *modulation* if the
//   sliding window is dominated by B for ≥ stabilityFraction of the window;
//   otherwise it is a *tonicization* — a brief inflection without a true
//   tonal-center shift.
//
// All thresholds are tunable defaults; document them in JSDoc so callers can
// override per genre (chorales tonicize less than romantic-symphony recaps).

import { NOTE_NAMES } from './pitch.js';
import type { Note, Score, KeyEvent, KeySection } from './types.js';

// ─── Profiles ────────────────────────────────────────────────────────────────

/** Krumhansl 1990 major-key tonal hierarchy. Index 0 = tonic (1̂). */
const KRUMHANSL_MAJOR = [
  6.35, 2.23, 3.48, 2.33, 4.38, 4.09,
  2.52, 5.19, 2.39, 3.66, 2.29, 2.88,
];

/** Krumhansl 1990 minor-key tonal hierarchy. Index 0 = tonic. */
const KRUMHANSL_MINOR = [
  6.33, 2.68, 3.52, 5.38, 2.60, 3.53,
  2.54, 4.75, 3.98, 2.69, 3.34, 3.17,
];

/** Aarden-Essen 2003 major profile. Derived from the Essen folksong corpus,
 *  weighted by the duration each scale degree spends in the corpus. Much
 *  more sharply peaked on tonic / stable degrees than Krumhansl. This is
 *  Music21's default for `score.analyze('key')`. */
const AARDEN_MAJOR = [
  17.7661, 0.145624, 14.9265, 0.160186, 19.8049, 11.3587,
  0.291248, 22.062, 0.145624, 8.15494, 0.232998, 4.95122,
];

/** Aarden-Essen minor profile. */
const AARDEN_MINOR = [
  18.2648, 0.737619, 14.0499, 16.8599, 0.702494, 14.4362,
  0.702494, 18.6161, 4.56621, 1.93186, 7.37619, 1.75623,
];

/** Bellman-Budge 2005 major profile. */
const BELLMAN_MAJOR = [
  16.8, 0.86, 12.95, 1.41, 13.49, 11.93,
  1.25, 20.28, 1.8, 8.04, 0.62, 10.57,
];

/** Bellman-Budge minor profile. */
const BELLMAN_MINOR = [
  18.16, 0.69, 12.99, 13.34, 1.07, 11.15,
  1.38, 21.07, 7.49, 1.53, 0.92, 10.21,
];

export type ProfileName = 'aarden' | 'krumhansl' | 'bellman';

const PROFILES: Record<ProfileName, { major: number[]; minor: number[] }> = {
  aarden:    { major: AARDEN_MAJOR,    minor: AARDEN_MINOR },
  krumhansl: { major: KRUMHANSL_MAJOR, minor: KRUMHANSL_MINOR },
  bellman:   { major: BELLMAN_MAJOR,   minor: BELLMAN_MINOR },
};

const DEFAULT_PROFILE: ProfileName = 'aarden';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Transpose a 12-element profile so the tonic sits at pitch class `tonicPc`. */
function rotate(profile: number[], tonicPc: number): number[] {
  const out = new Array(12);
  for (let i = 0; i < 12; i++) {
    out[i] = profile[((i - tonicPc) % 12 + 12) % 12];
  }
  return out;
}

/** Pearson correlation. Returns 0 when either input is constant. */
function pearson(a: number[], b: number[]): number {
  const n = a.length;
  if (n === 0) return 0;
  let sumA = 0, sumB = 0;
  for (let i = 0; i < n; i++) { sumA += a[i]; sumB += b[i]; }
  const meanA = sumA / n, meanB = sumB / n;
  let num = 0, denomA = 0, denomB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    num += da * db;
    denomA += da * da;
    denomB += db * db;
  }
  if (denomA === 0 || denomB === 0) return 0;
  return num / Math.sqrt(denomA * denomB);
}

/** Build a duration-weighted pc profile from a list of notes. Rests skipped. */
function pcProfile(notes: Note[]): number[] {
  const profile = new Array(12).fill(0);
  for (const n of notes) {
    if (n.midi === null || n.isRest) continue;
    const pc = ((n.midi % 12) + 12) % 12;
    profile[pc] += Math.max(n.duration, 0);
  }
  return profile;
}

/** "C" → 0, "F#" → 6, "Bb" → 10. */
function keyNameToPc(root: string): number {
  // Convert flats to enharmonic sharps for index lookup.
  const enh: Record<string, string> = { Db: 'C#', Eb: 'D#', Gb: 'F#', Ab: 'G#', Bb: 'A#' };
  return NOTE_NAMES.indexOf(enh[root] ?? root);
}

// ─── Public API ──────────────────────────────────────────────────────────────

export interface KeyEstimate {
  /** "C major", "Bb minor". Uses flats for flat-key names (Bb, Eb, Ab, Db, Gb)
   *  and sharps for sharp-key names (G, D, A, E, B, F#, C#) — matching the
   *  curriculum prose convention. */
  key: string;
  /** Pearson correlation with the winning profile. Roughly 0.6–0.9 for clear
   *  tonal music; below 0.5 means the analyzer is unsure. */
  confidence: number;
  /** Runner-up key (for tonicization-vs-modulation logic). Often a closely-
   *  related key (V, vi, IV) when confidence is low. */
  runnerUp: string;
  runnerUpConfidence: number;
  /** "major" or "minor". */
  mode: 'major' | 'minor';
  /** Tonic pitch class 0..11. */
  tonicPc: number;
}

/** Canonical (= fewest accidentals) major-key tonic name per pitch class. */
const PC_TO_MAJOR_NAME: Record<number, string> = {
  0: 'C',  1: 'Db', 2: 'D',  3: 'Eb', 4: 'E',  5: 'F',
  6: 'F#', 7: 'G',  8: 'Ab', 9: 'A',  10: 'Bb', 11: 'B',
};

/** Canonical (= fewest accidentals) minor-key tonic name per pitch class.
 *  Bb minor (5 flats) is preferred over A# minor (7 sharps); Eb minor (6
 *  flats) is preferred over D# minor (6 sharps); etc. Matches Music21. */
const PC_TO_MINOR_NAME: Record<number, string> = {
  0: 'C',  1: 'C#', 2: 'D',  3: 'Eb', 4: 'E',  5: 'F',
  6: 'F#', 7: 'G',  8: 'G#', 9: 'A',  10: 'Bb', 11: 'B',
};

function preferredKeyName(pc: number, mode: 'major' | 'minor'): string {
  const root = (mode === 'major' ? PC_TO_MAJOR_NAME : PC_TO_MINOR_NAME)[pc] ?? NOTE_NAMES[pc];
  return `${root} ${mode}`;
}

/**
 * Run profile-correlation key detection over the given notes. Returns the
 * winning key plus its runner-up (used by tonicization-vs-modulation
 * classification).
 *
 * `profileName` defaults to 'aarden' to match Music21's `score.analyze('key')`.
 * Set 'krumhansl' for the canonical published profile.
 */
export function analyzeNotesKey(
  notes: Note[],
  profileName: ProfileName = DEFAULT_PROFILE,
): KeyEstimate | null {
  const profile = pcProfile(notes);
  const totalDuration = profile.reduce((a, b) => a + b, 0);
  if (totalDuration === 0) return null;

  const { major, minor } = PROFILES[profileName];

  let bestKey = '';
  let bestMode: 'major' | 'minor' = 'major';
  let bestPc = 0;
  let bestCorr = -2;
  let secondKey = '';
  let secondCorr = -2;

  for (let tonic = 0; tonic < 12; tonic++) {
    const majProfile = rotate(major, tonic);
    const minProfile = rotate(minor, tonic);
    const majCorr = pearson(profile, majProfile);
    const minCorr = pearson(profile, minProfile);
    const candidates: Array<[number, 'major' | 'minor']> = [
      [majCorr, 'major'],
      [minCorr, 'minor'],
    ];
    for (const [corr, mode] of candidates) {
      const name = preferredKeyName(tonic, mode);
      if (corr > bestCorr) {
        secondCorr = bestCorr;
        secondKey = bestKey;
        bestCorr = corr;
        bestKey = name;
        bestMode = mode;
        bestPc = tonic;
      } else if (corr > secondCorr) {
        secondCorr = corr;
        secondKey = name;
      }
    }
  }

  return {
    key: bestKey,
    confidence: bestCorr,
    runnerUp: secondKey,
    runnerUpConfidence: secondCorr,
    mode: bestMode,
    tonicPc: bestPc,
  };
}

/** Whole-piece key — equivalent to running the analyzer over every note.
 *
 *  Known limitation: pieces with extensive modal/minor coloring throughout
 *  but a final apotheosis in the parallel major (Bruckner 5 mvt I is the
 *  canonical case) will produce a minor-mode key estimate even though the
 *  conventional analytical reading is the parallel major. Krumhansl is
 *  duration-weighted; the apotheosis is short relative to the rest of the
 *  movement, so it gets outvoted. Music21's `analyze('key')` produces the
 *  same B♭-minor reading for Bruckner 5. End-weighting heuristics (up to 3x
 *  the final 10% of measures) were tested empirically and don't shift the
 *  Bruckner result without risking over-correction elsewhere.
 *
 *  When you know the work's declared key (e.g. from a catalog metadata
 *  field), prefer that as the analyzer's home key over the Krumhansl
 *  estimate — analyzeKey's job is to GUESS the key from pitch content
 *  alone, not to override authoritative metadata. */
export function analyzeKey(
  score: Score,
  profileName: ProfileName = DEFAULT_PROFILE,
): KeyEstimate | null {
  return analyzeNotesKey(score.notes, profileName);
}

/**
 * Local key estimate centered on a measure, using a window of `halfWindow`
 * measures on either side. `halfWindow = 2` → 4-measure window plus the
 * center, total 5 measures.
 */
export function analyzeKeyAt(
  score: Score,
  centerMeasure: number,
  halfWindow = 2,
  profileName: ProfileName = DEFAULT_PROFILE,
): KeyEstimate | null {
  const lo = Math.max(1, centerMeasure - halfWindow);
  const hi = centerMeasure + halfWindow;
  const window = score.notes.filter(n => n.measure >= lo && n.measure <= hi);
  if (window.length === 0) return null;
  return analyzeNotesKey(window, profileName);
}

export interface KeyTrajectoryEntry {
  measure: number;
  key: string;
  confidence: number;
  mode: 'major' | 'minor';
}

/**
 * Per-measure local-key trajectory across the whole piece. Each entry's `key`
 * is the windowed Krumhansl winner centered on that measure.
 */
export function analyzeKeyTrajectory(
  score: Score,
  halfWindow = 2,
  profileName: ProfileName = DEFAULT_PROFILE,
): KeyTrajectoryEntry[] {
  const out: KeyTrajectoryEntry[] = [];
  const lastMeasure = score.measureCount || score.notes.reduce((m, n) => Math.max(m, n.measure), 1);
  for (let m = 1; m <= lastMeasure; m++) {
    const e = analyzeKeyAt(score, m, halfWindow, profileName);
    if (e) {
      out.push({ measure: m, key: e.key, confidence: e.confidence, mode: e.mode });
    }
  }
  return out;
}

// ─── Tonicization vs modulation ──────────────────────────────────────────────

export type KeyChangeKind = 'tonicization' | 'modulation' | 'none';

/**
 * Classify the change at `measure` in the trajectory. A modulation is
 * declared when the candidate key dominates a window of the next
 * `lookAheadMeasures` measures by at least `stabilityFraction`.
 *
 * Defaults: 4-measure look-ahead, 0.6 stability fraction. These are tunable
 * — chorales modulate less than late-romantic recapitulations, so the
 * analyzer caller may want to lower the threshold for chorales.
 */
export function classifyKeyChange(
  trajectory: KeyTrajectoryEntry[],
  fromMeasure: number,
  toMeasure: number,
  opts: { lookAheadMeasures?: number; stabilityFraction?: number } = {},
): KeyChangeKind {
  const { lookAheadMeasures = 4, stabilityFraction = 0.6 } = opts;
  const fromEntry = trajectory.find(e => e.measure === fromMeasure);
  const toEntry = trajectory.find(e => e.measure === toMeasure);
  if (!fromEntry || !toEntry) return 'none';
  if (fromEntry.key === toEntry.key) return 'none';

  // Look at trajectory[toMeasure .. toMeasure + lookAheadMeasures]
  const window = trajectory.filter(
    e => e.measure >= toMeasure && e.measure < toMeasure + lookAheadMeasures,
  );
  if (window.length === 0) return 'none';
  const matching = window.filter(e => e.key === toEntry.key).length;
  const fraction = matching / window.length;
  return fraction >= stabilityFraction ? 'modulation' : 'tonicization';
}

/**
 * Compute the Pearson correlation of a *specific named key* against the
 * given notes. Use this to check how well the global key fits a phrase's
 * notes before accepting a local-key shift that differs from the global estimate.
 *
 * Returns 0 when notes is empty or the key string is not parseable.
 */
export function correlateKey(
  notes: Note[],
  key: string,
  profileName: ProfileName = DEFAULT_PROFILE,
): number {
  const profile = pcProfile(notes);
  const totalDuration = profile.reduce((a, b) => a + b, 0);
  if (totalDuration === 0) return 0;

  const m = key.match(/^([A-G](?:##|#|bb|b)?)\s+(major|minor)$/i);
  if (!m) return 0;
  const root = m[1];
  const mode = m[2].toLowerCase() as 'major' | 'minor';
  const tonic = keyNameToPc(root);
  if (tonic < 0) return 0;

  const { major, minor } = PROFILES[profileName];
  const ref = rotate(mode === 'minor' ? minor : major, tonic);
  return pearson(profile, ref);
}

/**
 * Convenience: convert the trajectory into a list of confirmed modulations.
 * Each entry in the result is a key change that survived the stability test.
 */
export function detectModulations(
  trajectory: KeyTrajectoryEntry[],
  opts: { lookAheadMeasures?: number; stabilityFraction?: number } = {},
): KeyEvent[] {
  const out: KeyEvent[] = [];
  for (let i = 1; i < trajectory.length; i++) {
    const prev = trajectory[i - 1];
    const cur = trajectory[i];
    if (prev.key === cur.key) continue;
    const kind = classifyKeyChange(trajectory, prev.measure, cur.measure, opts);
    if (kind !== 'modulation') continue;
    const fifthsMatch = cur.key.match(/^([A-G](?:##|#|bb|b)?)\s+(major|minor)$/i);
    const root = fifthsMatch ? fifthsMatch[1] : 'C';
    const tonic = keyNameToPc(root);
    out.push({
      measure: cur.measure,
      beat: 1,
      key: cur.key,
      fifths: 0, // unknown; we rebuild from name when we need it
      mode: cur.mode,
    });
    void tonic; // pc available for callers who need it via tonicPc()
  }
  return out;
}


// ─── Hierarchical key analysis — sustained-section detection ─────────────────

/**
 * Detect sustained non-home key regions ("sections") in a piece. The middle
 * tier between whole-piece key and per-phrase key: identifies modulations
 * that span enough measures to be structurally definitive (sonata-form
 * Group 2 in the relative major, a 60-bar development episode, a recap
 * variant in the tonic-major) without firing on brief 4–20-measure
 * tonicizations that phrase-mode already handles.
 *
 * Algorithm:
 *   1. Compute the global key (whole-piece Krumhansl).
 *   2. For each measure m, run a wide windowed Krumhansl centered on m
 *      (default ±12 measures = 25-measure window).
 *   3. At each measure, ask: does the windowed winner differ from global,
 *      AND does its correlation beat the global key's correlation on the
 *      same window by ≥ `deltaOverGlobal`?
 *   4. Find runs of consecutive "yes" answers where ALL measures agree on
 *      the SAME non-global key. Runs of length ≥ `minSectionMeasures`
 *      become sections.
 *   5. Adjacent sections in the same key (separated by short gaps) merge.
 *
 * Defaults are tuned conservatively:
 *   - 25-measure window: enough context to be reliable; short enough to
 *     resolve mid-piece modulations.
 *   - 30-measure minimum: filters out chorale-scale tonicizations
 *     (typical chorales spend 4–20 measures in a tonicized key).
 *   - 0.10 delta over global: weaker than the per-phrase 0.30 because a
 *     longer window is more reliable; we want sustained modulations to
 *     register even when individual phrases inside might bounce around.
 *
 * Returns sections in measure order. Empty array means no sustained
 * modulations were found — typical for Bach chorales.
 */
export function detectKeySections(
  score: Score,
  opts: {
    /** Half-window in measures (window = 2*halfWindow + 1). Default 12. */
    windowHalf?: number;
    /** Minimum span (in measures) for a section. Default 30. */
    minSectionMeasures?: number;
    /** Correlation delta over the global key required to count a measure
     *  as "non-home" for that window. Default 0.10. */
    deltaOverGlobal?: number;
    /** Max gap (in measures) between same-key runs that should be merged
     *  into one section. Default 4. */
    maxMergeGap?: number;
    /** Profile to use for Krumhansl. Default 'aarden'. */
    profileName?: ProfileName;
  } = {},
): KeySection[] {
  const windowHalf = opts.windowHalf ?? 12;
  const minSectionMeasures = opts.minSectionMeasures ?? 30;
  const deltaOverGlobal = opts.deltaOverGlobal ?? 0.10;
  const maxMergeGap = opts.maxMergeGap ?? 4;
  const profileName = opts.profileName ?? DEFAULT_PROFILE;

  const overall = analyzeKey(score, profileName);
  if (!overall) return [];
  const globalKey = overall.key;

  const lastMeasure = score.measureCount || score.notes.reduce((m, n) => Math.max(m, n.measure), 1);
  if (lastMeasure < minSectionMeasures) return [];

  // Per-measure: windowed Krumhansl winner + how strongly global fits the
  // SAME window. The delta comparison must be on the same window — otherwise
  // we'd be comparing apples to oranges (windowed winner vs whole-piece global).
  type Marker = { measure: number; windowedKey: string | null; nonHome: boolean };
  const markers: Marker[] = [];
  for (let m = 1; m <= lastMeasure; m++) {
    const lo = Math.max(1, m - windowHalf);
    const hi = m + windowHalf;
    const windowNotes = score.notes.filter(n => n.measure >= lo && n.measure <= hi);
    if (windowNotes.length === 0) {
      markers.push({ measure: m, windowedKey: null, nonHome: false });
      continue;
    }
    const windowed = analyzeNotesKey(windowNotes, profileName);
    if (!windowed) {
      markers.push({ measure: m, windowedKey: null, nonHome: false });
      continue;
    }
    const sameAsGlobal = windowed.key === globalKey;
    if (sameAsGlobal) {
      markers.push({ measure: m, windowedKey: windowed.key, nonHome: false });
      continue;
    }
    const globalFit = correlateKey(windowNotes, globalKey, profileName);
    const nonHome = windowed.confidence - globalFit >= deltaOverGlobal;
    markers.push({ measure: m, windowedKey: windowed.key, nonHome });
  }

  // Helper: extract tonic pc from a key string ("Bb major" → 10, "B minor"
  // → 11). Parallel major and minor of the same tonic return the same pc.
  // This is the key insight for tonic-grouping: a passage that flips between
  // parallel major and minor (very common in Brahms, Bruckner, late-Beethoven
  // sonata-form Group 2 areas) should NOT have its run broken by the mode
  // change. The tonal area "B" is the same area whether B major or B minor.
  const tonicPcOf = (key: string): number => {
    const m = key.match(/^([A-G](?:##|#|bb|b)?)\s+(major|minor)/i);
    if (!m) return -1;
    return keyNameToPc(m[1]);
  };
  const globalTonic = tonicPcOf(globalKey);

  // Walk the markers: build runs of consecutive non-home measures sharing
  // the same TONIC (regardless of mode). Within a run, track which exact
  // keys appeared so we can pick the run's dominant mode by majority vote.
  //
  // "Non-home" here is mode-sensitive: a C-major windowed key in a C-minor
  // piece counts as non-home because the parallel-major reading IS a real
  // tonal shift (Beethoven 5's recap variant of Group 2 in C major), even
  // though it shares a tonic with the global key. The bridge-merge pass
  // below collapses brief parallel-mode interpolations (Brahms 4 mvt 1
  // E-major mixture inside a B-major Group 2) into the surrounding tonic.
  type Run = {
    measureStart: number;
    measureEnd: number;
    tonicPc: number;
    keyCounts: Map<string, number>;
    confSum: number;
    confCount: number;
  };
  const runs: Run[] = [];
  let cur: Run | null = null;
  for (const mk of markers) {
    const wt = mk.windowedKey ? tonicPcOf(mk.windowedKey) : -1;
    // Use mode-sensitive non-home detection (mk.nonHome was set in the
    // marker pass with windowed.key !== globalKey). Don't reject by tonic
    // equality — parallel-mode mixtures are real non-home events.
    const isNonHomeTonic = mk.nonHome && mk.windowedKey && wt !== -1;
    if (isNonHomeTonic) {
      const lo = Math.max(1, mk.measure - windowHalf);
      const hi = mk.measure + windowHalf;
      const windowed = analyzeNotesKey(
        score.notes.filter(n => n.measure >= lo && n.measure <= hi),
        profileName,
      );
      if (cur && cur.tonicPc === wt && mk.measure === cur.measureEnd + 1) {
        cur.measureEnd = mk.measure;
        cur.keyCounts.set(mk.windowedKey!, (cur.keyCounts.get(mk.windowedKey!) ?? 0) + 1);
        if (windowed) {
          cur.confSum += windowed.confidence;
          cur.confCount += 1;
        }
      } else {
        if (cur) runs.push(cur);
        cur = {
          measureStart: mk.measure,
          measureEnd: mk.measure,
          tonicPc: wt,
          keyCounts: new Map([[mk.windowedKey!, 1]]),
          confSum: windowed?.confidence ?? 0,
          confCount: 1,
        };
      }
    } else if (cur) {
      runs.push(cur);
      cur = null;
    }
  }
  if (cur) runs.push(cur);

  // Merge same-tonic runs separated by ≤ maxMergeGap measures.
  const merged: Run[] = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last && last.tonicPc === r.tonicPc && r.measureStart - last.measureEnd <= maxMergeGap + 1) {
      last.measureEnd = r.measureEnd;
      last.confSum += r.confSum;
      last.confCount += r.confCount;
      Array.from(r.keyCounts.entries()).forEach(([k, v]) => {
        last.keyCounts.set(k, (last.keyCounts.get(k) ?? 0) + v);
      });
    } else {
      merged.push({ ...r, keyCounts: new Map(r.keyCounts) });
    }
  }

  // Bridge-merge pass: same-tonic runs separated by a SHORT cross-tonic
  // or home gap should be merged into one section. Two patterns motivate
  // this:
  //   (a) Brahms 4 mvt 1 Group 2 — B-tonic (m90-104) then E-major
  //       parallel-mode mixture (m105-111, E tonic = global tonic so it
  //       doesn't even form a run, just breaks the B run) then B-tonic
  //       again (m114-141). The 7-mm parallel-mode interpolation is
  //       inside the B-major Group 2, not a separate section.
  //   (b) Beethoven 7 mvt 1 — E-major Group 2 (m113-170) with a brief
  //       E-minor mode flip (m175-180, same tonic) before the C-major
  //       development. The mode flip should be absorbed into the E
  //       section.
  //
  // Rule: walk `merged` and merge run R into the previous run P when
  // P and R share a tonic AND the gap from P.end to R.start is ≤
  // bridgeGapMeasures (default 16). The gap can be home-key measures
  // OR a short different-tonic interpolation — either way, if the
  // two flanking runs share a tonic, they're the same tonal area.
  const bridgeGapMeasures = 16;
  const bridged: Run[] = [];

  const absorb = (into: Run, from: Run): void => {
    into.measureEnd = from.measureEnd;
    into.confSum += from.confSum;
    into.confCount += from.confCount;
    Array.from(from.keyCounts.entries()).forEach(([k, v]) => {
      into.keyCounts.set(k, (into.keyCounts.get(k) ?? 0) + v);
    });
  };

  for (const r of merged) {
    const last = bridged[bridged.length - 1];
    const secondLast = bridged[bridged.length - 2];

    // Case A — same-tonic adjacent across a home-key (or no-run) gap.
    if (last && last.tonicPc === r.tonicPc &&
        r.measureStart - last.measureEnd - 1 <= bridgeGapMeasures) {
      absorb(last, r);
      continue;
    }

    // Case B — same-tonic across a brief cross-tonic interpolation.
    // The interpolation `last` is a different-tonic run that's MUCH
    // shorter than the surrounding same-tonic runs (the Brahms 4 E-major
    // mixture inside a B-major Group 2). Merge secondLast + r and
    // discard last.
    if (secondLast && last && secondLast.tonicPc === r.tonicPc) {
      const sameTonicLeft = secondLast.measureEnd - secondLast.measureStart + 1;
      const sameTonicRight = r.measureEnd - r.measureStart + 1;
      const gapRun = last.measureEnd - last.measureStart + 1;
      const totalGap = r.measureStart - secondLast.measureEnd - 1;
      const canBridge =
        gapRun < Math.min(sameTonicLeft, sameTonicRight) &&
        totalGap <= bridgeGapMeasures;
      if (canBridge) {
        bridged.pop();             // drop the cross-tonic interpolation
        absorb(secondLast, r);
        continue;
      }
    }

    bridged.push({ ...r, keyCounts: new Map(r.keyCounts) });
  }

  // Pick the run's representative key by majority vote among its measures.
  const dominantKey = (r: Run): string => {
    let best = '';
    let bestCount = -1;
    Array.from(r.keyCounts.entries()).forEach(([k, c]) => {
      if (c > bestCount) { bestCount = c; best = k; }
    });
    return best;
  };

  // Promote runs meeting the minimum-span threshold to sections.
  const sections: KeySection[] = [];
  for (const r of bridged) {
    const span = r.measureEnd - r.measureStart + 1;
    if (span < minSectionMeasures) continue;
    const key = dominantKey(r);
    sections.push({
      measureStart: r.measureStart,
      measureEnd: r.measureEnd,
      key,
      confidence: r.confCount > 0 ? r.confSum / r.confCount : 0,
      basis: `Sustained ${key} (tonic pc ${r.tonicPc}) for ${span} measures (window ${windowHalf * 2 + 1}, Δ≥${deltaOverGlobal.toFixed(2)})`,
    });
  }

  // Section-edge expansion — walk outward from each section with a narrower
  // window. Absorb adjacent measures whose narrow-windowed key shares the
  // section's TONIC (mode flips OK). Stop when (a) the narrow window says
  // we've returned to the global key, (b) the narrow-windowed key has a
  // different tonic from the section's, or (c) we'd cross into another
  // section's core measures. The third clause is what prevents adjacent
  // E-major and C-major sections from absorbing each other's territory
  // (the bug that produced overlapping sections in Beethoven 7 mvt 1).
  const narrowHalf = Math.max(4, Math.floor(windowHalf / 2));
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    const sectionTonic = tonicPcOf(section.key);
    const leftBound = i > 0 ? sections[i - 1].measureEnd + 1 : 1;
    const rightBound = i + 1 < sections.length ? sections[i + 1].measureStart - 1 : lastMeasure;

    // Walk left
    let leftEdge = section.measureStart;
    while (leftEdge > leftBound) {
      const m = leftEdge - 1;
      const lo = Math.max(1, m - narrowHalf);
      const hi = m + narrowHalf;
      const windowNotes = score.notes.filter(n => n.measure >= lo && n.measure <= hi);
      if (windowNotes.length === 0) break;
      const windowed = analyzeNotesKey(windowNotes, profileName);
      if (!windowed) break;
      if (windowed.key === globalKey) break;
      const wt = tonicPcOf(windowed.key);
      if (wt !== sectionTonic) break;
      leftEdge = m;
    }
    // Walk right
    let rightEdge = section.measureEnd;
    while (rightEdge < rightBound) {
      const m = rightEdge + 1;
      const lo = Math.max(1, m - narrowHalf);
      const hi = m + narrowHalf;
      const windowNotes = score.notes.filter(n => n.measure >= lo && n.measure <= hi);
      if (windowNotes.length === 0) break;
      const windowed = analyzeNotesKey(windowNotes, profileName);
      if (!windowed) break;
      if (windowed.key === globalKey) break;
      const wt = tonicPcOf(windowed.key);
      if (wt !== sectionTonic) break;
      rightEdge = m;
    }
    section.measureStart = leftEdge;
    section.measureEnd = rightEdge;
  }

  return sections;
}

// ─── Recap-variant detection ─────────────────────────────────────────────────

/**
 * Detect recap-variant relationships between key sections. Two sections
 * are recap-variants when they contain the same thematic material in
 * different keys (and thus different absolute pitch classes, but the
 * same pitch-class profile when transposed to a common reference).
 *
 * Algorithm:
 *   1. For each section, build a duration-weighted pitch-class profile
 *      transposed so the section's tonic sits at pc 0. This normalizes
 *      key — a melody that's I-IV-V in E♭ has the same transposed
 *      profile as the same melody in C major.
 *   2. Compare every pair (i, j) with i < j by Pearson correlation. If
 *      the correlation exceeds a threshold (default 0.85, i.e. very
 *      strong profile match), mark j as a recap of i.
 *   3. Annotate the section with `recapOf` and `recapTransposition`.
 *
 * Limitations: this catches thematic recap *under the same scale-degree
 * pattern*. It will NOT catch a variation that significantly alters
 * pitch content (e.g. an inverted theme, a thematic transformation
 * that adds chromatic neighbors). For Bach chorales the detector
 * produces no recaps (no sections); for sonata-form works it correctly
 * identifies exposition→recap parallels.
 */
export function annotateRecapVariants(
  score: Score,
  sections: KeySection[],
  opts: { profileName?: ProfileName; correlationThreshold?: number } = {},
): void {
  const profileName = opts.profileName ?? DEFAULT_PROFILE;
  const threshold = opts.correlationThreshold ?? 0.85;
  void profileName;

  if (sections.length < 2) return;

  // Per-section transposed-to-pc-0 profile.
  const profiles: Array<number[]> = [];
  const tonics: number[] = [];
  for (const sec of sections) {
    const m = sec.key.match(/^([A-G](?:##|#|bb|b)?)\s+(major|minor)/i);
    const tonic = m ? keyNameToPc(m[1]) : -1;
    tonics.push(tonic);
    const notes = score.notes.filter(
      n => n.measure >= sec.measureStart && n.measure <= sec.measureEnd,
    );
    const raw = pcProfile(notes);
    // Transpose so tonic sits at pc 0
    const transposed = new Array(12);
    for (let i = 0; i < 12; i++) {
      transposed[i] = raw[((i + tonic) % 12 + 12) % 12];
    }
    profiles.push(transposed);
  }

  for (let j = 1; j < sections.length; j++) {
    let bestI = -1;
    let bestCorr = -2;
    for (let i = 0; i < j; i++) {
      // Skip if the later section already claims a recap relationship
      // (sections normally only have ONE source recap, not a chain).
      if (sections[i].recapOf) continue;
      const corr = pearson(profiles[i], profiles[j]);
      if (corr > bestCorr) {
        bestCorr = corr;
        bestI = i;
      }
    }
    if (bestI >= 0 && bestCorr >= threshold) {
      const transposition = ((tonics[j] - tonics[bestI]) % 12 + 12) % 12;
      // Express transposition as the smaller signed value: -6..+5 instead
      // of 0..11. -4 (a major third down) is more intuitive than +8.
      const signed = transposition > 6 ? transposition - 12 : transposition;
      sections[j].recapOf = `section-${bestI}`;
      sections[j].recapTransposition = signed;
      sections[j].basis += `; recap of section-${bestI} transposed ${signed >= 0 ? '+' : ''}${signed} semitones (pc-profile r=${bestCorr.toFixed(2)})`;
    }
  }
}

// ─── Pivot-chord identification at section boundaries ────────────────────────

/**
 * Annotate each detected key section with the pivot chord that bridges its
 * modulation FROM the previous key area INTO the section's key. A pivot
 * chord is one that is *diatonic in both keys*. Standard pivots:
 *   Home C major → Eb major: ii (= Dm in C, = vi in F via Bb...) — none
 *   Home C minor → Eb major: III in C minor (Eb major) = I of Eb. Or
 *     i in C minor (Cm) — but Cm isn't diatonic in Eb. The cleanest
 *     pivot is iv in C minor (Fm) = ii in Eb.
 *   Home A major → E major: I or IV in A = IV or VII in E... actually
 *     IV in A (D maj) = ♭VII in E, not diatonic. The clean pivot is
 *     vi in A (F#m) = ii in E.
 *
 * Algorithm:
 *   1. For each section S whose immediate predecessor is the home key
 *      (or another section's tail), scan backward from S.measureStart
 *      across up to 6 measures looking for a chord that:
 *        a. is diatonic in the previous key area
 *        b. is diatonic in S.key
 *   2. The closest-to-section-boundary such chord is the pivot.
 *
 * Skips when:
 *   - The previous key is the same as the section key (no modulation).
 *   - No chord in the lookback window satisfies both keys.
 *   - The section is a recap whose preceding measures are already in a
 *     different region (the modulation is already analyzed earlier).
 *
 * This function depends on the per-chord RN readings that haven't been
 * computed yet at the point where detectKeySections runs. So it must be
 * called from analyzeScore() AFTER chordAnalyses are built.
 */
export interface PivotInputChord {
  measure: number;
  rn: string;             // primary RN reading in whatever key it was assigned
  pcs: number[];          // pitch-class set of the chord
}

export function annotatePivotChords(
  sections: KeySection[],
  chords: PivotInputChord[],
  globalKey: string,
  opts: { lookbackMeasures?: number } = {},
): void {
  const lookback = opts.lookbackMeasures ?? 6;
  if (sections.length === 0 || chords.length === 0) return;

  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i];
    const prevKey = i > 0 && sections[i - 1].measureEnd + 1 >= sec.measureStart - lookback
      ? sections[i - 1].key
      : globalKey;
    if (prevKey === sec.key) continue;

    const prevPcs = diatonicPcSet(prevKey);
    const newPcs = diatonicPcSet(sec.key);
    if (!prevPcs || !newPcs) continue;

    // Walk backward from sec.measureStart-1.
    const lookbackStart = Math.max(1, sec.measureStart - lookback);
    const candidates = chords
      .filter(c => c.measure >= lookbackStart && c.measure < sec.measureStart)
      .sort((a, b) => b.measure - a.measure); // closest first

    for (const c of candidates) {
      const inPrev = c.pcs.every(p => prevPcs.has(p));
      const inNew = c.pcs.every(p => newPcs.has(p));
      if (inPrev && inNew) {
        sec.pivotMeasure = c.measure;
        sec.pivotChordInOldKey = `${c.rn} in ${prevKey}`;
        // The new-key reading we can't easily compute without re-running
        // RN analysis with the new key — note just the source pcs.
        sec.pivotChordInNewKey = `same pcs diatonic in ${sec.key}`;
        sec.basis += `; pivot chord at m${c.measure} (${c.rn})`;
        break;
      }
    }
  }
}

/** Pitch-class set of the diatonic scale in `key`. Returns null if key
 *  string is unparseable. */
function diatonicPcSet(key: string): Set<number> | null {
  const m = key.match(/^([A-G](?:##|#|bb|b)?)\s+(major|minor)/i);
  if (!m) return null;
  const tonic = keyNameToPc(m[1]);
  if (tonic < 0) return null;
  const mode = m[2].toLowerCase();
  const intervals = mode === 'minor'
    ? [0, 2, 3, 5, 7, 8, 10]  // natural minor
    : [0, 2, 4, 5, 7, 9, 11];  // major
  const out = new Set<number>();
  for (const ivl of intervals) out.add((tonic + ivl) % 12);
  // For minor, also allow the harmonic-minor raised 7 (common in
  // pre-modulation cadential figures).
  if (mode === 'minor') out.add((tonic + 11) % 12);
  return out;
}
