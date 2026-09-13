# @atlas/angular

The official **Angular** SDK for Atlas — the Angular peer of [`@atlas/react`](../react). It wraps the framework-agnostic [`@atlas/js`](../js) client and exposes Atlas's reactive auth state, sign-in/up flows, prebuilt UI, authorization directives, and route guards as idiomatic modern Angular (standalone APIs, RxJS **and** Signals, DI).

Requires **Angular 17+**.

---

## Install

```bash
pnpm add @atlas/angular
# peers: @angular/core, @angular/common (>=17), rxjs (>=7); @angular/router if you use the guards
```

## Setup

### Standalone (recommended, Angular 17+)

`provideAtlas` is the analogue of wrapping your tree in React's `<AtlasProvider>`. Register it once at the application root:

```ts
import { bootstrapApplication } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { provideAtlas } from '@atlas/angular';
import { AppComponent } from './app/app.component';
import { routes } from './app/routes';

bootstrapApplication(AppComponent, {
  providers: [
    provideAtlas({
      publishableKey: 'pk_test_…',
      // frontendApi: 'https://fapi.your-instance.atlasauth.net', // omit for same-origin
      // appearance: { baseTheme: 'dark', elements: { formButtonPrimary: 'rounded-xl' } },
      // localization: myCatalog,
    }),
    provideRouter(routes),
  ],
});
```

The service begins booting immediately — completing any OAuth/hosted-page redirect, scrubbing the URL, and reading the session — exactly as the React provider does on first render.

### NgModule

```ts
import { AtlasModule } from '@atlas/angular';

@NgModule({
  imports: [AtlasModule.forRoot({ publishableKey: 'pk_test_…' })],
})
export class AppModule {}
```

Feature modules `import { AtlasModule }` (no `forRoot`) to use the directives and components. Standalone components import them individually, or spread `ATLAS_UI`:

```ts
import { ATLAS_UI } from '@atlas/angular';

@Component({ standalone: true, imports: [...ATLAS_UI], template: '…' })
export class DashboardComponent {}
```

---

## `AtlasService`

Injectable, `providedIn: 'root'`. The Angular peer of `<AtlasProvider>` + the React hooks. Exposes state twice so you can pick your idiom.

**RxJS observables** (the primary API):

```ts
export class HeaderComponent {
  private atlas = inject(AtlasService);

  user$        = this.atlas.user$;         // Observable<AtlasUser | null>
  session$     = this.atlas.session$;      // Observable<AtlasSession | null>
  isSignedIn$  = this.atlas.isSignedIn$;   // Observable<boolean>
  isLoaded$    = this.atlas.isLoaded$;
  claims$      = this.atlas.claims$;
  memberships$ = this.atlas.memberships$;
  organization$= this.atlas.organization$;
}
```

**Signals** (same values, for templates / `computed()`):

```ts
this.atlas.user();        // Signal<AtlasUser | null>
this.atlas.isSignedIn();  // Signal<boolean>
this.atlas.status();      // 'loading' | 'signed_in' | 'signed_out'
```

