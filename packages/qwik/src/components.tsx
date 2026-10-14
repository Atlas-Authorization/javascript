import { component$, useSignal, useVisibleTask$ } from '@builder.io/qwik';
import { useAtlas } from './context';
import { mountAtlasWidget } from './widget';

/**
 * The mountable widget components and the user button.
 *
 * `<SignIn>` / `<SignUp>` are the peer of React's `<SignIn/>` and Vue's — but
 * where those re-implement the flow in their own render tree, the Qwik versions
 * mount the framework-agnostic `@atlasauth/embed` DOM widget into a ref'd element
 * from a client-only `useVisibleTask$`, and tear it down on cleanup. Mounting a
 * real DOM widget (rather than re-authoring the flow as Qwik JSX) sidesteps the
 * serialization boundary entirely: the widget is plain DOM the optimizer never
 * has to resume.
 *
 * `<UserButton>` has no DOM-widget counterpart in `@atlasauth/embed`, so it is a
 * small native Qwik component rendered from the reactive store — the same shape
 * as Vue's `UserButton`.
 */

export interface SignInProps {
  /** Where to send the user once the flow completes. */
  redirect?: string;
}

export const SignIn = component$<SignInProps>((props) => {
  const store = useAtlas();
  const hostRef = useSignal<HTMLElement>();

  // eslint-disable-next-line qwik/no-use-visible-task -- the widget is DOM the
  // optimizer must not resume; it mounts client-side only.
  useVisibleTask$(({ cleanup }) => {
    const host = hostRef.value;
    if (!host) return;
    const teardown = mountAtlasWidget(host, 'sign-in', {
      publishableKey: store.publishableKey,
      frontendApi: store.frontendApi,
      redirect: props.redirect,
    });
    cleanup(teardown);
  });

  return <div class="atlas-sign-in" ref={hostRef} />;
});

export const SignUp = component$<SignInProps>((props) => {
  const store = useAtlas();
  const hostRef = useSignal<HTMLElement>();

  // eslint-disable-next-line qwik/no-use-visible-task -- see <SignIn>.
  useVisibleTask$(({ cleanup }) => {
    const host = hostRef.value;
    if (!host) return;
    const teardown = mountAtlasWidget(host, 'sign-up', {
      publishableKey: store.publishableKey,
      frontendApi: store.frontendApi,
      redirect: props.redirect,
    });
    cleanup(teardown);
  });

  return <div class="atlas-sign-up" ref={hostRef} />;
});

export const UserButton = component$(() => {
  const store = useAtlas();
  const open = useSignal(false);

  const u = store.user;
  if (!u) return <>{null}</>;

  const label = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || '';

  return (
    <div class="atlas-user-button">
      <button
        class="atlas-avatar"
        aria-expanded={open.value}
        onClick$={() => {
          open.value = !open.value;
        }}
      >
        {u.image_url ? <img alt="" src={u.image_url} /> : <span>{label.slice(0, 1)}</span>}
      </button>
      {open.value ? (
        <div class="atlas-menu" role="menu">
          <span class="atlas-menu-item">{label}</span>
          <button
            class="atlas-menu-item"
            onClick$={() => {
              // `store` is serializable; the live client is read at click time.
              void store.client?.signOut();
            }}
          >
            Sign out
          </button>
        </div>
      ) : null}
    </div>
  );
});
