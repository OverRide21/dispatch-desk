import { DatabaseSync } from 'node:sqlite';

// Match the async storage contract without opening a second connection to a local file.
export function openLocalSqlite(filename) {
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
  let queue = Promise.resolve();

  function enqueue(work) {
    const next = queue.then(work);
    queue = next.catch(() => {});
    return next;
  }

  function execute(input) {
    const { sql, args = [] } = typeof input === 'string' ? { sql: input } : input;
    const query = db.prepare(sql);
    if (query.columns().length) return { rows: query.all(...args) };
    return { rows: [], rowsAffected: query.run(...args).changes };
  }

  return {
    close: () => db.close(),
    execute: input => enqueue(() => execute(input)),
    batch(inputs, mode) {
      return enqueue(() => {
        db.exec(mode === 'write' ? 'BEGIN IMMEDIATE' : 'BEGIN');
        try {
          const results = inputs.map(execute);
          db.exec('COMMIT');
          return results;
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      });
    },
    transaction() {
      let release;
      const complete = new Promise(resolve => { release = resolve; });
      const ready = enqueue(() => db.exec('BEGIN IMMEDIATE'));
      queue = ready.then(() => complete, () => {});
      return ready.then(() => {
        let open = true;
        return {
          execute,
          batch: inputs => inputs.map(execute),
          commit() {
            db.exec('COMMIT');
            open = false;
            release();
          },
          close() {
            if (!open) return;
            try { db.exec('ROLLBACK'); } finally { release(); }
          },
        };
      });
    },
  };
}
