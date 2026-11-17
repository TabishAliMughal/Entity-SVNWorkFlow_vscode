export type ContentEncoding = 'utf-8' | 'utf-8-bom' | 'utf-16le' | 'utf-16be' | 'windows-1252';

export interface DecodedContent {
  text: string;
  encoding: ContentEncoding;
  binary: boolean;
}

const SNIFF_BYTES = 8000;

/** Mime types that mean "text" even though they are not text/*. */
const TEXTUAL_MIME = /^(text\/|application\/(json|xml|javascript|x-javascript|x-sh|x-httpd-php|xhtml\+xml|sql)|image\/svg\+xml)/i;

/** svn:mime-type that does not start with text/ marks the file binary (svn's own rule), apart from known textual types. */
export function isBinaryMime(mime: string | undefined): boolean {
  const m = mime?.trim();
  return !!m && !TEXTUAL_MIME.test(m);
}

function hasUtf16Bom(buf: Uint8Array): 'utf-16le' | 'utf-16be' | undefined {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return 'utf-16le';
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return 'utf-16be';
  return undefined;
}

/** NUL byte in the first 8000 bytes (the same heuristic git and svn use); UTF-16 with BOM is text. */
export function hasNulBytes(buf: Uint8Array): boolean {
  if (hasUtf16Bom(buf)) return false;
  const n = Math.min(buf.length, SNIFF_BYTES);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function decodeUtf16(buf: Uint8Array, le: boolean): string {
  const body = buf.subarray(2);
  const len = body.length - (body.length % 2);
  const units = new Array<string>();
  const CH = 8192;
  for (let i = 0; i < len; i += CH * 2) {
    const codes: number[] = [];
    for (let j = i; j < Math.min(len, i + CH * 2); j += 2) codes.push(le ? body[j] | (body[j + 1] << 8) : (body[j] << 8) | body[j + 1]);
    units.push(String.fromCharCode(...codes));
  }
  return units.join('');
}

function decodeWindows1252(buf: Uint8Array): string {
  try {
    return new TextDecoder('windows-1252').decode(buf);
  } catch {
    return Buffer.from(buf).toString('latin1');
  }
}

/** Decode file bytes: BOMs are stripped, invalid UTF-8 falls back to windows-1252. `mime` is the optional svn:mime-type. */
export function decodeContent(buf: Uint8Array, mime?: string): DecodedContent {
  if (isBinaryMime(mime) || hasNulBytes(buf)) return { text: '', encoding: 'utf-8', binary: true };
  const u16 = hasUtf16Bom(buf);
  if (u16) return { text: decodeUtf16(buf, u16 === 'utf-16le'), encoding: u16, binary: false };
  let bom = false;
  let body = buf;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    bom = true;
    body = buf.subarray(3);
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(body), encoding: bom ? 'utf-8-bom' : 'utf-8', binary: false };
  } catch {
    return { text: decodeWindows1252(buf), encoding: 'windows-1252', binary: false };
  }
}
