/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Obj } from '../openapi';
import { bad, isObj } from './emu4-shared';
import { validateCookieConsent } from './emu4-cookies';
import { validateMinors } from './emu4-minors';

/**
 * The compliance part of the emulator's instance configuration: validation of a patch (one problem list for the whole patch,
 * like a configuration write) and the merge. Shared by the config helper route and by config snapshot restore.
 */
type Problem = { param: string; message: string };
const LEGAL_BASES = ['consent', 'contract', 'legal_obligation', 'vital_interests', 'public_task', 'legitimate_interests'];
const KEY_RE = /^[a-z][a-z0-9_]{0,47}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateDataPolicy(raw: unknown): Problem[] {
  const p = 'compliance.dataPolicy';
  if (!isObj(raw)) return [{ param: p, message: 'Expected an object.' }];
  const out: Problem[] = [];
  for (const k of Object.keys(raw)) if (!['controller', 'activities'].includes(k)) out.push({ param: `${p}.${k}`, message: 'Unknown field. Expected controller, activities.' });
  if (raw.controller !== undefined) {
    if (!isObj(raw.controller)) out.push({ param: `${p}.controller`, message: 'Expected an object.' });
    else {
      for (const k of Object.keys(raw.controller)) if (!['name', 'contactEmail', 'dpoEmail'].includes(k)) out.push({ param: `${p}.controller.${k}`, message: 'Unknown field.' });
      if (raw.controller.name != null && !(typeof raw.controller.name === 'string' && raw.controller.name.trim() && raw.controller.name.length <= 200)) out.push({ param: `${p}.controller.name`, message: 'Text of at most 200 characters, or null.' });
      for (const k of ['contactEmail', 'dpoEmail'] as const) if (raw.controller[k] != null && (typeof raw.controller[k] !== 'string' || !EMAIL_RE.test(raw.controller[k] as string))) out.push({ param: `${p}.controller.${k}`, message: 'An email address, or null.' });
    }
  }
  if (raw.activities !== undefined) {
    if (!Array.isArray(raw.activities)) out.push({ param: `${p}.activities`, message: 'Expected an array.' });
    else if (raw.activities.length > 100) out.push({ param: `${p}.activities`, message: 'At most 100 processing activities.' });
    else {
      const seen = new Set<string>();
      raw.activities.forEach((a: unknown, i: number) => {
        const at = `${p}.activities.${i}`;
        if (!isObj(a)) return void out.push({ param: at, message: 'Expected an object.' });
        const known = ['key', 'name', 'purpose', 'legalBasis', 'dataCategories', 'dataSubjects', 'recipients', 'transfersTo', 'retentionDays'];
        for (const k of Object.keys(a)) if (!known.includes(k)) out.push({ param: `${at}.${k}`, message: `Unknown field. Expected ${known.join(', ')}.` });
        if (typeof a.key !== 'string' || !KEY_RE.test(a.key)) out.push({ param: `${at}.key`, message: 'A slug: lowercase letters, digits and _, starting with a letter (at most 48).' });
        else if (seen.has(a.key)) out.push({ param: `${at}.key`, message: 'Duplicate activity key.' });
        else seen.add(a.key);
        if (!(typeof a.name === 'string' && a.name.trim() && a.name.length <= 120)) out.push({ param: `${at}.name`, message: 'Required text of at most 120 characters.' });
        if (!(typeof a.purpose === 'string' && a.purpose.trim() && a.purpose.length <= 500)) out.push({ param: `${at}.purpose`, message: 'Required text of at most 500 characters.' });
        if (!LEGAL_BASES.includes(a.legalBasis as string)) out.push({ param: `${at}.legalBasis`, message: `One of ${LEGAL_BASES.join(', ')}.` });
        if (a.transfersTo !== undefined && (!Array.isArray(a.transfersTo) || a.transfersTo.some((x) => typeof x !== 'string' || !/^[A-Z]{2}$/.test(x)))) out.push({ param: `${at}.transfersTo`, message: 'ISO 3166-1 alpha-2 country codes.' });
        if (a.retentionDays != null && !(typeof a.retentionDays === 'number' && Number.isInteger(a.retentionDays) && a.retentionDays >= 1 && a.retentionDays <= 36500)) out.push({ param: `${at}.retentionDays`, message: 'Whole days from 1 to 36500, or null.' });
      });
    }
  }
  return out;
}

