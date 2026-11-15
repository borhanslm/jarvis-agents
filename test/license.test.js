// Android app licenses: issue on the seller's computer, check offline on the phone.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { pathToFileURL } = require('url');
const L = require('../lib/license');

const keys = L.generateKeys();
const DEV = L.deviceCodeFrom('a1b2c3d4e5f60718');

test('device code: stable, 3 groups of 4, no raw id inside', () => {
  assert.match(DEV, L.DEVICE_RE);
  assert.strictEqual(L.deviceCodeFrom('a1b2c3d4e5f60718'), DEV);
  assert.notStrictEqual(L.deviceCodeFrom('other'), DEV);
  assert.strictEqual(L.normDevice(DEV.toLowerCase().replace(/-/g, ' ')), DEV);
});

test('a key works only on its own phone, cannot be forged, and carries one year of updates', () => {
  const now = Date.parse('2026-11-15T10:00:00Z');
  const { key, payload } = L.issue({ privateKey: keys.privateKey, device: DEV, buyer: 'علی', now });
  assert.match(key, /^JRV1\.[\w-]+\.[\w-]+$/);
  assert.strictEqual(L.verify(key, keys.publicKey, DEV).ok, true);
  assert.strictEqual(L.verify(key, keys.publicKey, 'AAAA-BBBB-CCCC').reason, 'device');
  // tampering (e.g. changing the device inside) breaks the signature
  const [, p, sig] = key.split('.');
  const forged = JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()); forged.d = 'AAAA-BBBB-CCCC';
  assert.strictEqual(L.verify('JRV1.' + L.b64u(JSON.stringify(forged)) + '.' + sig, keys.publicKey, 'AAAA-BBBB-CCCC').reason, 'signature');
  // another seller's key pair does not validate it
  assert.strictEqual(L.verify(key, L.generateKeys().publicKey, DEV).reason, 'signature');
  // update window: ~365 days
  assert.ok(payload.u - payload.i >= 364 && payload.u - payload.i <= 366);
  assert.strictEqual(L.verify(key, keys.publicKey, DEV, { buildDay: payload.u }).ok, true);
  assert.strictEqual(L.verify(key, keys.publicKey, DEV, { buildDay: payload.u + 1 }).reason, 'updates');
  assert.throws(() => L.issue({ privateKey: keys.privateKey, device: 'bad' }), /کد دستگاه/);
});

test('the phone-side check (WebCrypto) accepts the same keys', async () => {
  const { verifyLicense } = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'license-verify.js')).href);
  const { key } = L.issue({ privateKey: keys.privateKey, device: DEV, buyer: 'Sara' });
  assert.strictEqual((await verifyLicense(key, keys.publicKey, DEV)).ok, true);
  assert.strictEqual((await verifyLicense(key, keys.publicKey, 'AAAA-BBBB-CCCC')).reason, 'device');
  assert.strictEqual((await verifyLicense(key.slice(0, -4) + 'AAAA', keys.publicKey, DEV)).reason, 'signature');
  assert.strictEqual((await verifyLicense('nonsense', keys.publicKey, DEV)).reason, 'format');
});
