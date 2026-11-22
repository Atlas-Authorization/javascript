import type { RevokedMachineRef } from './client/machines';
import { createMachineDenyList, type MachineDenyList } from './machine-deny-list';
import { revocationStream, type RevocationFrame, type RevocationStreamHandle, type RevocationStreamOptions } from './revocation-stream';

/** A deny list of sessions, fed by the revocation stream: plug it into `authenticateRequest({ revocation: { mode: 'sid_list', deny } })`. */
export interface SessionDenyList {
  /** True when the session was revoked, or the user's sessions were all ended after this token was issued. */
  isSessionRevoked(claims: { sid?: string; sub?: string; iat?: number }): boolean;
  /** Record one `session` / `user_sessions` / `user` frame. */
  apply(frame: RevocationFrame): void;
  size(): number;
}

export function createSessionDenyList(options: { maxTokenLifetimeSeconds?: number; now?: () => number } = {}): SessionDenyList {
  const now = options.now ?? Date.now;
  const lifetimeMs = (options.maxTokenLifetimeSeconds ?? 3600) * 1000;
  /** session id -> when to forget it */
  const sessions = new Map<string, number>();
  /** user id -> the cutoff (ms): tokens issued at or before it are dead (`kept` is the one session spared) */
  const users = new Map<string, { at: number; kept: string | null; forgetAt: number }>();
  const prune = () => {
    const t = now();
    for (const [k, v] of sessions) if (v <= t) sessions.delete(k);
    for (const [k, v] of users) if (v.forgetAt <= t) users.delete(k);
  };
  return {
    apply(frame) {
      const at = frame.revoked_at ?? frame.at;
      if (frame.kind === 'session' && frame.ids.session_id) sessions.set(frame.ids.session_id, at + lifetimeMs);
      else if ((frame.kind === 'user_sessions' || frame.kind === 'user') && frame.user_id) {
        const held = users.get(frame.user_id);
        // `user` frames (ban, deactivation, lock) end everything; a later cutoff wins.
        if (!held || at >= held.at) users.set(frame.user_id, { at, kept: frame.kind === 'user_sessions' ? frame.kept_session_id ?? null : null, forgetAt: at + lifetimeMs });
      }
    },
    isSessionRevoked(claims) {
      prune();
      if (claims.sid && sessions.has(claims.sid)) return true;
      const u = claims.sub ? users.get(claims.sub) : undefined;
      if (!u) return false;
      if (u.kept && claims.sid === u.kept) return false;
      return typeof claims.iat === 'number' ? claims.iat * 1000 <= u.at : true;
    },
    size: () => sessions.size + users.size,
  };
}

export interface RevocationMirrorOptions extends Omit<RevocationStreamOptions, 'onEvent' | 'onReconnect'> {
  /** `createKeyMirror(...)`: `api_key` events revoke the key locally at once; `sync()` runs after every reconnect. */
  keyMirror?: { applyWebhook(event: { type: string; data: unknown }): Promise<boolean>; sync(): Promise<unknown> };
  /** Default: a new one (read it as `.machines`). Pass your own to share it with `verifyMachineToken({ isRevoked })`. */
  machineDenyList?: MachineDenyList;
  /** Default: a new one (read it as `.sessions`). */
  sessionDenyList?: SessionDenyList;
  /** Called for every frame after the built-in handling (your own fan-out: close sockets, purge caches). */
  onEvent?: (frame: RevocationFrame) => void | Promise<void>;
  /** Extra reconcile work after a reconnect; the mirror's own `sync()` calls run first. */
  onReconnect?: () => void | Promise<void>;
}

export interface RevocationMirror {
  /** Start consuming. Call `stop()` on the handle to end it. */
  start(): RevocationStreamHandle;
  sessions: SessionDenyList;
  machines: MachineDenyList;
  /** Apply one frame by hand (a webhook you received on the second channel). */
  apply(frame: RevocationFrame): Promise<void>;
}

/**
 * One consumer that keeps your local copies of "what was revoked" current from the revocation stream: the API key
 * mirror, a machine token deny list and a session deny list. Reconnects resume by cursor and re-sync the feeds first.
 *
 * Fail-closed guidance: while the stream is down nothing new arrives. Pair this with `maxStalenessMs` on the key
 * mirror (it refuses answers once `sync()` is overdue) and the sid list's `onStale: 'reject'`.
 */
export function createRevocationMirror(options: RevocationMirrorOptions): RevocationMirror {
  const sessions = options.sessionDenyList ?? createSessionDenyList();
  const machines = options.machineDenyList ?? createMachineDenyList();

  const apply = async (frame: RevocationFrame): Promise<void> => {
    switch (frame.kind) {
      case 'api_key':
        if (options.keyMirror && frame.ids.api_key_id) {
          await options.keyMirror.applyWebhook({
            type: 'api_key.revoked',
            data: { id: frame.ids.api_key_id, revoked_at: frame.revoked_at ?? frame.at, revoked_reason: frame.reason },
          });
        }
        break;
      case 'machine':
        if (frame.ids.machine_id) machines.apply({ object: 'machine', id: frame.ids.machine_id, revoked_at: frame.revoked_at ?? frame.at } satisfies RevokedMachineRef);
        break;
      case 'machine_grant': {
        const { machine_id: machineId, audience } = frame.ids;
        if (machineId && audience) machines.apply({ object: 'machine_grant', id: frame.ids.machine_grant_id ?? frame.id, machine_id: machineId, audience, revoked_at: frame.revoked_at ?? frame.at });
        // Older events carry no audience: the feed does.
        else if (machines.canSync) await machines.sync();
        break;
      }
      default:
        sessions.apply(frame);
    }
    await options.onEvent?.(frame);
  };

  return {
    sessions,
    machines,
    apply,
    start() {
      const { onEvent: _onEvent, onReconnect, keyMirror, machineDenyList: _m, sessionDenyList: _s, ...stream } = options;
      return revocationStream({
        ...stream,
        onEvent: apply,
        onReconnect: async () => {
          await keyMirror?.sync();
          if (machines.canSync) await machines.sync();
          await onReconnect?.();
        },
      });
    },
  };
}
