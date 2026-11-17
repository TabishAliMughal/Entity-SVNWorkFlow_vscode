import { describe, expect, it } from 'vitest';
import { quoteForLog, redactArgs, redactText, redactUrlCredentials } from '../../src/util/redact';

describe('redact', () => {
  it('masks --password value and --password=value', () => {
    expect(redactArgs(['up', '--password', 'p w', '--username', 'u'])).toEqual(['up', '--password', '********', '--username', 'u']);
    expect(redactArgs(['--password=abc'])).toEqual(['--password=********']);
    expect(redactArgs(['--password'])).toEqual(['--password']);
  });
  it('masks user:pass@ in URLs but not plain URLs', () => {
    expect(redactUrlCredentials('svn://u:secret@host/r')).toBe('svn://u:********@host/r');
    expect(redactUrlCredentials('https://host:8443/r')).toBe('https://host:8443/r');
    expect(redactArgs(['info', 'http://a:b@h/x'])[1]).toBe('http://a:********@h/x');
  });
  it('masks every occurrence of secrets', () => {
    expect(redactText('bad hunter2 and hunter2 again', ['hunter2', ''])).toBe('bad ******** and ******** again');
  });
  it('quoteForLog quotes whitespace and redacts', () => {
    expect(quoteForLog(['a b', '--password', 'x'])).toBe('"a b" --password ********');
  });
});
