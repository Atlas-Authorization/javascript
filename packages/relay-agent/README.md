# @atlasauth/relay-agent

Outbound-only relay agent for Atlas. Run it inside a private network: it polls Atlas for work, performs LDAP
binds/searches and HTTP calls locally, and posts results back. No inbound port is opened.

```
ATLAS_RELAY_URL=https://api.atlasauth.net \
ATLAS_RELAY_TOKEN=rla_... \
RELAY_ALLOW='dc1.corp.example:636,hr.corp.example:443' \
npx @atlasauth/relay-agent
```

Set `RELAY_CLIENT_CERT` / `RELAY_CLIENT_KEY` (PEM paths) for mutual TLS. See the "On-prem relay agent" guide.

## Write-back (off by default)

The agent only reads unless you allow more. Turn each on deliberately:

- `RELAY_ALLOW_WRITE=1` lets Atlas create, change and delete directory entries (Active Directory user and group provisioning). The connection must be `ldaps://`, since passwords are set.
- `RELAY_ALLOW_SQL=1` lets Atlas run its configured, parameterized SQL statements against a database, in one transaction per job. Install the driver you use next to the agent: `npm install pg` (PostgreSQL), `mysql2`, `mssql` or `oracledb`. The database host and port must be on `RELAY_ALLOW`, and the connection can only go to the destination the job names.
