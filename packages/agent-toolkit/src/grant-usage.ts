import type { UsageClaims, UsageGate } from '@atlasauth/backend';

/**
 * Spend a grant counter BEFORE a tool acts. Each wrapped tool call:
 *  1. optionally pre-checks the token claims locally (deny-only),
 *  2. consumes from the counter through the usage gate with a fresh idempotency key,
 *  3. runs the tool only when the consume is allowed,
 *  4. refunds the consume when the tool throws, so a failed action does not cost the agent its allowance.
 * A denial throws {@link GrantUsageDeniedError} (the MCP server and the framework adapters show its message to the model).
 *
 * The idempotency key is random per invocation: a key derived from the arguments would make a second,
 * identical, legitimate call replay the first spend and run for free. Pass `idempotencyKey` when your
 * framework gives you a stable tool-call id and you want retries of the SAME call deduplicated.
 */

export interface GrantUsageToolOptions {
  gate: UsageGate;
  /** The grant the agent acts under. A function lets it follow the current session. */
  grant: { grantType: 'machine' | 'agent'; grantId: string } | (() => { grantType: 'machine' | 'agent'; grantId: string });
  /** One counter for every tool, or a map of tool name to its counter and cost. Tools not in a map are not metered. */
  counter: string | Record<string, string | { counter: string; amount?: number }>;
  /** Default 1 per call; a counter-map entry can override. */
  amount?: number;
  /** Token claims for the local deny-only pre-check. Omit to skip it. */
  claims?: () => UsageClaims | null | undefined;
  /** Stable key per call (e.g. a framework tool-call id). Default: random. */
  idempotencyKey?: (toolName: string, args: unknown) => string | undefined;
  /** Refund the consume when the tool throws. Default true. */
  refundOnError?: boolean;
}

export class GrantUsageDeniedError extends Error {
  override readonly name = 'GrantUsageDeniedError';
  constructor(
    readonly tool: string,
    readonly reason: string,
    /** Epoch ms the window resets, when known. */
    readonly resetsAt: number | null,
  ) {
    super(
      reason === 'limit_reached' || reason === 'exhausted'
        ? `Tool "${tool}" was not run: this grant has used up its allowance${resetsAt ? ` until ${new Date(resetsAt).toISOString()}` : ''}.`
        : `Tool "${tool}" was not run: this grant does not allow it (${reason}).`,
    );
  }
}

/** Wrap every metered tool so it spends from the grant counter before it acts. Returns new tool objects; the inputs are untouched. */
export function withGrantUsage<T extends { name: string; execute(args: unknown): Promise<unknown> }>(tools: readonly T[], options: GrantUsageToolOptions): T[] {
  const { gate } = options;
  const refundOnError = options.refundOnError ?? true;
  const metering = (name: string): { counter: string; amount: number } | null => {
    const spec = typeof options.counter === 'string' ? options.counter : options.counter[name];
    if (spec === undefined) return null;
    return typeof spec === 'string'
      ? { counter: spec, amount: options.amount ?? 1 }
      : { counter: spec.counter, amount: spec.amount ?? options.amount ?? 1 };
  };

  return tools.map((tool) => {
    const meter = metering(tool.name);
    if (!meter) return tool;
    return {
      ...tool,
      async execute(args: unknown) {
        const claims = options.claims?.();
        if (options.claims) {
          const local = gate.check(claims, { counter: meter.counter, amount: meter.amount });
          if (!local.ok) throw new GrantUsageDeniedError(tool.name, local.reason, null);
        }
        const grant = typeof options.grant === 'function' ? options.grant() : options.grant;
        const idempotencyKey = options.idempotencyKey?.(tool.name, args) ?? globalThis.crypto.randomUUID();
        const spent = await gate.consume({ ...grant, counter: meter.counter, amount: meter.amount, idempotencyKey });
        if (!spent.allowed) throw new GrantUsageDeniedError(tool.name, spent.reason ?? 'denied', spent.resetsAt);
        try {
          return await tool.execute(args);
        } catch (error) {
          if (refundOnError) {
            await gate
              .refund({ ...grant, counter: meter.counter, amount: meter.amount, idempotencyKey: `${idempotencyKey}:refund`, consumeIdempotencyKey: idempotencyKey })
              .catch(() => undefined); // the refund is best-effort; the tool's own error is what the caller needs
          }
          throw error;
        }
      },
    } as T;
  });
}