**Methods** (mirror the React hooks' actions):

| Method | Mirrors |
| --- | --- |
| `getToken(): Promise<string \| null>` | `useAuth().getToken` — always fresh; refreshes if within 5s of expiry |
| `getProviderToken(provider): Promise<ProviderToken \| null>` | `useUser().getProviderToken` — the user's own live token at a connected provider |
| `has(condition): boolean` | `useAuth().has` — imperative permission check |
| `signOut(): Promise<void>` | `useAuth().signOut` |
| `setActiveOrganization(orgId \| null)` | `useOrganization().setActive` |
| `reload(): Promise<void>` | re-read `/v1/client` |

The session JWT lives only in memory (a `TokenCache`); the refresh token is HttpOnly and never touched by script. Refresh is proactive and jittered off the token's own expiry.

---

## Directives

All standalone. Structural directives mirror React's `components.tsx`:

```html
<!-- render only when signed in (after boot) — React <SignedIn> -->
<div *atlasSignedIn>Welcome back</div>

<!-- render only when signed out — React <SignedOut> -->
<atlas-sign-in *atlasSignedOut></atlas-sign-in>

<!-- boot-state helpers — React <AtlasLoading> / <AtlasLoaded> -->
<app-spinner *atlasLoading></app-spinner>
<main *atlasLoaded>…</main>

<!-- permission-gated rendering — React <Protect permission="…"> -->
<button *atlasProtect="{ permission: 'org:sys_memberships:manage' }">Invite</button>

<!-- with a fallback (identical microsyntax to *ngIf … else) -->
<div *atlasProtect="{ role: 'admin' }; else denied">Admin tools</div>
<ng-template #denied>You lack access.</ng-template>
```

`*atlasProtect` is a **rendering** helper, never an authorization boundary — the server checking the same permission is what actually stops a request. An empty condition (`*atlasProtect`) means simply "signed in".

**Theming host** — apply the appearance tokens as `--atlas-*` CSS variables (React does this via the provider's wrapping `<div class="atlas-root">`):

```html
<div atlasRoot>
  <router-outlet></router-outlet>
</div>
```

## Components

Server-driven, rendered in the host DOM (no iframe), themed via the `appearance` option:

| Selector | Mirrors |
| --- | --- |
| `<atlas-sign-in>` | `<SignIn/>` |
| `<atlas-sign-up>` | `<SignUp/>` |
| `<atlas-user-button>` | `<UserButton/>` |
| `<atlas-organization-switcher>` | `<OrganizationSwitcher/>` |
| `<atlas-user-profile>` | `<UserProfile/>` |
| `<atlas-organization-profile>` | `<OrganizationProfile/>` |

`<atlas-sign-in>` / `<atlas-sign-up>` run the full multi-step flow (identifier → first factor → 2FA / enrollment → email code → completion, plus magic-link polling), driven entirely by the server-side attempt status through the shared `@atlas/js` engine.

---

## Route guards

`atlasGuard` gates a route on session, and optionally on a permission/role — the router equivalent of fencing a page with `<SignedIn>` / `<Protect>`. It waits for boot to settle first, so a hard refresh onto a protected URL doesn't bounce to sign-in prematurely.

```ts
import { Routes } from '@angular/router';
import { atlasGuard } from '@atlas/angular';

export const routes: Routes = [
  {
    path: 'dashboard',
    canActivate: [atlasGuard({ redirectTo: '/sign-in' })],
    loadComponent: () => import('./dashboard.component').then((m) => m.DashboardComponent),
  },
  {
    path: 'admin',
    canActivate: [atlasGuard({ permission: 'org:admin', redirectTo: '/' })],
    loadComponent: () => import('./admin.component').then((m) => m.AdminComponent),
  },
];
```

With `redirectTo` set the guard returns a `UrlTree` (redirect, with the attempted URL preserved as `redirect_url`); without it, it returns `false`. `atlasChildGuard` is the `CanActivateChild` form.

Like the components, guards are UX, not security — the server enforces the same checks on every request.

---

## Theming & i18n

`appearance` accepts design tokens + per-element class overrides and a `baseTheme` (`default`, `dark`, `neobrutalist`); overrides are **appended** to the base classes so your Tailwind/CSS just works. `localization` merges a catalog over `en-US`. Both are identical in shape to `@atlas/react` — see `appearance.ts` and `i18n.ts`, which are shared verbatim.

## Build & test

- **Build**: `pnpm --filter @atlas/angular build` (ng-packagr → `dist/`, an Angular Package Format bundle with FESM2022 + type definitions).
- **Typecheck**: `pnpm --filter @atlas/angular typecheck`.
- **Test**: unit specs run under the Angular CLI test runner (Karma/Jasmine or your configured runner). A starter spec lives in `src/lib/atlas.service.spec.ts`.
