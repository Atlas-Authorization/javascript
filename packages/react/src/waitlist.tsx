import { useCallback, useState } from 'react';
import { useClass, useClasses, useMeClient, useText } from './components-shared';

/**
 * Clerk-parity `useWaitlist()`. Headless join: `join(email)` posts the address to
 * the waitlist endpoint and hands back the raw {@link FapiClient} response, so a
 * caller rendering its own form decides what to show on success vs. failure.
 */
export function useWaitlist() {
  const client = useMeClient();
  const join = useCallback(
    (email: string) => client.post('/v1/client/waitlist', { email_address: email }),
    [client],
  );
  return { join };
}

/**
 * Clerk-parity `<Waitlist>`. An email-and-submit card (styled like `<SignUp>`)
 * that calls {@link useWaitlist}. A 200 swaps the form for a success message; any
 * other response surfaces the server's message as a field error, so a bad or
 * duplicate address is reported in place rather than silently swallowed.
 */
export function Waitlist() {
  const { join } = useWaitlist();
  const t = useText();
  const cardClass = useClass('card', 'atlas-card');
  const cls = useClasses();
  const titleClass = useClass('headerTitle', 'atlas-title');
  const inputClass = useClass('formFieldInput', 'atlas-input');
  const buttonClass = useClass('formButtonPrimary', 'atlas-button');
  const errorClass = useClass('formFieldError', 'atlas-error');

  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [joined, setJoined] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    const res = await join(email);
    setBusy(false);
    if (res.ok) {
      setJoined(true);
      return;
    }
    setError(res.errors[0]?.message ?? t('error.generic'));
  };

  return (
    <form
      className={cardClass}
      data-atlas="waitlist"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h1 className={titleClass}>{t('waitlist.title')}</h1>
      {joined ? (
        <p className={cls('text', 'atlas-text')} data-atlas="waitlist-success">{t('waitlist.success')}</p>
      ) : (
        <>
          <label className={cls('formField', 'atlas-field')}>
            <span className={cls('formFieldLabel', 'atlas-field-label')}>{t('waitlist.emailLabel')}</span>
            <input
              className={inputClass}
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
            {error ? (
              <span className={errorClass} role="alert">
                {error}
              </span>
            ) : null}
          </label>
          <button className={buttonClass} type="submit" disabled={busy}>
            {t('waitlist.submit')}
          </button>
        </>
      )}
    </form>
  );
}
