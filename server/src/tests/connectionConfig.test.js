import pg from 'pg';
import tls from 'node:tls';
import { describe, expect, it } from 'vitest';
import {
  APPROVED_NEON_HOST,
  buildDatabaseConnectionConfig,
  selectMigrationDatabaseUrl,
} from '../db/connectionConfig.js';

const productionUrl = `postgresql://neondb_owner:test-only@${APPROVED_NEON_HOST}/neondb?sslmode=verify-full&channel_binding=require`;

describe('database TLS configuration', () => {
  it('uses the exact approved host and explicit verified TLS configuration', () => {
    const config = buildDatabaseConnectionConfig(productionUrl, 'production', { max: 3 });
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

  it.each([
    productionUrl.replace('sslmode=verify-full', 'sslmode=require'),
    productionUrl.replace('?sslmode=verify-full&', '?'),
  ])('rejects production URLs that do not require full verification', url => {
    expect(() => buildDatabaseConnectionConfig(url, 'production'))
      .toThrow('Production DATABASE_URL must include exactly one sslmode=verify-full parameter.');
  });

  it.each([
    productionUrl.replace(APPROVED_NEON_HOST, 'ep-withered-wildflower-azfhemim-pooler.c-3.ap-southeast-1.aws.neon.tech'),
    productionUrl.replace(APPROVED_NEON_HOST, 'database.neon.tech'),
    productionUrl.replace(APPROVED_NEON_HOST, 'localhost'),
  ])('rejects non-direct Neon hosts in production', url => {
    expect(() => buildDatabaseConnectionConfig(url, 'production'))
      .toThrow('Production DATABASE_URL must use the approved direct Neon hostname.');
  });

  it('preserves local and test SSL behavior', () => {
    expect(buildDatabaseConnectionConfig('postgres://user:pass@localhost/pawpal', 'development').ssl)
      .toBe(false);
    const testConfig = buildDatabaseConnectionConfig(
      'postgres://user:pass@localhost/pawpal_test?sslmode=require',
      'test'
    );
    expect(testConfig).not.toHaveProperty('ssl');
    expect(new pg.Client(testConfig).connectionParameters.ssl).toEqual({});
  });

  it('selects TEST_DATABASE_URL in test mode and refuses other test database names', () => {
    const testUrl = 'postgres://test:test@localhost/pawpal_test';
    const mainUrl = 'postgres://main:main@localhost/pawpal';

    expect(selectMigrationDatabaseUrl({ nodeEnv: 'test', testDatabaseUrl: testUrl, databaseUrl: mainUrl }))
      .toBe(testUrl);
    expect(selectMigrationDatabaseUrl({ runOnTestDb: '1', nodeEnv: 'development', testDatabaseUrl: testUrl, databaseUrl: mainUrl }))
      .toBe(testUrl);
    expect(() => selectMigrationDatabaseUrl({ nodeEnv: 'test', databaseUrl: mainUrl }))
      .toThrow('TEST_DATABASE_URL is required for test migrations; refusing to fall back to DATABASE_URL.');
    expect(() => selectMigrationDatabaseUrl({ nodeEnv: 'test', testDatabaseUrl: mainUrl, databaseUrl: mainUrl }))
      .toThrow('Test migrations may connect only to the pawpal_test database.');
  });
});
