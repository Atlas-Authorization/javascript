import type { FapiClient } from './fapi';
import type { FieldError, ProfileCompletionField } from './attempt';

/**
 * Update the signed-in user's own profile (`PATCH /v1/client/me`). `traits`
 * sets identity traits the application marked user-editable — each is typed
 * and checked by the server against the trait schema (a refused value comes
 * back as an error whose `param` is `traits.<key>`); `null` removes an optional
 * one. Cookie-authenticated through the {@link FapiClient}.
 */
export interface ProfileUpdate {
  firstName?: string;
  lastName?: string;
  username?: string;
  locale?: string;
  unsafeMetadata?: Record<string, unknown>;
  traits?: Record<string, unknown>;
}

export async function updateProfile(
  client: FapiClient,
  update: ProfileUpdate,
): Promise<{ ok: true; user: Record<string, unknown> } | { ok: false; errors: FieldError[] }> {
  const body: Record<string, unknown> = {};
  if (update.firstName !== undefined) body.first_name = update.firstName;
  if (update.lastName !== undefined) body.last_name = update.lastName;
  if (update.username !== undefined) body.username = update.username;
  if (update.locale !== undefined) body.locale = update.locale;
  if (update.unsafeMetadata !== undefined) body.unsafe_metadata = update.unsafeMetadata;
  if (update.traits !== undefined) body.traits = update.traits;
  const response = await client.request<Record<string, unknown>>('/v1/client/me', {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  return response.ok && response.data ? { ok: true, user: response.data } : { ok: false, errors: response.errors };
}

/** One field of the signed-in user's profile form (`GET /v1/client/profile_schema`). */
export interface ProfileSchemaField {
  key: string;
  type: 'string' | 'number' | 'boolean' | 'enum' | 'date' | 'email' | 'url' | 'phone' | 'multi_select' | 'array' | 'object';
  /** Already in the user's language. */
  label: string;
  description: string | null;
  /** The key of a section in `groups`, or null. */
  group: string | null;
  /** Needed now, given the user's other values (a conditional requirement counts). */
  required: boolean;
  /** Whether the user may change it; a read-only field is shown but not sent. */
  editable: boolean;
  enum?: string[];
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  min?: number;
  max?: number;
  minDate?: string;
  maxDate?: string;
  minItems?: number;
  maxItems?: number;
  items?: 'string' | 'number';
  properties?: ProfileSchemaField[];
}

export interface ProfileSchema {
  object: 'profile_schema';
  groups: { key: string; label: string }[];
  fields: ProfileSchemaField[];
  /** The user's current value for each field. */
  values: Record<string, unknown>;
}

/**
 * The profile form the application defined (identity traits): the fields the user
 * may see, their labels in `locale` (default: the user's), sections, types and
 * limits, what is required and what they may change, with the current values.
 * Another audience's fields are left out.
 */
export async function getProfileSchema(
  client: FapiClient,
  options: { locale?: string } = {},
): Promise<{ ok: true; schema: ProfileSchema } | { ok: false; errors: FieldError[] }> {
  const qs = options.locale ? `?locale=${encodeURIComponent(options.locale)}` : '';
  const response = await client.request<ProfileSchema>(`/v1/client/profile_schema${qs}`, { method: 'GET' });
  return response.ok && response.data ? { ok: true, schema: response.data } : { ok: false, errors: response.errors };
}

/** Progressive profiling: what a signed-in user still owes before a feature (fields configured `before_feature`). */
export interface ProfileCompletion {
  object: 'profile_completion';
  complete: boolean;
  fields: ProfileCompletionField[];
}

export async function getProfileCompletion(
  client: FapiClient,
): Promise<{ ok: true; completion: ProfileCompletion } | { ok: false; errors: FieldError[] }> {
  const response = await client.request<ProfileCompletion>('/v1/client/me/profile_completion', { method: 'GET' });
  return response.ok && response.data ? { ok: true, completion: response.data } : { ok: false, errors: response.errors };
}

/** Save the `before_feature` fields: `{ key: value }`. Required fields must be present. */
export async function saveProfileCompletion(
  client: FapiClient,
  fields: Record<string, string>,
): Promise<{ ok: true; completion: ProfileCompletion } | { ok: false; errors: FieldError[] }> {
  const response = await client.request<ProfileCompletion>('/v1/client/me/profile_completion', { method: 'POST', body: JSON.stringify({ fields }) });
  return response.ok && response.data ? { ok: true, completion: response.data } : { ok: false, errors: response.errors };
}
