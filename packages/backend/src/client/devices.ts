import { enc, type RequestFn } from './request';
import type { ListPage } from './types';

export interface Device {
  object: 'device';
  id: string;
  user_id: string | null;
  source: string;
  external_id: string;
  name: string | null;
  platform: string | null;
  managed: boolean;
  compliant: boolean;
  posture: Record<string, unknown>;
  os_version: string | null;
  disk_encrypted: boolean | null;
  screen_lock: boolean | null;
  secure_hardware: boolean | null;
  jailbroken: boolean | null;
  firewall: boolean | null;
  edr_present: boolean | null;
  assurance_state: 'compliant' | 'grace' | 'noncompliant' | null;
  assurance_checks: Array<{ policyId: string; check: string; ok: boolean; detail?: string }>;
  integration_id: string | null;
  last_reported_at: number;
  created_at: number;
}

/** One posture report. Identify the owner with `user_id` or a verified `user_email`. */
export interface DeviceReportBody {
  external_id: string;
  /** Who reported it (`intune`, `jamf`, …); defaults to `api`. */
  source?: string;
  user_id?: string | null;
  user_email?: string;
  name?: string | null;
  platform?: string | null;
  managed?: boolean;
  compliant?: boolean;
  posture?: Record<string, unknown>;
  /** Typed posture; `null` or absent = unknown (never assumed good). */
  os_version?: string | null;
  disk_encrypted?: boolean | null;
  screen_lock?: boolean | null;
  secure_hardware?: boolean | null;
  jailbroken?: boolean | null;
  firewall?: boolean | null;
  edr_present?: boolean | null;
}

export type DevicePlatform = 'any' | 'macos' | 'windows' | 'linux' | 'ios' | 'android' | 'chromeos';

export interface DeviceAssurancePolicy {
  object: 'device_assurance_policy';
  id: string;
  name: string;
  platform: DevicePlatform;
  enabled: boolean;
  min_os_version: string | null;
  os_latest_minus: number | null;
  require_disk_encryption: boolean;
  require_screen_lock: boolean;
  require_secure_hardware: boolean;
  block_jailbroken: boolean;
  require_firewall: boolean;
  require_edr: boolean;
  grace_hours: number;
  created_at: number;
  updated_at: number;
}

export type DeviceAssurancePolicyBody = Partial<Omit<DeviceAssurancePolicy, 'object' | 'id' | 'created_at' | 'updated_at'>> & { name?: string };

export type DeviceIntegrationProvider = 'intune' | 'jamf' | 'crowdstrike' | 'fleet' | 'chrome';

export interface DeviceIntegration {
  object: 'device_integration';
  id: string;
  provider: DeviceIntegrationProvider;
  name: string;
  status: 'active' | 'paused';
  config: Record<string, unknown>;
  has_credentials: boolean;
  interval_minutes: number;
  next_sync_at: number | null;
  last_sync_at: number | null;
  last_status: string | null;
  last_error: string | null;
  last_stats: Record<string, unknown>;
  created_at: number;
  updated_at: number;
}

export interface DeviceIntegrationBody {
  provider?: DeviceIntegrationProvider;
  name?: string;
  /** Intune `{ tenantId }`; Jamf and Fleet `{ baseUrl }`; CrowdStrike `{ cloud, minZtaScore?, userEmailDomain? }`; Chrome `{ customer? }`. */
  config?: Record<string, unknown>;
  /** Write-only. Intune and Jamf and CrowdStrike `{ clientId, clientSecret }`; Fleet `{ apiToken }`; Chrome `{ clientEmail, privateKey, adminEmail }`. */
  credentials?: Record<string, unknown>;
  interval_minutes?: number;
  status?: 'active' | 'paused';
}

