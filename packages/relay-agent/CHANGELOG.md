# @atlasauth/relay-agent changelog

## 0.2.0 — 2026-10-27

### Added

- `ldap_write` jobs: create, change and delete directory entries, for Active Directory user and group provisioning. Off unless the agent is started with `RELAY_ALLOW_WRITE=1`; requires `ldaps://`.
- `sql` jobs: run Atlas's configured, parameterized statements against PostgreSQL, MySQL, SQL Server or Oracle in one transaction. Off unless the agent is started with `RELAY_ALLOW_SQL=1`; the database driver is installed next to the agent, and the connection can only go to the allow-listed destination the job names.
- LDAP search can return only the attributes it names.

## 0.1.0 — 2026-10-26

### Added

- First release. Outbound-only relay agent: lets Atlas reach LDAP / Active Directory and HTTP targets inside a private network without opening an inbound port.
