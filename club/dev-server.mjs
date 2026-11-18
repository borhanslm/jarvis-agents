// Run the club on this computer (for testing, no Cloudflare): node club/dev-server.mjs [port] [db-file] [admin-email]
// Uses Node's built-in SQLite in place of D1.
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { handle, devOutbox } from './worker.js';
// show the email codes in this window (nothing is emailed in dev mode)
const _set = devOutbox.set.bind(devOutbox); devOutbox.set = (to, code) => { console.log(`[email] code for ${to}: ${code}`); return _set(to, code); };

const [port = 8788, file = ':memory:', adminEmail = 'admin@example.com'] = process.argv.slice(2);
const db = new DatabaseSync(file);
const stmt = (sql, args = []) => ({
  bind: (...a) => stmt(sql, a.map(v => v === undefined ? null : v)),
  first: async () => db.prepare(sql).get(...args) ?? null,
  all: async () => ({ results: db.prepare(sql).all(...args) }),
  run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
});
const DB = { prepare: sql => stmt(sql), batch: async list => { db.exec('BEGIN'); try { const o = []; for (const s of list) o.push(await s.run()); db.exec('COMMIT'); return o; } catch (e) { db.exec('ROLLBACK'); throw e; } } };
const env = { DB, ADMIN_EMAIL: adminEmail, DEV_MAIL: '1' }; // codes are printed here instead of being emailed

http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const r = await handle(new Request('http://127.0.0.1:' + port + req.url, { method: req.method, headers: { ...req.headers, 'cf-connecting-ip': req.socket.remoteAddress }, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body }), env);
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
}).listen(+port, '127.0.0.1', () => console.log(`JARVIS club (dev) on http://127.0.0.1:${port} — admin: ${adminEmail}`));
