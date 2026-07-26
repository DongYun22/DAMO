import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createDatabasePool } from "./database.js";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.resolve(moduleDirectory, "../migrations");

export const runMigrations = async () => {
  const pool = createDatabasePool();
  const client = await pool.connect();
  let applied = 0;

  try {
    await client.query(`
      create table if not exists damo_schema_migrations (
        name text primary key,
        applied_at timestamptz not null default now()
      )
    `);
    await client.query(
      "select pg_advisory_lock(hashtext('damo-schema-migrations'))"
    );

    const entries = (await readdir(migrationsDirectory))
      .filter((name) => /^\d+.*\.sql$/.test(name))
      .sort();

    for (const name of entries) {
      const exists = await client.query(
        "select 1 from damo_schema_migrations where name = $1",
        [name]
      );
      if (exists.rowCount) continue;

      const sql = await readFile(path.join(migrationsDirectory, name), "utf8");
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query(
          "insert into damo_schema_migrations (name) values ($1)",
          [name]
        );
        await client.query("commit");
        applied += 1;
        console.log(`Applied migration: ${name}`);
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    }

    await client.query("alter table damo_schema_migrations enable row level security");
    await client.query(
      "revoke all on damo_schema_migrations from anon, authenticated"
    );
    return { applied, total: entries.length };
  } finally {
    await client
      .query("select pg_advisory_unlock(hashtext('damo-schema-migrations'))")
      .catch(() => undefined);
    client.release();
    await pool.end();
  }
};

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";

if (import.meta.url === entry) {
  runMigrations()
    .then(({ applied, total }) => {
      console.log(`Database migrations ready (${applied} applied, ${total} total).`);
    })
    .catch((error) => {
      console.error("Database migration failed:", error);
      process.exitCode = 1;
    });
}
