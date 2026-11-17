/** Counts running user operations (update, commit, ...) so the status bar can show a spinner. */
export class ActivityTracker {
  private count = 0;
  private label = '';
  private readonly listeners = new Set<() => void>();

  get busy(): boolean {
    return this.count > 0;
  }

  get current(): string {
    return this.label;
  }

  onDidChange(cb: () => void): { dispose(): void } {
    this.listeners.add(cb);
    return { dispose: () => this.listeners.delete(cb) };
  }

  async track<T>(label: string, fn: () => Promise<T>): Promise<T> {
    this.count++;
    this.label = label;
    this.emit();
    try {
      return await fn();
    } finally {
      this.count--;
      if (!this.count) this.label = '';
      this.emit();
    }
  }

  private emit(): void {
    for (const l of [...this.listeners]) l();
  }
}

export const activity = new ActivityTracker();
