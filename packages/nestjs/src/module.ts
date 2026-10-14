import {
  Inject,
  Module,
  type DynamicModule,
  type InjectionToken,
  type ModuleMetadata,
  type OptionalFactoryDependency,
  type Provider,
} from '@nestjs/common';
import { AtlasBackend, type AtlasBackendOptions } from '@atlasauth/backend';
import { ATLAS_BACKEND } from './constants';
import { AtlasGuard, AtlasAuthGuard } from './guards';

/**
 * Configuration for {@link AtlasModule.forRoot}. The same contract as
 * `@atlasauth/backend`'s `AtlasBackendOptions`: provide exactly one key source
 * (`jwksUrl` to fetch, or a static `jwks` for offline verification) plus the
 * expected `issuer`; `authorizedParties`/`audience`/`secretKey` are optional
 * hardening, and `fetchImpl` is injectable for tests.
 */
export type AtlasModuleOptions = AtlasBackendOptions;

/**
 * Async configuration for {@link AtlasModule.forRootAsync}: build the options
 * from injected config (e.g. a `ConfigService`) via a factory, exactly like
 * Nest's own `forRootAsync` convention.
 */
export interface AtlasModuleAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  useFactory: (...args: never[]) => Promise<AtlasModuleOptions> | AtlasModuleOptions;
  inject?: Array<InjectionToken | OptionalFactoryDependency>;
  /** Register globally (the default) so the verifier and guards resolve app-wide. */
  global?: boolean;
}

/**
 * Shorthand for `@Inject(ATLAS_BACKEND)` — inject the configured verifier into
 * your own provider when you need to verify a token outside a guard.
 *
 * @example
 * constructor(@InjectAtlas() private readonly atlas: AtlasBackend) {}
 */
export const InjectAtlas = (): ParameterDecorator => Inject(ATLAS_BACKEND);

/** The guards every registration provides and exports. */
const GUARDS: Provider[] = [AtlasGuard, AtlasAuthGuard];

/**
 * `AtlasModule` — the framework-native NestJS integration for Atlas.
 *
 * `forRoot`/`forRootAsync` register a single configured `@atlasauth/backend`
 * verifier under the {@link ATLAS_BACKEND} token (local, in-process JWKS
 * verification — no Atlas call on the request path) together with
 * {@link AtlasGuard} and {@link AtlasAuthGuard}. Register once at the root; the
 * module is global by default, so the guards (via `@UseGuards` or `APP_GUARD`)
 * and the verifier resolve anywhere.
 *
 * @example
 * @Module({ imports: [AtlasModule.forRoot({ jwksUrl, issuer })] })
 * export class AppModule {}
 */
@Module({})
export class AtlasModule {
  static forRoot(options: AtlasModuleOptions, config?: { global?: boolean }): DynamicModule {
    const provider: Provider = {
      provide: ATLAS_BACKEND,
      useFactory: () => new AtlasBackend(options),
    };
    return {
      module: AtlasModule,
      global: config?.global ?? true,
      providers: [provider, ...GUARDS],
      exports: [ATLAS_BACKEND, ...GUARDS],
    };
  }

  static forRootAsync(options: AtlasModuleAsyncOptions): DynamicModule {
    const provider: Provider = {
      provide: ATLAS_BACKEND,
      useFactory: async (...args: never[]) => new AtlasBackend(await options.useFactory(...args)),
      // The caller's injection tokens, forwarded verbatim to the factory.
      inject: options.inject ?? [],
    };
    return {
      module: AtlasModule,
      global: options.global ?? true,
      imports: options.imports ?? [],
      providers: [provider, ...GUARDS],
      exports: [ATLAS_BACKEND, ...GUARDS],
    };
  }
}
