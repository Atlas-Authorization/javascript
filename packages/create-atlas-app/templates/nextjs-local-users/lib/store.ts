// Your own tables, in memory so the example runs as is. Replace with your database;
// keep a UNIQUE index on atlasSub (syncLocalUser relies on it to be race-safe).
export interface LocalUser { id: string; atlasSub: string | null; email?: string; emailVerified: boolean; externalId: string }
export interface LocalOrg { id: string; atlasOrgId: string; name: string }

export const users = new Map<string, LocalUser>();
export const orgs = new Map<string, LocalOrg>();
export const seenEvents: string[] = [];
