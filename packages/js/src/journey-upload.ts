import type { FapiClient, FlowState } from './fapi';

export type JourneyUploadResult = { ok: true; id: string; contentType: string; size: number } | { ok: false; errors: Array<{ code?: string; message: string }> };

/** File types a journey file field takes (the server also checks the bytes, the field's `accept` and `maxBytes`). */
export const JOURNEY_UPLOAD_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf'] as const;

/**
 * Upload the file for a journey form's `file` field on the held attempt and answer the upload id to put in that field's value.
 * The attempt proves itself with its one-time token or poll secret, like finishing the step.
 */
export async function uploadJourneyFile(client: FapiClient, state: FlowState, field: string, file: Blob): Promise<JourneyUploadResult> {
  const id = state.attempt?.id;
  const type = file.type || 'application/octet-stream';
  if (!id) return { ok: false, errors: [{ code: 'no_attempt', message: 'There is no sign-in to attach this file to.' }] };
  if (!(JOURNEY_UPLOAD_TYPES as readonly string[]).includes(type)) {
    return { ok: false, errors: [{ code: 'unsupported_media_type', message: `Use a PNG, JPEG, GIF, WebP or PDF file (got ${type}).` }] };
  }
  const res = await client.request<{ id: string; content_type: string; size: number }>(`/v1/client/sign_ins/${encodeURIComponent(id)}/journey_uploads?field=${encodeURIComponent(field)}`, {
    method: 'POST',
    body: file,
    headers: {
      'content-type': type,
      ...(state.policyToken ? { 'x-required-action-token': state.policyToken } : state.pollSecret ? { 'x-poll-secret': state.pollSecret } : {}),
    },
  });
  return res.ok && res.data ? { ok: true, id: res.data.id, contentType: res.data.content_type, size: res.data.size } : { ok: false, errors: res.errors };
}
