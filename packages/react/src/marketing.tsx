'use client';

import { useState, type FormEvent } from 'react';
import { submitLead } from '@atlasauth/js';
import { useClass, useClasses, useMeClient } from './components-shared';

/** English defaults for `<LeadForm/>`; override any through `labels`. */
const LEAD_LABELS = {
  email: 'Email address',
  name: 'Name',
  submit: 'Subscribe',
  consent: 'I agree to receive emails',
  thanks: 'Thanks — you are on the list.',
  invalid: 'Enter a valid email address.',
  failed: 'Could not subscribe. Try again.',
};
export type LeadFormLabels = Partial<typeof LEAD_LABELS>;

/**
 * `<LeadForm/>` — a lead / newsletter signup. It stores the address (with the
 * campaign attribution the SDK captured, when the instance captures it and the
 * visitor consented) for you to read in the dashboard or over the API
 * (`GET /v1/leads`). One row per email per `form`, so a repeat submission updates
 * rather than duplicates, and the answer is the same for a known address. Carries
 * a hidden honeypot field; submissions share the sign-up per-IP rate limit.
 *
 * `consentLabel`/`requireConsent` add a checkbox (and block submit until ticked);
 * `showName` adds a name field.
 */
export function LeadForm({
  form = 'default',
  showName = false,
  requireConsent = false,
  labels = {},
  onSubmitted,
}: {
  form?: string;
  showName?: boolean;
  /** Show the consent checkbox and require it. Without it the form records `consent: false`. */
  requireConsent?: boolean;
  labels?: LeadFormLabels;
  onSubmitted?(email: string): void;
} = {}) {
  const client = useMeClient();
  const L = { ...LEAD_LABELS, ...labels };
  const cls = useClasses();
  const cardClass = useClass('card', 'atlas-card');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [consent, setConsent] = useState(false);
  const [website, setWebsite] = useState('');
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError(L.invalid);
      return;
    }
    setState('busy');
    setError(null);
    const out = await submitLead(client, { email: email.trim(), name: name.trim() || undefined, form, consent, website });
    if (out.ok) {
      setState('done');
      onSubmitted?.(email.trim());
    } else {
      setState('idle');
      setError(out.error ?? L.failed);
    }
  };

  if (state === 'done') {
    return (
      <div className={cardClass} data-atlas="lead-form" role="status">
        {L.thanks}
      </div>
    );
  }
  return (
    <form className={cardClass} data-atlas="lead-form" onSubmit={(e) => void submit(e)} noValidate>
      {showName ? (
        <label className={cls('formField', 'atlas-field')}>
          <span className={cls('formFieldLabel', 'atlas-field-label')}>{L.name}</span>
          <input className={cls('formFieldInput', 'atlas-input')} value={name} autoComplete="name" onChange={(e) => setName(e.target.value)} />
        </label>
      ) : null}
      <label className={cls('formField', 'atlas-field')}>
        <span className={cls('formFieldLabel', 'atlas-field-label')}>{L.email}</span>
        <input className={cls('formFieldInput', 'atlas-input')} type="email" value={email} autoComplete="email" onChange={(e) => setEmail(e.target.value)} />
      </label>
      {requireConsent ? (
        <label className={cls('formField', 'atlas-field')}>
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> {L.consent}
        </label>
      ) : null}
      {/* Honeypot: hidden from people, filled by bots. */}
      <input
        aria-hidden="true"
        tabIndex={-1}
        autoComplete="off"
        name="website"
        value={website}
        onChange={(e) => setWebsite(e.target.value)}
        style={{ position: 'absolute', left: '-10000px', width: 1, height: 1, opacity: 0 }}
      />
      {error ? (
        <p className={cls('formFieldError', 'atlas-error')} role="alert">
          {error}
        </p>
      ) : null}
      <button className={cls('formButtonPrimary', 'atlas-button')} type="submit" disabled={state === 'busy' || (requireConsent && !consent)}>
        {L.submit}
      </button>
    </form>
  );
}
