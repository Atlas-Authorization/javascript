'use client';

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import {
  PolicyAcceptanceController,
  acceptMyPolicies,
  controllerForPending,
  formatPolicyDate,
  loadMyPolicies,
  loadPolicies,
  joinTitles,
  observeScrollEnd,
  policyHtml,
  policyTranslator,
  sanitizePolicyHtml,
  splitTemplate,
  trapFocus,
  type FieldError,
  type MyPolicyStatus,
  type Policy,
  type PolicyAcceptancePayload,
  type PolicySnapshot,
} from '@atlasauth/js';
import { useAtlas } from './AtlasProvider';
import { useClass, useClasses, useFapiClient, useText } from './components-shared';
import type { FapiClient } from './fapi';

/**
 * Policy acceptance (terms of service, privacy, any policy) — the React half.
 *
 * `<SignUp/>` and `<SignIn/>` use these themselves; they are exported for
 * custom forms and for in-app re-acceptance:
 *  - {@link usePolicies}: load the instance's policies into a controller;
 *  - {@link PolicyConsent} / {@link PolicyClickwrap}: the checkbox block (with
 *    an in-page document viewer) and the clickwrap sentence;
 *  - {@link PolicyModal}: the unskippable scroll-to-accept dialog;
 *  - {@link PolicyGate}: a signed-in banner for policies that need
 *    re-acceptance, opening the modal / checkboxes on demand.
 */

/** A translator over the catalog that falls back to the English policy strings. */
export function usePolicyText() {
  const t = useText();
  return useMemo(() => policyTranslator((key, vars) => t(key, vars)), [t]);
}

/** Subscribe a component to a controller's state. */
export function usePolicyState(controller: PolicyAcceptanceController): PolicySnapshot {
  const cache = useRef<{ key: string; snap: PolicySnapshot } | null>(null);
  const get = useCallback(() => {
    const snap = controller.snapshot();
    const key = `${snap.viewing}|${snap.combinedChecked}|${snap.policies.map((p) => `${p.key}:${p.versionId}:${controller.isChecked(p.key)}`).join(',')}`;
    if (cache.current?.key === key) return cache.current.snap;
    cache.current = { key, snap };
    return snap;
  }, [controller]);
  return useSyncExternalStore((cb) => controller.subscribe(cb), get, get);
}

export interface UsePoliciesOptions {
  /** One checkbox for all checkbox-mode policies (default) or one each. */
  combined?: boolean;
  /** Only the policies that also apply at sign-in (`sign_in_and_sign_up`). */
  signIn?: boolean;
  /** Skip loading (e.g. the instance has no policies). */
  enabled?: boolean;
}

export interface UsePoliciesResult {
  /** The state machine behind the policy UI; pass it to {@link PolicyConsent}. */
  controller: PolicyAcceptanceController;
  policies: Policy[];
  loading: boolean;
  /** Re-fetch (after a 422 `POLICY_ACCEPTANCE_REQUIRED`, say). */
  refresh(): Promise<void>;
  /** The `policy_acceptances` body for the current ticks. */
  build(): PolicyAcceptancePayload[];
}

/**
 * Load the instance's policies (`GET /v1/client/policies`) into a controller.
 * Resolves to an empty list when the instance defines none — render nothing.
 */
