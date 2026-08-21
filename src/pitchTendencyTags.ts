// ─── lib/maestroAnalyst/pitchTendencyTags.ts ────────────────────────────────
// Given an analyst-tagged chord (chord-level tendency-tone tags + root pc +
// local tonic), identify which specific pitch class carries each tag and
// where it resolves to. Pulled out of the BWV 38.6 visualization into a
// reusable module so other consumers (score-study overlay, Maestro chat,
// critique narrative) can use the same per-pitch identification.
//
// Pure module. No external deps beyond standard pc-math.
//
// The chord-level tags come from lib/voiceLeadingTendencyTones.ts. They're
// applied to the chord; this helper identifies which pitch in the chord is
// the source of each tag.

export type SemanticTag =
  | 'leading-tone'
  | 'leading-tone-minor'
  | 'phrygian-pull'
  | 'chordal-seventh'
  | 'temporary-leading-tone'
  | 'temporary-chordal-seventh';

export interface PitchTendencyTag {
  /** Pitch class (0..11) the tag applies to. */
  pc: number;
  /** The tag itself (matches voiceLeadingTendencyTones.ts vocabulary). */
  tag: SemanticTag;
  /** Pitch class the tone resolves to, or null if context-dependent. */
  resolvesTo: number | null;
  /** Short human label for tooltips / overlays: "7̂ → 1̂" etc. */
  label: string;
}

/**
 * Identify per-pitch tendency tags from a chord's tag set.
 *
 * @param pcs        Pitch classes sounding in the chord
 * @param rootPc     Chord-root pc (from analyst's rootPc)
 * @param tonicPc    Local tonic pc
 * @param chordTags  Tendency-tone tags from `ChordAnalysis.tendencyTones`
 * @param mode       'major' | 'minor' — affects chordal-seventh step size
 *                   (V⁷ → I: half-step in major, V⁷ → i: whole-step in minor)
 */
export function identifyPitchTendencyTags(
  pcs: number[],
  rootPc: number,
  tonicPc: number,
  chordTags: string[],
  mode: 'major' | 'minor',
): PitchTendencyTag[] {
  const out: PitchTendencyTag[] = [];
  const seen = new Set<string>(); // dedupe per (pc, tag)

  const push = (tag: PitchTendencyTag) => {
    const key = `${tag.pc}-${tag.tag}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(tag);
  };

  for (const tag of chordTags) {
    if (tag === 'leading-tone' || tag === 'leading-tone-minor') {
      // 7̂: 1 semitone below tonic
      const ltPc = (tonicPc + 11) % 12;
      if (pcs.includes(ltPc)) {
        push({
          pc: ltPc,
          tag: tag as SemanticTag,
          resolvesTo: tonicPc,
          label: '7̂ → 1̂',
        });
      }
    } else if (tag === 'phrygian-pull') {
      // ♭6̂ → 5̂ (the natural F → E in A minor): tonic + 8 semitones
      const flat6 = (tonicPc + 8) % 12;
      if (pcs.includes(flat6)) {
        push({
          pc: flat6,
          tag: 'phrygian-pull',
          resolvesTo: (tonicPc + 7) % 12,
          label: '♭6̂ → 5̂',
        });
      }
      // ♭2̂ → 1̂ (the soprano motion of a Phrygian cadence): tonic + 1
      const flat2 = (tonicPc + 1) % 12;
      if (pcs.includes(flat2)) {
        push({
          pc: flat2,
          tag: 'phrygian-pull',
          resolvesTo: tonicPc,
          label: '♭2̂ → 1̂',
        });
      }
    } else if (tag === 'chordal-seventh') {
      // m7 above the chord root; resolves down by step. Step size depends
      // on the resolution chord's mode: half in major (4̂→3̂), whole in
      // minor (4̂→♭3̂).
      const seventh = (rootPc + 10) % 12;
      if (pcs.includes(seventh)) {
        const stepDown = mode === 'minor' ? 10 : 11;
        push({
          pc: seventh,
          tag: 'chordal-seventh',
          resolvesTo: (seventh + stepDown) % 12,
          label: mode === 'minor' ? '7 of V → ♭3̂' : '7 of V → 3̂',
        });
      }
    } else if (tag === 'temporary-leading-tone') {
      // The chromatic pitch in the texture — find the pc that's not in
      // the local diatonic collection (major/minor scale). Best-effort
      // until the analyzer carries the explicit tonicized-degree.
      const scale =
        mode === 'minor'
          ? new Set([0, 2, 3, 5, 7, 8, 10].map(d => (tonicPc + d) % 12))
          : new Set([0, 2, 4, 5, 7, 9, 11].map(d => (tonicPc + d) % 12));
      // Pick the chromatic pc with the largest LCM distance (most "outside")
      const chromatic = pcs.filter(p => !scale.has(p));
      if (chromatic.length > 0) {
        // For each chromatic pitch, it likely resolves up by step. We don't
        // know which degree is being tonicized without RN parsing.
        chromatic.forEach(pc => {
          push({
            pc,
            tag: 'temporary-leading-tone',
            resolvesTo: (pc + 1) % 12,
            label: 'secondary 7̂',
          });
        });
      }
    } else if (tag === 'temporary-chordal-seventh') {
      const seventh = (rootPc + 10) % 12;
      if (pcs.includes(seventh)) {
        push({
          pc: seventh,
          tag: 'temporary-chordal-seventh',
          resolvesTo: (seventh + 11) % 12,
          label: 'secondary 7',
        });
      }
    }
  }

  return out;
}
