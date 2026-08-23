// ─── lib/maestroAnalyst/analyze.ts ───────────────────────────────────────────
// The full-pipeline analyzer, in its OWN module so client components can
// import it directly without going through the barrel (index.ts) — the barrel
// re-exports ./xmlParser, whose static jszip import (~94KB) would otherwise
// ride into every bundle that only wants analyzeScore (MaestroAnalystPanel in
// /figured-bass, /chorale-harmonization, /counterpoint-workshop, the Master
// Sketchbook). index.ts re-exports everything here, so the barrel's public
// API is unchanged.
//
//   const result = analyzeScore(score);
//
// `result` carries everything Phase 0–2 produces:
//   - chord stream (chordify)
//   - whole-piece + per-measure key estimates
//   - phrase boundaries
//   - per-chord Roman-numeral readings + tendency-tone tags
//   - cadence per phrase
//
// Consumers (the critique route, check-l2-analysis, Maestro context builders)
// pick the fields they need; nothing here mutates the input score.

import type { Score, ScoreAnalysis, ChordAnalysis, PhraseRange, KeySection } from './types.js';
import { chordify } from './chordify.js';
import { analyzeKey, analyzeKeyTrajectory, analyzeKeyRegionTrajectory, analyzeNotesKey, correlateKey, detectKeySections, annotateRecapVariants, annotatePivotChords } from './keyDetection.js';
import { classifyMeasureTextures } from './texture.js';
import { findPhraseBoundaries } from './phraseSegmentation.js';
import { analyzeChord } from './romanNumeral.js';
import { classifyCadences } from './cadence.js';
import { detectPedalRuns, pedalPcByChordIndex, applyPedalReading } from './pedalPoint.js';
import { getScalePcs, isDiatonic } from './scale.js';

export interface AnalyzeScoreOptions {
  /** Local-key window half-size in measures. Default 2 (= 5-measure window).
   *  Only used when `useLocalKeys = 'window'`. */
  localKeyHalfWindow?: number;
  /** Local-key strategy:
   *    'phrase' — Krumhansl over each phrase's measures (best for chorales).
   *    'window' — sliding window centered on each measure.
   *    'overall' — use the whole-piece key everywhere.
   *  Default: 'phrase' if any phrase has > 1 measure, else 'window'.
   */
  useLocalKeys?: 'phrase' | 'window' | 'overall';
  /** Enable the hierarchical section detector. When true (default), the
   *  analyzer scans for sustained non-home key regions (≥30 measures) with
   *  a wide window before running phrase-mode, and uses each section's key
   *  as the "home" context for phrase-mode within that span. Off → falls
   *  back to the flat phrase-mode-vs-global-key behavior. */
  detectSections?: boolean;
}

/**
 * Run the full Phase 0–2 pipeline on a `Score`. The result is non-mutating
 * and idempotent — running twice produces the same object.
 */
