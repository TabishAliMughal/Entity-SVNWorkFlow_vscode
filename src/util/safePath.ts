import * as path from 'node:path';
import { isSameOrUnder } from '../incoming/model';

/** A '/'-separated path relative to some root: no absolute form, drive/stream colon, backslash or `.`/`..` segment. */
export function isSafeRel(rel: unknown, allowEmpty = false): rel is string {
  if (typeof rel !== 'string') return false;
  if (rel === '') return allowEmpty;
  if (rel.includes('\0') || rel.includes('\\') || rel.includes(':') || rel.startsWith('/')) return false;
  return rel.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

export function assertSafeRel(rel: unknown, what: string, allowEmpty = false): string {
  if (!isSafeRel(rel, allowEmpty)) throw new Error(`Unsafe ${what}: ${JSON.stringify(rel)}`);
  return rel;
}

/** Throws unless `abs` is `root` or lies beneath it (case-insensitive on Windows). */
export function assertUnder(abs: string, root: string, what = 'path'): string {
  if (!isSameOrUnder(path.resolve(abs), path.resolve(root))) throw new Error(`Refusing to touch a ${what} outside ${root}: ${abs}`);
  return abs;
}
