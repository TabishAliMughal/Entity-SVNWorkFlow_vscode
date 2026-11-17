export interface UpToDateCheck {
  leftIsLocal: boolean;
  rightIsHead: boolean;
  /** Text shown on the left, the editor document text, and the incoming (HEAD) text. */
  leftText: string;
  docText: string;
  rightText: string;
  /** The file is currently listed as incoming in the pane. */
  listedIncoming: boolean;
}

/** `svn update` the file only when the local content equals the incoming content exactly (no extra local edits, no ignore options involved). */
export function shouldAutoUpdate(c: UpToDateCheck): boolean {
  return c.leftIsLocal && c.rightIsHead && c.listedIncoming && c.leftText === c.rightText && c.docText === c.rightText;
}
