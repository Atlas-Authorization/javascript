import { CONFORMANCE_CASES, WEBHOOK_CONFORMANCE_CASES, type CaseProfile, type ConformanceCase } from './cases';
import { materialize, type RecordedCall } from './requests';
import { matchShape } from './shape';

export interface ConformanceTarget {
  /** The platform's base URL (the cases append /v1/auth/connections/{id}/…). */
  baseUrl: string;
  /**
   * Which protocol to test: `connection` (the connection-API dialect, as
   * Referalli speaks it; the default) or `webhook` (the generic Atlas referral
   * protocol any platform can implement).
   */
  profile?: CaseProfile;
  /** A connection id on the platform that you own (the cases never create one). Unused by the `webhook` profile. */
  connectionId: string;
  /** Its signing secret. */
  secret: string;
  fetch?: typeof fetch;
  /** Epoch ms for signing; default `Date.now`. */
  now?: () => number;
  /** Per-request timeout; default 10 000. */
  timeoutMs?: number;
  /** Run only these case ids (or area prefixes such as `auth.`). */
  only?: string[];
  /** Distinguishes this run's customers from another's; default a random suffix. */
  runId?: string;
}

export type CaseOutcome = 'pass' | 'fail' | 'warn';

export interface CaseResult {
  id: string;
  title: string;
  outcome: CaseOutcome;
  /** The status the platform answered (the second answer for a replay case). */
  status: number | null;
  problems: string[];
  why: string;
}

export interface ConformanceReport {
  ok: boolean;
  passed: number;
  failed: number;
  warnings: number;
  results: CaseResult[];
}

const runIdDefault = () => Math.random().toString(36).slice(2, 10);

async function send(call: RecordedCall, impl: typeof fetch, timeoutMs: number): Promise<{ status: number; body: unknown; text: string }> {
  const res = await impl(call.url, {
    method: call.method,
    headers: call.headers,
    ...(call.body !== undefined ? { body: call.body } : {}),
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: res.status, body, text };
}

/** Judge one answer against a case's expectation. Returns the problems (empty = conforms). */
export function judge(c: ConformanceCase, answer: { status: number; body: unknown }): string[] {
  const problems: string[] = [];
  if (!c.expect.status.includes(answer.status)) {
    problems.push(`status ${answer.status}, expected ${c.expect.status.join(' or ')}`);
    return problems;
  }
  if (c.expect.json !== undefined && answer.status !== 204) {
    problems.push(...matchShape(answer.body, c.expect.json));
  }
  if (c.expect.errorCodes) {
    const code = (answer.body as { error?: { code?: unknown } } | null)?.error?.code;
    if (typeof code !== 'string' || !c.expect.errorCodes.includes(code)) {
      problems.push(`error.code ${JSON.stringify(code)}, expected ${c.expect.errorCodes.join(' or ')}`);
    }
  }
  return problems;
}

/** The cases a run covers. */
export function selectCases(only?: string[], profile: CaseProfile = 'connection'): ConformanceCase[] {
  const all = profile === 'webhook' ? WEBHOOK_CONFORMANCE_CASES : CONFORMANCE_CASES;
  if (!only?.length) return [...all];
  return all.filter((c) => only.some((o) => c.id === o || c.id.startsWith(o.endsWith('.') ? o : `${o}.`)));
}

/**
 * Run the cases against a platform. Every case is sent as a real signed
 * request and judged; the cases only ever use throwaway customer refs, and the
 * ones that write (sign-up, user, alias) use refs prefixed `conformance_` or
 * `atlas_test_`, so a platform can ignore or sweep them.
 */
export async function runConformance(target: ConformanceTarget): Promise<ConformanceReport> {
  const impl = target.fetch ?? globalThis.fetch;
  const runId = target.runId ?? runIdDefault();
  const results: CaseResult[] = [];
  for (const c of selectCases(target.only, target.profile)) {
    const call = materialize(c, {
      baseUrl: target.baseUrl,
      connectionId: target.connectionId,
      secret: target.secret,
      now: (target.now ?? Date.now)(),
      runId,
    });
    let status: number | null = null;
    let problems: string[];
    try {
      if (call.replay) await send(call, impl, target.timeoutMs ?? 10_000);
      const answer = await send(call, impl, target.timeoutMs ?? 10_000);
      status = answer.status;
      problems = judge(c, answer);
    } catch (error) {
      problems = [`no answer: ${error instanceof Error ? error.message : String(error)}`];
    }
    const outcome: CaseOutcome = problems.length === 0 ? 'pass' : c.recommended ? 'warn' : 'fail';
    results.push({ id: c.id, title: c.title, outcome, status, problems, why: c.why });
  }
  const failed = results.filter((r) => r.outcome === 'fail').length;
  return {
    ok: failed === 0,
    passed: results.filter((r) => r.outcome === 'pass').length,
    failed,
    warnings: results.filter((r) => r.outcome === 'warn').length,
    results,
  };
}

/** A plain-text report, one line per case. */
export function formatReport(report: ConformanceReport): string[] {
  const lines: string[] = [];
  for (const r of report.results) {
    const mark = r.outcome === 'pass' ? 'PASS' : r.outcome === 'warn' ? 'WARN' : 'FAIL';
    lines.push(`${mark}  ${r.id}  ${r.title}`);
    for (const p of r.problems) lines.push(`        ${p}`);
    if (r.outcome !== 'pass') lines.push(`        why it matters: ${r.why}`);
  }
  lines.push('');
  lines.push(`${report.passed} passed, ${report.failed} failed, ${report.warnings} warning(s).`);
  return lines;
}
