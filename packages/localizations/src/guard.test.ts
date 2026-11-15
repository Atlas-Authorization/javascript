import { describe, expect, it } from 'vitest';
import { LOCALES } from './coverage';
import { enUS } from './en-US';
import { checkBundle } from './guard';

describe('translation guard', () => {
  it('finds a missing key, an extra key, an empty string and a placeholder that changed', () => {
    const ref = { locale: 'en', a: 'Hello {name}', b: 'Plain text', c: 'Code {n} of {m}', z: 'Last' };
    const r = checkBundle({ locale: 'xx', a: 'Hola', b: '  ', c: 'Código {n}', d: 'Sobra' }, ref);
    expect(r.failures.map((f) => `${f.kind}:${f.key}`).sort()).toEqual(['empty:b', 'extra:d', 'missing:z', 'placeholder_mismatch:a', 'placeholder_mismatch:c'].sort());
  });

  it('warns about an untranslated string with words, not about codes', () => {
    const r = checkBundle({ locale: 'xx', a: 'Continue', b: '123' }, { locale: 'en', a: 'Continue', b: '123' });
    expect(r.failures).toEqual([]);
    expect(r.warnings.map((w) => w.key)).toEqual(['a']);
    expect(checkBundle({ locale: 'xx', a: 'Continue' }, { locale: 'en', a: 'Continue' }, { allowUntranslated: ['a'] }).warnings).toEqual([]);
  });

  it('every shipped bundle has every key, no blank string, and the same placeholders as English', () => {
    for (const [tag, bundle] of Object.entries(LOCALES)) {
      if (tag === 'en-US') continue;
      const { failures } = checkBundle(bundle as unknown as Record<string, unknown>, enUS as unknown as Record<string, unknown>);
      expect(failures.map((f) => `${tag}: ${f.message}`)).toEqual([]);
    }
  });
});
