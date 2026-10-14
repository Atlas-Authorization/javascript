/**
 * The instance's public sign-in / sign-up settings (`useAtlas().instanceSettings`),
 * read from the same `GET /v1/appearance` response the provider already fetches
 * for the dashboard design. The parser is shared with every framework SDK's
 * prebuilt forms and lives in `@atlasauth/js`.
 */
export {
  instanceSettingsFrom,
  type InstanceSettings,
  type PublicSignUpField,
} from '@atlasauth/js';
