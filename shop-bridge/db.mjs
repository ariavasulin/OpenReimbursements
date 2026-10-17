// The SQL Server connection: config from env, and one lazily created pool.
import sql from 'mssql';

/**
 * SHOP_DB_SERVER accepts three shapes:
 *   SQL2016\SQLEXPRESS  -> server SQL2016, named instance SQLEXPRESS (found via SQL Browser)
 *   10.0.0.5,1433       -> server 10.0.0.5, port 1433
 *   sql2016.local       -> plain host, default port
 */
export function parseServer(value) {
  const raw = String(value ?? '').trim();
  if (!raw) {
    const err = new Error('SHOP_DB_SERVER is not set');
    err.code = 'ECONFIG';
    throw err;
  }
  const slash = raw.indexOf('\\');
  if (slash !== -1) {
    return { server: raw.slice(0, slash), instanceName: raw.slice(slash + 1) };
  }
  const comma = raw.indexOf(',');
  if (comma !== -1) {
    const port = Number(raw.slice(comma + 1).trim());
    if (!Number.isInteger(port) || port <= 0) throw new Error(`bad port in SHOP_DB_SERVER: ${raw}`);
    return { server: raw.slice(0, comma).trim(), port };
  }
  return { server: raw };
}

export function buildConfig(env = process.env) {
  const { server, instanceName, port } = parseServer(env.SHOP_DB_SERVER);
  const trustCert = (env.SHOP_DB_TRUST_CERT ?? 'true').trim().toLowerCase() !== 'false';
  const config = {
    server,
    database: env.SHOP_DB_NAME,
    requestTimeout: 30000,
    connectionTimeout: 15000,
    pool: { max: 4, min: 0, idleTimeoutMillis: 30000 },
    options: {
      encrypt: true,
      // The shop instance most likely has a self-signed certificate; this hop stays on the LAN.
      trustServerCertificate: trustCert,
      readOnlyIntent: true,
      // Keep datetime values as the wall-clock time stored in SQL Server. With the default
      // (useUTC: true) a 9:00 shop timestamp would land in Postgres shifted by the box's
      // UTC offset, because pg writes JS Dates in local time.
      useUTC: false,
    },
  };
  if (instanceName) config.options.instanceName = instanceName;
  if (port) config.port = port;
  if (env.SHOP_DB_DOMAIN) {
    // Windows account (when the instance only allows Windows logins).
    config.authentication = {
      type: 'ntlm',
      options: {
        domain: env.SHOP_DB_DOMAIN,
        userName: env.SHOP_DB_USER,
        password: env.SHOP_DB_PASSWORD,
      },
    };
  } else {
    config.user = env.SHOP_DB_USER;
    config.password = env.SHOP_DB_PASSWORD;
  }
  return config;
}

let poolPromise = null;

/** The shared pool, connected on first use. A failed connect is retried on the next call. */
export function getPool() {
  if (!poolPromise) {
    const pool = new sql.ConnectionPool(buildConfig());
    pool.on('error', (err) => {
      console.error(`${new Date().toISOString()} sql pool error: ${err.code ?? ''} ${err.message}`);
    });
    poolPromise = pool.connect().catch((err) => {
      poolPromise = null;
      throw err;
    });
  }
  return poolPromise;
}

export async function closePool() {
  const current = poolPromise;
  poolPromise = null;
  if (current) {
    try {
      const pool = await current;
      await pool.close();
    } catch {
      // never connected; nothing to close
    }
  }
}
