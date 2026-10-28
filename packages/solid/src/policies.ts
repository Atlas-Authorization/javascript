import { createEffect, onCleanup } from 'solid-js';
import { render } from 'solid-js/web';
import {
  FapiClient,
  PolicyGateController,
  formatPolicyDate,
  injectPolicyStyles,
  joinTitles,
  mountPolicyAcceptStep,
  policyTranslator,
  type MountedPolicyStep,
  type PolicyAcceptanceController,
  type PolicyT,
} from '@atlasauth/js';
import type { AtlasClient } from './provider';
import { ATLAS_SOLID_SDK } from './version';

/**
 * Policy acceptance (terms, privacy, any policy) — the Solid half. `<SignUp>` and
 * `<SignIn>` use the helpers here themselves; `<PolicyGate>` is the in-app
 * re-acceptance banner. The state machine and DOM come from `@atlasauth/js`.
 */

/** The policy UI's translator: the client's `localization` bundle, else the English policy strings. */
export function policyText(client: AtlasClient, fallback: (key: string, vars?: Record<string, string>) => string): PolicyT {
  const bundle = client.localization as Record<string, unknown> | undefined;
  return policyTranslator((key, vars = {}) => {
    const own = bundle?.[key];
    if (typeof own === 'string' && own.trim()) return own.replace(/\{(\w+)\}/g, (m, n: string) => vars[n] ?? m);
    return fallback(key, vars);
  });
}

/** An element the vanilla policy UI draws into, mounted once it is in the document and destroyed with the Solid scope. */
export function policyHost(tag: 'div' | 'p', mount: (el: HTMLElement) => { destroy(): void }): HTMLElement {
  const el = document.createElement(tag);
  let mounted: { destroy(): void } | null = null;
  queueMicrotask(() => {
    injectPolicyStyles(el.ownerDocument);
    mounted = mount(el);
  });
  onCleanup(() => mounted?.destroy());
  return el;
}

/** Everything `<PolicyGate>` needs from the client's own FAPI settings. */
function gateFor(client: AtlasClient): PolicyGateController {
  return new PolicyGateController(
    new FapiClient({ publishableKey: client.publishableKey, baseUrl: client.frontendApi, locale: client.locale, sdk: ATLAS_SOLID_SDK }),
    client.locale ?? undefined,
  );
}

function GateView(client: AtlasClient): HTMLElement {
  const root = document.createElement('div');
  const gate = gateFor(client);
  const t = policyText(client, (key, vars = {}) => key.replace(/\{(\w+)\}/g, (m, n: string) => vars[n] ?? m));
  let step: MountedPolicyStep | null = null;
  let controller: PolicyAcceptanceController | null = null;
  let error = '';

  const draw = () => {
    step?.destroy();
    step = null;
    root.textContent = '';
    if (controller) {
      const card = document.createElement('div');
      card.className = 'atlas-card';
      card.setAttribute('data-atlas-policy-gate', '');
      const host = document.createElement('div');
      card.append(host);
      if (error) {
        const p = document.createElement('p');
        p.className = 'atlas-error';
        p.setAttribute('role', 'alert');
        p.textContent = error;
        card.append(p);
      }
      root.append(card);
      const active = controller;
      step = mountPolicyAcceptStep(host, active, {
        t,
        onSubmit: async () => {
          step?.setBusy(true);
          const res = await gate.accept(active);
          step?.setBusy(false);
          if (!res.ok) {
            error = res.errors[0]?.message ?? t('policy.requiredGeneric');
            draw();
            return;
          }
          controller = null;
          error = '';
          draw();
        },
        onDecline: () => {
          controller = null;
          draw();
        },
      });
      return;
    }
    if (gate.pending.length === 0) return;
    const banner = document.createElement('div');
    banner.className = 'atlas-policy-banner';
    banner.setAttribute('role', 'status');
    banner.setAttribute('data-atlas-policy-banner', '');
    const text = document.createElement('span');
    const strong = document.createElement('strong');
    strong.textContent = `${t('policy.bannerTitle')}. `;
    const grace = gate.graceEndsAt;
    text.append(
      strong,
      t('policy.bannerBody', { policies: joinTitles(gate.pending.map((p) => p.title), t('policy.and')) }) +
        (grace ? ` ${t('policy.bannerGrace', { date: formatPolicyDate(grace) })}` : ''),
    );
    const review = document.createElement('button');
    review.type = 'button';
    review.className = 'atlas-link';
    review.textContent = t('policy.bannerReview');
    review.addEventListener('click', () => {
      void gate.begin().then((c) => {
        controller = c;
        draw();
      });
    });
    banner.append(text, review);
    root.append(banner);
  };

  injectPolicyStyles(document);
  const off = gate.subscribe(draw);
  createEffect(() => {
    if (client.state.status === 'signed_in') void gate.load();
  });
  onCleanup(() => {
    off();
    step?.destroy();
  });
  return root;
}

/** Mount the in-app re-acceptance banner (the client's `mountPolicyGate` seam). */
export function mountPolicyGateWidget(client: AtlasClient, el: HTMLElement): () => void {
  return render(() => GateView(client), el);
}
