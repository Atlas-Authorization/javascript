import type { FapiClient } from './fapi';

export type AvatarResult = { ok: true; user: Record<string, unknown> } | { ok: false; errors: Array<{ code?: string; message: string }> };

/** Image types the server accepts for a profile picture (5 MB max). */
export const AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

/**
 * Upload the signed-in user's profile picture (a File or Blob from an
 * `<input type="file">`). Replaces the current one; answers with the updated user.
 */
export async function setAvatar(client: FapiClient, file: Blob): Promise<AvatarResult> {
  const type = file.type || 'application/octet-stream';
  if (!(AVATAR_TYPES as readonly string[]).includes(type)) {
    return { ok: false, errors: [{ code: 'unsupported_media_type', message: `Use a PNG, JPEG, GIF or WebP image (got ${type}).` }] };
  }
  const res = await client.request<Record<string, unknown>>('/v1/client/me/avatar', { method: 'POST', body: file, headers: { 'content-type': type } });
  return res.ok && res.data ? { ok: true, user: res.data } : { ok: false, errors: res.errors };
}

/** Remove the signed-in user's profile picture. Answers with the updated user. */
export async function removeAvatar(client: FapiClient): Promise<AvatarResult> {
  const res = await client.request<Record<string, unknown>>('/v1/client/me/avatar', { method: 'DELETE' });
  return res.ok && res.data ? { ok: true, user: res.data } : { ok: false, errors: res.errors };
}
