/**
 * `@atlasauth/actions` — the typed SDK, local test harness and template gallery
 * for Atlas Actions (tenant code run at fixed points in the auth pipeline). The
 * Atlas peer of `@auth0/actions` + `@kilterset/auth0-actions-testing`.
 *
 * - Author:  `defineAction(trigger, (event, api) => { ... })`
 * - Test:    `runAction(action, createTestEvent(trigger, overrides))`
 * - Deploy:  `action.toCode()`  (what `atlas actions deploy` uploads)
 * - Gallery: `import { templates } from '@atlasauth/actions/templates'`
 */
export * from './types';
export * from './harness';
export { templates, getTemplate, type TemplateEntry } from './templates';
