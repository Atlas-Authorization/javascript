import { enc, type RequestFn } from './request';

export type ServiceConnectorCategory = 'messaging' | 'crm' | 'analytics' | 'fraud' | 'idv' | 'http' | 'ticketing';

/** A configured service. Credentials are write-only: they live in the vault and are never returned. */
export interface ServiceConnector {
  object: 'service_connector';
  id: string;
  name: string;
  /** `twilio`, `sendgrid`, `slack`, `hubspot`, `salesforce`, `segment`, `fingerprint`, `arkose`, `forter`, `sardine`, `persona`, `onfido`, `veriff`, `stripe_identity` or `http`. */
  kind: string;
  category: ServiceConnectorCategory | null;
  config: Record<string, string>;
  enabled: boolean;
  last_used_at: number | null;
  last_status: 'ok' | 'error' | null;
  created_at: number;
  updated_at: number;
}

export interface ServiceConnectorField {
  key: string;
  label: string;
  required: boolean;
  type?: string;
  enum?: string[];
  default?: string;
}

export interface ServiceConnectorKind {
  object: 'service_connector_kind';
  kind: string;
  name: string;
  category: ServiceConnectorCategory;
  summary: string;
  credentials: ServiceConnectorField[];
  config: ServiceConnectorField[];
  operations: Array<{ operation: string; summary: string; input: ServiceConnectorField[] }>;
}

export interface CreateServiceConnectorBody {
  /** Lowercase letters, digits, `-` and `_`; what Actions call it by. */
  name: string;
  kind: string;
  config?: Record<string, string>;
  /** Stored in the vault. See the catalog entry for the fields. */
  credentials: Record<string, string>;
}

export interface UpdateServiceConnectorBody {
  name?: string;
  enabled?: boolean;
  /** Merged into the current config. */
  config?: Record<string, string>;
  /** Only the fields you pass are replaced. */
  credentials?: Record<string, string>;
}

/** Typed connectors to messaging, CRM, analytics, fraud and identity-verification services. */
export function serviceConnectorsResource(request: RequestFn) {
  return {
    /** The services you can connect, with their fields and operations. */
    catalog(): Promise<{ object: 'list'; data: ServiceConnectorKind[]; has_more: boolean }> {
      return request({ method: 'GET', path: '/v1/service_connector_catalog' });
    },
    list(): Promise<{ object: 'list'; data: ServiceConnector[]; has_more: boolean }> {
      return request({ method: 'GET', path: '/v1/service_connectors' });
    },
    get(id: string): Promise<ServiceConnector> {
      return request({ method: 'GET', path: `/v1/service_connectors/${enc(id)}` });
    },
    create(body: CreateServiceConnectorBody, idempotencyKey?: string): Promise<ServiceConnector> {
      return request({ method: 'POST', path: '/v1/service_connectors', body, idempotencyKey });
    },
    update(id: string, body: UpdateServiceConnectorBody): Promise<ServiceConnector> {
      return request({ method: 'PATCH', path: `/v1/service_connectors/${enc(id)}`, body });
    },
    delete(id: string): Promise<{ object: 'service_connector.deleted'; id: string; deleted: boolean }> {
      return request({ method: 'DELETE', path: `/v1/service_connectors/${enc(id)}` });
    },
    /** Run an operation, e.g. `invoke(id, 'send_sms', { to, body })`. A failure from the service is a 502 `CONNECTOR_UPSTREAM_ERROR`. */
    invoke(id: string, operation: string, input: Record<string, unknown> = {}): Promise<{ object: 'service_connector_result'; operation: string; result: Record<string, unknown> }> {
      return request({ method: 'POST', path: `/v1/service_connectors/${enc(id)}/invoke`, body: { operation, input } });
    },
  };
}
