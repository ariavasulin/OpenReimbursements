import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildConfig, parseServer } from './db.mjs';

const ENV = { SHOP_DB_SERVER: 'SQL2016\\SQLEXPRESS', SHOP_DB_NAME: 'DWS', SHOP_DB_USER: 'u', SHOP_DB_PASSWORD: 'p' };

test('SHOP_DB_SERVER and SHOP_DB_NAME are both required, as configuration errors', () => {
  for (const name of ['SHOP_DB_SERVER', 'SHOP_DB_NAME']) {
    for (const value of [undefined, '', '  ']) {
      assert.throws(() => buildConfig({ ...ENV, [name]: value }), { code: 'ECONFIG', message: `${name} is not set` });
    }
  }
});

test('buildConfig: named instance, database, encryption', () => {
  const config = buildConfig(ENV);
  assert.equal(config.server, 'SQL2016');
  assert.equal(config.options.instanceName, 'SQLEXPRESS');
  assert.equal(config.database, 'DWS');
  assert.equal(config.options.encrypt, true);
  assert.equal(config.user, 'u');
});

test('parseServer: host,port and plain host', () => {
  assert.deepEqual(parseServer('10.0.0.5,1433'), { server: '10.0.0.5', port: 1433 });
  assert.deepEqual(parseServer('sql2016.local'), { server: 'sql2016.local' });
});
