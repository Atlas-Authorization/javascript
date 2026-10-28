import { azurePlugin } from '../azure-ad-b2c/plugin';
import type { MigrationPlugin } from '../framework/plugin';

/**
 * `atlas migrate entra-external-id` — Microsoft Entra External ID (external
 * tenants). Same Graph exporter and translator as Azure AD B2C; lazy
 * migration through the native authentication API (external tenants have no
 * ROPC) and the bridge matching on the `oid` claim.
 */
export const entraExternalIdPlugin: MigrationPlugin = azurePlugin('entra');
