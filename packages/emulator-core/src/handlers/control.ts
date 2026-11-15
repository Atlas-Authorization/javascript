/* eslint-disable @typescript-eslint/no-explicit-any */
import type { RouteDef } from '../engine';
import { runOAuthClockWork } from './emu4-oauth';
import { EmulatorError } from '../errors';
import { runScenario } from '../scenario';
import { refreshSession } from './sessions';
import { deliverDueJourneyMessages } from './emu4-messaging';

/** The emulator's own control surface. None of it exists on a real Atlas; the parity suite skips `/__emulator`. */
export function controlHandlers(): RouteDef[] {
  return [
    {
      method: 'GET',
      pattern: '/__emulator/messages',
      public: true,
      handler: async (c) => {
        const q = { to: c.query.get('to') ?? undefined, channel: c.query.get('channel') ?? undefined, after: c.query.get('after') ? Number(c.query.get('after')) : undefined };
        const wait = Number(c.query.get('wait') ?? 0);
        if (wait > 0) {
          try {
            await c.engine.messages.waitFor(q, Math.min(wait, 30_000));
          } catch {
            /* timed out: answer with whatever is there, which is nothing */
          }
        }
        return { body: { object: 'list', data: c.engine.messages.list(q) } };
      },
    },
    { method: 'DELETE', pattern: '/__emulator/messages', public: true, handler: (c) => (c.engine.messages.clear(), { body: { ok: true } }) },
    { method: 'POST', pattern: '/__emulator/messages', public: true, handler: (c) => ({ status: 201, body: c.engine.messages.send({ channel: String(c.body.channel ?? 'email'), to: String(c.body.to ?? ''), subject: c.body.subject, body: c.body.body, code: c.body.code, link: c.body.link }) }) },
    { method: 'POST', pattern: '/__emulator/reset', public: true, handler: (c) => (c.engine.reset(), { body: { ok: true } }) },
    { method: 'GET', pattern: '/__emulator/time', public: true, handler: (c) => ({ body: { now: c.engine.clock.now() } }) },
    {
      method: 'POST',
      pattern: '/__emulator/time/advance',
      public: true,
      handler: async (c) => {
        if (typeof c.body.ms !== 'number') throw new EmulatorError('VALIDATION_FAILED', 'ms must be a number.', 'ms');
        c.engine.clock.advance(c.body.ms);
        // Whatever the OAuth provider had waiting for this moment: key rotation schedule, retried deliveries.
        await runOAuthClockWork(c.engine);
        deliverDueJourneyMessages(c.engine);
        return { body: { now: c.engine.clock.now() } };
      },
    },
    {
      method: 'POST',
      pattern: '/__emulator/faults',
      public: true,
      handler: (c) => {
        const status = c.body.status === 'network' ? 'network' : Number(c.body.status);
        if (status !== 'network' && !(status >= 100 && status < 600)) throw new EmulatorError('VALIDATION_FAILED', 'status must be an HTTP status or "network".', 'status');
        c.engine.webhooks.faults.push({ endpointId: c.body.endpoint_id, status, times: Number(c.body.times ?? 1) });
        return { status: 201, body: { ok: true } };
      },
    },
    { method: 'DELETE', pattern: '/__emulator/faults', public: true, handler: (c) => ((c.engine.webhooks.faults.length = 0), { body: { ok: true } }) },
    { method: 'GET', pattern: '/__emulator/webhooks/deliveries', public: true, handler: (c) => ({ body: { object: 'list', data: c.engine.webhooks.deliveries } }) },
    {
      method: 'POST',
      pattern: '/__emulator/changes/trim',
      public: true,
      handler: (c) => {
        if (!Number.isInteger(c.body.seq)) throw new EmulatorError('VALIDATION_FAILED', 'seq must be an integer.', 'seq');
        c.engine.feed.trim(c.body.seq);
        return { body: { retention_floor_seq: c.engine.feed.retentionFloorSeq } };
      },
    },
    {
      method: 'POST',
      pattern: '/__emulator/scenarios',
      public: true,
      handler: async (c) => ({ status: 201, body: await runScenario(c.engine, c.body) }),
    },
    {
      method: 'POST',
      pattern: '/__emulator/sessions/refresh',
      public: true,
      handler: async (c) => ({ body: await refreshSession(c.engine, String(c.body.refresh_token ?? '')) }),
    },
  ];
}
