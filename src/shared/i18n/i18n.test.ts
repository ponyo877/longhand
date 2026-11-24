import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { format, type Message } from './define';
import { messageKeys, rawMessage, resolveLocale, translator } from './index';

describe('resolveLocale', () => {
  it('uses the chosen language', () => {
    expect(resolveLocale('ja', ['en-US'])).toBe('ja');
    expect(resolveLocale('en', ['ja-JP'])).toBe('en');
  });

  it('follows the first of English and Japanese among the system languages', () => {
    expect(resolveLocale('system', ['ja-JP', 'en-US'])).toBe('ja');
    expect(resolveLocale('system', ['fr-FR', 'ja', 'en'])).toBe('ja');
    expect(resolveLocale('system', ['en-GB', 'ja-JP'])).toBe('en');
    expect(resolveLocale('system', ['de-DE'])).toBe('en');
    expect(resolveLocale('system', [])).toBe('en');
  });
});

describe('format', () => {
  it('fills placeholders and leaves unknown ones visible', () => {
    expect(format('Hold {key} to talk', { key: 'fn' })).toBe('Hold fn to talk');
    expect(format('{a} and {b}', { a: 1 })).toBe('1 and {b}');
    expect(format((v) => (v.count === 1 ? 'one word' : '{count} words'), { count: 3 })).toBe('3 words');
  });
});

const placeholders = (m: Message) => (typeof m === 'string' ? [...m.matchAll(/\{(\w+)\}/g)].map((x) => x[1]).sort() : null);

describe('catalog', () => {
  const keys = messageKeys();

  it('has text in both languages for every key', () => {
    for (const key of keys) {
      for (const locale of ['en', 'ja'] as const) {
        const m = rawMessage(locale, key);
        expect(typeof m === 'function' || m.trim().length > 0, `${locale} ${key}`).toBe(true);
      }
    }
  });

  it('uses the same placeholders in both languages', () => {
    for (const key of keys) {
      const en = placeholders(rawMessage('en', key));
      const ja = placeholders(rawMessage('ja', key));
      if (en && ja) expect(ja, key).toEqual(en);
    }
  });

  it('keeps English text free of Japanese', () => {
    const t = translator('en');
    for (const key of keys) {
      const m = rawMessage('en', key);
      if (typeof m === 'string') expect(t(key), key).not.toMatch(/[ぁ-んァ-ヶ一-龯]/);
    }
  });

  it('prefixes every key with the name of its area file', () => {
    const dir = path.join(__dirname, 'messages');
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      const area = file.replace(/\.ts$/, '');
      const text = fs.readFileSync(path.join(dir, file), 'utf8');
      for (const [, key] of text.matchAll(/^\s+'([\w.-]+)':/gm)) expect(key.startsWith(`${area}.`), `${file}: ${key}`).toBe(true);
    }
  });
});
