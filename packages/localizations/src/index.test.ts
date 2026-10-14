import { describe, expect, it } from 'vitest';

import { enUS } from './en-US';
import { deDE } from './de-DE';
import { esES } from './es-ES';
import { frFR } from './fr-FR';
import { jaJP } from './ja-JP';
import { nlNL } from './nl-NL';
import { ptBR } from './pt-BR';
import type { Localization, LocalizationResource } from './types';

/** The non-base bundles, each tagged with the locale its file declares. */
const BUNDLES: { file: string; bundle: Localization }[] = [
  { file: 'fr-FR', bundle: frFR },
  { file: 'es-ES', bundle: esES },
  { file: 'de-DE', bundle: deDE },
  { file: 'pt-BR', bundle: ptBR },
  { file: 'ja-JP', bundle: jaJP },
  { file: 'nl-NL', bundle: nlNL },
];

const baseKeys = new Set(Object.keys(enUS));

describe('en-US (reference bundle)', () => {
  it('declares its own locale', () => {
    expect(enUS.locale).toBe('en-US');
  });

  it('has no empty string values', () => {
    for (const [key, value] of Object.entries(enUS)) {
      expect(typeof value, `${key} is a string`).toBe('string');
      expect(value.trim(), `${key} is non-empty`).not.toBe('');
    }
  });
});

describe.each(BUNDLES)('$file', ({ file, bundle }) => {
  it("declares a locale matching the file's name", () => {
    expect(bundle.locale).toBe(file);
  });

  it('only uses keys that exist in en-US (strict subset, no stray/misspelled keys)', () => {
    const stray = Object.keys(bundle).filter((key) => !baseKeys.has(key));
    expect(stray, `stray keys in ${file}`).toEqual([]);
  });

  it('has no empty string values', () => {
    for (const [key, value] of Object.entries(bundle)) {
      expect(typeof value, `${file} ${key} is a string`).toBe('string');
      expect((value as string).trim(), `${file} ${key} is non-empty`).not.toBe('');
    }
  });

  it('preserves {application} / {provider} placeholders where it translates those keys', () => {
    if (typeof bundle['signIn.subtitle'] === 'string') {
      expect(bundle['signIn.subtitle']).toContain('{application}');
    }
    if (typeof bundle['signIn.socialButton'] === 'string') {
      expect(bundle['signIn.socialButton']).toContain('{provider}');
    }
  });
});

describe('type surface', () => {
  it('en-US satisfies the full LocalizationResource', () => {
    // Compile-time check made explicit at runtime: every base key is present.
    const resource: LocalizationResource = enUS;
    expect(Object.keys(resource).length).toBe(baseKeys.size);
  });

  it('es-ES, fr-FR, de-DE and pt-BR satisfy the full LocalizationResource', () => {
    const complete: LocalizationResource[] = [esES, frFR, deDE, ptBR];
    for (const resource of complete) {
      expect(new Set(Object.keys(resource)), resource.locale).toEqual(baseKeys);
    }
  });
});
