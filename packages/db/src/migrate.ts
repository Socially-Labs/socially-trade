import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createPool, inTransaction } from "./index.js";

const directory = fileURLToPath(new URL("../migrations/", import.meta.url));
const pool = createPool();

try {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) {
    const sql = await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8");
    const applied = await inTransaction(pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(72644201)");
      const existing = await client.query("SELECT 1 FROM schema_migrations WHERE name = $1", [file]);
      if (existing.rowCount) return false;
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      return true;
    });
    console.info(`${applied ? "Applied" : "Skipped"} ${file}`);
  }
} finally {
  await pool.end();
}
