import type { ApprovalRequest, ApprovalRequestCreated, CreateApprovalRequestBody } from './client/approvals';
import type { ConsumeResult, GateConsumeInput, GateRefundInput, UsageGate } from './usage-gate';
import { verifyApprovalReceipt, type VerifyApprovalReceiptOptions } from './approval-receipt';

/**
 * Approval gate: make a tool wait for a human before it runs.
 *
 * `createApprovalGate({ client })` wraps the management client's `approvals` resource into the steps an agent tool
 * needs: create the request, wait for it (long-poll) or hand back a resume token, spend the approval once, check the
 * signed receipt, and only then run. `guardToolCall` is that sequence around one call, optionally followed by a
 * metered spend of a grant counter through the usage gate; the agent toolkit, the MCP server and the LangChain and
 * LlamaIndex packages all call it, so the four behave the same.
 *
 * The request is bound to the tool and its exact arguments (a SHA-256 binding), so an approval for one call can never
 * be used for another, and each approval runs the tool at most once.
 */

/** The slice of the management client the gate needs. */
export interface ApprovalGateClient {
  approvals: {
    create(body: CreateApprovalRequestBody, opts?: { idempotencyKey?: string }): Promise<ApprovalRequestCreated>;
    get(id: string, opts?: { waitSeconds?: number }): Promise<ApprovalRequest>;
    consume(id: string, body?: { binding?: string }): Promise<ApprovalRequest>;
    cancel(id: string): Promise<ApprovalRequest>;
  };
}

export class ApprovalPendingError extends Error {
  override readonly name = 'ApprovalPendingError';
  constructor(
    readonly tool: string,
    /** Pass this back (as the resume token) to continue once the approver has answered. */
    readonly approvalId: string,
    readonly expiresAt: number,
  ) {
    super(`Tool "${tool}" is waiting for approval (${approvalId}). Ask the approver to answer, then call it again with approval_id "${approvalId}".`);
  }
}

export class ApprovalDeniedError extends Error {
  override readonly name = 'ApprovalDeniedError';
  constructor(readonly tool: string, readonly approvalId: string, readonly status: 'denied' | 'expired' | 'cancelled') {
    super(
      status === 'denied'
        ? `Tool "${tool}" was not run: the approval was denied.`
        : `Tool "${tool}" was not run: the approval request ${status === 'expired' ? 'expired before anyone answered' : 'was cancelled'}.`,
    );
  }
}

export class ToolUsageDeniedError extends Error {
  override readonly name = 'ToolUsageDeniedError';
  constructor(readonly tool: string, readonly reason: string, readonly resetsAt: number | null) {
    super(`Tool "${tool}" was not run: this grant does not allow it (${reason}).`);
  }
}

export interface ApprovalGateOptions {
  client: ApprovalGateClient;
  /** The instance JWKS; with it the receipt is verified before the tool runs. Omit to skip verification. */
  jwks?: VerifyApprovalReceiptOptions['jwks'] | (() => Promise<VerifyApprovalReceiptOptions['jwks']>);
  /** Receipt issuer to require (the instance Frontend API origin). */
  issuer?: string;
  /** Require signed approvals on every request the gate creates. Default true. */
  requireSignatures?: boolean;
  /** How long `wait` holds for an answer before it gives up with {@link ApprovalPendingError}. Default 120000 ms. */
  maxWaitMs?: number;
  /** One long-poll round, 1 to 25 seconds. Default 20. */
  pollSeconds?: number;
  /** Injectable clock and sleep, for tests. */
  now?: () => number;
}

export interface ApprovalOutcome {
  request: ApprovalRequest;
}

