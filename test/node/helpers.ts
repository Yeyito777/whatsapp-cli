import { getDb } from '../../lib/db.js';

/** Empty every table in the isolated test DB. */
export function resetDb(): void {
  const db = getDb();
  for (const row of db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all() as Array<{ name: string }>) {
    db.prepare(`DELETE FROM ${row.name}`).run();
  }
}
