import { bindPlaceholders, type SqlJob, type SqlResult } from './agent';

/**
 * Runs a sql job against the customer's own database in one transaction. The database drivers are loaded on
 * demand (install the one you use next to the agent: `npm install pg`, `mysql2`, `mssql` or `oracledb`),
 * so an agent that never runs SQL carries none of them.
 */
const MAX_ROWS = 100;

async function load(name: string): Promise<any> {
  try {
    return await import(name);
  } catch {
    throw new Error(`The ${name} package is not installed on this agent. Install it next to the agent (npm install ${name}).`);
  }
}

export async function runSql(job: SqlJob): Promise<SqlResult> {
  const statements = job.statements.map((s) => ({ sql: bindPlaceholders(s.sql, job.driver), params: s.params }));
  let last: SqlResult = {};
  if (job.driver === 'postgres') {
    const { Client } = await load('pg');
    const c = new Client({ host: job.host, port: job.port, database: job.database, user: job.user, password: job.password, ssl: job.tls ? { rejectUnauthorized: true } : false, connectionTimeoutMillis: 10_000, statement_timeout: 15_000 });
    await c.connect();
    try {
      await c.query('begin');
      for (const s of statements) {
        const r = await c.query(s.sql, s.params);
        last = { rows: (r.rows ?? []).slice(0, MAX_ROWS), rowCount: r.rowCount ?? 0 };
      }
      await c.query('commit');
    } catch (e) {
      await c.query('rollback').catch(() => undefined);
      throw e;
    } finally {
      await c.end().catch(() => undefined);
    }
    return last;
  }
  if (job.driver === 'mysql') {
    const mysql = await load('mysql2/promise');
    const c = await mysql.createConnection({ host: job.host, port: job.port, database: job.database, user: job.user, password: job.password, ssl: job.tls ? {} : undefined, connectTimeout: 10_000 });
    try {
      await c.beginTransaction();
      for (const s of statements) {
        const [r] = await c.execute(s.sql, s.params);
        last = Array.isArray(r) ? { rows: r.slice(0, MAX_ROWS), rowCount: r.length } : { rowCount: r.affectedRows ?? 0, insertId: r.insertId ?? null };
      }
      await c.commit();
    } catch (e) {
      await c.rollback().catch(() => undefined);
      throw e;
    } finally {
      await c.end().catch(() => undefined);
    }
    return last;
  }
  if (job.driver === 'mssql') {
    const mssql = await load('mssql');
    const pool = await mssql.connect({ server: job.host, port: job.port, database: job.database, user: job.user, password: job.password, options: { encrypt: job.tls, trustServerCertificate: false }, connectionTimeout: 10_000, requestTimeout: 15_000 });
    const tx = new mssql.Transaction(pool);
    try {
      await tx.begin();
      for (const s of statements) {
        const req = new mssql.Request(tx);
        s.params.forEach((v, i) => req.input(`p${i + 1}`, v));
        const r = await req.query(s.sql);
        last = { rows: (r.recordset ?? []).slice(0, MAX_ROWS), rowCount: (r.rowsAffected ?? [0])[0] ?? 0 };
      }
      await tx.commit();
    } catch (e) {
      await tx.rollback().catch(() => undefined);
      throw e;
    } finally {
      await pool.close().catch(() => undefined);
    }
    return last;
  }
  const oracledb = (await load('oracledb')).default ?? (await load('oracledb'));
  const c = await oracledb.getConnection({ user: job.user, password: job.password, connectString: `${job.host}:${job.port}/${job.database}` });
  try {
    for (const s of statements) {
      const r = await c.execute(s.sql, s.params, { autoCommit: false, outFormat: oracledb.OUT_FORMAT_OBJECT });
      const rows = (r.rows ?? []).slice(0, MAX_ROWS).map((row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k.toLowerCase(), v])));
      last = { rows, rowCount: r.rowsAffected ?? rows.length };
    }
    await c.commit();
  } catch (e) {
    await c.rollback().catch(() => undefined);
    throw e;
  } finally {
    await c.close().catch(() => undefined);
  }
  return last;
}