export interface ApprovalGate {
  /** Create the request. */
  request(body: CreateApprovalRequestBody, opts?: { idempotencyKey?: string }): Promise<ApprovalRequestCreated>;
  /** Wait for an answer. Resolves with the approved request; throws {@link ApprovalDeniedError} or {@link ApprovalPendingError}. */
  wait(approvalId: string, opts?: { tool?: string; maxWaitMs?: number; signal?: AbortSignal }): Promise<ApprovalRequest>;
  /** One look, no waiting: the resume path. Same outcomes as `wait`. */
  resume(approvalId: string, tool?: string): Promise<ApprovalRequest>;
  /** Spend an approved request once, verify its receipt and return it. */
  redeem(approvalId: string, opts?: { binding?: string; tool?: string }): Promise<ApprovalRequest>;
}

export function createApprovalGate(options: ApprovalGateOptions): ApprovalGate {
  const { client } = options;
  const now = options.now ?? (() => Date.now());
  const pollSeconds = Math.min(25, Math.max(1, Math.floor(options.pollSeconds ?? 20)));
  const maxWaitMs = options.maxWaitMs ?? 120_000;

  const settle = (req: ApprovalRequest, tool: string): ApprovalRequest | 'pending' => {
    if (req.status === 'approved') return req;
    if (req.status === 'pending') return 'pending';
    throw new ApprovalDeniedError(tool, req.id, req.status);
  };

  return {
    request: (body, opts) => client.approvals.create({ require_signature: options.requireSignatures ?? true, ...body }, opts),

    async wait(approvalId, opts = {}) {
      const tool = opts.tool ?? 'tool';
      const deadline = now() + (opts.maxWaitMs ?? maxWaitMs);
      for (;;) {
        if (opts.signal?.aborted) throw new ApprovalPendingError(tool, approvalId, 0);
        const left = Math.max(0, Math.floor((deadline - now()) / 1000));
        const req = await client.approvals.get(approvalId, { waitSeconds: Math.min(pollSeconds, left) });
        const s = settle(req, tool);
        if (s !== 'pending') return s;
        if (now() >= deadline) throw new ApprovalPendingError(tool, approvalId, req.expires_at);
      }
    },

    async resume(approvalId, tool = 'tool') {
      const req = await client.approvals.get(approvalId);
      const s = settle(req, tool);
      if (s === 'pending') throw new ApprovalPendingError(tool, approvalId, req.expires_at);
      return s;
    },

    async redeem(approvalId, opts = {}) {
      const spent = await client.approvals.consume(approvalId, opts.binding === undefined ? {} : { binding: opts.binding });
      if (options.jwks) {
        if (!spent.receipt) throw new ApprovalDeniedError(opts.tool ?? 'tool', approvalId, 'cancelled');
        const jwks = typeof options.jwks === 'function' ? await options.jwks() : options.jwks;
        await verifyApprovalReceipt(spent.receipt, {
          jwks,
          issuer: options.issuer,
          approvalId,
          binding: opts.binding,
          requireSignatures: options.requireSignatures ?? true,
          now: now(),
        });
      }
      return spent;
    },
  };
}

// ── Guarding one tool call ───────────────────────────────────────────────────

/** What a framework-neutral tool wrapper needs to know; the same shape for every package. */
export interface ApprovalToolOptions {
  gate: ApprovalGate;
  /** The user the approval is about (their approvers are named by `approvers`, or they approve themselves). */
  user: string | (() => string);
  /** Which tools need an approval: a list of names, or a predicate. Default: every tool. */
  requireFor?: readonly string[] | ((tool: string, args: unknown) => boolean);
  /** The text the approver sees. Default: `Run <tool> with <args>`. */
  describe?: (tool: string, args: unknown) => { description: string; context?: Record<string, string> };
  approvers?: CreateApprovalRequestBody['approvers'];
  ttlSeconds?: number;
  /**
   * `wait` (default): hold until the approver answers or `maxWaitMs` passes. `resume`: do not wait; throw
   * {@link ApprovalPendingError} carrying the approval id as the resume token.
   */
  mode?: 'wait' | 'resume';
  /** Read a resume token from the call's arguments (default: `args.approval_id`). */
  resumeToken?: (tool: string, args: unknown) => string | undefined;
  /** Spend a grant counter after the approval, before the tool runs (refunded when the tool throws). */
  usage?: {
    gate: UsageGate;
    grant: { grantType: 'machine' | 'agent'; grantId: string };
    counter: string;
    amount?: number;
  };
}

