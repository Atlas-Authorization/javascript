import { enc, type RequestFn } from './request';



export type OpaQueryDataBody = {
  input?: unknown;
};

export type OpaQueryDataResult = Record<string, unknown>;

export type OpaIngestLogsBody = Record<string, unknown>[];

export type OpaIngestLogsResult = Record<string, unknown>;

export type OpaReportStatusBody = Record<string, unknown>;

export type OpaReportStatusResult = Record<string, unknown>;

/** Operations on `/v1/opa` (4). */
export function opaOpsResource(request: RequestFn) {
  return {
    /** OPA Data API over Atlas. POST { "input": ... } to atlas/abac/allow (boolean), atlas/abac/decision, atlas/fga/{store}/allow (input user, relation, object) or atlas/fga/{store}/objects (input user, relation, type); the answer is { "result": ... }. An unknown path answers 200 with no result, as OPA does. Not a Rego runtime: Atlas evaluates Cedar and relationship models. */
    queryData(path: string, body?: OpaQueryDataBody, idempotencyKey?: string): Promise<OpaQueryDataResult> {
      return request({ method: 'POST', path: `/v1/opa/v1/data/${path}`, body, idempotencyKey });
    },
    /** An OPA bundle (gzipped tarball with .manifest and data.json) holding the store's model and unexpired tuples under data.atlas.fga.{store id}, for Rego you write over Atlas data. Supports ETag and If-None-Match (304). */
    getBundle(store: string): Promise<Uint8Array> {
      return request({ method: 'GET', path: `/v1/opa/bundles/${enc(store)}`, binary: true });
    },
    /** OPA decision log ingestion: accepts the gzipped JSON array OPA's decision_logs plugin posts and records each event in the Atlas decision log (source `opa`), sampled and redacted by the instance settings. */
    ingestLogs(body?: OpaIngestLogsBody, idempotencyKey?: string): Promise<OpaIngestLogsResult> {
      return request({ method: 'POST', path: '/v1/opa/logs', body, idempotencyKey });
    },
    /** Accepts OPA status updates and ignores them, so a default OPA configuration does not log errors. */
    reportStatus(body?: OpaReportStatusBody, idempotencyKey?: string): Promise<OpaReportStatusResult> {
      return request({ method: 'POST', path: '/v1/opa/status', body, idempotencyKey });
    },
  };
}
