import type { ParityRequest } from './parity';

const q = (id: string, method: ParityRequest['method'], path: string, rest: Partial<ParityRequest> = {}): ParityRequest => ({ id, method, path, group: 'platform', ...rest });
const flowShape = ['definition', 'active_version', 'latest_version', 'applications', 'description', 'is_default', 'abandon_after_hours', 'enabled'];
const V1 = { steps: [{ id: 'hello', type: 'send_message', subject: 'Welcome', body: 'Hi {{first_name}}' }] };
const V2 = { steps: [{ id: 'hello', type: 'send_message', subject: 'Welcome aboard', body: 'Hi {{first_name}}, glad you are here' }] };
const VARIANTS = [
  { key: 'control', version: 1, weight: 50 },
  { key: 'short', version: 2, weight: 50 },
];

/** A journey with two saved versions, an A/B experiment over them (draft, edit, start, read out, stop and promote, delete) and the messages the journey schedules. */
export const emu4MessagingParityRequests: ParityRequest[] = [
  q('emu4 journey', 'POST', '/v1/flows', { body: { name: 'emu4-{{rand}}', definition: V1 }, capture: { ef: 'id' }, tolerate: flowShape }),
  q('emu4 journey new version', 'PATCH', '/v1/flows/{{ef}}', { body: { definition: V2, activate: false }, tolerate: flowShape }),
  q('emu4 journey versions', 'GET', '/v1/flows/{{ef}}/versions', { tolerate: ['data'] }),
  q('emu4 journey activate', 'POST', '/v1/flows/{{ef}}/activate', { body: { version: 1 }, tolerate: flowShape }),
  q('emu4 journey activate unknown', 'POST', '/v1/flows/{{ef}}/activate', { body: { version: 99 } }),
  q('emu4 experiment bad weights', 'POST', '/v1/flows/{{ef}}/experiments', { body: { name: 'bad', variants: [{ key: 'a', version: 1, weight: 60 }, { key: 'b', version: 2, weight: 60 }] } }),
  q('emu4 experiment create', 'POST', '/v1/flows/{{ef}}/experiments', { body: { name: 'short body', hypothesis: 'A shorter mail converts', variants: VARIANTS }, capture: { ex: 'id' }, tolerate: ['hypothesis'] }),
  q('emu4 experiment duplicate', 'POST', '/v1/flows/{{ef}}/experiments', { body: { name: 'short body', variants: VARIANTS } }),
  q('emu4 experiments', 'GET', '/v1/flows/{{ef}}/experiments', { tolerate: ['data'] }),
  q('emu4 experiment get', 'GET', '/v1/flows/{{ef}}/experiments/{{ex}}', { tolerate: ['hypothesis'] }),
  q('emu4 experiment patch', 'PATCH', '/v1/flows/{{ef}}/experiments/{{ex}}', { body: { hypothesis: 'Shorter wins' }, tolerate: ['hypothesis'] }),
  q('emu4 experiment start', 'POST', '/v1/flows/{{ef}}/experiments/{{ex}}/start', { tolerate: ['hypothesis'] }),
  q('emu4 experiment frozen', 'PATCH', '/v1/flows/{{ef}}/experiments/{{ex}}', { body: { name: 'renamed' } }),
  q('emu4 experiment delete running', 'DELETE', '/v1/flows/{{ef}}/experiments/{{ex}}'),
  q('emu4 experiment readout', 'GET', '/v1/flows/{{ef}}/experiments/{{ex}}/readout', { tolerate: ['variants', 'started_at'] }),
  q('emu4 experiment stop unknown variant', 'POST', '/v1/flows/{{ef}}/experiments/{{ex}}/stop', { body: { promote_variant: 'nope' } }),
  q('emu4 experiment stop', 'POST', '/v1/flows/{{ef}}/experiments/{{ex}}/stop', { body: { promote_variant: 'short' }, tolerate: ['hypothesis', 'promoted_variant', 'stopped_at'] }),
  q('emu4 experiment stop again', 'POST', '/v1/flows/{{ef}}/experiments/{{ex}}/stop', { body: {} }),
  q('emu4 experiment delete', 'DELETE', '/v1/flows/{{ef}}/experiments/{{ex}}'),
  q('emu4 experiment gone', 'GET', '/v1/flows/{{ef}}/experiments/{{ex}}'),
  q('emu4 journey messages', 'GET', '/v1/flows/{{ef}}/messages', { tolerate: ['data'] }),
  q('emu4 journey messages bad status', 'GET', '/v1/flows/{{ef}}/messages?status=nope'),
  q('emu4 journey message cancel unknown', 'POST', '/v1/flows/{{ef}}/messages/jmsg_unknown/cancel'),
  q('emu4 journey delete', 'DELETE', '/v1/flows/{{ef}}', { tolerate: ['deleted', 'object'] }),
  // A custom block in a page template: anything outside the allowlist is refused, a clean one is stored in its sanitized form.
  q('emu4 template custom refused', 'PUT', '/v1/instance/page_templates/sign-up?locale=nl', { body: { definition: { version: 1, regions: { footer: [{ type: 'custom', html: '<script>alert(1)</script><p>x</p>', height: 120 }] } } } }),
  q('emu4 template custom', 'PUT', '/v1/instance/page_templates/sign-up?locale=nl', { body: { definition: { version: 1, regions: { footer: [{ type: 'custom', html: '<p class="note">Hallo {{year}}</p>', css: '.note{color:#333}', height: 120 }] } } }, tolerate: ['draft', 'live', 'scope', 'version', 'updated_at'] }),
];
