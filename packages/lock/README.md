# @atlasauth/lock

A **drop-in, batteries-included** sign-in / sign-up widget for Atlas — the Atlas
peer of Auth0 **Lock**. Add a complete, styled, accessible login modal (or inline
panel) to any page with **one script tag and a few options**. No framework, no
build step required.

It does **not** reimplement auth. Lock _wraps_:

- **[`@atlasauth/embed`](../embed)** — the framework-agnostic sign-in widget that
  drives the shared **[`@atlasauth/js`](../js)** flow machine against FAPI. So
  MFA, step-up, captcha, passkeys, social connections, error handling and session
  exchange all come **for free** and stay identical to the React `<SignIn/>` and
  the hosted pages.
- **[`@atlasauth/themes`](../themes)** — the prebuilt appearance presets, used to
  theme both the modal chrome and the form inside it from one source.

Lock adds only the parts a "lock" needs: a **modal / inline shell**, a
**sign-in / sign-up tab switcher**, a **method allow-list**, **accessibility**
(focus trap, ARIA, keyboard, reduced-motion), and **`onAuthenticated` /
`onError`** callbacks.

---

## One-script quickstart (CDN)

```html
<!-- Opens a modal when any [data-atlas-lock-open] element is clicked -->
<script
  src="https://cdn.atlasauth.net/lock/atlas-lock.min.js"
  data-atlas-key="pk_live_…"
  data-atlas-domain="accounts.yourapp.com"
  data-atlas-theme="dark"
  data-atlas-primary-color="#16a34a"
></script>

<button data-atlas-lock-open>Sign in</button>
```

The bundle defines a global **`AtlasLock`** and, when the script tag carries a
key + domain, a ready-to-use singleton **`window.atlasLock`**. Script-tag
options:

| Attribute                  | Meaning                                              |
| -------------------------- | ---------------------------------------------------- |
| `data-atlas-key`           | Publishable key (`pk_…`) — **required**              |
| `data-atlas-domain`        | Instance frontend API origin — **required**          |
| `data-atlas-theme`         | `base` · `dark` · `midnight` · `neobrutalism` · `shadcn` · `auto` |
| `data-atlas-primary-color` | Accent override, e.g. `#16a34a`                      |
| `data-atlas-screen`        | `sign-in` (default) or `sign-up`                     |
| `data-atlas-redirect`      | Where to go on success                               |
| `data-atlas-logo`          | Logo URL shown in the header                         |
| `data-atlas-title`         | Header title                                         |
| `data-atlas-mount="#el"`   | Render **inline** into `#el` instead of a modal      |
| `data-atlas-auto`          | Open the modal immediately on load                   |

Any element with **`data-atlas-lock-open`** opens the modal on click.

## Programmatic use (bundlers)

```ts
import { AtlasLock } from '@atlasauth/lock';

const lock = new AtlasLock({
  publishableKey: 'pk_live_…',
  domain: 'accounts.yourapp.com',
  options: {
    theme: 'dark',
    methods: ['password', 'social', 'passkey'],
    redirectUrl: '/dashboard',
    onAuthenticated: (session) => console.log('signed in', session),
    onError: (err) => console.warn(err.message),
  },
});

document.querySelector('#login')!.addEventListener('click', () => lock.show());
```

Inline panel instead of a modal:

```ts
new AtlasLock({
  publishableKey: 'pk_live_…',
  domain: 'accounts.yourapp.com',
  container: '#auth',
  options: { display: 'inline' },
}).show();
```

## API

```ts
new AtlasLock(config: AtlasLockConfig)
lock.show(): this          // open the modal / render the inline panel
lock.hide(): this          // tear down the shell, restore focus
lock.switchTo('sign-up')   // switch screen programmatically
lock.whenReady(): Promise<void>  // resolves once the current screen has mounted
lock.destroy(): void
lock.visible: boolean
lock.screen: 'sign-in' | 'sign-up'
```

### `AtlasLockConfig`

| Field            | Type                    | Notes                                                        |
| ---------------- | ----------------------- | ------------------------------------------------------------ |
| `publishableKey` | `string`                | **Required.** `pk_…`                                         |
| `domain`         | `string`                | **Required.** FAPI origin; a bare host is upgraded to https. |
| `frontendApi`    | `string`                | Alias for `domain`.                                          |
| `container`      | `Element \| string`     | Required for `display: 'inline'`.                            |
| `options`        | `AtlasLockOptions`      | See below.                                                   |

### `AtlasLockOptions`

| Option            | Type                                             | Default              | Notes |
| ----------------- | ------------------------------------------------ | -------------------- | ----- |
| `screen`          | `'sign-in' \| 'sign-up'`                         | `'sign-in'`          | Opening screen. |
| `allowSignIn`     | `boolean`                                        | `true`               | |
| `allowSignUp`     | `boolean`                                        | `true`               | |
| `tabs`            | `boolean`                                        | both allowed         | Show the tab switcher. |
| `methods`         | `('password'\|'emailCode'\|'emailLink'\|'social'\|'passkey')[]` | all enabled | Allow-list; hides the buttons/fields for the rest. Never enables a method the instance has off. |
| `display`         | `'modal' \| 'inline'`                            | `'modal'`            | |
| `closable`        | `boolean`                                        | `true`               | Backdrop click / close button / Escape. |
| `redirectUrl`     | `string`                                         | —                    | Validated by the widget (same-origin or https). |
| `preview`         | `boolean`                                        | `false`              | Runs the flow but never creates a session. |
| `theme`           | preset name · `Appearance` · `'auto'`            | `'auto'`             | From `@atlasauth/themes`. |
| `primaryColor`    | `string`                                         | —                    | Accent override, layered over `theme`. |
| `logo`            | `string`                                         | —                    | Header logo. |
| `title`/`subtitle`| `string`                                         | screen name          | Header text. |
| `appearance`      | `WidgetAppearance`                               | —                    | Advanced widget override, merged last. |
| `onAuthenticated` | `(session) => void`                              | —                    | Fired on completion. |
| `onError`         | `(error) => void`                                | —                    | Config problems + surfaced form errors. |
| `onShow`/`onHide`/`onReady` | `() => void`                           | —                    | Lifecycle. |

## Theming

`theme` accepts any `@atlasauth/themes` preset by name, a full `Appearance`
object, or `'auto'` (follow the tenant's own server-side appearance). The theme's
design tokens are mapped onto the widget's token set and applied as CSS variables
to **both** the modal chrome (`--atlas-lock-*`) and the embedded form
(`--atlas-embed-*`), so they always match — including dark themes.

```ts
import { experimental_createTheme, dark } from '@atlasauth/themes';
const brand = experimental_createTheme({ variables: { colorPrimary: '#16a34a' } }, dark);
new AtlasLock({ publishableKey, domain, options: { theme: brand } }).show();
```

## Accessibility

- `role="dialog"` + `aria-modal` + `aria-labelledby`.
- Focus is trapped within the modal (Tab / Shift+Tab cycle), moved in on open and
  **restored** to the trigger on close.
- Escape closes a closable modal; the backdrop and a labelled close button too.
- All transitions are disabled under `prefers-reduced-motion`.

## Outputs

- **ESM** — `dist/index.js` + `dist/index.d.ts` (for bundlers).
- **CDN / IIFE** — `dist/atlas-lock.min.js`, a single self-contained file that
  defines the global `AtlasLock` (all dependencies bundled in).
