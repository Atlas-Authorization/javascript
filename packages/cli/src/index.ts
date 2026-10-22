/**
 * Library surface of `@atlasauth/cli`. The package ships a bin (`atlas`), but
 * exporting the pieces lets the handlers be unit-tested with injected deps and
 * lets another tool embed the CLI (e.g. `create-atlas-app`) without spawning a
 * child process.
 */
export { run, type Handler } from './run';
export { defaultContext, type RunContext, type ManagementClient } from './context';
export { createConfigHttp, isNotFound, type ConfigHttp } from './config-http';
export { CliError } from './errors';
export { defaultIO, captureIO, type IO, type CaptureIO } from './io';
export {
  FileConfigStore,
  MemoryConfigStore,
  defaultConfigPath,
  type ConfigStore,
  type ConfigFile,
  type Profile,
} from './config';
export { defaultPrompter, type Prompter } from './prompt';
export { getVersion } from './version';

// The individual command handlers, exported for direct testing/embedding.
export { login, logout, whoami } from './commands/auth';
export { users } from './commands/users';
export { orgs } from './commands/orgs';
export { apiKeys } from './commands/api-keys';
export { webhooks } from './commands/webhooks';
export { sessions } from './commands/sessions';
export { config } from './commands/config';
export { actions } from './commands/actions';
export { init } from './commands/init';
export { preflight, envCommand, client } from './commands/project-commands';
export { referrals } from './commands/referrals';
export {
  writeSecretFile,
  readEnvFile,
  parseDotenv,
  renderDotenv,
  productDir,
  deliverSecret,
} from './secrets';
export {
  readManifest,
  writeManifest,
  manifestPath,
  type ProjectManifest,
  type ProjectInstance,
  type InstanceEnv,
} from './project';