export function analyzeScore(
  score: Score,
  opts: AnalyzeScoreOptions = {},
): ScoreAnalysis {
  const { localKeyHalfWindow = 2 } = opts;
  const textures = classifyMeasureTextures(score);

  // 1. Chord stream
  const chordStream = chordify(score);

  // 2. Whole-piece key
  const overallKeyEst = analyzeKey(score);
  const overallKey = overallKeyEst
    ? {
        measure: 1,
        beat: 1,
        key: overallKeyEst.key,
        fifths: 0,
        mode: overallKeyEst.mode,
      }
    : { measure: 1, beat: 1, key: 'C major', fifths: 0, mode: 'major' };

  // 3. Phrases — needed by both cadence classification and per-phrase keys.
  const phrases = findPhraseBoundaries(score);
  const useLocalKeys: 'phrase' | 'window' | 'overall' =
    opts.useLocalKeys ?? (phrases.some(p => p.measureEnd > p.measureStart) ? 'phrase' : 'window');

  // 3b. Sustained-section detection (hierarchical key analysis).
  //
  // Sections are the middle tier between whole-piece key and per-phrase key.
  // They catch structural modulations that span ≥ 30 measures — Group 2 of
  // a sonata exposition, a development episode, a recap variant — without
  // firing on the brief tonicizations that phrase-mode handles.
  //
  // For pieces with no sustained modulations (typical Bach chorales),
  // detectKeySections returns an empty array and phrase-mode runs exactly
  // as before. For sonata-form pieces (Beethoven 5 mvt 1's Group 2 in E♭
  // for 60+ bars, the C major recap variants, etc.) the detector picks up
  // the modulation and phrase-mode operates relative to the section key
  // rather than the home key.
  const detectSections = opts.detectSections ?? true;
  const keySections: KeySection[] = detectSections ? detectKeySections(score) : [];
  // Annotate sections with recap-variant relationships when two or more
  // are detected. Mutates `keySections` in place to add `recapOf` and
  // `recapTransposition` fields on later sections that match an earlier
  // one's transposed pc profile.
  if (keySections.length >= 2) {
    annotateRecapVariants(score, keySections);
  }
  // Build a per-measure section-key lookup for fast access in the loops below.
  const sectionKeyByMeasure = new Map<number, string>();
  for (const sec of keySections) {
    for (let m = sec.measureStart; m <= sec.measureEnd; m++) {
      sectionKeyByMeasure.set(m, sec.key);
    }
  }

  // 4. Per-phrase OR per-measure local keys.
  const localKeyByMeasure = new Map<number, string>();
  let localKeys: Array<{ measure: number; key: string; confidence: number }> = [];

  // Minimum confidence advantage required over the *contextual home* key
  // before accepting a per-phrase shift. The contextual home is the
  // section key when the phrase is inside a section, else the global key.
  // A small delta like 0.05 causes spurious relative-major/minor flips on
  // short phrases (A minor → C major when the phrase cadences on III).
  // Calibration on the 10-chorale theory-bench starter preset:
  //   delta = 0.20 → 41.4% exact match
  //   delta = 0.25 → 53.5%
  //   delta = 0.30 → 54.8%  ← chosen
  //   delta = 0.40 → 57.3% (suppresses real tonicizations; benchmark biased)
  // 0.30 catches every adjudicated relative-major-flip case while leaving
  // real long-form modulations to the section detector above.
  const PHRASE_KEY_DELTA = 0.30;

  if (useLocalKeys === 'phrase') {
    // Run Krumhansl per phrase, decide each phrase's key (relative to its
    // section/global home), then assign each measure. Two-pass design lets
    // us smooth isolated key-flips before they propagate to chord readings.
    //
    // Pass 1: per-phrase decision.
    interface PhraseDecision {
      phrase: PhraseRange;
      phraseKey: string;          // Krumhansl winner
      phraseConf: number;         // Krumhansl correlation
      homeKey: string;            // section key or global
      homeFit: number;            // global-fit correlation
      chosenKey: string;          // after delta threshold
      chosenConf: number;
    }
    const decisions: PhraseDecision[] = [];
    for (const phrase of phrases) {
      const phraseNotes = score.notes.filter(
        n => n.measure >= phrase.measureStart && n.measure <= phrase.measureEnd,
      );
      const e = analyzeNotesKey(phraseNotes);
      const phraseKey = e?.key ?? overallKey.key;
      const phraseConf = e?.confidence ?? 0;
      const homeKey = sectionKeyByMeasure.get(phrase.measureStart) ?? overallKey.key;
      const homeFit = correlateKey(phraseNotes, homeKey);

      let chosenKey: string;
      let chosenConf: number;
      if (phraseKey !== homeKey && phraseConf - homeFit >= PHRASE_KEY_DELTA) {
        chosenKey = phraseKey;
        chosenConf = phraseConf;
      } else {
        chosenKey = homeKey;
        chosenConf = homeFit;
      }
      decisions.push({ phrase, phraseKey, phraseConf, homeKey, homeFit, chosenKey, chosenConf });
    }

    // Pass 1.5: smoothing — if a phrase's chosen key is non-home and
    // it's short (≤ 8 measures) AND both neighbors are in the home, revert
    // to home. This catches isolated phrase-key flips on brief chromatic
    // passages (e.g. bwv11.6 m9-12 where 4 measures were reading as E minor
    // inside a D-major piece). Conservative: only fires when the phrase is
    // genuinely isolated; doesn't touch sustained non-home regions.
    const SMOOTH_MAX_MEASURES = 8;
    for (let i = 1; i < decisions.length - 1; i++) {
      const cur = decisions[i];
      const prev = decisions[i - 1];
      const next = decisions[i + 1];
      const curSpan = cur.phrase.measureEnd - cur.phrase.measureStart + 1;
      if (curSpan > SMOOTH_MAX_MEASURES) continue;
      // Both neighbors agree on the home key (or the same non-home key
      // that is NOT the current phrase's chosen key).
      if (cur.chosenKey === cur.homeKey) continue;     // already home
      if (prev.chosenKey !== next.chosenKey) continue; // neighbors disagree
      if (prev.chosenKey === cur.chosenKey) continue;  // already matching neighbors
      // Revert.
      cur.chosenKey = prev.chosenKey;
      cur.chosenConf = correlateKey(
        score.notes.filter(n => n.measure >= cur.phrase.measureStart && n.measure <= cur.phrase.measureEnd),
        prev.chosenKey,
      );
    }

    // Pass 2: assign per-measure local keys from the (possibly-smoothed)
    // decisions. Also handle phrases that straddle a section boundary —
    // measures inside a section get the section's key, even if the phrase
    // as a whole was decided in the home key.
    // A phrase longer than this is not a perceptual phrase — it means the
    // fermata segmentation found nothing (orchestral movements). Inside such
    // a span the single phrase-vs-home decision is meaningless: the span IS
    // mostly home, so the delta gate always keeps home and every 10–20 bar
    // tonicized region inside it inherits the global key (the bench's
    // dominant "other" error class). Hand those spans to the region tier —
    // a Viterbi-smoothed per-measure trajectory whose switch penalty
    // provides the hysteresis the phrase gate provided here. Chorale-scale
    // phrases (2–10 measures between fermatas) keep the phrase decision
    // unchanged, which is what the theory-bench chorale guarantees pin.
    const LONG_PHRASE_MEASURES = 16;

    const phraseKeys: Array<{ phraseIndex: number; key: string; confidence: number }> = [];
    for (const d of decisions) {
      const span = d.phrase.measureEnd - d.phrase.measureStart + 1;
      if (span > LONG_PHRASE_MEASURES) {
        const regions = analyzeKeyRegionTrajectory(score, {
          measureStart: d.phrase.measureStart,
          measureEnd: d.phrase.measureEnd,
        });
        for (const r of regions) {
          localKeyByMeasure.set(r.measure, r.key);
          localKeys.push({ measure: r.measure, key: r.key, confidence: r.confidence });
        }
        phraseKeys.push({ phraseIndex: d.phrase.index, key: d.homeKey, confidence: d.homeFit });
        continue;
      }
      phraseKeys.push({ phraseIndex: d.phrase.index, key: d.chosenKey, confidence: d.chosenConf });
      for (let m = d.phrase.measureStart; m <= d.phrase.measureEnd; m++) {
        const sectionKey = sectionKeyByMeasure.get(m);
        // If the phrase chose a non-home key (a real tonicization), use it
        // throughout. Otherwise, defer to the per-measure section key.
        const k = d.chosenKey !== d.homeKey
          ? d.chosenKey
          : (sectionKey ?? overallKey.key);
        localKeyByMeasure.set(m, k);
        localKeys.push({ measure: m, key: k, confidence: d.chosenConf });
      }
    }
  } else if (useLocalKeys === 'window') {
    const trajectory = analyzeKeyTrajectory(score, localKeyHalfWindow);
    localKeys = trajectory.map(t => ({
      measure: t.measure,
      key: t.key,
      confidence: t.confidence,
    }));
    for (const t of trajectory) localKeyByMeasure.set(t.measure, t.key);
  } else {
    // 'overall' — every measure gets the whole-piece key.
    const lastM = score.measureCount;
    for (let m = 1; m <= lastM; m++) {
      localKeyByMeasure.set(m, overallKey.key);
      localKeys.push({ measure: m, key: overallKey.key, confidence: overallKeyEst?.confidence ?? 0 });
    }
  }

  // 5. Per-chord RN analysis — pedal-aware.
  //
  // Pedal runs are detected first, over the raw chord stream: a bass pc
  // sustained across slices while the harmony above diverges from it (see
  // pedalPoint.ts for the divergence rule and its negative cases). On a
  // slice inside a confirmed run, the reading comes from the upper
  // structure when the pedal is foreign to the full-set match (G⁷ over a
  // tonic pedal reads V⁷, not '?'); the full-set reading survives when the
  // pedal is one of its chord tones (I over 1̂ is just I). Non-pedal
  // slices are untouched — identical output to the pre-pedal analyzer.
  const pedalByIdx = pedalPcByChordIndex(detectPedalRuns(chordStream.chords));
  const chordAnalyses: ChordAnalysis[] = chordStream.chords.map((chord, i) => {
    const localKey = localKeyByMeasure.get(chord.measure) ?? overallKey.key;
    const next = i + 1 < chordStream.chords.length ? chordStream.chords[i + 1] : null;
    const opts = {
      key: localKey,
      nextChordPcs: next ? next.pcs : undefined,
      nextChord: next ?? undefined,
    };
    const full = analyzeChord(chord, opts);
    const pedalPc = pedalByIdx.get(i);
    if (pedalPc === undefined) return full;
    return applyPedalReading(chord, full, pedalPc, opts);
  });

  // 6. Cadences — use the local key of the phrase end for each cadence.
  const cadences = phrases.map((phrase: PhraseRange) => {
    const finalKey = localKeyByMeasure.get(phrase.measureEnd) ?? overallKey.key;
    const subset = chordAnalyses.filter(c =>
      c.measure >= phrase.measureStart && c.measure <= phrase.measureEnd,
    );
    const cads = classifyCadences([phrase], subset, score, finalKey);
    return cads[0];
  });

  // 7. Pivot chord annotation — only meaningful when sections exist.
  if (keySections.length > 0) {
    const chordInputs = chordAnalyses.map(c => ({
      measure: c.measure,
      rn: c.primary,
      pcs: [...(c.pcSet ?? [])],
    }));
    annotatePivotChords(keySections, chordInputs, overallKey.key);
  }

  return {
    score,
    chordStream,
    overallKey,
    overallKeyConfidence: overallKeyEst?.confidence ?? 0,
    keySections,
    localKeys,
    textures,
    phrases,
    chordAnalyses,
    cadences,
  };
}

