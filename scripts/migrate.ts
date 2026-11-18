import { config } from "dotenv";
config({ path: ".env.local" });
import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await migrate(drizzle(pool), { migrationsFolder: "./drizzle" });
  await pool.query(readFileSync("./drizzle/constraints.sql", "utf8")); // idempotent DB-level integrity
  console.log("migrated");
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
