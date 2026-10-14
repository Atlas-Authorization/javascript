import { Show, createEffect, createSignal, onCleanup, onMount, type JSX } from 'solid-js';
import { isServer, render } from 'solid-js/web';
import { h } from './h';
import {
  FapiClient,
  advance,
  flowFromPending,
  nextStep,
  pollAttempt,
  shouldKeepPolling,
  type FlowState,
} from '@atlasauth/js';
import { useAtlas } from './context';
import type { AtlasClient } from './provider';

/**
 * The mountable widgets — `<SignIn>`, `<SignUp>`, `<UserButton>`.
 *
 * `@atlasauth/js` ships no DOM widgets (it is the framework-agnostic flow
 * DRIVER: `advance` / `nextStep` / `pollAttempt`, which own the
 * step-to-endpoint mapping in ONE place). So, exactly as `@atlasauth/react` and
 * `@atlasauth/vue` do, the rendered flow lives in the framework binding and is
 * driven by that shared driver — a client that guessed the next step locally is
 * how a password ends up posted to the second-factor endpoint.
 *
 * The public components are deliberately thin: each creates a host element and,
 * in `onMount`, calls the client's `mountX(el)` seam, tearing it down in
 * `onCleanup`. The actual rendering is a nested Solid root (`render`) owned by
 * the client, so the mounted flow can reach the same client's `reload()` /
 * `signOut()` without being inside the component's context.
 */

type FlowErrors = FlowState['errors'];

/** A labelled, UNCONTROLLED input — its value is read from the form's
 * `FormData` on submit, which sidesteps per-keystroke signal churn for a plain
 * auth form. */
function field(name: string, label: string, type = 'text'): JSX.Element {
  return h('label', { class: 'atlas-field' }, [
    h('span', label),
    h('input', { class: 'atlas-input', name, type }),
  ]);
}

/** Form-level (non-field) errors, rendered as an alert. */
function renderErrors(errors: FlowErrors): JSX.Element {
  return errors
    .filter((error) => !error.param)
    .map((error) => h('p', { class: 'atlas-error', role: 'alert' }, error.message));
}

/** The fields for the current server-driven step. The `unknown`/default branch
 * says so out loud rather than rendering a blank box the user cannot act on. */
function renderFields(kind: string): JSX.Element {
  switch (kind) {
    case 'collect_identifier':
      return [field('identifier', 'Email', 'email')];
    case 'collect_first_factor':
      return [field('password', 'Password', 'password')];
    case 'collect_second_factor':
      return [field('code', 'Two-factor code')];
    case 'enroll_second_factor':
      // Two codes, not one: consecutive codes catch a phone with a fast clock
      // here rather than on every sign-in afterwards.
      return [
        field('code', 'Authenticator code'),
        field('secondCode', 'Next authenticator code'),
      ];
    case 'collect_email_code':
      return [field('code', 'Email code')];
    case 'collect_new_password':
      return [field('password', 'New password', 'password')];
    case 'await_oauth':
      return [h('p', 'Continue in the window that opened.')];
    case 'done':
      return [h('p', 'Signed in — you can close this.')];
    default:
      return [h('p', { class: 'atlas-error' }, 'This step needs an updated app. Please reload.')];
  }
}

function renderSubmit(kind: string, busy: boolean): JSX.Element {
  if (kind === 'done' || kind === 'await_oauth') return null;
  return h('button', { class: 'atlas-button', type: 'submit', disabled: busy }, 'Continue');
}

/**
 * The server-driven sign-in / sign-up flow. Never decides what comes next: it
 * drives through `advance` (the driver owns the step→endpoint mapping) and
 * renders whatever `status` the server returned. `<SignIn>` and `<SignUp>` are
 * the same driver — only the title differs, exactly as in React and Vue.
 */
