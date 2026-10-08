// Minimal stand-in for a Cloudflare D1 binding, backed by in-memory SQLite with every migration applied.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export function createD1() {
  const sqlite = new DatabaseSync(':memory:');
  const dir = new URL('../migrations/', import.meta.url);
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(new URL(file, dir), 'utf8'));
  }
  const DB = {
    prepare(sql) {
      const stmt = sqlite.prepare(sql);
      let args = [];
      const api = {
        bind: (...a) => {
          assert.ok(!a.includes(undefined), `undefined bound in: ${sql}`); // D1 rejects undefined too
          args = a;
          return api;
        },
        first: async () => {
          const row = stmt.get(...args);
          return row ? { ...row } : null;
        },
        all: async () => ({ results: stmt.all(...args).map((row) => ({ ...row })) }),
        run: async () => (stmt.run(...args), { success: true }),
      };
      return api;
    },
    // Like D1: the statements run in order, in one transaction.
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (err) {
        sqlite.exec('ROLLBACK');
        throw err;
      }
    },
  };
  return { DB, sqlite };
}