/** Stable JSON: object keys sorted at every depth. */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => stableJson(v)).join(',')}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
    .join(',')}}`;
}

/** SHA-256 hex of the tool name and its arguments: the binding an approval is limited to. */
export async function bindingFor(tool: string, args: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(stableJson({ tool, args }));
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

const needsApproval = (o: ApprovalToolOptions, tool: string, args: unknown): boolean =>
  o.requireFor === undefined ? true : typeof o.requireFor === 'function' ? o.requireFor(tool, args) : o.requireFor.includes(tool);

/** The resume token argument is not part of what the approver approves, so it is removed before binding and running. */
function splitResume(args: unknown, o: ApprovalToolOptions, tool: string): { args: unknown; token: string | undefined } {
  const token = o.resumeToken ? o.resumeToken(tool, args) : (args as { approval_id?: unknown } | null)?.approval_id;
  if (typeof token !== 'string' || !token) return { args, token: undefined };
  if (o.resumeToken || !args || typeof args !== 'object') return { args, token };
  const { approval_id: _drop, ...rest } = args as Record<string, unknown>;
  return { args: rest, token };
}

/**
 * Run `run` only after the approval (and, when configured, the usage spend) succeeds. A tool that needs no approval
 * still goes through the usage spend. Errors from `run` refund the spend and propagate.
 */
export async function guardToolCall<T>(o: ApprovalToolOptions, tool: string, rawArgs: unknown, run: (args: unknown) => Promise<T>): Promise<T> {
  const { args, token } = splitResume(rawArgs, o, tool);
  if (needsApproval(o, tool, args)) {
    const binding = await bindingFor(tool, args);
    let id = token;
    if (!id) {
      const text = o.describe?.(tool, args) ?? { description: `Run ${tool}`, context: { tool } };
      const created = await o.gate.request(
        {
          user_id: typeof o.user === 'function' ? o.user() : o.user,
          description: text.description,
          ...(text.context ? { context: text.context } : {}),
          binding,
          ...(o.approvers ? { approvers: o.approvers } : {}),
          ...(o.ttlSeconds ? { ttl_seconds: o.ttlSeconds } : {}),
        },
        { idempotencyKey: `tool-approval-${binding}-${globalThis.crypto.randomUUID()}` },
      );
      id = created.id;
      if (o.mode === 'resume') throw new ApprovalPendingError(tool, id, created.expires_at);
    }
    if (token && o.mode === 'resume') await o.gate.resume(id, tool);
    else await o.gate.wait(id, { tool });
    await o.gate.redeem(id, { binding, tool });
  }
  if (!o.usage) return run(args);
  const key = globalThis.crypto.randomUUID();
  const spend: GateConsumeInput = { ...o.usage.grant, counter: o.usage.counter, amount: o.usage.amount ?? 1, idempotencyKey: key };
  const spent: ConsumeResult = await o.usage.gate.consume(spend);
  if (!spent.allowed) throw new ToolUsageDeniedError(tool, spent.reason ?? 'denied', spent.resetsAt);
  try {
    return await run(args);
  } catch (error) {
    const refund: GateRefundInput = { ...o.usage.grant, counter: o.usage.counter, amount: spend.amount, idempotencyKey: `${key}:refund`, consumeIdempotencyKey: key };
    await o.usage.gate.refund(refund).catch(() => undefined);
    throw error;
  }
}

/** Wrap `{ name, execute(args) }` tools. Returns new tool objects; the inputs are untouched. */
export function withApproval<T extends { name: string; execute(args: unknown): Promise<unknown> }>(tools: readonly T[], options: ApprovalToolOptions): T[] {
  return tools.map((tool) => ({ ...tool, execute: (args: unknown) => guardToolCall(options, tool.name, args, (a) => tool.execute(a)) }) as T);
}
