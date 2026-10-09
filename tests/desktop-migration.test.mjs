import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  readdir,
} from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const compiled = await build({
  entryPoints: [join(root, "local", "migrate-desktop.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  write: false,
});
const { migrateDesktopData } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`
);

test("desktop import includes live WAL, preserves the old library and never reimports later changes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "lantern-desktop-migration-"));
  const legacy = join(directory, "legacy"),
    desktop = join(legacy, "desktop");
  await mkdir(legacy);
  const source = new DatabaseSync(join(legacy, "adventures.sqlite"));
  t.after(async () => {
    source.close();
    await rm(directory, { recursive: true, force: true });
  });
  source.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE fixture (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO fixture VALUES (1, 'before');",
  );
  await writeFile(
    join(legacy, "settings.json"),
    JSON.stringify({
      provider: "none",
      baseUrl: "https://api.openai.com/v1",
      model: "",
      apiKeyEncrypted: "",
    }),
  );
  const options = {
    legacyDirectory: legacy,
    desktopDirectory: desktop,
    migrationsDirectory: join(root, "drizzle"),
  };
  const result = migrateDesktopData(options);
  assert.equal(result.legacyImported, true);
  const target = new DatabaseSync(result.databasePath);
  assert.equal(
    target.prepare("SELECT value FROM fixture WHERE id=1").get().value,
    "before",
  );
  target.close();
  source.exec("UPDATE fixture SET value='old-package-later' WHERE id=1;");
  assert.equal(migrateDesktopData(options).imported, false);
  const unchanged = new DatabaseSync(result.databasePath);
  assert.equal(
    unchanged.prepare("SELECT value FROM fixture WHERE id=1").get().value,
    "before",
  );
  assert.equal(unchanged.prepare("PRAGMA quick_check").get().quick_check, "ok");
  unchanged.close();
  assert.equal(
    source.prepare("SELECT value FROM fixture WHERE id=1").get().value,
    "old-package-later",
  );
  assert.ok(
    (await readdir(join(desktop, "backups"))).some((name) =>
      name.endsWith(".sqlite"),
    ),
  );
  assert.deepEqual(
    JSON.parse(await readFile(join(desktop, "settings.json"), "utf8")),
    JSON.parse(await readFile(join(legacy, "settings.json"), "utf8")),
  );
});

test("a failed schema import publishes no current data and a corrected retry succeeds", async (t) => {
  const directory = await mkdtemp(
    join(tmpdir(), "lantern-desktop-failed-import-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const legacy = join(directory, "legacy"),
    desktop = join(legacy, "desktop"),
    migrations = join(directory, "bad-migrations");
  await mkdir(legacy);
  await mkdir(migrations);
  const source = new DatabaseSync(join(legacy, "adventures.sqlite"));
  source.exec(
    "CREATE TABLE fixture(id INTEGER); INSERT INTO fixture VALUES (7)",
  );
  source.close();
  await writeFile(join(migrations, "0000_bad.sql"), "NOT VALID SQL");
  const options = {
    legacyDirectory: legacy,
    desktopDirectory: desktop,
    migrationsDirectory: migrations,
  };
  assert.throws(() => migrateDesktopData(options));
  await assert.rejects(readFile(join(desktop, "adventures-desktop.sqlite")), {
    code: "ENOENT",
  });
  await assert.rejects(readFile(join(desktop, "desktop-import.json")), {
    code: "ENOENT",
  });
  const result = migrateDesktopData({
    ...options,
    migrationsDirectory: join(root, "drizzle"),
  });
  const target = new DatabaseSync(result.databasePath);
  assert.equal(target.prepare("SELECT id FROM fixture").get().id, 7);
  target.close();
});

test("fresh desktop storage is initialized once and unknown existing data is preserved", async (t) => {
  const directory = await mkdtemp(
    join(tmpdir(), "lantern-desktop-new-import-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = {
    legacyDirectory: directory,
    desktopDirectory: join(directory, "desktop"),
    migrationsDirectory: join(root, "drizzle"),
  };
  assert.equal(migrateDesktopData(options).legacyImported, false);
  assert.equal(migrateDesktopData(options).imported, false);
  const other = join(directory, "other");
  await mkdir(other);
  await writeFile(join(other, "adventures-desktop.sqlite"), "preserve me");
  assert.throws(
    () => migrateDesktopData({ ...options, desktopDirectory: other }),
    /Unmarked/,
  );
  assert.equal(
    await readFile(join(other, "adventures-desktop.sqlite"), "utf8"),
    "preserve me",
  );
});
