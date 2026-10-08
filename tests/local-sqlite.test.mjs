import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = process.env.LANTERN_TEST_SOURCE || projectRoot;
const require = createRequire(join(sourceRoot, "package.json"));
const { transform } = await import(pathToFileURL(require.resolve("esbuild")).href);
const compiled = await transform(await readFile(join(projectRoot, "local", "sqlite.ts"), "utf8"), { loader: "ts", format: "esm", target: "node24" });
const { SQLiteD1 } = await import(`data:text/javascript;base64,${Buffer.from(compiled.code).toString("base64")}`);
test("local D1 adapter applies real migrations once and rolls a failed batch back", async t => {
  const directory = await mkdtemp(join(tmpdir(), "lantern-sqlite-test-"));
  let db;
  t.after(async () => { db?.close(); await rm(directory, { recursive: true, force: true }); });
  const filename = join(directory, "adventures.sqlite"), migrations = join(sourceRoot, "drizzle");
  db = new SQLiteD1(filename, migrations);
  await assert.rejects(db.batch([
    db.prepare("INSERT INTO heroes (id,owner,data,created_at) VALUES (?,?,?,?)").bind("fixture", "local-owner", "{}", 0),
    db.prepare("INSERT INTO heroes (id,owner,data,created_at) VALUES (?,?,?,?)").bind("fixture", "local-owner", "{}", 1),
  ]));
  assert.equal(await db.prepare("SELECT id FROM heroes WHERE id = ?").bind("fixture").first(), null);
  const result = await db.prepare("INSERT INTO heroes (id,owner,data,created_at) VALUES (?,?,?,?)").bind("fixture", "local-owner", "{}", 0).run();
  assert.equal(result.meta.changes, 1);
  assert.equal(await db.prepare("SELECT created_at FROM heroes WHERE id = ?").bind("fixture").first("created_at"), 0);
  db.close(); db = new SQLiteD1(filename, migrations);
  assert.equal((await db.prepare("SELECT id FROM heroes").all()).results.length, 1);
  assert.equal((await db.prepare("SELECT name FROM lantern_migrations").all()).results.length >= 1, true);
});
