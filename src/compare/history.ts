import { comparePos, endPosition, type Pos } from './editing';

export interface HistoryEntry {
  start: Pos;
  removed: string;
  inserted: string;
  time: number;
}

/** What to apply to the document for an undo/redo step, and where the caret goes afterwards. */
export interface Step {
  start: Pos;
  end: Pos;
  text: string;
  caret: Pos;
}

/** Undo/redo stack for edits made through the compare view (the view's own, since it is not a VS Code editor). */
export class EditHistory {
  private undos: HistoryEntry[] = [];
  private redos: HistoryEntry[] = [];

  constructor(private readonly max = 500, private readonly mergeMs = 1000) {}

  record(e: HistoryEntry): void {
    this.redos = [];
    const last = this.undos[this.undos.length - 1];
    if (last && this.canMerge(last, e)) {
      last.inserted += e.inserted;
      last.time = e.time;
      return;
    }
    this.undos.push({ ...e });
    if (this.undos.length > this.max) this.undos.shift();
  }

  private canMerge(a: HistoryEntry, b: HistoryEntry): boolean {
    return (
      a.removed === '' && b.removed === '' && b.inserted !== '' &&
      !a.inserted.includes('\n') && !b.inserted.includes('\n') &&
      b.time - a.time <= this.mergeMs &&
      comparePos(b.start, endPosition(a.start, a.inserted)) === 0
    );
  }

  undo(): Step | undefined {
    const e = this.undos.pop();
    if (!e) return undefined;
    this.redos.push(e);
    return { start: e.start, end: endPosition(e.start, e.inserted), text: e.removed, caret: endPosition(e.start, e.removed) };
  }

  redo(): Step | undefined {
    const e = this.redos.pop();
    if (!e) return undefined;
    this.undos.push(e);
    return { start: e.start, end: endPosition(e.start, e.removed), text: e.inserted, caret: endPosition(e.start, e.inserted) };
  }

  clear(): void {
    this.undos = [];
    this.redos = [];
  }
}
