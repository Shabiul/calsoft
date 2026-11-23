// Tests create and delete rows: refuse to run against anything but a local database (ALLOW_REMOTE_TEST_DB=1 overrides).
const url = process.env.DATABASE_URL ?? "";
const host = (() => { try { return new URL(url).hostname; } catch { return ""; } })();
if (url && !["localhost", "127.0.0.1", "::1", "[::1]", "postgres"].includes(host) && process.env.ALLOW_REMOTE_TEST_DB !== "1") {
  throw new Error(`Refusing to run tests against non-local database host "${host}". Set ALLOW_REMOTE_TEST_DB=1 to override.`);
}
