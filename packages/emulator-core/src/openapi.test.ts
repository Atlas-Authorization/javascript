import { describe, expect, it } from 'vitest';
import { OpenApiIndex, synthesize, validate } from './openapi';

const doc = {
  paths: {
    '/v1/things': { post: { requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/NewThing' } } } }, responses: { '201': { content: { 'application/json': { schema: { $ref: '#/components/schemas/Thing' } } } } }, security: [{ secretKey: [] }], 'x-required-scope': 'things:write' } },
    '/v1/things/{id}': { get: { responses: { '200': {} } } },
    '/v1/things/search': { get: { responses: { '200': {} } } },
  },
  components: {
    schemas: {
      NewThing: { type: 'object', required: ['name'], properties: { name: { type: 'string', minLength: 2 }, kind: { type: 'string', enum: ['a', 'b'] }, tags: { type: 'array', items: { type: 'string' } }, nested: { type: 'object', properties: { n: { type: 'integer', minimum: 1 } } } } },
      Thing: { type: 'object', required: ['object', 'id', 'n', 'maybe', 'list'], properties: { object: { const: 'thing' }, id: { type: 'string' }, n: { type: 'integer' }, maybe: { type: ['string', 'null'] }, list: { type: 'array' } } },
    },
  },
};

describe('OpenApiIndex', () => {
  const index = new OpenApiIndex(doc);

  it('prefers the literal path over the parameter path', () => {
    expect(index.match('GET', '/v1/things/search')?.op.path).toBe('/v1/things/search');
    expect(index.match('GET', '/v1/things/abc')?.params).toEqual({ id: 'abc' });
    expect(index.match('DELETE', '/v1/things/abc')).toBeNull();
    expect(index.methodsFor('/v1/things')).toEqual(['POST']);
  });

  it('reads scope, security and the success status', () => {
    const op = index.match('POST', '/v1/things')?.op;
    expect(op).toMatchObject({ scope: 'things:write', needsSecretKey: true, successStatus: 201, requestRequired: true });
  });

  it('validates types, required fields, enums, bounds and nested paths', () => {
    const schema = index.schemaByName('NewThing');
    expect(validate(index, schema, { name: 'ok' }).violations).toEqual([]);
    expect(validate(index, schema, {}).violations[0]).toMatchObject({ param: 'name' });
    expect(validate(index, schema, { name: 'x' }).violations[0]?.param).toBe('name');
    expect(validate(index, schema, { name: 'ok', kind: 'z' }).violations[0]?.param).toBe('kind');
    expect(validate(index, schema, { name: 'ok', tags: ['a', 1] }).violations[0]?.param).toBe('tags[1]');
    expect(validate(index, schema, { name: 'ok', nested: { n: 0 } }).violations[0]?.param).toBe('nested.n');
    expect(validate(index, schema, { name: 5 }).violations[0]?.param).toBe('name');
  });

  it('reports unknown fields without failing them', () => {
    const r = validate(index, index.schemaByName('NewThing'), { name: 'ok', surprise: 1, nested: { n: 2, extra: true } });
    expect(r.violations).toEqual([]);
    expect(r.unknown.sort()).toEqual(['nested.extra', 'surprise']);
  });

  it('synthesizes the required fields of a response, null where nullable', () => {
    expect(synthesize(index, index.schemaByName('Thing'))).toEqual({ object: 'thing', id: '', n: 0, maybe: null, list: [] });
  });
});
