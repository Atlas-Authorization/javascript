import type { Clock } from './clock';

export interface SunkMessage {
  id: number;
  at: string;
  channel: string;
  to: string;
  subject?: string;
  body?: string;
  /** A verification code, magic-link token or similar, when the message carries one. */
  code?: string;
  link?: string;
  meta?: Record<string, unknown>;
}

export interface MessageQuery {
  to?: string;
  channel?: string;
  /** Only messages with an id above this one. */
  after?: number;
}

/**
 * The universal message sink: everything the engine would have sent (email, SMS, WhatsApp, voice, push)
 * lands here instead. Read it with `GET /__emulator/messages` or `engine.messages`.
 */
/** What the messaging layer decides for one outgoing message before it is sunk. `done` gets the sunk copy, or null when it was not delivered. */
export interface MessagePlan {
  deliver: boolean;
  done?: (sunk: SunkMessage | null) => void;
}

export class MessageSink {
  readonly messages: SunkMessage[] = [];
  /** Suppression, provider failover and the message ledger plug in here (see handlers/messaging.ts); unset, every message is delivered. */
  route?: (m: Omit<SunkMessage, 'id' | 'at'>) => MessagePlan;
  private waiters: Array<{ q: MessageQuery; resolve: (m: SunkMessage) => void; timer: ReturnType<typeof setTimeout> }> = [];

  constructor(private readonly clock: Clock) {}

  send(m: Omit<SunkMessage, 'id' | 'at'>): SunkMessage {
    const plan = this.route?.(m);
    if (plan && !plan.deliver) {
      plan.done?.(null);
      return { id: 0, at: new Date(this.clock.now()).toISOString(), ...m, meta: { ...(m.meta ?? {}), undelivered: true } };
    }
    const full: SunkMessage = { id: this.messages.length + 1, at: new Date(this.clock.now()).toISOString(), ...m };
    this.messages.push(full);
    for (const w of [...this.waiters]) {
      if (this.matches(full, w.q)) {
        clearTimeout(w.timer);
        this.waiters = this.waiters.filter((x) => x !== w);
        w.resolve(full);
      }
    }
    plan?.done?.(full);
    return full;
  }

  private matches(m: SunkMessage, q: MessageQuery): boolean {
    return (!q.to || m.to.toLowerCase() === q.to.toLowerCase()) && (!q.channel || m.channel === q.channel) && (q.after === undefined || m.id > q.after);
  }

  list(q: MessageQuery = {}): SunkMessage[] {
    return this.messages.filter((m) => this.matches(m, q));
  }

  /** Resolve with the first matching message, already sunk or arriving within `timeoutMs`; rejects on timeout. */
  waitFor(q: MessageQuery, timeoutMs = 5000): Promise<SunkMessage> {
    const have = this.list(q)[0];
    if (have) return Promise.resolve(have);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.timer !== timer);
        reject(new Error(`No message for ${JSON.stringify(q)} within ${timeoutMs} ms.`));
      }, timeoutMs);
      this.waiters.push({ q, resolve, timer });
    });
  }

  clear(): void {
    this.messages.length = 0;
    for (const w of this.waiters) clearTimeout(w.timer);
    this.waiters = [];
  }
}
