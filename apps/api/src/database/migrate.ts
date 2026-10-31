import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";
import { settings } from "../config";
export async function migrate(url: string) {
  const pool = new Pool({ connectionString: url });
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock(hashtext('wms-migrations'))");
    await c.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const dir = resolve(__dirname, "../../../../database/migrations");
    for (const file of (await readdir(dir))
      .filter((f) => /^\d+.*\.sql$/.test(f))
      .sort()) {
      const name = file.replace(/\.sql$/, "");
      const applied = await c.query(
        "SELECT 1 FROM schema_migrations WHERE name=$1",
        [name],
      );
      if (!applied.rowCount) {
        await c.query(await readFile(resolve(dir, file), "utf8"));
        await c.query("INSERT INTO schema_migrations(name) VALUES($1)", [name]);
      }
    }
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
    await pool.end();
  }
}
if (require.main === module)
  migrate(settings.migrationUrl)
    .then(() => console.log("Migrations applied."))
    .catch((e) => {
      console.error(e.message);
      process.exitCode = 1;
    });
