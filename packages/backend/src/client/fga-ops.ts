import { enc, type RequestFn } from './request';



export interface FgaGetStoreExportQuery {
  /** Resume after this tuple id. */
  cursor?: string;
  /** Tuples per page. */
  limit?: number;
}

export type FgaGetStoreExportResult = string;

export interface FgaGetStoreWatchQuery {
  /** Store revision to start after (default: now). */
  since?: string;
  /** Only changes to objects of this type. */
  type?: string;
}

export type FgaGetStoreWatchResult = string;

export type FgaListStoreMaterializationsResult = Record<string, unknown>;

export type FgaCreateStoreMaterializationBody = {
  object_type?: string;
  relation?: string;
  user_type?: string;
};

export type FgaCreateStoreMaterializationResult = Record<string, unknown>;

export type FgaRebuildStoreMaterializationResult = Record<string, unknown>;

export type FgaDeleteStoreMaterializationResult = Record<string, unknown>;

/** Operations on `/v1/fga` (6). */
export function fgaOpsResource(request: RequestFn) {
  return {
    /** Export the store tuples as NDJSON (one tuple per line), paged: pass the `atlas-next-cursor` response header back as `cursor`. */
    getStoreExport(id: string, query?: FgaGetStoreExportQuery): Promise<FgaGetStoreExportResult> {
      return request({ method: 'GET', path: `/v1/fga/stores/${enc(id)}/export`, query: { ...query } });
    },
    /** Server-sent stream of the store tuple changes after `since` (or `Last-Event-ID`). Ends after about a minute; reconnect with the last event id. */
    getStoreWatch(id: string, query?: FgaGetStoreWatchQuery): Promise<FgaGetStoreWatchResult> {
      return request({ method: 'GET', path: `/v1/fga/stores/${enc(id)}/watch`, query: { ...query } });
    },
    /** The materialized permission sets of a store: which (object type, relation, user type) answers are precomputed, their status, the revision they were built at and when a tuple expiry will next invalidate them. */
    listStoreMaterializations(id: string): Promise<FgaListStoreMaterializationsResult> {
      return request({ method: 'GET', path: `/v1/fga/stores/${enc(id)}/materializations` });
    },
    /** Precompute list-objects for every user of `user_type` on `object_type#relation`, so a huge list question is one indexed read. The first build runs now; the worker rebuilds after tuple writes. A stored answer is served only while it is current for the store revision and model, before any tuple expiry, and for a plain `type:id` user with no request context or contextual tuples; otherwise list-objects is answered live. A model that uses conditions cannot be materialized. */
    createStoreMaterialization(id: string, body?: FgaCreateStoreMaterializationBody, idempotencyKey?: string): Promise<FgaCreateStoreMaterializationResult> {
      return request({ method: 'POST', path: `/v1/fga/stores/${enc(id)}/materializations`, body, idempotencyKey });
    },
    /** Rebuild one materialization now. */
    rebuildStoreMaterialization(id: string, mid: string): Promise<FgaRebuildStoreMaterializationResult> {
      return request({ method: 'POST', path: `/v1/fga/stores/${enc(id)}/materializations/${enc(mid)}/rebuild` });
    },
    /** Remove a materialization; list-objects is then always computed live. */
    deleteStoreMaterialization(id: string, mid: string): Promise<FgaDeleteStoreMaterializationResult> {
      return request({ method: 'DELETE', path: `/v1/fga/stores/${enc(id)}/materializations/${enc(mid)}` });
    },
  };
}
