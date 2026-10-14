# @atlasauth/agent-toolkit

Safe, scoped Atlas identity tools for AI agents — the Atlas peer of
`@clerk/agent-toolkit`. It wraps the [`@atlasauth/backend`](../backend) management
client and exposes its operations as framework-native tools for the
**Vercel AI SDK** and **LangChain**.

## Safety model — scoping is mandatory and safe by default

> An AI agent must not be able to delete a user, revoke a session, or create an
> org unless you explicitly opted in.

With no `allowedTools` / `scopes`, the toolkit exposes **only read tools**. Every
write — and the two irreversible deletes (`delete_user`, `delete_organization`) —
is hidden until you grant it. Nothing destructive is reachable by accident.

You opt in two ways:

- **`allowedTools`** — an explicit allowlist of tool names. Authoritative: a tool
  is exposed iff its name is listed (and `scopes` is ignored). Use it for
  surgical control.
- **`scopes`** — `resource:verb` grants, where either half may be `*`:
  `users:read`, `organizations:*`, `*:read`. A `write` scope implies `read` for
  the same resource; **`delete` is only ever granted by an explicit `:delete`
  (or `:*`)** — never by `write`.

Results are sanitized at the boundary: `private_metadata`, `unsafe_metadata`, and
credentials (`secret`, `jwt`, `refresh_token`, `token`) are stripped from every
tool result, so they never reach the model.

## Install

```sh
npm i @atlasauth/agent-toolkit
# plus the framework(s) you use (optional peers):
npm i ai            # for /ai-sdk
npm i @langchain/core  # for /langchain
```

## Usage

### Vercel AI SDK (primary)

```ts
import { createAtlasToolkit } from '@atlasauth/agent-toolkit';
import { toAiSdkTools } from '@atlasauth/agent-toolkit/ai-sdk';
import { generateText } from 'ai';

const toolkit = createAtlasToolkit({
  secretKey: process.env.ATLAS_SECRET_KEY!, // or: backend: myAtlasClient
  scopes: ['users:read', 'organizations:read'], // reads only here
});

await generateText({ model, tools: toAiSdkTools(toolkit), prompt: '…' });
```

### LangChain

```ts
import { createAtlasToolkit } from '@atlasauth/agent-toolkit';
import { toLangChainTools } from '@atlasauth/agent-toolkit/langchain';

const toolkit = createAtlasToolkit({
  secretKey: process.env.ATLAS_SECRET_KEY!,
  allowedTools: ['get_user', 'list_users', 'ban_user'], // one gated write, two reads
});

const tools = toLangChainTools(toolkit); // DynamicStructuredTool[]
```

## Tools

| Resource | Reads (default) | Gated writes / deletes |
| --- | --- | --- |
| users | `get_user`, `list_users` | `create_user`, `update_user`, `ban_user`, `unban_user`, `delete_user` |
| organizations | `get_organization`, `list_organizations`, `get_organization_members` | `create_organization`, `update_organization`, `delete_organization`, `add_organization_member`, `remove_organization_member`, `update_organization_member_role` |
| invitations | `list_invitations` | `create_invitation`, `revoke_invitation` |
| sessions | `list_user_sessions` | `revoke_session` |
| api_keys | `list_api_keys` | `create_api_key`, `revoke_api_key` |

`create_api_key` never returns the one-time plaintext secret (it is stripped);
mint through `@atlasauth/backend` directly if you need it.

## License

MIT
