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


## Rate limits and grant usage

Two gates sit behind your auth, both built on `@atlasauth/backend`: a rate limiter (`createRateLimiter`, fixed window, 429 with `Retry-After` and `RateLimit-*` headers) and a grant usage gate (`createUsageGate`, which consumes a named counter on a machine or agent grant: 429 when the counter is spent, 403 when the grant is missing or expired). Each wrapper takes the limiter or options, or a check you already built with `rateLimitRequest` / `requireGrantUsage`. A limit store or usage call that throws is an error, never an allow.

Build the limiter and the gate once at startup:

```ts
import { createAtlasClient, createRateLimiter, createUsageGate } from '@atlasauth/backend';

const atlas = createAtlasClient({ secretKey: process.env.ATLAS_SECRET_KEY! });
const limiter = createRateLimiter({ policies: [{ name: 'per-user', subject: 'user', limit: 100, windowSeconds: 60 }] });
const gate = createUsageGate({ client: atlas }); // or { mode: 'lease', leaseSize: 20 }
// atlasGrantUsage({ gate, counter: 'orders', amount: 1 }) spends the grant named by the token's grant_id claim.
```

```ts
@Module({ imports: [AtlasLimitsModule.register({ rateLimit: limiter, grantUsage: { gate, counter: 'orders' } })] })
export class AppModule {}

@UseGuards(AtlasGuard, AtlasRateLimitGuard, AtlasGrantUsageGuard)
@Post('orders')
create() {}
```
A denial throws an `HttpException` carrying the status and body; the `RateLimit-*` headers are set on the response.
