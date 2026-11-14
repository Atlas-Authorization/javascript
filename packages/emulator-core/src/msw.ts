import { http, type HttpHandler } from 'msw';
import type { Engine } from './engine';

export interface CoreHandlersOptions {
  /** The origin your code calls, e.g. `https://api.atlasauth.net`. Every path under it is answered by the engine. */
  baseUrl: string;
}

/**
 * msw handlers backed by the in-memory engine: the same state, validation, tokens and webhooks as the
 * emulator server, in-process. Mount them with `setupServer(...coreHandlers(engine, { baseUrl }))`.
 */
export function coreHandlers(engine: Engine, options: CoreHandlersOptions): HttpHandler[] {
  const base = options.baseUrl.replace(/\/+$/, '');
  return [http.all(`${base}/*`, ({ request }) => engine.handle(request))];
}
