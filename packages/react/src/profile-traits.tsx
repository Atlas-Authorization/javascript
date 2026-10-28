'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { getProfileSchema, updateProfile, type ProfileSchema, type ProfileSchemaField } from '@atlasauth/js';
import { useClass, useClasses, useErrorText, useMeClient, useText } from './components-shared';

/**
 * The signed-in user's profile traits — the custom fields the application
 * defined (identity traits), rendered from `GET /v1/client/profile_schema`:
 * labels in the user's language, sections, a control per type, what is required
 * and what the user may change. `useProfileTraits()` is the headless half.
 */

export type ProfileTraitsStatus = 'loading' | 'ready' | 'error';

export interface UseProfileTraitsResult {
  status: ProfileTraitsStatus;
  schema: ProfileSchema | null;
  /** The form's current values (the saved ones, plus the user's edits). */
  values: Record<string, unknown>;
  setValue(key: string, value: unknown): void;
  /** Whether anything the user may change differs from what is saved. */
  dirty: boolean;
  saving: boolean;
  /** Message of the last failed load or save; per-field messages are in `fieldErrors`. */
  error: string | null;
  fieldErrors: Record<string, string>;
  save(): Promise<boolean>;
  reload(): Promise<void>;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function useProfileTraits(options: { locale?: string } = {}): UseProfileTraitsResult {
  const client = useMeClient();
  const errorText = useErrorText();
  const [status, setStatus] = useState<ProfileTraitsStatus>('loading');
  const [schema, setSchema] = useState<ProfileSchema | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const reload = useCallback(async () => {
    const res = await getProfileSchema(client, { locale: options.locale });
    if (!res.ok) {
      setStatus('error');
      setError(res.errors[0] ? errorText(res.errors[0]) : null);
      return;
    }
    setSchema(res.schema);
    setValues(res.schema.values);
    setStatus('ready');
    setError(null);
    setFieldErrors({});
  }, [client, errorText, options.locale]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const editable = schema?.fields.filter((f) => f.editable) ?? [];
  const changed = editable.filter((f) => !same(values[f.key] ?? null, schema?.values[f.key] ?? null));

  const save = useCallback(async () => {
    if (!schema || changed.length === 0) return true;
    setSaving(true);
    setError(null);
    setFieldErrors({});
    // An emptied optional field is removed (null); a required one is sent as it is, for the server to refuse.
    const traits: Record<string, unknown> = {};
    for (const f of changed) {
      const v = values[f.key];
      traits[f.key] = v === undefined || v === '' || (Array.isArray(v) && v.length === 0 && !f.required) ? null : v;
    }
    const res = await updateProfile(client, { traits });
    setSaving(false);
    if (!res.ok) {
      const next: Record<string, string> = {};
      for (const e of res.errors) {
        const key = e.param?.startsWith('traits.') ? e.param.slice('traits.'.length) : null;
        if (key) next[key] = errorText(e);
      }
      setFieldErrors(next);
      if (Object.keys(next).length === 0) setError(res.errors[0] ? errorText(res.errors[0]) : null);
      return false;
    }
    await reload();
    return true;
  }, [changed, client, errorText, reload, schema, values]);

  return {
    status,
    schema,
    values,
    setValue: (key, value) => setValues((v) => ({ ...v, [key]: value })),
    dirty: changed.length > 0,
    saving,
    error,
    fieldErrors,
    save,
    reload,
  };
}

const INPUT_TYPE: Partial<Record<ProfileSchemaField['type'], string>> = {
  email: 'email',
  url: 'url',
  phone: 'tel',
  date: 'date',
  number: 'number',
};

function TraitControl({ field, value, onChange, className }: { field: ProfileSchemaField; value: unknown; onChange(v: unknown): void; className: string }) {
  const disabled = !field.editable;
  const id = `atlas_trait_${field.key}`;
  switch (field.type) {
    case 'boolean':
      return <input id={id} type="checkbox" checked={value === true} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />;
    case 'enum':
      return (
        <select id={id} className={className} value={typeof value === 'string' ? value : ''} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
          <option value="" />
          {(field.enum ?? []).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );
    case 'multi_select': {
      const chosen = Array.isArray(value) ? (value as string[]) : [];
      return (
        <span id={id} role="group">
          {(field.enum ?? []).map((o) => (
            <label key={o}>
              <input
                type="checkbox"
                checked={chosen.includes(o)}
                disabled={disabled}
                onChange={(e) => onChange(e.target.checked ? [...chosen, o] : chosen.filter((c) => c !== o))}
              />{' '}
              {o}
            </label>
          ))}
        </span>
      );
    }
    case 'array':
      return (
        <input
          id={id}
          className={className}
          value={Array.isArray(value) ? value.join(', ') : ''}
          disabled={disabled}
          onChange={(e) => {
            const parts = e.target.value.split(',').map((s) => s.trim()).filter(Boolean);
            onChange(field.items === 'number' ? parts.map((p) => (Number.isFinite(Number(p)) ? Number(p) : p)) : parts);
          }}
        />
      );
    case 'object':
      return (
        <textarea
          id={id}
          className={className}
          disabled={disabled}
          defaultValue={value === undefined ? '' : JSON.stringify(value, null, 2)}
          onChange={(e) => {
            try {
              onChange(e.target.value.trim() ? (JSON.parse(e.target.value) as unknown) : null);
            } catch {
              onChange(e.target.value);
            }
          }}
        />
      );
    default:
      return (
        <input
          id={id}
          className={className}
          type={INPUT_TYPE[field.type] ?? 'text'}
          value={value === undefined || value === null ? '' : String(value)}
          min={field.type === 'date' ? field.minDate : field.min}
          max={field.type === 'date' ? field.maxDate : field.max}
          minLength={field.minLength}
          maxLength={field.maxLength}
          disabled={disabled}
          onChange={(e) => onChange(field.type === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value)}
        />
      );
  }
}

export interface ProfileTraitsProps {
  /** Language for labels and sections; default the user's own. */
  locale?: string;
  /** Called after a successful save. */
  onSaved?(): void;
  /** Shown when the application defines no traits for this user. */
  empty?: ReactNode;
}

/** The profile fields the application defined, as a form. Renders `empty` (default nothing) when there are none. */
export function ProfileTraits({ locale, onSaved, empty = null }: ProfileTraitsProps) {
  const t = useText();
  const cls = useClasses();
  const inputClass = useClass('formFieldInput', 'atlas-input');
  const buttonClass = useClass('formButtonPrimary', 'atlas-button');
  const errorClass = useClass('formFieldError', 'atlas-error');
  const form = useProfileTraits({ locale });
  if (form.status === 'loading') return null;
  if (form.status === 'error') {
    return (
      <p className={errorClass} role="alert">
        {form.error ?? t('error.generic')}
      </p>
    );
  }
  const fields = form.schema?.fields ?? [];
  if (fields.length === 0) return <>{empty}</>;
  const groups = form.schema?.groups ?? [];
  const sections: { key: string | null; label: string | null; fields: ProfileSchemaField[] }[] = [
    { key: null, label: null, fields: fields.filter((f) => !f.group || !groups.some((g) => g.key === f.group)) },
    ...groups.map((g) => ({ key: g.key, label: g.label, fields: fields.filter((f) => f.group === g.key) })),
  ].filter((s) => s.fields.length > 0);

  return (
    <form
      className="atlas-profile-traits"
      onSubmit={(event) => {
        event.preventDefault();
        void form.save().then((ok) => ok && onSaved?.());
      }}
    >
      {form.error ? (
        <p className={errorClass} role="alert">
          {form.error}
        </p>
      ) : null}
      {sections.map((s) => (
        <fieldset key={s.key ?? 'default'} data-atlas-trait-group={s.key ?? ''}>
          {s.label ? <legend>{s.label}</legend> : null}
          {s.fields.map((f) => (
            <div key={f.key} className={cls('formField', 'atlas-field')}>
              <label className={cls('formFieldLabel', 'atlas-field-label')} htmlFor={`atlas_trait_${f.key}`}>
                {f.label}
                {f.required ? ' *' : ''}
              </label>
              <TraitControl field={f} value={form.values[f.key]} onChange={(v) => form.setValue(f.key, v)} className={inputClass} />
              {f.description ? <small>{f.description}</small> : null}
              {form.fieldErrors[f.key] ? (
                <span className={errorClass} role="alert">
                  {form.fieldErrors[f.key]}
                </span>
              ) : null}
            </div>
          ))}
        </fieldset>
      ))}
      {fields.some((f) => f.editable) ? (
        <button className={buttonClass} type="submit" disabled={!form.dirty || form.saving}>
          {t('profileTraits.save')}
        </button>
      ) : null}
    </form>
  );
}
