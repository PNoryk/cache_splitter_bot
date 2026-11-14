/**
 * D1-compatible adapter over node:sqlite for tests.
 */
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

/**
 * Wrap a prepared statement with D1-style methods.
 * @param {DatabaseSync} raw
 * @param {string} sql
 * @param {unknown[]} args
 * @returns {object}
 */
function makeStatement(raw, sql, args) {
  /**
   * Bound parameters; undefined is rejected like real D1 does.
   * @returns {unknown[]}
   */
  const params = () => {
    args.forEach((a, i) => {
      if (a === undefined) throw new Error(`D1_TYPE_ERROR: undefined bind at index ${i}`);
    });
    return args;
  };
  return {
    sql,
    args,
    /**
     * @param {...unknown} next
     * @returns {object}
     */
    bind: (...next) => makeStatement(raw, sql, next),
    /**
     * @param {string} [col]
     * @returns {Promise<any>}
     */
    first: async (col) => {
      const row = raw.prepare(sql).get(...params());
      if (row === undefined) return null;
      const plain = { ...row };
      return col === undefined ? plain : plain[col];
    },
    /** @returns {Promise<{results: object[]}>} */
    all: async () => ({ results: raw.prepare(sql).all(...params()).map((r) => ({ ...r })) }),
    /** @returns {Promise<{meta: {changes: number, last_row_id: number}}>} */
    run: async () => runSync(raw, sql, params()),
    /**
     * Synchronous run used by batch; returns results and meta.
     * @returns {{results: object[], meta: {changes: number, last_row_id?: number}}}
     */
    runSync: () => runSync(raw, sql, params()),
  };
}

/**
 * Run a statement synchronously.
 * @param {DatabaseSync} raw
 * @param {string} sql
 * @param {unknown[]} params
 * @returns {{results: object[], meta: {changes: number, last_row_id?: number}}}
 */
function runSync(raw, sql, params) {
  const stmt = raw.prepare(sql);
  if (stmt.columns().length > 0) {
    return { results: stmt.all(...params).map((r) => ({ ...r })), meta: { changes: 0 } };
  }
  const info = stmt.run(...params);
  return {
    results: [],
    meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) },
  };
}

/**
 * Create an in-memory D1 with all migrations applied.
 * @returns {object} D1Database-like
 */
export function createD1() {
  const raw = new DatabaseSync(':memory:');
  for (const f of readdirSync(MIGRATIONS_DIR).filter((n) => n.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(MIGRATIONS_DIR + f, 'utf8'));
  }
  return {
    /**
     * @param {string} sql
     * @returns {object}
     */
    prepare: (sql) => makeStatement(raw, sql, []),
    /**
     * Run statements in one transaction.
     * @param {object[]} stmts
     * @returns {Promise<object[]>}
     */
    batch: async (stmts) => {
      raw.exec('BEGIN');
      try {
        const out = stmts.map((s) => s.runSync());
        raw.exec('COMMIT');
        return out;
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      }
    },
  };
}
