export const PROP_NAME = /^[A-Za-z_:][A-Za-z0-9_:.-]*$/;

export function validatePropName(name: string): string | undefined {
  if (!name) return 'A property name is required';
  if (!PROP_NAME.test(name)) return 'Property names may contain letters, digits, ":", "_", "-", "." and must not start with a digit or "-"';
  if (name.length > 200) return 'The name is too long';
  return undefined;
}

export const EOL_STYLES = ['native', 'LF', 'CRLF', 'CR'] as const;
export const KEYWORDS = ['Id', 'Date', 'Revision', 'Author', 'HeadURL', 'URL', 'Header', 'LastChangedDate', 'LastChangedRevision', 'LastChangedBy', 'Rev'] as const;

const FILE_ONLY = new Set(['svn:executable', 'svn:needs-lock', 'svn:mime-type', 'svn:keywords', 'svn:eol-style']);
const DIR_ONLY = new Set(['svn:ignore', 'svn:global-ignores', 'svn:externals', 'svn:auto-props']);

export function propAppliesTo(name: string, isDir: boolean): boolean {
  return isDir ? !FILE_ONLY.has(name) : !DIR_ONLY.has(name);
}

export function parseKeywords(v: string): string[] {
  return v.split(/[\s,]+/).filter(Boolean);
}

export function formatKeywords(list: readonly string[]): string {
  return list.join(' ');
}

/** Flags (`svn:executable`, `svn:needs-lock`) use `*` by convention. */
export const FLAG_VALUE = '*';

export interface PropChange {
  name: string;
  /** undefined = delete. */
  value?: string;
  recursive?: boolean;
}

/** Normalises an svn:ignore style list: LF, no empty lines, trailing newline. */
export function normalizeLines(v: string): string {
  const lines = v.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines.join('\n') + '\n' : '';
}

export function validateChange(c: PropChange, isDir: boolean): string | undefined {
  const e = validatePropName(c.name);
  if (e) return e;
  if (c.value !== undefined && c.value.includes('\0')) return 'Binary property values are not supported';
  if (c.value !== undefined && !propAppliesTo(c.name, isDir)) return `${c.name} cannot be set on a ${isDir ? 'folder' : 'file'}`;
  if (c.name === 'svn:eol-style' && c.value !== undefined && !(EOL_STYLES as readonly string[]).includes(c.value.trim())) return 'svn:eol-style must be native, LF, CRLF or CR';
  return undefined;
}
