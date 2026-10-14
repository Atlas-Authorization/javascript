import { describe, expect, it } from 'vitest';

import { LOCALES, LOCALIZATION_KEYS, missingKeys, resolveLocale } from './coverage';
import { deDE } from './de-DE';
import { enUS } from './en-US';
import { esES } from './es-ES';
import { frFR } from './fr-FR';
import { jaJP } from './ja-JP';
import { nlNL } from './nl-NL';
import { ptBR } from './pt-BR';
import * as pkg from './index';

/** The sorted set of `{placeholder}` names a string interpolates. */
function placeholders(text: string): string[] {
  return [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!))].sort();
}

describe('LOCALIZATION_KEYS', () => {
  it('is every en-US key except the locale tag', () => {
    expect(LOCALIZATION_KEYS.length).toBe(Object.keys(enUS).length - 1);
    expect(LOCALIZATION_KEYS).not.toContain('locale');
    expect(new Set(LOCALIZATION_KEYS)).toEqual(
      new Set(Object.keys(enUS).filter((key) => key !== 'locale')),
    );
  });

  it('is frozen', () => {
    expect(Object.isFrozen(LOCALIZATION_KEYS)).toBe(true);
  });
});

describe('missingKeys', () => {
  it('reports nothing for en-US itself', () => {
    expect(missingKeys(enUS)).toEqual([]);
  });

  it.each([
    ['es-ES', esES],
    ['fr-FR', frFR],
    ['de-DE', deDE],
    ['pt-BR', ptBR],
  ] as const)('%s is complete', (_tag, bundle) => {
    expect(missingKeys(bundle)).toEqual([]);
  });

  it('reports every UI key for an empty catalog, never the locale tag', () => {
    expect(missingKeys({})).toEqual([...LOCALIZATION_KEYS]);
    expect(missingKeys({ locale: 'xx' })).not.toContain('locale');
  });

  it('treats absent, empty, whitespace-only and non-string values as missing', () => {
    const catalog: Record<string, unknown> = { ...enUS };
    delete catalog['signIn.title'];
    catalog['signIn.submit'] = '';
    catalog['signUp.title'] = '   ';
    catalog['mfa.submit'] = 42;
    expect(missingKeys(catalog)).toEqual([
      'signIn.title',
      'signIn.submit',
      'signUp.title',
      'mfa.submit',
    ]);
  });

  it('ignores inherited properties', () => {
    const proto = { 'signIn.title': 'Sign in' };
    const catalog = Object.create(proto) as Record<string, unknown>;
    expect(missingKeys(catalog)).toContain('signIn.title');
  });

  it('accepts a custom reference', () => {
    expect(missingKeys({ a: 'x' }, { locale: 'zz', a: 'A', b: 'B' })).toEqual(['b']);
  });
});

describe('placeholders', () => {
  const bundles = Object.entries(LOCALES).filter(([tag]) => tag !== 'en-US');

  it.each(bundles)('%s interpolates exactly the en-US {placeholders} for every key it translates', (tag, bundle) => {
    const translated = bundle as Record<string, unknown>;
    for (const key of LOCALIZATION_KEYS) {
      const value = translated[key];
      if (typeof value !== 'string') continue;
      expect(placeholders(value), `${tag} ${key}`).toEqual(placeholders(enUS[key]));
    }
  });
});

describe('LOCALES', () => {
  it('keys every shipped bundle by its own locale tag', () => {
    for (const [tag, bundle] of Object.entries(LOCALES)) {
      expect(bundle.locale).toBe(tag);
    }
    expect(Object.keys(LOCALES).sort()).toEqual(
      ['de-DE', 'en-US', 'es-ES', 'fr-FR', 'ja-JP', 'nl-NL', 'pt-BR'],
    );
  });
});

describe('resolveLocale', () => {
  it.each([
    ['en', enUS],
    ['en-US', enUS],
    ['en-GB', enUS],
    ['es', esES],
    ['es-ES', esES],
    ['es-MX', esES],
    ['es-419', esES],
    ['fr', frFR],
    ['fr-FR', frFR],
    ['fr-CA', frFR],
    ['de', deDE],
    ['de-DE', deDE],
    ['de-AT', deDE],
    ['de-CH', deDE],
    ['pt', ptBR],
    ['pt-BR', ptBR],
    ['pt-PT', ptBR],
    ['ja', jaJP],
    ['ja-JP', jaJP],
    ['nl', nlNL],
    ['nl-NL', nlNL],
    ['nl-BE', nlNL],
  ] as const)('%s', (tag, bundle) => {
    expect(resolveLocale(tag)).toBe(bundle);
  });

  it('is case-insensitive and accepts underscores', () => {
    expect(resolveLocale('pt_BR')).toBe(ptBR);
    expect(resolveLocale('PT-br')).toBe(ptBR);
    expect(resolveLocale('EN_gb')).toBe(enUS);
    expect(resolveLocale(' fr-ca ')).toBe(frFR);
  });

  it('falls back to the language subtag for an unlisted region or script', () => {
    expect(resolveLocale('es-AR')).toBe(esES);
    expect(resolveLocale('en-AU')).toBe(enUS);
    expect(resolveLocale('de-LI')).toBe(deDE);
    expect(resolveLocale('ja-Jpan-JP')).toBe(jaJP);
  });

  it('returns undefined for an unknown language', () => {
    expect(resolveLocale('zz')).toBeUndefined();
    expect(resolveLocale('it-IT')).toBeUndefined();
    expect(resolveLocale('')).toBeUndefined();
    expect(resolveLocale('-')).toBeUndefined();
    expect(resolveLocale('constructor')).toBeUndefined();
    expect(resolveLocale('__proto__')).toBeUndefined();
  });
});

describe('package entry', () => {
  it('re-exports the coverage helpers', () => {
    expect(pkg.LOCALIZATION_KEYS).toBe(LOCALIZATION_KEYS);
    expect(pkg.missingKeys).toBe(missingKeys);
    expect(pkg.resolveLocale).toBe(resolveLocale);
    expect(pkg.LOCALES).toBe(LOCALES);
  });
});
