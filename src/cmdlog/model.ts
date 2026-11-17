import type { CommandRecord } from '../svn/runner';
import { quoteForLog, redactText } from '../util/redact';

export type Verbosity = 'off' | 'commands' | 'commandsAndOutput';

export function parseVerbosity(v: unknown): Verbosity {
  return v === 'off' || v === 'commandsAndOutput' ? v : 'commands';
}

export interface LogRecord extends CommandRecord {
  repoName?: string;
}

/** The command exactly as it can be pasted into a terminal; credentials are masked. */
export function commandLine(rec: Pick<LogRecord, 'args'>): string {
  return `svn ${quoteForLog(rec.args)}`;
}

export function formatRecord(rec: LogRecord, verbosity: Verbosity): string {
  const ts = new Date(rec.time).toISOString();
  const head = `[${ts}] ${rec.repoName ? `repo=${rec.repoName} ` : ''}${rec.cwd ? `cwd=${rec.cwd}` : 'cwd=(none)'}`;
  const status = `exit ${rec.exitCode}${rec.error ? ` (${rec.error})` : ''} in ${rec.durationMs} ms`;
  const lines = [`${head}`, `  > ${commandLine(rec)}`, `  < ${status}`];
  if (verbosity === 'commandsAndOutput') {
    const err = rec.stderr.trim();
    const out = rec.stdout.trim();
    if (err) lines.push(...indent('stderr', err));
    if (out) lines.push(...indent('stdout', out));
  }
  return redactText(lines.join('\n'));
}

function indent(label: string, text: string): string[] {
  return [`  ${label}:`, ...text.split(/\r?\n/).map((l) => `    ${l}`)];
}

/** Bounded in-memory history for the "Copy command" picker. */
export class CommandHistory {
  private items: LogRecord[] = [];
  constructor(private readonly max = 500) {}

  add(rec: LogRecord): void {
    this.items.push(rec);
    if (this.items.length > this.max) this.items.splice(0, this.items.length - this.max);
  }

  /** Newest first. */
  list(): LogRecord[] {
    return [...this.items].reverse();
  }

  clear(): void {
    this.items = [];
  }
}
