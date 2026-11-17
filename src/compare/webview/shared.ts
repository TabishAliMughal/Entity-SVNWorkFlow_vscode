import hljs from 'highlight.js/lib/core';
import php from 'highlight.js/lib/languages/php';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import css from 'highlight.js/lib/languages/css';
import scss from 'highlight.js/lib/languages/scss';
import less from 'highlight.js/lib/languages/less';
import xml from 'highlight.js/lib/languages/xml';
import sql from 'highlight.js/lib/languages/sql';
import json from 'highlight.js/lib/languages/json';
import yaml from 'highlight.js/lib/languages/yaml';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import java from 'highlight.js/lib/languages/java';
import csharp from 'highlight.js/lib/languages/csharp';
import bash from 'highlight.js/lib/languages/bash';
import ini from 'highlight.js/lib/languages/ini';
import properties from 'highlight.js/lib/languages/properties';
import cpp from 'highlight.js/lib/languages/cpp';
import go from 'highlight.js/lib/languages/go';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import powershell from 'highlight.js/lib/languages/powershell';
import diff from 'highlight.js/lib/languages/diff';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import { escapeHtml, splitHighlighted } from '../lineHtml';

const LANGS = { php, javascript, typescript, css, scss, less, xml, sql, json, yaml, markdown, python, java, csharp, bash, ini, properties, cpp, go, ruby, rust, powershell, diff, dockerfile };
for (const [name, def] of Object.entries(LANGS)) hljs.registerLanguage(name, def);

export const MAX_HIGHLIGHT_CHARS = 600_000;

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}


/** Highlighted HTML per line (plain escaped text when the language is unknown or the text is huge). */
export function highlight(lines: string[], lang: string | undefined): string[] {
  const text = lines.join('\n');
  if (lang && text.length <= MAX_HIGHLIGHT_CHARS && hljs.getLanguage(lang)) {
    try {
      return splitHighlighted(hljs.highlight(text, { language: lang, ignoreIllegals: true }).value);
    } catch {
      /* fall through to plain */
    }
  }
  return lines.map(escapeHtml);
}