function validateInactive(raw: unknown): Problem[] {
  const p = 'compliance.inactiveUsers';
  if (!isObj(raw)) return [{ param: p, message: 'Expected an object.' }];
  const out: Problem[] = [];
  for (const k of Object.keys(raw)) if (!['enabled', 'afterDays', 'warnDays', 'action'].includes(k)) out.push({ param: `${p}.${k}`, message: 'Unknown field. Expected enabled, afterDays, warnDays, action.' });
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') out.push({ param: `${p}.enabled`, message: 'Expected a boolean.' });
  if (raw.afterDays !== undefined && !(typeof raw.afterDays === 'number' && Number.isInteger(raw.afterDays) && raw.afterDays >= 30 && raw.afterDays <= 3650)) out.push({ param: `${p}.afterDays`, message: 'Whole days from 30 to 3650.' });
  if (raw.warnDays !== undefined && !(typeof raw.warnDays === 'number' && Number.isInteger(raw.warnDays) && raw.warnDays >= 0 && raw.warnDays < (typeof raw.afterDays === 'number' ? raw.afterDays : 730))) out.push({ param: `${p}.warnDays`, message: 'Whole days from 0, fewer than afterDays.' });
  if (raw.action !== undefined && !['notify', 'ban', 'schedule_deletion'].includes(raw.action as string)) out.push({ param: `${p}.action`, message: 'One of notify, ban, schedule_deletion.' });
  return out;
}

/** Merge a validated patch into the compliance configuration; one problem list for the whole patch, like a configuration write. */
export function configProblems(patch: Obj): Problem[] {
  const problems: Problem[] = [];
  const known = ['compliance', 'localization'];
  for (const k of Object.keys(patch)) if (!known.includes(k)) problems.push({ param: k, message: `Unknown section. Expected ${known.join(', ')}.` });
  const c = patch.compliance;
  if (c !== undefined && !isObj(c)) problems.push({ param: 'compliance', message: 'Expected an object.' });
  if (isObj(c)) {
    const blocks = ['minors', 'cookieConsent', 'dataPolicy', 'inactiveUsers', 'dataRegion', 'consents', 'retention'];
    for (const k of Object.keys(c)) if (!blocks.includes(k)) problems.push({ param: `compliance.${k}`, message: `Unknown field. Expected ${blocks.join(', ')}.` });
    if (c.minors !== undefined) problems.push(...validateMinors(c.minors));
    if (c.cookieConsent !== undefined) problems.push(...validateCookieConsent(c.cookieConsent));
    if (c.dataPolicy !== undefined) problems.push(...validateDataPolicy(c.dataPolicy));
    if (c.inactiveUsers !== undefined) problems.push(...validateInactive(c.inactiveUsers));
    if (c.dataRegion !== undefined && c.dataRegion !== null && (typeof c.dataRegion !== 'string' || !c.dataRegion)) problems.push({ param: 'compliance.dataRegion', message: 'A region id, or null.' });
    if (c.consents !== undefined && !Array.isArray(c.consents)) problems.push({ param: 'compliance.consents', message: 'Expected an array.' });
    if (c.retention !== undefined && !isObj(c.retention)) problems.push({ param: 'compliance.retention', message: 'Expected an object.' });
  }
  const l = patch.localization;
  if (l !== undefined) {
    if (!isObj(l)) problems.push({ param: 'localization', message: 'Expected an object.' });
    else for (const k of Object.keys(l)) {
      if (!['requireReview', 'requireFourEyes'].includes(k)) problems.push({ param: `localization.${k}`, message: 'Unknown field. Expected requireReview, requireFourEyes.' });
      else if (typeof l[k] !== 'boolean') problems.push({ param: `localization.${k}`, message: 'Expected a boolean.' });
    }
  }
  return problems;
}

/** Merge a patch after it passed `configProblems`; throws one validation error listing the first problems otherwise. */
export function applyConfigPatch(cfg: Obj, patch: Obj): void {
  const problems = configProblems(patch);
  if (problems.length > 0) throw bad(`The configuration is not valid: ${problems.slice(0, 5).map((x) => `${x.param}: ${x.message}`).join('; ')}`, problems[0]!.param);
  const c = patch.compliance;
  const l = patch.localization;
  if (isObj(c)) {
    for (const [k, v] of Object.entries(c)) {
      cfg.compliance[k] = isObj(v) && isObj(cfg.compliance[k]) ? { ...cfg.compliance[k], ...v } : v;
    }
    const cats = cfg.compliance.cookieConsent.categories as string[];
    cfg.compliance.cookieConsent.categories = ['necessary', ...cats.filter((x) => x !== 'necessary')];
  }
  if (isObj(l)) Object.assign(cfg.localization, l);
}