export function usePolicies(options: UsePoliciesOptions = {}, clientOverride?: FapiClient): UsePoliciesResult {
  const own = useFapiClient();
  const client = clientOverride ?? own;
  const { locale } = useAtlas();
  const enabled = options.enabled !== false;
  const controller = useMemo(() => new PolicyAcceptanceController([], { combined: options.combined }), [options.combined]);
  const [loading, setLoading] = useState(enabled);
  const refresh = useCallback(async () => {
    const list = await loadPolicies(client, { locale: locale ?? undefined, signIn: options.signIn });
    controller.setPolicies(list);
    setLoading(false);
  }, [client, controller, locale, options.signIn]);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void loadPolicies(client, { locale: locale ?? undefined, signIn: options.signIn }).then((list) => {
      if (!alive) return;
      controller.setPolicies(list);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [client, controller, enabled, locale, options.signIn]);
  const state = usePolicyState(controller);
  return { controller, policies: state.policies, loading, refresh, build: () => controller.build() };
}

function PolicyContent({ policy, onEnd }: { policy: Policy; onEnd?: () => void }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLSpanElement>(null);
  const html = useMemo(() => sanitizePolicyHtml(policyHtml(policy)), [policy]);
  const cls = useClass('text', 'atlas-policy-body');
  useEffect(() => {
    if (!onEnd || !bodyRef.current) return;
    return observeScrollEnd(bodyRef.current, sentinelRef.current, onEnd);
  }, [html, onEnd]);
  return (
    <div ref={bodyRef} className={cls} tabIndex={0} role="region" aria-label={policy.title} data-atlas-policy-content="">
      <div dangerouslySetInnerHTML={{ __html: html }} />
      <span ref={sentinelRef} className="atlas-policy-sentinel" aria-hidden="true" data-atlas-policy-end="" />
    </div>
  );
}

/** The in-page document viewer: the exact version the user is agreeing to. */
export function PolicyViewer({ policy, controller }: { policy: Policy; controller: PolicyAcceptanceController }) {
  const t = usePolicyText();
  const cls = useClasses();
  const onEnd = useCallback(() => controller.markScrolledToEnd(policy.key), [controller, policy.key]);
  const meta = [
    policy.version ? t('policy.version', { version: policy.version }) : '',
    policy.effectiveAt ? t('policy.effective', { date: formatPolicyDate(policy.effectiveAt) }) : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <div className="atlas-policy-viewer" role="region" aria-label={policy.title} data-atlas-policy-viewer={policy.key}>
      <div className="atlas-policy-viewer-head">
        <strong>{policy.title}</strong>
        <button type="button" className={cls('link', 'atlas-policy-link')} data-atlas-policy-back="" onClick={() => controller.closeDocument()}>
          {t('policy.viewerBack')}
        </button>
      </div>
      {meta ? <p className="atlas-policy-meta">{meta}</p> : null}
      <PolicyContent policy={policy} onEnd={onEnd} />
    </div>
  );
}

function PolicyLink({ policy, controller }: { policy: Policy; controller: PolicyAcceptanceController }) {
  const cls = useClasses();
  return (
    <button
      type="button"
      className={cls('link', 'atlas-policy-link')}
      data-atlas-policy-open={policy.key}
      aria-haspopup="dialog"
      onClick={() => controller.openDocument(policy.key)}
    >
      {policy.title}
    </button>
  );
}

function Sentence({ template, name, nodes, and }: { template: string; name: string; nodes: ReactNode[]; and: string }) {
  const [before, after] = splitTemplate(template, name);
  return (
    <>
      {before}
      {nodes.map((node, i) => (
        <span key={i}>
          {i > 0 ? (i === nodes.length - 1 ? ` ${and} ` : ', ') : null}
          {node}
        </span>
      ))}
      {after}
    </>
  );
}

/**
 * The checkbox-mode policies: one combined checkbox ("I agree to the Terms of
 * Service and Privacy Policy") or one each, the names opening the in-page
 * viewer. While a document is open it replaces the checkboxes.
 */
export function PolicyConsent({ controller, errors = [] }: { controller: PolicyAcceptanceController; errors?: FieldError[] }) {
  const t = usePolicyText();
  const cls = useClasses();
  const state = usePolicyState(controller);
  const id = useId();
  const viewing = state.viewing ? state.policies.find((p) => p.key === state.viewing) : null;
  if (viewing) return <PolicyViewer policy={viewing} controller={controller} />;
  const boxes = state.policies.filter((p) => p.display === 'checkbox');
  if (boxes.length === 0) return null;
  const and = t('policy.and');
  return (
    <div className="atlas-policy-consent" data-atlas-policies="">
      {controller.combined ? (
        <div className="atlas-policy-row atlas-consent">
          <input
            id={`${id}-all`}
            type="checkbox"
            name="policies"
            data-atlas-policy-all=""
            checked={state.combinedChecked}
            onChange={(e) => controller.setAllChecked(e.target.checked)}
          />
          <label htmlFor={`${id}-all`} className={cls('text', 'atlas-text')}>
            <Sentence template={t('policy.agreeCombined')} name="policies" and={and} nodes={boxes.map((p) => <PolicyLink key={p.key} policy={p} controller={controller} />)} />
          </label>
        </div>
      ) : (
        boxes.map((p) => {
          const [before, after] = splitTemplate(t('policy.agreeOne'), 'policy');
          return (
            <div key={p.key} className="atlas-policy-row atlas-consent">
              <input
                id={`${id}-${p.key}`}
                type="checkbox"
                name={`policy_${p.key}`}
                data-atlas-policy-box={p.key}
                checked={controller.isChecked(p.key)}
                onChange={(e) => controller.setChecked(p.key, e.target.checked)}
              />
              <label htmlFor={`${id}-${p.key}`} className={cls('text', 'atlas-text')}>
                {before}
                <PolicyLink policy={p} controller={controller} />
                {after}
              </label>
            </div>
          );
        })
      )}
      {errors
        .filter((e) => e.param === 'policy_acceptances' || e.param === 'consent')
        .map((e) => (
          <span key={e.code} className={cls('formFieldError', 'atlas-error')}>
            {e.message}
          </span>
        ))}
    </div>
  );
}

/** The clickwrap sentence under the submit button for `link`-mode policies. */
export function PolicyClickwrap({ controller }: { controller: PolicyAcceptanceController }) {
  const t = usePolicyText();
  const cls = useClasses();
  const state = usePolicyState(controller);
  const links = state.policies.filter((p) => p.display === 'link');
  if (links.length === 0) return null;
  return (
    <p className={cls('text', 'atlas-policy-clickwrap')} data-atlas-policy-clickwrap="">
      <Sentence template={t('policy.clickwrap')} name="policies" and={t('policy.and')} nodes={links.map((p) => <PolicyLink key={p.key} policy={p} controller={controller} />)} />
    </p>
  );
}

export interface PolicyModalProps {
  policy: Policy;
  /** An updated policy the user already accepted before: shows the summary of changes. */
  reaccept?: boolean;
  controller?: PolicyAcceptanceController;
  onAccept(): void;
  onDecline(): void;
}

/**
 * The unskippable scroll-mode dialog: `role="dialog" aria-modal="true"`, focus
 * trapped, no close button, Escape disabled. Accept enables only once the end of
 * the text has been seen (an IntersectionObserver on an end sentinel) or the
 * text fits; Decline calls `onDecline`.
 */
export function PolicyModal({ policy, reaccept = false, controller, onAccept, onDecline }: PolicyModalProps) {
  const t = usePolicyText();
  const cls = useClasses();
  const uid = useId();
  const modalRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const html = useMemo(() => sanitizePolicyHtml(policyHtml(policy)), [policy]);
  const sentinelRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    setReady(false);
    const body = bodyRef.current;
    if (!body) return;
    return observeScrollEnd(body, sentinelRef.current, () => {
      setReady(true);
      controller?.markScrolledToEnd(policy.key);
    });
  }, [html, controller, policy.key]);

  useEffect(() => {
    const modal = modalRef.current;
    if (!modal) return;
    controller?.startClock(policy.key);
    const release = trapFocus(modal, { initialFocus: bodyRef.current });
    return () => {
      release();
      controller?.stopClock(policy.key);
    };
  }, [controller, policy.key]);

  const titleId = `${uid}-title`;
  const hintId = `${uid}-hint`;
  return (
    <div className="atlas-policy-overlay" data-atlas-policy-modal={policy.key}>
      <div
        ref={modalRef}
        className="atlas-policy-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={hintId}
        tabIndex={-1}
      >
        <h2 id={titleId}>{reaccept && policy.reaccept !== false ? t('policy.reacceptTitle', { policy: policy.title }) : policy.title}</h2>
        {reaccept && policy.reaccept !== false && policy.summaryOfChanges ? (
          <div className="atlas-policy-summary" data-atlas-policy-summary="">
            <strong>{t('policy.summaryTitle')}</strong>
            <span>{policy.summaryOfChanges}</span>
          </div>
        ) : null}
        <div ref={bodyRef} className="atlas-policy-body" tabIndex={0} role="region" aria-label={policy.title} data-atlas-policy-content="">
          <div dangerouslySetInnerHTML={{ __html: html }} />
          <span ref={sentinelRef} className="atlas-policy-sentinel" aria-hidden="true" data-atlas-policy-end="" />
        </div>
        <p id={hintId} className="atlas-policy-hint" aria-live="polite">
          {ready ? '' : t('policy.scrollHint')}
        </p>
        <div className="atlas-policy-actions">
          <button type="button" className={cls('formButtonSecondary', '')} data-atlas-policy-decline="" onClick={onDecline}>
            {t('policy.decline')}
          </button>
          <button
            type="button"
            className={cls('formButtonPrimary', 'atlas-policy-accept')}
            data-atlas-policy-accept=""
            disabled={!ready}
            aria-disabled={!ready}
            onClick={() => ready && onAccept()}
          >
            {t('policy.accept')}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Walk the controller's unread scroll-mode policies one dialog at a time while
 * `running`. `onDone` fires once when the last one is accepted;
 * `onDecline(policy)` when the user declines one.
 */
export function PolicyScrollQueue({
  controller,
  running,
  reaccept = false,
  onDone,
  onDecline,
}: {
  controller: PolicyAcceptanceController;
  running: boolean;
  reaccept?: boolean;
  onDone(): void;
  onDecline(policy: Policy): void;
}) {
  usePolicyState(controller);
  const pending = controller.pendingScroll();
  const policy = running ? pending : null;
  const hadPolicy = useRef(false);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  useEffect(() => {
    if (policy) hadPolicy.current = true;
    // Done only when the queue emptied because the user accepted the last one — not because it stopped (a decline).
    else if (hadPolicy.current && running && pending === null) {
      hadPolicy.current = false;
      doneRef.current();
    } else if (!running) hadPolicy.current = false;
  }, [policy, running, pending]);
  if (!policy) return null;
  return (
    <PolicyModal
      key={policy.versionId}
      policy={policy}
      reaccept={reaccept}
      controller={controller}
      onAccept={() => controller.acceptScroll(policy.key)}
      onDecline={() => onDecline(policy)}
    />
  );
}

/**
 * The sign-in step for a `needs_policy_acceptance` attempt: scroll-mode policies
 * in their dialog, the rest as checkboxes / a clickwrap sentence, then
 * "Accept and continue", which hands the `policy_acceptances` JSON to `onSubmit`.
 */
export function PolicyAcceptStep({
  attempt,
  busy,
  onSubmit,
  onDecline,
}: {
  attempt: { pending_policies?: unknown } | null;
  busy: boolean;
  onSubmit(values: Record<string, string>): void;
  onDecline?(policy: Policy): void;
}) {
  const t = usePolicyText();
  const cls = useClasses();
  const client = useFapiClient();
  const { locale } = useAtlas();
  const [controller, setController] = useState<PolicyAcceptanceController | null>(null);
  useEffect(() => {
    let alive = true;
    void controllerForPending(client, attempt, { locale: locale ?? undefined, combined: true }).then((c) => alive && setController(c));
    return () => {
      alive = false;
    };
  }, [client, attempt, locale]);
  if (!controller) return <p className={cls('text', 'atlas-text')}>{t('policy.loading')}</p>;
  return <PolicyAcceptStepBody controller={controller} busy={busy} onSubmit={onSubmit} onDecline={onDecline} />;
}

function PolicyAcceptStepBody({
  controller,
  busy,
  onSubmit,
  onDecline,
}: {
  controller: PolicyAcceptanceController;
  busy: boolean;
  onSubmit(values: Record<string, string>): void;
  onDecline?(policy: Policy): void;
}) {
  const t = usePolicyText();
  const cls = useClasses();
  const state = usePolicyState(controller);
  const [declined, setDeclined] = useState(false);
  const send = useCallback(() => onSubmit({ policy_acceptances: JSON.stringify(controller.build()) }), [controller, onSubmit]);
  const hasOthers = state.policies.some((p) => p.display !== 'scroll');
  return (
    <div data-atlas-policy-step="">
      <p className={cls('text', 'atlas-text')}>{t('policy.pendingIntro')}</p>
      <PolicyConsent controller={controller} />
      <PolicyClickwrap controller={controller} />
      {hasOthers ? (
        <button type="button" className={cls('formButtonPrimary', 'atlas-button')} data-atlas-policy-continue="" disabled={busy || !controller.canSubmit() || controller.pendingScroll() !== null} onClick={send}>
          {t('policy.submit')}
        </button>
      ) : null}
      <PolicyScrollQueue
        controller={controller}
        running={!declined}
        reaccept
        onDone={() => {
          if (!hasOthers) send();
        }}
        onDecline={(p) => {
          setDeclined(true);
          onDecline?.(p);
        }}
      />
    </div>
  );
}

export interface PolicyGateProps {
  /** Called after the user accepted and the server confirmed. */
  onAccepted?(): void;
  /** Open the unskippable dialog straight away instead of a banner (use when grace has ended). */
  blocking?: boolean;
  children?: ReactNode;
}

/**
 * In-app re-acceptance. For a signed-in user it checks
 * `GET /v1/client/me/policies`; when a policy needs re-acceptance it shows a
 * banner (or, with `blocking`, the dialog at once). Accepting posts to
 * `/v1/client/me/policies/accept`. Renders `children` (if any) always.
 */
export function PolicyGate({ onAccepted, blocking = false, children }: PolicyGateProps) {
  const { status } = useAtlas();
  const client = useFapiClient();
  const t = usePolicyText();
  const cls = useClasses();
  const [pending, setPending] = useState<MyPolicyStatus[]>([]);
  const [controller, setController] = useState<PolicyAcceptanceController | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (status !== 'signed_in') return;
    let alive = true;
    void loadMyPolicies(client).then((all) => {
      if (alive) setPending(all.filter((p) => p.needsReaccept));
    });
    return () => {
      alive = false;
    };
  }, [client, status]);

  const begin = useCallback(async () => {
    const all = await loadPolicies(client, {});
    const wanted = new Set(pending.map((p) => p.key));
    const c = new PolicyAcceptanceController(all.filter((p) => wanted.has(p.key)).map((p) => ({ ...p, required: true })));
    setController(c);
    setOpen(true);
  }, [client, pending]);

  useEffect(() => {
    if (blocking && pending.length > 0 && !controller) void begin();
  }, [blocking, pending, controller, begin]);

  const submit = useCallback(async () => {
    if (!controller) return;
    setBusy(true);
    const res = await acceptMyPolicies(client, controller.build());
    setBusy(false);
    if (!res.ok) {
      setError(res.errors[0]?.message ?? t('policy.requiredGeneric'));
      return;
    }
    setPending([]);
    setOpen(false);
    setController(null);
    onAccepted?.();
  }, [client, controller, onAccepted, t]);

  const titles = pending.map((p) => p.title);
  const soonest = pending.map((p) => p.graceEndsAt).filter((x): x is string => !!x).sort()[0];
  return (
    <>
      {pending.length > 0 && !open ? (
        <div className={cls('alert', 'atlas-policy-banner')} role="status" data-atlas-policy-banner="">
          <span>
            <strong>{t('policy.bannerTitle')}. </strong>
            {t('policy.bannerBody', { policies: joinTitles(titles, t('policy.and')) })}
            {soonest ? ` ${t('policy.bannerGrace', { date: formatPolicyDate(soonest) })}` : ''}
          </span>
          <button type="button" className={cls('link', 'atlas-policy-link')} onClick={() => void begin()}>
            {t('policy.bannerReview')}
          </button>
        </div>
      ) : null}
      {open && controller ? (
        <PolicyGateDialog controller={controller} busy={busy} error={error} onSubmit={() => void submit()} onCancel={() => { setOpen(false); setController(null); }} blocking={blocking} />
      ) : null}
      {children}
    </>
  );
}

