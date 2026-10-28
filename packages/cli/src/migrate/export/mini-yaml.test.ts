import { describe, expect, it } from 'vitest';
import { parseYaml } from './mini-yaml';

const doc = (...lines: string[]) => lines.join('\n');

describe('parseYaml', () => {
  // The shape of a Kratos config file (https://www.ory.sh/docs/kratos/reference/configuration)
  const kratos = doc(
    '# Kratos config', // 1
    'version: v1.1.0',
    '',
    'dsn: memory',
    '',
    'serve:',
    '  public:',
    '    base_url: http://127.0.0.1:4433/',
    '    cors:',
    '      enabled: true', // 10
    `      allowed_origins: [ "http://localhost:3000", 'https://app.example.com' ]`,
    '',
    'selfservice:',
    '  methods:',
    '    password:',
    '      enabled: true',
    '      config:',
    '        min_password_length: 10',
    '        haveibeenpwned_enabled: false',
    '    oidc:', // 20
    '      enabled: true',
    '      config:',
    '        providers:',
    '          - id: google',
    '            provider: google',
    '            client_id: abc.apps.googleusercontent.com',
    '            mapper_url: "base64://bG9jYWwgY2xhaW1z"',
    '            scope:',
    '              - email',
    '              - profile', // 30
    '          - id: github # the GitHub app',
    '            provider: github',
    '            scope: [user:email]',
    'hashers:',
    '  algorithm: bcrypt',
    '  bcrypt:',
    '    cost: 12',
    'session:',
    '  lifespan: 720h',
    '  cookie:', // 40
    '    same_site: Lax',
    '    domain: ~',
  );

  it('reads nested mappings, sequences of mappings and flow sequences', () => {
    const y = parseYaml(kratos);
    expect(y.value).toEqual({
      version: 'v1.1.0',
      dsn: 'memory',
      serve: {
        public: {
          base_url: 'http://127.0.0.1:4433/',
          cors: { enabled: true, allowed_origins: ['http://localhost:3000', 'https://app.example.com'] },
        },
      },
      selfservice: {
        methods: {
          password: { enabled: true, config: { min_password_length: 10, haveibeenpwned_enabled: false } },
          oidc: {
            enabled: true,
            config: {
              providers: [
                {
                  id: 'google',
                  provider: 'google',
                  client_id: 'abc.apps.googleusercontent.com',
                  mapper_url: 'base64://bG9jYWwgY2xhaW1z',
                  scope: ['email', 'profile'],
                },
                { id: 'github', provider: 'github', scope: ['user:email'] },
              ],
            },
          },
        },
      },
      hashers: { algorithm: 'bcrypt', bcrypt: { cost: 12 } },
      session: { lifespan: '720h', cookie: { same_site: 'Lax', domain: null } },
    });
  });

  it('remembers the source line of every key and sequence item', () => {
    const y = parseYaml(kratos);
    expect(y.line('version')).toBe(2);
    expect(y.line('serve.public.cors.allowed_origins')).toBe(11);
    expect(y.line('serve.public.cors.allowed_origins.1')).toBe(11);
    expect(y.line('selfservice.methods.password.config.min_password_length')).toBe(18);
    expect(y.line('selfservice.methods.oidc.config.providers.0')).toBe(24);
    expect(y.line('selfservice.methods.oidc.config.providers.0.id')).toBe(24);
    expect(y.line('selfservice.methods.oidc.config.providers.0.scope.1')).toBe(30);
    expect(y.line('selfservice.methods.oidc.config.providers.1.id')).toBe(31);
    expect(y.line('selfservice.methods.oidc.config.providers.1.provider')).toBe(32);
    expect(y.line('hashers.bcrypt.cost')).toBe(37);
    expect(y.line('session.cookie.domain')).toBe(42);
    expect(y.line('session.cookie.nope')).toBeUndefined();
  });

  it('resolves scalars per the core schema and keeps quoted text verbatim', () => {
    const y = parseYaml(
      doc(
        `a: 'it''s'`,
        String.raw`b: "tab\there \u00e9 \"q\""`,
        'c: 42',
        'd: -3.5',
        'e: 1e3',
        'f: true',
        'g: False',
        'h: null',
        'i: ~',
        'j:',
        'k: "123"',
        'l: !!str 123',
        'm: a#b',
        'n: value # a comment',
        'o: 0x1F',
        'p: 30s',
        `q: 'a # not a comment'`,
        `r: it's plain`,
        's: !Ref tagged',
      ),
    );
    expect(y.value).toEqual({
      a: "it's",
      b: 'tab\there é "q"',
      c: 42,
      d: -3.5,
      e: 1000,
      f: true,
      g: false,
      h: null,
      i: null,
      j: null,
      k: '123',
      l: '123',
      m: 'a#b',
      n: 'value',
      o: 31,
      p: '30s',
      q: 'a # not a comment',
      r: "it's plain",
      s: 'tagged',
    });
  });

  it('reads literal and folded block scalars with their chomping', () => {
    const y = parseYaml(
      doc(
        'literal: |',
        '  line one',
        '  line two',
        '',
        'folded: >',
        '  a long',
        '  sentence',
        '',
        '  next para',
        'strip: |-',
        '  no newline',
        'keep: |+',
        '  kept',
        '',
        'script: |',
        '  # not a comment',
        '  echo hi',
        'after: 1',
      ),
    );
    expect(y.value).toEqual({
      literal: 'line one\nline two\n',
      folded: 'a long sentence\nnext para\n',
      strip: 'no newline',
      keep: 'kept\n\n',
      script: '# not a comment\necho hi\n',
      after: 1,
    });
    expect(y.line('after')).toBe(18);
  });

  it('reads sequences at the key indentation, nested sequences and flow mappings', () => {
    const y = parseYaml(
      doc(
        'providers:',
        '- id: a',
        '  scopes: [x, y]',
        '- id: b',
        '  extra: {mapper: "file://m.jsonnet", n: 2, flag}',
        'matrix:',
        '  - - 1',
        '    - 2',
        '  - [3, 4]',
        'empty_list: []',
        'empty_map: {}',
      ),
    );
    expect(y.value).toEqual({
      providers: [
        { id: 'a', scopes: ['x', 'y'] },
        { id: 'b', extra: { mapper: 'file://m.jsonnet', n: 2, flag: null } },
      ],
      matrix: [
        [1, 2],
        [3, 4],
      ],
      empty_list: [],
      empty_map: {},
    });
    expect(y.line('providers.1')).toBe(4);
    expect(y.line('providers.1.extra.mapper')).toBe(5);
    expect(y.line('matrix.0.0')).toBe(7);
    expect(y.line('matrix.0.1')).toBe(8);
    expect(y.line('matrix.1.0')).toBe(9);
  });

  it('reads a top-level sequence, multi-line plain and quoted scalars, and CRLF input', () => {
    expect(parseYaml(doc('- a', '- b: 1', '  c: [1]')).value).toEqual(['a', { b: 1, c: [1] }]);
    expect(parseYaml(doc('desc: this is', '  a long value', 'q: "first', '  second"')).value).toEqual({
      desc: 'this is a long value',
      q: 'first second',
    });
    expect(parseYaml('a: 1\r\nb: two\r\n').value).toEqual({ a: 1, b: 'two' });
  });

  it('reads the first document only, after directives and a document start', () => {
    const y = parseYaml(doc('%YAML 1.2', '---', '# first', 'name: one', '---', 'name: two'));
    expect(y.value).toEqual({ name: 'one' });
    expect(y.line('name')).toBe(4);
    expect(parseYaml('').value).toBeNull();
    expect(parseYaml('# only a comment\n').value).toBeNull();
  });

  it('throws with the line number on malformed input', () => {
    expect(() => parseYaml('a:\n\tb: 1')).toThrow(/line 2: tabs/);
    expect(() => parseYaml('a:\n    b: 1\n  c: 2')).toThrow(/line 3: unexpected indentation/);
    expect(() => parseYaml('a: "open\nb: 1')).toThrow(/line 1: unterminated quoted string/);
    expect(() => parseYaml('a: [1, 2\nb: 3')).toThrow(/line 1: unterminated flow collection/);
    expect(() => parseYaml('a: 1\na: 2')).toThrow(/line 2: duplicate key "a"/);
    expect(() => parseYaml('a: 1\n  b: 2')).toThrow(/line 2: unexpected indentation/);
    expect(() => parseYaml('a: 1\njust text')).toThrow(/line 2: expected "key: value"/);
    expect(() => parseYaml('a: |x\n  b')).toThrow(/line 1: bad block scalar header/);
  });
});
