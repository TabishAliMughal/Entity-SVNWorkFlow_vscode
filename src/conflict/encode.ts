import type { ContentEncoding } from '../compare/content';

/** Inverse of `decodeContent`. Characters windows-1252 cannot hold make the whole text fall back to UTF-8. */
export function encodeText(text: string, encoding: ContentEncoding): { bytes: Buffer; encoding: ContentEncoding } {
  switch (encoding) {
    case 'utf-8-bom':
      return { bytes: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]), encoding };
    case 'utf-16le':
      return { bytes: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]), encoding };
    case 'utf-16be': {
      const le = Buffer.from(text, 'utf16le');
      le.swap16();
      return { bytes: Buffer.concat([Buffer.from([0xfe, 0xff]), le]), encoding };
    }
    case 'windows-1252':
      if (!/[\u0100-\uffff]/.test(text)) return { bytes: Buffer.from(text, 'latin1'), encoding };
      return { bytes: Buffer.from(text, 'utf8'), encoding: 'utf-8' };
    default:
      return { bytes: Buffer.from(text, 'utf8'), encoding: 'utf-8' };
  }
}