function PolicyGateDialog({
  controller,
  busy,
  error,
  onSubmit,
  onCancel,
  blocking,
}: {
  controller: PolicyAcceptanceController;
  busy: boolean;
  error: string;
  onSubmit(): void;
  onCancel(): void;
  blocking: boolean;
}) {
  const t = usePolicyText();
  const cls = useClasses();
  const state = usePolicyState(controller);
  const hasOthers = state.policies.some((p) => p.display !== 'scroll');
  return (
    <>
      {hasOthers ? (
        <div className={cls('card', 'atlas-card')} data-atlas-policy-gate="">
          <PolicyConsent controller={controller} />
          <PolicyClickwrap controller={controller} />
          {error ? <p className={cls('formFieldError', 'atlas-error')} role="alert">{error}</p> : null}
          <button type="button" className={cls('formButtonPrimary', 'atlas-button')} disabled={busy || !controller.canSubmit() || controller.pendingScroll() !== null} onClick={onSubmit}>
            {t('policy.submit')}
          </button>
          {blocking ? null : (
            <button type="button" className={cls('link', 'atlas-link')} onClick={onCancel}>
              {t('policy.decline')}
            </button>
          )}
        </div>
      ) : null}
      <PolicyScrollQueue
        controller={controller}
        running
        reaccept
        onDone={() => {
          if (!hasOthers) onSubmit();
        }}
        onDecline={() => {
          if (!blocking) onCancel();
        }}
      />
    </>
  );
}
