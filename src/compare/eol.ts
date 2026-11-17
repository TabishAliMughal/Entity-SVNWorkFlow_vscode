import type { Line } from '../diff';

export function dominantEolOf(lines: readonly Line[]): string {
  let lf = 0;
  let crlf = 0;
  let cr = 0;
  for (const l of lines) {
    if (l.eol === '\n') lf++;
    else if (l.eol === '\r\n') crlf++;
    else if (l.eol === '\r') cr++;
  }
  if (crlf > lf && crlf >= cr) return '\r\n';
  if (cr > lf && cr > crlf) return '\r';
  return '\n';
}
