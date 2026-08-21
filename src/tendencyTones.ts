/**
 * Tendency-tone vocabulary.
 *
 * A tendency tone is a pitch whose position in the prevailing key or chord
 * gives it a directed pull toward a specific resolution — the leading tone
 * upward to the tonic, a chordal seventh downward by step. The analyzer tags
 * chords with the pulls it finds, which is what makes its output describe
 * musical motion rather than only naming chords.
 *
 * Extracted verbatim from the Gradus curriculum's shared vocabulary so the
 * package carries no dependency on the application it came from. The names are
 * the ones the curriculum uses in prose, deliberately: a label a student reads
 * and a label the analyzer emits should be the same word.
 */
export type TendencyToneTag =
  | 'leading-tone'
  | 'leading-tone-minor'
  | 'chordal-seventh'
  | 'phrygian-pull'
  | 'suspension-4-3'
  | 'suspension-7-6'
  | 'suspension-9-8'
  | 'suspension-2-3'
  | 'suspension-5-4-3'
  | 'suspension-6-5'
  | 'suspension-9-4-8-3'
  | 'suspension-9-7-8-6'
  | 'suspension-7-6-5'
  | 'chromatic-neighbor'
  | 'temporary-leading-tone'
  | 'temporary-chordal-seventh'
  | 'cadential-6-4'
  | 'pedal-point'
  | 'modulating'
  | 'no-tendency-tones';
