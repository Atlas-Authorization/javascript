import { TSESLint } from '@typescript-eslint/utils';
import * as tsParser from '@typescript-eslint/parser';
import { describe, it } from 'vitest';
import rule from './require-webhook-verify';

const { RuleTester } = TSESLint;

// Drive the @typescript-eslint/utils RuleTester with vitest's it/describe.
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

// The deprecated RuleTester's config type is pre-flat-config, but at runtime it
// extends ESLint 9's RuleTester, which reads `languageOptions`. Cast to bridge.
const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  },
} as unknown as ConstructorParameters<typeof RuleTester>[0]);

ruleTester.run('require-webhook-verify', rule, {
  valid: [
    // Verified in the handler.
    { code: `app.post('/webhooks/atlas', async (req, res) => { const e = verifyWebhook({ payload: req.body, headers: req.headers, secret }); res.send(e.id); });` },
    // Verified by a method named verify.
    { code: `app.post('/api/webhook', (req, res) => { const evt = wh.verify(req.body, req.headers); res.json(evt); });` },
    // Verification as middleware.
    { code: `app.post('/webhooks/atlas', verifyAtlasWebhookMiddleware(secret), (req, res) => res.sendStatus(204));` },
    // Stripe-style constructEvent counts.
    { code: `router.post('/stripe-webhook', async (req, res) => { const e = stripe.webhooks.constructEvent(req.body, sig, secret); res.json(e); });` },
    // A handler named elsewhere (imported) cannot be judged here.
    { code: `import { handle } from './handle'; app.post('/webhooks/atlas', handle);` },
    // A named handler that verifies.
    { code: `async function handle(req, res) { await verifyAtlasWebhookRequest({ request: req, secret }); res.end(); } app.post('/webhooks/atlas', handle);` },
    // Not a webhook path.
    { code: `app.post('/orders', (req, res) => res.json({ ok: true }));` },
    // A file-based route in a webhook file that verifies.
    { code: `export async function POST(request) { const body = await request.text(); const e = await verifyAtlasWebhookRequest({ request, secret }); return Response.json(e); }`, filename: 'app/api/webhooks/atlas/route.ts' },
    // An exported POST in a file that is not a webhook route.
    { code: `export async function POST(request) { return Response.json({}); }`, filename: 'app/api/orders/route.ts' },
    // A custom check named in options.
    { code: `app.post('/webhooks/atlas', (req, res) => { checkSig(req); res.end(); });`, options: [{ verifyFunctions: ['checkSig'] }] },
  ],
  invalid: [
    { code: `app.post('/webhooks/atlas', async (req, res) => { const e = JSON.parse(req.body); res.json(e); });`, errors: [{ messageId: 'unverified' }] },
    { code: `router.all('/api/webhook', (req, res) => { res.sendStatus(200); });`, errors: [{ messageId: 'unverified' }] },
    { code: `async function handle(req, res) { res.json(req.body); } app.post('/webhooks/atlas', handle);`, errors: [{ messageId: 'unverified' }] },
    { code: `export async function POST(request) { const e = await request.json(); return Response.json(e); }`, filename: 'app/api/webhooks/atlas/route.ts', errors: [{ messageId: 'unverified' }] },
    { code: `export const POST = async (request) => Response.json(await request.json());`, filename: 'src/routes/webhook/+server.ts', errors: [{ messageId: 'unverified' }] },
    // A decoder is not a verifier.
    { code: `app.post('/webhooks/atlas', (req, res) => { const e = decodeJwt(req.body.token); res.json(e); });`, errors: [{ messageId: 'unverified' }] },
  ],
});
