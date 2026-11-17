// Is the internet reachable? Cached for a few seconds; a failed online request marks it down at once.
'use strict';

const PROBES = ['https://www.gstatic.com/generate_204', 'https://cloudflare.com/cdn-cgi/trace'];
let last = { at: 0, ok: null };
let pending = null;

async function online({ force = false, probe } = {}) {
  if (!force && last.ok !== null && Date.now() - last.at < (last.ok ? 20000 : 8000)) return last.ok;
  if (pending) return pending;
  const urls = probe ? [].concat(probe) : PROBES;
  pending = Promise.any(urls.map(u => fetch(u, { method: 'HEAD', signal: AbortSignal.timeout(3000) }).then(r => { if (r.status >= 500) throw new Error(String(r.status)); return true; })))
    .catch(() => false)
    .then(ok => { last = { at: Date.now(), ok }; pending = null; return ok; });
  return pending;
}

// An error that means "could not reach the service" (not a refusal from it).
function isNetError(e) {
  if (!e) return false;
  if (e.name === 'TimeoutError') return true;
  const t = [e.message, e.code, e.cause && e.cause.code, e.cause && e.cause.message].filter(Boolean).join(' ');
  return /fetch failed|ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|ECONNREFUSED|UND_ERR_CONNECT|socket hang up|network|connection error|unable to connect|getaddrinfo/i.test(t);
}

function markOffline() { last = { at: Date.now(), ok: false }; }
function state() { return { online: last.ok, checkedAt: last.at }; }
function _reset() { last = { at: 0, ok: null }; pending = null; }

module.exports = { online, isNetError, markOffline, state, _reset };