function Flow(props: { client: AtlasClient; title: string }): JSX.Element {
  const client = props.client;
  const fapi = new FapiClient({ publishableKey: client.publishableKey, baseUrl: client.frontendApi });
  // Seeded from a redirect that returned mid-flow (OAuth owing a second
  // factor), so the user resumes at the demanded step instead of restarting.
  const [state, setState] = createSignal<FlowState>(flowFromPending(client.pendingAttempt));

  const submit = (values: Record<string, string>) => {
    void (async () => {
      setState((s) => ({ ...s, busy: true, errors: [] }));
      const next = await advance(fapi, state(), values);
      setState(next);

      // A completion response carries a one-time ticket (§7.1). FAPI is
      // cross-origin to the app and cannot set the cookie on its own response,
      // so exchange the ticket over a request THEN re-boot, so the rest of the
      // app sees a signed-in user — and no session token ever rode in a URL.
      if (next.attempt?.status === 'complete') {
        if (next.ticket) {
          await fapi.post('/v1/client/tickets/exchange', {
            attempt_id: (next.attempt as { id?: string }).id,
            ticket: next.ticket,
          });
        }
        await client.reload();
      }
    })();
  };

  // §5.3 magic-link poll: a sign-in finished on another device. Restart on each
  // state change, run only while the state says to, stop on teardown.
  let poller: ReturnType<typeof setInterval> | null = null;
  const stopPolling = () => {
    if (poller) {
      clearInterval(poller);
      poller = null;
    }
  };
  createEffect(() => {
    const current = state();
    stopPolling();
    if (!shouldKeepPolling(current)) return;
    poller = setInterval(() => {
      void (async () => {
        const { state: next, ticket } = await pollAttempt(fapi, state());
        setState(next);
        if (!ticket || !next.attempt) return;
        await fapi.post('/v1/client/tickets/exchange', {
          attempt_id: (next.attempt as { id?: string }).id,
          ticket,
        });
        await client.reload();
      })();
    }, 2_000);
  });
  onCleanup(stopPolling);

  const step = () => {
    const attempt = state().attempt;
    return attempt ? nextStep(attempt) : ({ kind: 'collect_identifier' } as const);
  };

  return h(
    'form',
    {
      class: 'atlas-card',
      onSubmit: (event: Event) => {
        event.preventDefault();
        const form = event.currentTarget as HTMLFormElement;
        const values: Record<string, string> = {};
        new FormData(form).forEach((value, key) => {
          values[key] = String(value);
        });
        submit(values);
      },
    },
    [
      h('h1', { class: 'atlas-title' }, props.title),
      () => renderErrors(state().errors),
      () => renderFields(step().kind),
      () => renderSubmit(step().kind, state().busy),
    ],
  );
}

/** The signed-in user's avatar + a menu whose only built-in action is sign-out
 * — the Solid peer of Vue's `<UserButton>`. Renders nothing when signed out. */
function UserButtonView(client: AtlasClient): JSX.Element {
  const [open, setOpen] = createSignal(false);
  const user = () => client.state.user;
  const label = () => {
    const u = user();
    if (!u) return '';
    return [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || '';
  };

  return h(
    Show,
    { when: () => Boolean(user()) },
    () =>
      h('div', { class: 'atlas-user-button' }, [
        h(
          'button',
          {
            class: 'atlas-avatar',
            'aria-expanded': () => open(),
            onClick: () => setOpen(!open()),
          },
          () => {
            const u = user();
            return u?.image_url
              ? h('img', { alt: '', src: u.image_url })
              : h('span', () => label().slice(0, 1));
          },
        ),
        () =>
          open()
            ? h('div', { class: 'atlas-menu', role: 'menu' }, [
                h('span', { class: 'atlas-menu-item' }, () => label()),
                h(
                  'button',
                  { class: 'atlas-menu-item', onClick: () => void client.signOut() },
                  'Sign out',
                ),
              ])
            : null,
      ]),
  );
}

// --- Mount seams, called by the client's `mountX` methods. `render` returns the
// disposer that `onCleanup` later invokes to tear the nested root down. ---

export function mountSignInWidget(client: AtlasClient, el: HTMLElement): () => void {
  return render(() => Flow({ client, title: 'Sign in' }), el);
}

export function mountSignUpWidget(client: AtlasClient, el: HTMLElement): () => void {
  return render(() => Flow({ client, title: 'Sign up' }), el);
}

export function mountUserButtonWidget(client: AtlasClient, el: HTMLElement): () => void {
  return render(() => UserButtonView(client), el);
}

// --- The public, thin mountable components. ---

/**
 * Build a component that mounts one widget. It calls the CLIENT's seam
 * (`client.mountSignIn` etc.) rather than the module function directly, so the
 * mounted root reaches the same client the provider built — and so the seam is a
 * real, test-observable boundary. The host element is created imperatively
 * (not via a reactive `ref`) so it is guaranteed present the moment `onMount`
 * fires. SSR renders an empty host and hydrates on the client.
 */
function mountable(
  seam: (client: AtlasClient) => (el: HTMLElement) => () => void,
  rootClass: string,
) {
  return (): JSX.Element => {
    const client = useAtlas();
    if (isServer) return h('div', { class: rootClass });

    const container = document.createElement('div');
    container.className = rootClass;
    onMount(() => {
      // The seam drives a nested Solid root into `container`; its disposer is
      // the whole teardown, so unmounting the component unmounts the widget.
      const dispose = seam(client)(container);
      onCleanup(dispose);
    });
    return container;
  };
}

export const SignIn = mountable((client) => client.mountSignIn, 'atlas-signin-root');
export const SignUp = mountable((client) => client.mountSignUp, 'atlas-signup-root');
export const UserButton = mountable((client) => client.mountUserButton, 'atlas-user-button-root');
