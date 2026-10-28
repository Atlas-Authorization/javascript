'use client';

import { useCallback, useEffect, useState } from 'react';
import { getProfileCompletion, saveProfileCompletion, type ProfileCompletionField } from '@atlasauth/js';
import { useClass, useClasses, useErrorText, useMeClient, useText } from './components-shared';

/**
 * Progressive profiling: ask a signed-in user for the profile fields the
 * application configured `before_feature`, just before the feature that needs
 * them. Renders nothing once nothing is owed, so it can sit in front of any
 * feature: `<ProfileCompletion onComplete={…}/>`.
 */
export interface ProfileCompletionProps {
  /** Called when nothing is owed (immediately on load if the user is already complete) or after a save. */
  onComplete?(): void;
}

export function ProfileCompletion({ onComplete }: ProfileCompletionProps) {
  const t = useText();
  const cls = useClasses();
  const client = useMeClient();
  const errorText = useErrorText();
  const inputClass = useClass('formFieldInput', 'atlas-input');
  const buttonClass = useClass('formButtonPrimary', 'atlas-button');
  const errorClass = useClass('formFieldError', 'atlas-error');
  const [fields, setFields] = useState<ProfileCompletionField[] | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void getProfileCompletion(client).then((res) => {
      if (!res.ok) return setError(res.errors[0] ? errorText(res.errors[0]) : null);
      setFields(res.completion.fields);
      if (res.completion.complete) onComplete?.();
    });
  }, [client]);

  const submit = useCallback(async () => {
    setSaving(true);
    setError(null);
    const res = await saveProfileCompletion(client, values);
    setSaving(false);
    if (!res.ok) return setError(res.errors[0] ? errorText(res.errors[0]) : t('error.generic'));
    setFields([]);
    onComplete?.();
  }, [client, errorText, onComplete, t, values]);

  if (error && !fields) return <p className={errorClass} role="alert">{error}</p>;
  if (!fields || fields.length === 0) return null;
  return (
    <form
      className="atlas-profile-completion"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {error ? <p className={errorClass} role="alert">{error}</p> : null}
      {fields.map((f) => (
        <label key={f.key} className={cls('formField', 'atlas-field')}>
          <span className={cls('formFieldLabel', 'atlas-field-label')}>{f.label}{f.required ? ' *' : ''}</span>
          {f.options.length > 0 ? (
            <select className={inputClass} required={f.required} value={values[f.key] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}>
              <option value="" />
              {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          ) : (
            <input
              className={inputClass}
              type={f.type === 'tel' || f.type === 'email' || f.type === 'url' || f.type === 'number' || f.type === 'date' ? f.type : 'text'}
              required={f.required}
              placeholder={f.placeholder ?? undefined}
              value={values[f.key] ?? ''}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
            />
          )}
        </label>
      ))}
      <button className={buttonClass} type="submit" disabled={saving}>{t('profileTraits.save')}</button>
    </form>
  );
}
