// License check for the Android app (runs in the app's WebView, offline): the same check as
// lib/license.js, with WebCrypto. The public key is built into the app; the device code comes
// from the phone. Returns { ok, reason, payload }.
export async function verifyLicense(licenseKey, publicKeyB64, deviceCode, { buildDay } = {}) {
  const m = /^JRV1\.([\w-]+)\.([\w-]+)$/.exec(String(licenseKey || '').trim().replace(/\s+/g, ''));
  if (!m) return { ok: false, reason: 'format' };
  const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
  let key;
  try { key = await crypto.subtle.importKey('spki', unb64u(publicKeyB64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']); }
  catch { return { ok: false, reason: 'publicKey' }; }
  const good = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, unb64u(m[2]), new TextEncoder().encode(m[1]));
  if (!good) return { ok: false, reason: 'signature' };
  let payload; try { payload = JSON.parse(new TextDecoder().decode(unb64u(m[1]))); } catch { return { ok: false, reason: 'format' }; }
  const norm = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^(.{4})(.{4})(.{4})$/, '$1-$2-$3');
  if (deviceCode != null && norm(deviceCode) !== payload.d) return { ok: false, reason: 'device', payload };
  if (buildDay != null && buildDay > payload.u) return { ok: false, reason: 'updates', payload };
  return { ok: true, payload };
}