// ─── inferSubmissionHints ────────────────────────────────────────────────────
// Heuristic: from a ScoreAnalysis, infer the most likely critique style
// period and a default focus-area set. Used by the /critique upload page to
// pre-fill the submission form so the student does not have to guess.

export interface SubmissionHints {
  /** Best-guess style period from the StylePeriod enum in maestroCritiqueRubric. */
  stylePeriod: 'modal' | 'baroque' | 'classical' | 'romantic' | 'impressionist'
              | 'post_tonal' | 'film_contemporary' | 'jazz' | 'minimalist';
  /** Suggested focus areas to pre-check. */
  focusAreas: Array<
    'voice_leading' | 'counterpoint' | 'harmonic_progression' | 'chromaticism'
    | 'modulation' | 'melody_contour' | 'rhythm_meter' | 'texture'
    | 'form_structure' | 'orchestration' | 'fugal_techniques' | 'dynamics_expression'
  >;
  /** Plain-text explanation of why this period was chosen. */
  rationale: string;
}

export function inferSubmissionHints(analysis: ScoreAnalysis): SubmissionHints {
  // Compute chromatic-tone fraction in the overall key.
  const scalePcs = getScalePcs(analysis.overallKey.key);
  const realNotes = analysis.score.notes.filter(n => !n.isRest);
  const total = realNotes.length;
  const chromatic = realNotes.filter(n => !isDiatonic(n.pitch, scalePcs)).length;
  const chromaticFrac = total > 0 ? chromatic / total : 0;

  // Distinct RN labels detected.
  const distinctRns = new Set(
    analysis.chordAnalyses.filter(c => c.primary !== '?').map(c => c.primary),
  );
  const rnList = Array.from(distinctRns);
  const hasAugSix = rnList.some(rn => /\+6$/.test(rn));
  const hasNeapolitan = rnList.some(rn => /^♭II|^bII/.test(rn));
  const hasSecondary = rnList.some(rn => /\//.test(rn));
  const hasCtDim = rnList.some(rn => /^CT/.test(rn));
  const hasTristan = rnList.some(rn => /Tr/.test(rn) || /♭5|b5/.test(rn));

  const voiceCount = analysis.score.parts.length;
  const realCadences = analysis.cadences.filter(c => c.type !== 'unclear');
  const cadenceTypes = new Set(realCadences.map(c => c.type));

  let stylePeriod: SubmissionHints['stylePeriod'] = 'classical';
  let rationale = 'Default classical inference.';
  if (hasTristan || chromaticFrac > 0.3) {
    stylePeriod = 'romantic';
    rationale = `Highly chromatic (${Math.round(chromaticFrac * 100)}% non-diatonic notes); romantic harmonic vocabulary detected.`;
  } else if (hasAugSix || hasNeapolitan || hasCtDim) {
    stylePeriod = 'romantic';
    rationale = 'Augmented-sixth, Neapolitan, or common-tone diminished chords detected — late-classical / romantic vocabulary.';
  } else if (chromaticFrac > 0.15 || hasSecondary) {
    stylePeriod = 'classical';
    rationale = `Moderate chromaticism (${Math.round(chromaticFrac * 100)}%) with secondary dominants — classical idiom.`;
  } else if (chromaticFrac > 0.05) {
    stylePeriod = 'baroque';
    rationale = `Light chromaticism (${Math.round(chromaticFrac * 100)}%); diatonic harmonic vocabulary suggests baroque idiom.`;
  } else if (chromaticFrac < 0.02) {
    stylePeriod = 'modal';
    rationale = 'Almost entirely diatonic — modal or early-music idiom.';
  }

  const focusAreas: SubmissionHints['focusAreas'] = [];
  const seen = new Set<string>();
  const add = (fa: SubmissionHints['focusAreas'][number]) => {
    if (!seen.has(fa)) { seen.add(fa); focusAreas.push(fa); }
  };
  if (voiceCount >= 2) add('voice_leading');
  if (voiceCount >= 2 && cadenceTypes.size > 0) add('harmonic_progression');
  if (voiceCount >= 3) add('counterpoint');
  if (chromaticFrac > 0.1) add('chromaticism');
  if (hasSecondary || analysis.localKeys.some((k, i) =>
    i > 0 && k.key !== analysis.localKeys[i - 1].key,
  )) add('modulation');

  return { stylePeriod, focusAreas, rationale };
}
