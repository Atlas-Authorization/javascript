'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import {
  getRoleMatrix,
  listResourceShares,
  listShareableResources,
  shareResource,
  unshareResource,
  type AccessRequest,
  type ResourceShares,
  type RoleMatrixData,
  type ShareableResource,
} from '@atlasauth/js';
import { useFapiClient } from './components-shared';
import { useOrganization } from './hooks';
import { useAccess } from './access';

/**
 * Embeddable authorization widgets. Each one only follows the server: what an organization may share, which roles
 * exist and what a request needs are decided by the API, and a refusal is shown as the server worded it.
 */

/** Share one resource with members of the active organization. */
export function ShareDialog({ resourceId, memberOptions, onChange }: { resourceId: string; memberOptions: Array<{ userId: string; label: string }>; onChange?: () => void }) {
  const client = useFapiClient();
  const { organization } = useOrganization();
  const orgId = organization?.id;
  const uid = useId();
  const [data, setData] = useState<ResourceShares | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState('');

  const load = useCallback(async () => {
    if (!orgId) return;
    const r = await listResourceShares(client, orgId, resourceId);
    if (r.ok) {
      setData(r.data);
      setRole((cur) => cur || r.data.roles[0]?.key || '');
      setError(null);
    } else setError(r.errors[0]?.message ?? 'Could not load who this is shared with.');
  }, [client, orgId, resourceId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!orgId) return null;
  if (!data) return error ? <p role="alert" data-atlas-share-error>{error}</p> : <div data-atlas-share aria-busy="true" />;

  const label = (id: string) => memberOptions.find((m) => m.userId === id)?.label ?? id;
  const act = async (run: () => Promise<{ ok: boolean; errors?: Array<{ message: string }> }>) => {
    const r = await run();
    setError(r.ok ? null : (r.errors?.[0]?.message ?? 'That did not work.'));
    if (r.ok) {
      await load();
      onChange?.();
    }
  };

  return (
    <div data-atlas-share>
      <h2 id={`${uid}-t`}>Share “{data.resource.name ?? data.resource.external_id}”</h2>
      {error ? <p role="alert" data-atlas-share-error>{error}</p> : null}
      <ul aria-labelledby={`${uid}-t`}>
        {data.data.map((s) => (
          <li key={s.id}>
            <span>{s.subject.type === 'user' ? label(s.subject.id) : `${s.subject.type}:${s.subject.id}`}</span> <em>{data.roles.find((r) => r.key === s.role)?.name ?? s.role}</em>{' '}
            {s.subject.type === 'user' ? <button type="button" onClick={() => void act(() => unshareResource(client, orgId, resourceId, s.id))}>Remove</button> : null}
          </li>
        ))}
      </ul>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (userId && role) void act(() => shareResource(client, orgId, resourceId, { userId, role }));
        }}
      >
        <label>
          Person{' '}
          <select value={userId} onChange={(e) => setUserId(e.target.value)} required>
            <option value="">Choose…</option>
            {memberOptions.map((m) => <option key={m.userId} value={m.userId}>{m.label}</option>)}
          </select>
        </label>{' '}
        <label>
          Role{' '}
          <select value={role} onChange={(e) => setRole(e.target.value)}>
            {data.roles.map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}
          </select>
        </label>{' '}
        <button type="submit">Share</button>
      </form>
    </div>
  );
}

/** A table of a resource type's roles against the permissions each grants. */
export function RoleMatrix({ resourceType }: { resourceType: string }) {
  const client = useFapiClient();
  const { organization } = useOrganization();
  const orgId = organization?.id;
  const [m, setM] = useState<RoleMatrixData | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!orgId) return;
    void getRoleMatrix(client, orgId, resourceType).then((r) => (r.ok ? (setM(r.data), setError(null)) : setError(r.errors[0]?.message ?? 'Could not load the roles.')));
  }, [client, orgId, resourceType]);
  if (!orgId) return null;
  if (!m) return error ? <p role="alert">{error}</p> : <div data-atlas-role-matrix aria-busy="true" />;
  return (
    <table data-atlas-role-matrix>
      <caption>{m.name}</caption>
      <thead>
        <tr>
          <th scope="col">Role</th>
          {m.permissions.map((p) => <th key={p} scope="col">{p}</th>)}
        </tr>
      </thead>
      <tbody>
        {m.matrix.map((row) => (
          <tr key={row.role}>
            <th scope="row">{row.name}</th>
            {m.permissions.map((p) => <td key={p}>{row.grants[p] ? <span aria-label="granted">✓</span> : <span aria-label="not granted">–</span>}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The resources the active organization can share (a picker feeding {@link ShareDialog}). */
export function useShareableResources(type?: string): { resources: ShareableResource[]; loading: boolean; error: string | null } {
  const client = useFapiClient();
  const { organization } = useOrganization();
  const orgId = organization?.id;
  const [state, setState] = useState<{ resources: ShareableResource[]; loading: boolean; error: string | null }>({ resources: [], loading: true, error: null });
  useEffect(() => {
    if (!orgId) return;
    void listShareableResources(client, orgId, { type }).then((r) => setState(r.ok ? { resources: r.data, loading: false, error: null } : { resources: [], loading: false, error: r.errors[0]?.message ?? 'Could not load resources.' }));
  }, [client, orgId, type]);
  return state;
}

/** A button that requests one catalog entitlement, with a justification when the catalog asks for one. */
export function AccessRequestButton({ entitlement, children = 'Request access', onRequested }: { entitlement: string; children?: React.ReactNode; onRequested?: () => void }) {
  const a = useAccess();
  const [reason, setReason] = useState('');
  const [open, setOpen] = useState(false);
  const item = a.catalog.find((c) => c.id === entitlement || c.key === entitlement);
  if (a.loading || !item) return null;
  const held = a.grants.some((g) => g.entitlement_id === item.id);
  const pending = a.requests.some((r) => r.entitlement_id === item.id && r.status === 'pending');
  if (held) return <span data-atlas-access-state="held">You have this</span>;
  if (pending) return <span data-atlas-access-state="pending">Requested</span>;
  const send = async () => {
    if (await a.request(item.id, reason || undefined)) {
      setOpen(false);
      onRequested?.();
    }
  };
  return (
    <span data-atlas-access-request>
      {open ? (
        <>
          <input aria-label="Why do you need this?" value={reason} onChange={(e) => setReason(e.target.value)} />{' '}
          <button type="button" onClick={() => void send()}>Send request</button>{' '}
          <button type="button" onClick={() => setOpen(false)}>Cancel</button>
          {a.error ? <span role="alert">{a.error}</span> : null}
        </>
      ) : (
        <button type="button" onClick={() => setOpen(true)}>{children}</button>
      )}
    </span>
  );
}

/** Access requests waiting on the signed-in user, with approve and deny. */
export function PendingApprovals({ label = (r: AccessRequest) => r.entitlement_id }: { label?: (r: AccessRequest) => string }) {
  const a = useAccess();
  if (a.loading || a.approvals.length === 0) return null;
  return (
    <section data-atlas-pending-approvals>
      <h2>Waiting for your approval</h2>
      <ul>
        {a.approvals.map((r) => (
          <li key={r.id}>
            <span>{label(r)}{r.justification ? ` — “${r.justification}”` : ''}</span>{' '}
            <button type="button" onClick={() => void a.decide(r.id, 'approve')}>Approve</button>{' '}
            <button type="button" onClick={() => void a.decide(r.id, 'deny')}>Deny</button>
          </li>
        ))}
      </ul>
      {a.error ? <p role="alert">{a.error}</p> : null}
    </section>
  );
}
