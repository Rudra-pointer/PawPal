import tls from 'node:tls';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import {
  APPROVED_MIGRATION_FILES,
  APPROVED_NEON_HOST,
  assertApprovedMigrationInventory,
  assertFreshProductionSchema,
  assertProductionDatabaseIdentity,
  assertVerifiedProductionConnection,
  buildDatabaseConnectionConfig,
  postgresMajorVersion,
} from './connectionConfig.js';

const productionUrl = `postgresql://neondb_owner:test-only@${APPROVED_NEON_HOST}/neondb?sslmode=verify-full&channel_binding=require`;

function certificate(host = APPROVED_NEON_HOST) {
  return { subject: { CN: host }, subjectaltname: `DNS:${host}` };
}

function connectedClient({ host = APPROVED_NEON_HOST, cert = certificate(), encrypted = true, authorized = true } = {}) {
  return {
    connectionParameters: {
      host,
      ssl: {
        rejectUnauthorized: true,
        checkServerIdentity: tls.checkServerIdentity,
        servername: APPROVED_NEON_HOST,
      },
    },
    connection: {
      stream: { encrypted, authorized, getPeerCertificate: () => cert },
    },
  };
}

describe('production PostgreSQL connection configuration', () => {
  it('constructs an effective pg config with explicit TLS and the approved hostname', () => {
    const config = buildDatabaseConnectionConfig(productionUrl, 'production', {
      max: 3,
      host: 'wrong.example',
      database: 'wrong_db',
      user: 'wrong_role',
      ssl: false,
    });
    const client = new pg.Client(config);

    expect(config).not.toHaveProperty('connectionString');
    expect(config.host).toBe(APPROVED_NEON_HOST);
    expect(config.database).toBe('neondb');
    expect(config.user).toBe('neondb_owner');
    expect(config.ssl.rejectUnauthorized).toBe(true);
    expect(config.ssl.checkServerIdentity).toBe(tls.checkServerIdentity);
    expect(config.ssl.servername).toBe(APPROVED_NEON_HOST);
    expect(client.connectionParameters.host).toBe(APPROVED_NEON_HOST);
    expect(client.connectionParameters.ssl.rejectUnauthorized).toBe(true);
    expect(client.connectionParameters.ssl.checkServerIdentity).toBe(tls.checkServerIdentity);
    expect(client.connectionParameters.ssl.servername).toBe(APPROVED_NEON_HOST);
  });

  it('prevents a caller connectionString from overriding explicit SSL options', () => {
    expect(() => buildDatabaseConnectionConfig(productionUrl, 'production', {
      connectionString: 'postgres://ignored:ignored@localhost/ignored',
    })).toThrow(/must not include connectionString alongside explicit TLS options/);
  });

  it.each([
    `postgresql://neondb_owner:test-only@ep-other.ap-southeast-1.aws.neon.tech/neondb?sslmode=verify-full&channel_binding=require`,
    `postgresql://neondb_owner:test-only@ep-withered-wildflower-azfhemim-pooler.c-3.ap-southeast-1.aws.neon.tech/neondb?sslmode=verify-full&channel_binding=require`,
    `postgresql://neondb_owner:test-only@localhost/neondb?sslmode=verify-full&channel_binding=require`,
  ])('rejects non-approved and pooled hosts', url => {
    expect(() => buildDatabaseConnectionConfig(url, 'production'))
      .toThrow('Production DATABASE_URL must use the approved direct Neon hostname.');
  });

  it.each([
    `postgresql://neondb_owner:test-only@${APPROVED_NEON_HOST}/pawpal?sslmode=verify-full&channel_binding=require`,
    `postgresql://other_role:test-only@${APPROVED_NEON_HOST}/neondb?sslmode=verify-full&channel_binding=require`,
  ])('rejects a wrong database or role', url => {
    expect(() => buildDatabaseConnectionConfig(url, 'production')).toThrow();
  });

  it.each([
    productionUrl.replace('sslmode=verify-full', 'sslmode=require'),
    productionUrl.replace('?sslmode=verify-full&', '?'),
    `${productionUrl}&sslmode=verify-full`,
    productionUrl.replace('channel_binding=require', 'channel_binding=prefer'),
    productionUrl.replace('&channel_binding=require', ''),
  ])('rejects invalid, missing, or duplicate security query parameters', url => {
    expect(() => buildDatabaseConnectionConfig(url, 'production')).toThrow();
  });
});

