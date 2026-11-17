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

// ---- activation with a short code through the signed public list (e.g. GitHub) ----
export const normCode = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^JRV/, '').replace(/^(.{4})(.{4})$/, 'JRV-$1-$2');
export const isShortCode = c => /^JRV-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(normCode(c));
export async function codeHash(c) { const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('jarvis-license|' + normCode(c))); return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join(''); }
export async function verifyList(list, publicKeyB64) {
  if (!list || !list.sig) return false;
  const { sig, ...body } = list;
  const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
  try {
    const key = await crypto.subtle.importKey('spki', unb64u(publicKeyB64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, unb64u(sig), new TextEncoder().encode(JSON.stringify(body)));
  } catch { return false; }
}
// download the list from the first address that answers, check its signature
export async function fetchList(urls, publicKeyB64) {
  let lastErr = 'فهرست دریافت نشد';
  for (const u of urls) {
    try {
      const r = await fetch(u + (u.includes('?') ? '&' : '?') + 't=' + Date.now(), { cache: 'no-store', signal: AbortSignal.timeout(8000) });
      if (!r.ok) { lastErr = 'HTTP ' + r.status; continue; }
      const list = await r.json();
      if (await verifyList(list, publicKeyB64)) return list;
      lastErr = 'امضای فهرست معتبر نیست';
    } catch (e) { lastErr = e.name === 'TimeoutError' ? 'اینترنت یا GitHub در دسترس نیست' : e.message; }
  }
  throw new Error(lastErr);
}
