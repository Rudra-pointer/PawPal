import tls from 'node:tls';
import connectionString from 'pg-connection-string';

const { parse } = connectionString;

export const APPROVED_NEON_HOST = 'ep-withered-wildflower-azfhemim.c-3.ap-southeast-1.aws.neon.tech';

export const APPROVED_MIGRATION_FILES = Object.freeze([
  '001_initial_schema.sql',
  '002_reports_open_per_target.sql',
  '003_open_species.sql',
]);

const approvedMigrationJson = JSON.stringify(APPROVED_MIGRATION_FILES);

export function assertApprovedMigrationInventory(files) {
  const sqlFiles = files.filter(file => file.endsWith('.sql')).sort();
  if (JSON.stringify(sqlFiles) !== approvedMigrationJson) {
    throw new Error('Migration inventory must contain only the three approved SQL migrations.');
  }
  return [...APPROVED_MIGRATION_FILES];
}

export function postgresMajorVersion(serverVersionNum) {
  const versionNumber = Number(serverVersionNum);
  if (!Number.isSafeInteger(versionNumber) || versionNumber < 10000) {
    throw new Error('Invalid PostgreSQL server_version_num.');
  }
  return Math.floor(versionNumber / 10000);
}

export function assertProductionDatabaseIdentity({ database, role, serverVersion, serverVersionNum }) {
  if (database !== 'neondb' || role !== 'neondb_owner') {
    throw new Error('Connected production database identity does not match the approved target.');
  }
  if (!String(serverVersion).startsWith('18.6') || postgresMajorVersion(serverVersionNum) !== 18) {
    throw new Error('Connected production PostgreSQL server must be version 18.6.');
  }
  return true;
}

export function assertFreshProductionSchema({ publicBaseTables, hasSchemaMigrations }) {
  if (publicBaseTables !== 0 || hasSchemaMigrations !== false) {
    throw new Error('Production migrations require an empty public schema with no schema_migrations table.');
  }
  return true;
}

function requireSingleParameter(url, name, expectedValue) {
  const values = url.searchParams.getAll(name);
  if (values.length !== 1 || values[0] !== expectedValue) {
    throw new Error(`Production DATABASE_URL must include exactly one ${name}=${expectedValue} parameter.`);
  }
}

/**
 * Parse the URL before constructing pg options. Omitting connectionString from
 * the returned config prevents pg from reparsing it over the explicit TLS
 * verification options.
 */
export function buildDatabaseConnectionConfig(connectionStringValue, nodeEnv, options = {}) {
  const url = new URL(connectionStringValue);

  if (nodeEnv === 'production') {
    if (Object.hasOwn(options, 'connectionString')) {
      throw new Error('Production pg configuration must not include connectionString alongside explicit TLS options.');
    }
    const host = url.hostname.toLowerCase();
    const user = decodeURIComponent(url.username);
    const database = decodeURIComponent(url.pathname.replace(/^\//, ''));

    if (host.includes('-pooler') || host !== APPROVED_NEON_HOST) {
      throw new Error('Production DATABASE_URL must use the approved direct Neon hostname.');
    }
    if (database !== 'neondb') {
      throw new Error('Production DATABASE_URL must target the neondb database.');
    }
    if (user !== 'neondb_owner') {
      throw new Error('Production DATABASE_URL must use the neondb_owner role.');
    }
    requireSingleParameter(url, 'sslmode', 'verify-full');
    // pg@8.23.1 parses but does not enforce channel_binding=require itself.
    // Keep requiring the URL option without claiming the SCRAM policy is enforced.
    requireSingleParameter(url, 'channel_binding', 'require');
    const parsed = parse(connectionStringValue);
    if (parsed.host !== APPROVED_NEON_HOST || parsed.database !== 'neondb' ||
        parsed.user !== 'neondb_owner' || !parsed.password) {
      throw new Error('Parsed production DATABASE_URL does not match the approved host, database, role, and credential requirements.');
    }

    return {
      ...options,
      host: parsed.host,
      port: Number(parsed.port || 5432),
      database: parsed.database,
      user: parsed.user,
      password: parsed.password,
      ssl: {
        rejectUnauthorized: true,
        checkServerIdentity: tls.checkServerIdentity,
        servername: APPROVED_NEON_HOST,
      },
    };
  }

  const sslMode = url.searchParams.get('sslmode')?.toLowerCase();
  return sslMode
    ? { ...options, connectionString: connectionStringValue }
    : { ...options, connectionString: connectionStringValue, ssl: false };
}

/** Verify the established pg TLS connection before a production preflight. */
export function assertVerifiedProductionConnection(client) {
  const parameters = client?.connectionParameters;
  const ssl = parameters?.ssl;
  const stream = client?.connection?.stream;

  if (parameters?.host !== APPROVED_NEON_HOST || ssl?.servername !== APPROVED_NEON_HOST) {
    throw new Error('Production PostgreSQL connection host does not match the approved Neon hostname.');
  }
  if (ssl?.rejectUnauthorized !== true || ssl?.checkServerIdentity !== tls.checkServerIdentity) {
    throw new Error('Production PostgreSQL TLS must verify the certificate chain and standard hostname identity.');
  }
  if (stream?.encrypted !== true || stream?.authorized !== true || typeof stream.getPeerCertificate !== 'function') {
    throw new Error('Production PostgreSQL connection is not an authorized TLS connection.');
  }

  const certificate = stream.getPeerCertificate(true);
  const hostnameError = tls.checkServerIdentity(APPROVED_NEON_HOST, certificate);
  if (hostnameError) {
    throw new Error('Production PostgreSQL peer certificate does not match the approved Neon hostname.');
  }
  return true;
}

export function selectMigrationDatabaseUrl({ runOnTestDb, nodeEnv, testDatabaseUrl, databaseUrl }) {
  const useTestDatabase = runOnTestDb === '1' || nodeEnv === 'test';
  if (useTestDatabase && !testDatabaseUrl) {
    throw new Error('TEST_DATABASE_URL is required for test migrations; refusing to fall back to DATABASE_URL.');
  }

  const selectedUrl = useTestDatabase ? testDatabaseUrl : databaseUrl;
  if (!selectedUrl) throw new Error('DATABASE_URL is required for migrations.');
  if (useTestDatabase && new URL(selectedUrl).pathname !== '/pawpal_test') {
    throw new Error('Test migrations may connect only to the pawpal_test database.');
  }
  return selectedUrl;
}
