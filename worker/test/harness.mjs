// Local stand-ins for the Cloudflare bindings, so the Worker can be tested with
// plain Node 22 (node:sqlite for D1, an in-memory map for R2). No dependencies.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

// When `latency.on` is true every query yields to the event loop first, like a
// real network round trip to D1, so concurrent requests interleave.
export const latency = { on: false };
const tick = () => (latency.on ? new Promise((r) => setTimeout(r, Math.random() * 3)) : null);

class Statement {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...args) { this.args = args.map((a) => (a === undefined ? null : a)); return this; }
  // D1 uses ?1, ?2 numbered params; node:sqlite accepts them as positional too.
  #stmt() { return this.db.prepare(this.sql); }
  async first() { await tick(); const r = this.#stmt().get(...this.args); return r ? { ...r } : null; }
  async all() { await tick(); return { results: this.#stmt().all(...this.args).map((r) => ({ ...r })) }; }
  runSync() {
    if (/\bRETURNING\b/i.test(this.sql)) { const rows = this.#stmt().all(...this.args); return { meta: { changes: rows.length }, results: rows }; }
    const info = this.#stmt().run(...this.args);
    return { meta: { changes: Number(info.changes) } };
  }
  async run() { await tick(); return this.runSync(); }
}

export function createD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8'));
  return {
    prepare: (sql) => new Statement(db, sql),
    // Like D1: all statements in one transaction, rolled back on any error.
    async batch(stmts) {
      await tick();
      db.exec('BEGIN');
      try {
        const out = [];
        for (const st of stmts) out.push(st.runSync()); // synchronous, like one D1 transaction
        db.exec('COMMIT');
        return out;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    raw: db,
  };
}

export function createR2() {
  const objects = new Map();
  return {
    objects,
    async put(key, bytes) { objects.set(key, new Uint8Array(bytes)); },
    async head(key) { const o = objects.get(key); return o ? { size: o.length } : null; },
    async get(key, opts = {}) {
      const o = objects.get(key);
      if (!o) return null;
      const off = opts.range?.offset ?? 0;
      const len = opts.range?.length ?? o.length - off;
      const slice = o.slice(off, off + len);
      return {
        async arrayBuffer() { return slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength); },
        get body() {
          // emit in 64 KiB chunks like a real stream
          let i = 0;
          return new ReadableStream({ pull(c) { if (i >= slice.length) return c.close(); c.enqueue(slice.slice(i, i + 65536)); i += 65536; } });
        },
      };
    },
  };
}
