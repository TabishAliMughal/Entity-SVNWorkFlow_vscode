export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  debug(msg: string): void;
}

export const nullLogger: Logger = { info() {}, warn() {}, error() {}, debug() {} };

/** Adapts anything with appendLine (e.g. vscode.OutputChannel) to Logger. */
export class LineLogger implements Logger {
  constructor(private readonly sink: { appendLine(line: string): void }) {}
  private write(level: string, msg: string): void {
    this.sink.appendLine(`[${new Date().toISOString()}] ${level} ${msg}`);
  }
  info(msg: string): void { this.write('INFO ', msg); }
  warn(msg: string): void { this.write('WARN ', msg); }
  error(msg: string): void { this.write('ERROR', msg); }
  debug(msg: string): void { this.write('DEBUG', msg); }
}
