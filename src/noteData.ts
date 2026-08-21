/**
 * A flat note list — the simplest way in.
 *
 * Most callers arrive with either a MusicXML file or a plain array of notes
 * from their own editor. `NoteData` is the second: no nesting, no parts, just
 * pitch, duration and position. `noteEntriesToScore()` lifts it into the
 * `Score` the analyzer works on.
 */
export interface NoteData {
  /** Scientific pitch — "C4", "F#5", "Bb3". Use "R" for a rest. */
  pitch: string;
  /** Length in beats: whole 4, half 2, quarter 1, eighth 0.5. */
  duration: number;
  /** 1-based beat within the measure. */
  beat: number;
  /** 1-based measure number. */
  measure: number;
  /** 1-based voice; 1 is the top line. */
  voice: number;
  /** Optional dynamic marking at this note. */
  dynamic?: string;
}
