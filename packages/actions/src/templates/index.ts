/**
 * The Atlas Actions template gallery — ready-to-use actions a tenant can drop
 * in and deploy, the Atlas peer of the Auth0 Actions marketplace. Each entry is
 * a typed {@link DefinedAction} with a one-line description; `toCode()` on any
 * of them produces the deployable script for `atlas actions deploy`.
 */
import type { ActionTrigger, AnyDefinedAction } from '../types';
import * as allowlist from './enforce-email-domain-allowlist';
import * as disposable from './block-disposable-emails';
import * as roles from './add-roles-to-token';
import * as enrich from './enrich-profile-from-secrets';
import * as ip from './restrict-signin-by-ip';

/** One gallery entry: a stable slug, a title, its trigger, and the action. */
export interface TemplateEntry {
  /** Stable kebab-case id (also the source filename). */
  slug: string;
  /** Human title for a picker. */
  title: string;
  /** One-line description. */
  description: string;
  /** The trigger the action binds to. */
  trigger: ActionTrigger;
  /** The defined action (handler + `toCode()`). */
  action: AnyDefinedAction;
}

export const templates: TemplateEntry[] = [
  {
    slug: 'enforce-email-domain-allowlist',
    title: 'Enforce email-domain allowlist',
    description: allowlist.description,
    trigger: allowlist.action.trigger,
    action: allowlist.action as AnyDefinedAction,
  },
  {
    slug: 'block-disposable-emails',
    title: 'Block disposable emails',
    description: disposable.description,
    trigger: disposable.action.trigger,
    action: disposable.action as AnyDefinedAction,
  },
  {
    slug: 'add-roles-to-token',
    title: 'Add roles to token',
    description: roles.description,
    trigger: roles.action.trigger,
    action: roles.action as AnyDefinedAction,
  },
  {
    slug: 'enrich-profile-from-secrets',
    title: 'Enrich profile from secrets',
    description: enrich.description,
    trigger: enrich.action.trigger,
    action: enrich.action as AnyDefinedAction,
  },
  {
    slug: 'restrict-signin-by-ip',
    title: 'Restrict sign-in by IP',
    description: ip.description,
    trigger: ip.action.trigger,
    action: ip.action as AnyDefinedAction,
  },
];

/** Look up a template by its slug. */
export function getTemplate(slug: string): TemplateEntry | undefined {
  return templates.find((t) => t.slug === slug);
}
