/**
 * Maps an Atlas `sid` (the `sid` claim of the ID token) to the session ids of
 * YOUR app, so a back-channel logout that names only the `sid` can end exactly
 * the app sessions it backs.
 *
 * Bind when you create your app session (after MFA, if you gate on it): a
 * step-up callback carries the same `sid`, so there is nothing new to bind
 * unless you rotate your own session id then, in which case bind the new one.
 */
export interface SidStore {
  /** Remember that `appSessionId` belongs to `sid` until `expiresAt` (epoch milliseconds or a Date). */
  bind(sid: string, appSessionId: string, expiresAt: number | Date): Promise<void> | void;
  /** Return AND remove every unexpired app session bound to `sid` (an empty list when none). */
  take(sid: string): Promise<string[]> | string[];
}

const ms = (at: number | Date) => (at instanceof Date ? at.getTime() : at);

/** An in-process {@link SidStore}. Fine for one server; use a shared store (e.g. {@link sqlSidStore}) for several. */
export function memorySidStore(now: () => number = Date.now): SidStore {
  const bySid = new Map<string, Map<string, number>>();
  const sweep = (t: number) => {
    for (const [sid, apps] of bySid) {
      for (const [id, exp] of apps) if (exp <= t) apps.delete(id);
      if (apps.size === 0) bySid.delete(sid);
    }
  };
  return {
    bind(sid, appSessionId, expiresAt) {
      sweep(now());
      let apps = bySid.get(sid);
      if (!apps) bySid.set(sid, (apps = new Map()));
      apps.set(appSessionId, ms(expiresAt));
    },
    take(sid) {
      sweep(now());
      const apps = bySid.get(sid);
      bySid.delete(sid);
      return apps ? [...apps.keys()] : [];
    },
  };
}

/** The one method {@link sqlSidStore} needs: a pg-compatible `query` (node-postgres `Pool`/`Client`, or a wrapper). */
export interface SqlSidStoreOptions {
  query(sql: string, params: unknown[]): Promise<{ rows: any[] }>;
}

/**
 * A {@link SidStore} on PostgreSQL. Create the table once:
 *
 *   create table atlas_rp_sessions (
 *     sid text not null,
 *     app_session_id text not null,
 *     expires_at timestamptz not null,
 *     primary key (sid, app_session_id)
 *   );
 *
 * `take` deletes every row for the sid (expired ones too) and returns the unexpired ids.
 */
export function sqlSidStore({ query }: SqlSidStoreOptions): SidStore {
  return {
    async bind(sid, appSessionId, expiresAt) {
      await query(
        'insert into atlas_rp_sessions (sid, app_session_id, expires_at) values ($1, $2, $3) ' +
          'on conflict (sid, app_session_id) do update set expires_at = excluded.expires_at',
        [sid, appSessionId, new Date(ms(expiresAt))],
      );
    },
    async take(sid) {
      const { rows } = await query(
        'delete from atlas_rp_sessions where sid = $1 returning app_session_id, expires_at > now() as live',
        [sid],
      );
      return rows.filter((r) => r.live).map((r) => String(r.app_session_id));
    },
  };
}
