import {
  FapiClient,
  clearCibaPin,
  decideCibaRequest,
  getCibaPin,
  listCibaRequests,
  setCibaPin,
  type CibaPinStatus,
  type CibaRequest,
} from '@atlasauth/js';

/**
 * The engine behind `<ManageCiba>`: the user's pending CIBA sign-in requests and their CIBA PIN, over the
 * `@atlasauth/js` calls. Plain (no Qwik) so the component only holds it `noSerialize`d and the logic is
 * unit-testable. Secrets (current password, PIN) are arguments, never stored.
 */
export interface CibaSnapshot {
  requests: CibaRequest[];
  pin: CibaPinStatus | null;
  message: string | null;
}

export class CibaController {
  private snap: CibaSnapshot = { requests: [], pin: null, message: null };
  private readonly listeners = new Set<(s: CibaSnapshot) => void>();

  constructor(private readonly client: FapiClient) {}

  getSnapshot(): CibaSnapshot {
    return this.snap;
  }

  subscribe(fn: (s: CibaSnapshot) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(patch: Partial<CibaSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    for (const fn of this.listeners) fn(this.snap);
  }

  async load(): Promise<void> {
    const [requests, pin] = await Promise.all([listCibaRequests(this.client).catch(() => []), getCibaPin(this.client).catch(() => null)]);
    this.set({ requests, pin });
  }

  private async run(fn: () => Promise<unknown>, fallback: string): Promise<boolean> {
    this.set({ message: null });
    try {
      await fn();
      await this.load();
      return true;
    } catch (e) {
      this.set({ message: e instanceof Error && e.message ? e.message : fallback });
      return false;
    }
  }

  decide(id: string, decision: 'approve' | 'deny'): Promise<boolean> {
    return this.run(() => decideCibaRequest(this.client, id, decision), decision === 'approve' ? 'Could not approve.' : 'Could not deny.');
  }

  savePin(pin: string, currentPassword: string): Promise<boolean> {
    return this.run(() => setCibaPin(this.client, { pin, currentPassword }), 'Could not save the PIN.');
  }

  removePin(currentPassword: string): Promise<boolean> {
    return this.run(() => clearCibaPin(this.client, { currentPassword }), 'Could not remove the PIN.');
  }
}

/** Whether `<ManageCiba>` has anything to show: a request, a PIN, or an app that could ask. */
export const cibaVisible = (s: CibaSnapshot): boolean => s.requests.length > 0 || !!(s.pin && (s.pin.set || s.pin.available));