export function devicesResource(request: RequestFn) {
  return {
    list(query: { user_id?: string; source?: string; platform?: string; assurance_state?: string } = {}): Promise<ListPage<Device>> {
      const q = new URLSearchParams(Object.entries(query).filter((e): e is [string, string] => e[1] !== undefined)).toString();
      return request({ method: 'GET', path: `/v1/devices${q ? `?${q}` : ''}` });
    },
    get(id: string): Promise<Device> {
      return request({ method: 'GET', path: `/v1/devices/${enc(id)}` });
    },
    report(body: DeviceReportBody): Promise<Device> {
      return request({ method: 'PUT', path: '/v1/devices', body });
    },
    /** Bulk posture ingestion, up to 500 reports. */
    ingestPosture(devices: DeviceReportBody[]): Promise<ListPage<Device>> {
      return request({ method: 'POST', path: '/v1/device_posture', body: { devices } });
    },
    remove(id: string): Promise<{ object: 'device'; id: string; deleted: true }> {
      return request({ method: 'DELETE', path: `/v1/devices/${enc(id)}` });
    },
    /** The compliance transitions of one device, newest first. */
    complianceHistory(id: string): Promise<ListPage<{ object: 'device_compliance_entry'; id: string; device_id: string; user_id: string | null; state: string; compliant: boolean; failing: string[]; source: string; created_at: number }>> {
      return request({ method: 'GET', path: `/v1/devices/${enc(id)}/compliance_history` });
    },
  };
}

/** Per-platform posture requirements (OS version, disk encryption, screen lock, ...) with a grace period. */
export function deviceAssurancePoliciesResource(request: RequestFn) {
  return {
    list(): Promise<ListPage<DeviceAssurancePolicy>> {
      return request({ method: 'GET', path: '/v1/device_assurance_policies' });
    },
    get(id: string): Promise<DeviceAssurancePolicy> {
      return request({ method: 'GET', path: `/v1/device_assurance_policies/${enc(id)}` });
    },
    create(body: DeviceAssurancePolicyBody & { name: string }): Promise<DeviceAssurancePolicy> {
      return request({ method: 'POST', path: '/v1/device_assurance_policies', body });
    },
    update(id: string, body: DeviceAssurancePolicyBody): Promise<DeviceAssurancePolicy> {
      return request({ method: 'PATCH', path: `/v1/device_assurance_policies/${enc(id)}`, body });
    },
    delete(id: string): Promise<{ object: 'device_assurance_policy'; id: string; deleted: true }> {
      return request({ method: 'DELETE', path: `/v1/device_assurance_policies/${enc(id)}` });
    },
    /** Re-evaluate every device against the current policies. */
    evaluate(): Promise<{ object: 'device_assurance_evaluation'; evaluated: number; changed: number }> {
      return request({ method: 'POST', path: '/v1/device_assurance_policies/evaluate', body: {} });
    },
  };
}

/** Pull connectors for Intune, Jamf Pro, CrowdStrike Falcon, Fleet and Google Chrome / ChromeOS. */
export function deviceIntegrationsResource(request: RequestFn) {
  return {
    list(): Promise<ListPage<DeviceIntegration>> {
      return request({ method: 'GET', path: '/v1/device_integrations' });
    },
    get(id: string): Promise<DeviceIntegration> {
      return request({ method: 'GET', path: `/v1/device_integrations/${enc(id)}` });
    },
    create(body: DeviceIntegrationBody & { provider: DeviceIntegrationProvider; name: string }): Promise<DeviceIntegration> {
      return request({ method: 'POST', path: '/v1/device_integrations', body });
    },
    update(id: string, body: DeviceIntegrationBody): Promise<DeviceIntegration> {
      return request({ method: 'PATCH', path: `/v1/device_integrations/${enc(id)}`, body });
    },
    delete(id: string): Promise<{ object: 'device_integration'; id: string; deleted: true }> {
      return request({ method: 'DELETE', path: `/v1/device_integrations/${enc(id)}` });
    },
    /** Pull now instead of waiting for the schedule. */
    sync(id: string): Promise<{ object: 'device_integration_sync'; integration_id: string; ok: boolean; seen: number; error: string | null }> {
      return request({ method: 'POST', path: `/v1/device_integrations/${enc(id)}/sync`, body: {} });
    },
  };
}
