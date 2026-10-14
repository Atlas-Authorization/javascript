# @atlasauth/nestjs

Framework-native [NestJS](https://nestjs.com) integration for Atlas — the
server-side twin of `@atlasauth/express` and `@atlasauth/fastify`. It wraps
`@atlasauth/backend`'s **local** session verification (the session JWT is
verified against the instance's in-process-cached JWKS, with no Atlas call on
the request path) in Nest's own primitives, and reads the request generically,
so it works behind both the Express and the Fastify Nest adapters.

## Install

```sh
pnpm add @atlasauth/nestjs
# peers: @nestjs/common @nestjs/core reflect-metadata rxjs
```

## Register

```ts
import { Module } from '@nestjs/common';
import { AtlasModule } from '@atlasauth/nestjs';

@Module({
  imports: [
    AtlasModule.forRoot({
      jwksUrl: 'https://<your-instance>.fapi.atlas.net/.well-known/jwks.json',
      issuer: 'https://<your-instance>.fapi.atlas.net',
    }),
  ],
})
export class AppModule {}
```

`forRootAsync({ useFactory, inject, imports })` builds the same options from
injected config (e.g. a `ConfigService`). The module is global by default.

## Protect routes

```ts
import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import {
  AtlasGuard,
  AtlasAuthGuard,
  Public,
  RequirePermission,
  CurrentUser,
  AtlasAuth,
  type SessionClaims,
  type AuthorizedSession,
} from '@atlasauth/nestjs';

@Controller()
@UseGuards(AtlasGuard) // every route closed by default…
export class AppController {
  @Public() // …except this one
  @Get('health')
  health() {
    return { ok: true };
  }

  @Get('me')
  me(@CurrentUser() user: SessionClaims, @AtlasAuth() auth: AuthorizedSession) {
    return { userId: user.sub, isAdmin: auth.has({ role: 'admin' }) };
  }

  @UseGuards(AtlasAuthGuard)
  @RequirePermission('org:billing:manage')
  @Post('invoices')
  createInvoice() {
    /* reached only when the verified claims hold the permission */
  }
}
```

`AtlasGuard` reads `Authorization: Bearer <jwt>` (or the `__session` cookie),
verifies it, and attaches the verified session to `request.atlas`; it throws
`UnauthorizedException` (401) on a missing/invalid token, unless the handler or
its controller is `@Public()`. `AtlasAuthGuard` adds a `@RequirePermission(...)`
gate that throws `ForbiddenException` (403) when the condition is unmet. To
protect the whole app, provide a guard via `APP_GUARD`.
