// Licenses for the paid Android app — offline, no server, no payment gateway.
//
//   seller (you):   makes a signing key pair once; the private half never leaves this computer.
//   buyer:          sends the phone's "device code" + the payment receipt (card to card).
//   seller:         issues a key for that device code: JRV1.<payload>.<signature>
//   Android app:    checks the signature with the public key (built into the app) and the device
//                   code — no internet needed. One phone per key; one year of updates.
//
// ECDSA P-256 / SHA-256 with raw (IEEE P1363) signatures, so the phone can verify with WebCrypto.
'use strict';

const crypto = require('crypto');

const b64u = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const DAY = 864e5;
const day = ms => Math.floor(ms / DAY);
const DEVICE_RE = /^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/; // base32, 3 groups of 4

function generateKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64') };
}
const normDevice = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^(.{4})(.{4})(.{4})$/, '$1-$2-$3');

// payload: { v, id, d: device, b: buyer, i: issued day, u: updates-until day }
function issue({ privateKey, device, buyer = '', updateMonths = 12, now = Date.now() }) {
  const d = normDevice(device);
  if (!DEVICE_RE.test(d)) throw new Error('کد دستگاه معتبر نیست (مثل ABCD-EF23-GH45)');
  if (!privateKey) throw new Error('کلید امضای فروش ساخته نشده است');
  const payload = { v: 1, id: crypto.randomBytes(4).toString('hex'), d, b: String(buyer).trim().slice(0, 40), i: day(now), u: day(now) + Math.round(Math.max(0, Math.min(120, +updateMonths || 12)) * 30.44) };
  const p = b64u(JSON.stringify(payload));
  const key = crypto.createPrivateKey({ key: Buffer.from(privateKey, 'base64'), format: 'der', type: 'pkcs8' });
  const sig = crypto.sign('sha256', Buffer.from(p), { key, dsaEncoding: 'ieee-p1363' });
  return { key: `JRV1.${p}.${b64u(sig)}`, payload };
}

// -> { ok, reason?, payload? }   (buildDay: the app's build date in days, for the update window)
function verify(licenseKey, publicKey, device, { buildDay } = {}) {
  const m = /^JRV1\.([\w-]+)\.([\w-]+)$/.exec(String(licenseKey || '').trim().replace(/\s+/g, ''));
  if (!m) return { ok: false, reason: 'format' };
  let pub; try { pub = crypto.createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' }); } catch { return { ok: false, reason: 'publicKey' }; }
  const good = crypto.verify('sha256', Buffer.from(m[1]), { key: pub, dsaEncoding: 'ieee-p1363' }, unb64u(m[2]));
  if (!good) return { ok: false, reason: 'signature' };
  let payload; try { payload = JSON.parse(unb64u(m[1]).toString('utf8')); } catch { return { ok: false, reason: 'format' }; }
  if (device != null && normDevice(device) !== payload.d) return { ok: false, reason: 'device', payload };
  if (buildDay != null && buildDay > payload.u) return { ok: false, reason: 'updates', payload };
  return { ok: true, payload };
}
const REASON_FA = { format: 'کلید درست وارد نشده', publicKey: 'کلید عمومی نامعتبر است', signature: 'این کلید معتبر نیست (امضا نمی‌خورد)', device: 'این کلید برای گوشی دیگری صادر شده', updates: 'مهلت یک‌ساله‌ی آپدیت این کلید برای این نسخه تمام شده' };

// The phone's device code: a short, stable hash (Android ID + app id) — no personal data inside.
function deviceCodeFrom(androidId, appId = 'ai.jarvis.app') {
  const h = crypto.createHash('sha256').update(String(androidId) + '|' + appId).digest();
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, val = 0, out = '';
  for (const byte of h) { val = (val << 8) | byte; bits += 8; while (bits >= 5 && out.length < 12) { out += A[(val >>> (bits - 5)) & 31]; bits -= 5; } if (out.length >= 12) break; }
  return out.replace(/^(.{4})(.{4})(.{4})$/, '$1-$2-$3');
}

module.exports = { generateKeys, issue, verify, normDevice, deviceCodeFrom, DEVICE_RE, REASON_FA, b64u };
