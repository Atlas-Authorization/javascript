import { describe, expect, it, vi } from 'vitest';
import { FapiClient, initialFlow } from './fapi';
import { uploadJourneyFile } from './journey-upload';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function clientWith(handler: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return handler(String(input), init);
  }) as unknown as typeof fetch;
  return { client: new FapiClient({ publishableKey: 'pk_test_x', baseUrl: 'https://fapi.example', fetchImpl }), calls };
}
const held = { ...initialFlow, attempt: { id: 'sia_1', status: 'needs_required_action' } as never, policyToken: 'tok_1' };

describe('uploadJourneyFile', () => {
  it('sends the raw bytes with the attempt proof and answers the upload id', async () => {
    const { client, calls } = clientWith(() => json(201, { object: 'journey_upload', id: 'ju_abc.png', content_type: 'image/png', size: 4 }));
    const file = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });
    expect(await uploadJourneyFile(client, held, 'doc', file)).toEqual({ ok: true, id: 'ju_abc.png', contentType: 'image/png', size: 4 });
    expect(calls[0]!.url).toBe('https://fapi.example/v1/client/sign_ins/sia_1/journey_uploads?field=doc');
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(h['x-required-action-token']).toBe('tok_1');
    expect(h['content-type']).toBe('image/png');
    expect(calls[0]!.init.body).toBe(file);
  });

  it('refuses an unsupported type and a missing attempt without calling the server', async () => {
    const { client, calls } = clientWith(() => json(201, {}));
    expect((await uploadJourneyFile(client, held, 'doc', new Blob(['x'], { type: 'text/html' }))).ok).toBe(false);
    expect((await uploadJourneyFile(client, initialFlow, 'doc', new Blob(['x'], { type: 'image/png' }))).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('surfaces the server refusal', async () => {
    const { client } = clientWith(() => json(400, { errors: [{ code: 'validation', message: 'too big' }] }));
    const out = await uploadJourneyFile(client, held, 'doc', new Blob(['x'], { type: 'application/pdf' }));
    expect(out.ok).toBe(false);
  });
});
