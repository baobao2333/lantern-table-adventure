import { DatabaseSync } from "node:sqlite";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { SQLiteD1 } from "./sqlite";
import { SettingsStore } from "./settings";

export type DesktopMigrationOptions = {
  legacyDirectory: string;
  desktopDirectory: string;
  migrationsDirectory: string;
};

export function migrateDesktopData(options: DesktopMigrationOptions) {
  const legacyDirectory = resolve(options.legacyDirectory);
  const desktopDirectory = resolve(options.desktopDirectory);
  if (legacyDirectory === desktopDirectory)
    throw new Error("Desktop storage must be separate from legacy storage.");
  mkdirSync(desktopDirectory, { recursive: true });
  const databasePath = join(desktopDirectory, "adventures-desktop.sqlite");
  const markerPath = join(desktopDirectory, "desktop-import.json");
  const pendingPath = join(desktopDirectory, "desktop-import.pending.json");
  const settingsPath = join(desktopDirectory, "settings.json");
  if (existsSync(markerPath)) {
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    if (marker.format !== 1 || !existsSync(databasePath))
      throw new Error(
        "Desktop import marker or database is invalid; restore a backup.",
      );
    return {
      databasePath,
      imported: false,
      legacyImported: marker.legacyImported === true,
    };
  }
  // Only remove files reserved by this importer before any service could use them.
  if (existsSync(pendingPath)) {
    const pending = JSON.parse(readFileSync(pendingPath, "utf8"));
    if (
      pending.format !== 1 ||
      pending.database !== "adventures-desktop.sqlite"
    )
      throw new Error(
        "Unrecognized unfinished desktop import; preserve it for recovery.",
      );
    for (const suffix of ["", "-wal", "-shm"])
      rmSync(databasePath + suffix, { force: true });
    if (pending.ownsSettings === true) rmSync(settingsPath, { force: true });
    rmSync(pendingPath, { force: true });
  }
  if (existsSync(databasePath) || existsSync(settingsPath))
    throw new Error(
      "Unmarked desktop data already exists; preserve it before importing.",
    );
  const staging = join(desktopDirectory, `.import-${randomUUID()}`);
  mkdirSync(staging);
  const stagedDatabase = join(staging, "adventures-desktop.sqlite");
  const legacyDatabase = join(legacyDirectory, "adventures.sqlite");
  const legacySettings = join(legacyDirectory, "settings.json");
  const legacyImported = existsSync(legacyDatabase);
  let published = false;
  try {
    if (legacyImported) {
      const source = new DatabaseSync(legacyDatabase, { readOnly: true });
      try {
        source.exec("PRAGMA busy_timeout=5000");
        source.prepare("VACUUM INTO ?").run(stagedDatabase);
      } finally {
        source.close();
      }
      const backupDirectory = join(desktopDirectory, "backups");
      mkdirSync(backupDirectory, { recursive: true });
      copyFileSync(
        stagedDatabase,
        join(backupDirectory, `legacy-${Date.now()}-${randomUUID()}.sqlite`),
      );
    }
    if (existsSync(legacySettings)) {
      copyFileSync(legacySettings, join(staging, "settings.json"));
      // Decryption must succeed for the same Windows user before publishing anything.
      new SettingsStore(staging);
    }
    const migrated = new SQLiteD1(stagedDatabase, options.migrationsDirectory);
    try {
      const result = migrated.sqlite.prepare("PRAGMA quick_check").get();
      if (result?.quick_check !== "ok")
        throw new Error("Imported database integrity check failed.");
      migrated.sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      migrated.close();
    }
    writeFileSync(
      pendingPath,
      JSON.stringify({
        format: 1,
        database: "adventures-desktop.sqlite",
        ownsSettings: existsSync(legacySettings),
      }),
      { mode: 0o600 },
    );
    renameSync(stagedDatabase, databasePath);
    if (existsSync(join(staging, "settings.json")))
      renameSync(join(staging, "settings.json"), settingsPath);
    const marker = {
      format: 1,
      legacyImported,
      importedAt: new Date().toISOString(),
      source: legacyImported ? legacyDatabase : null,
    };
    writeFileSync(
      join(staging, "marker.json"),
      JSON.stringify(marker, null, 2),
      { mode: 0o600 },
    );
    renameSync(join(staging, "marker.json"), markerPath);
    published = true;
    rmSync(pendingPath, { force: true });
    return { databasePath, imported: true, legacyImported };
  } finally {
    if (!published && existsSync(pendingPath)) {
      for (const suffix of ["", "-wal", "-shm"])
        rmSync(databasePath + suffix, { force: true });
      rmSync(settingsPath, { force: true });
      rmSync(pendingPath, { force: true });
    }
    rmSync(staging, { recursive: true, force: true });
  }
}