describe('verified PostgreSQL TLS socket', () => {
  it('requires encrypted and authorized TLS with the standard hostname check', () => {
    expect(assertVerifiedProductionConnection(connectedClient())).toBe(true);
  });

  it('rejects disabled verification or a non-standard hostname callback', () => {
    const insecure = connectedClient();
    insecure.connectionParameters.ssl.rejectUnauthorized = false;
    expect(() => assertVerifiedProductionConnection(insecure)).toThrow(/verify the certificate chain/);

    const bypassed = connectedClient();
    bypassed.connectionParameters.ssl.checkServerIdentity = () => undefined;
    expect(() => assertVerifiedProductionConnection(bypassed)).toThrow(/standard hostname identity/);
  });

  it('rejects an unencrypted or unauthorized socket and a mismatched peer certificate', () => {
    expect(() => assertVerifiedProductionConnection(connectedClient({ encrypted: false }))).toThrow(/authorized TLS/);
    expect(() => assertVerifiedProductionConnection(connectedClient({ authorized: false }))).toThrow(/authorized TLS/);
    expect(() => assertVerifiedProductionConnection(connectedClient({ cert: certificate('wrong.example') })))
      .toThrow(/does not match the approved Neon hostname/);
  });
});

describe('production preflight helpers', () => {
  it('calculates PostgreSQL major versions from the numeric server_version_num', () => {
    expect(postgresMajorVersion(180006)).toBe(18);
    expect(postgresMajorVersion('180006')).toBe(18);
    expect(postgresMajorVersion(160000)).toBe(16);
    expect(() => postgresMajorVersion('18.6')).toThrow(/Invalid PostgreSQL server_version_num/);
  });

  it('validates the connected production database, role, and PostgreSQL 18.6', () => {
    expect(assertProductionDatabaseIdentity({
      database: 'neondb',
      role: 'neondb_owner',
      serverVersion: '18.6',
      serverVersionNum: 180006,
    })).toBe(true);
    expect(() => assertProductionDatabaseIdentity({
      database: 'pawpal', role: 'neondb_owner', serverVersion: '18.6', serverVersionNum: 180006,
    })).toThrow(/identity/);
    expect(() => assertProductionDatabaseIdentity({
      database: 'neondb', role: 'other_role', serverVersion: '18.6', serverVersionNum: 180006,
    })).toThrow(/identity/);
    expect(() => assertProductionDatabaseIdentity({
      database: 'neondb', role: 'neondb_owner', serverVersion: '18.5', serverVersionNum: 180005,
    })).toThrow(/version 18.6/);
  });

  it('maps PostgreSQL query row fields before validating the production version', () => {
    const target = {
      database: 'neondb',
      role: 'neondb_owner',
      server_version: '18.6 (4e5fd08)',
      server_version_num: 180006,
    };

    expect(assertProductionDatabaseIdentity({
      database: target.database,
      role: target.role,
      serverVersion: target.server_version,
      serverVersionNum: target.server_version_num,
    })).toBe(true);

    expect(() => assertProductionDatabaseIdentity({
      database: target.database,
      role: target.role,
      serverVersion: '18.5 (older)',
      serverVersionNum: 180005,
    })).toThrow('Connected production PostgreSQL server must be version 18.6.');
  });

  it('requires no public base tables and no migration tracking table before first production migration', () => {
    expect(assertFreshProductionSchema({ publicBaseTables: 0, hasSchemaMigrations: false })).toBe(true);
    expect(() => assertFreshProductionSchema({ publicBaseTables: 1, hasSchemaMigrations: false })).toThrow(/empty public schema/);
    expect(() => assertFreshProductionSchema({ publicBaseTables: 0, hasSchemaMigrations: true })).toThrow(/empty public schema/);
  });

  it('accepts the exact approved migration inventory and rejects changes', () => {
    expect(assertApprovedMigrationInventory([...APPROVED_MIGRATION_FILES, 'README.txt']))
      .toEqual(APPROVED_MIGRATION_FILES);
    expect(() => assertApprovedMigrationInventory([...APPROVED_MIGRATION_FILES, '004_extra.sql']))
      .toThrow(/only the three approved SQL migrations/);
    expect(() => assertApprovedMigrationInventory(APPROVED_MIGRATION_FILES.slice(1)))
      .toThrow(/only the three approved SQL migrations/);
  });
});
