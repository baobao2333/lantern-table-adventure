import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import { join, resolve, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, execFileSync } from "node:child_process";
import { assertReleaseVersion } from "./check-release-version.mjs";
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceIndex = process.argv.indexOf("--source");
await assertReleaseVersion(
  sourceIndex < 0 ? projectRoot : resolve(process.argv[sourceIndex + 1]),
);
const metadata = JSON.parse(
  await readFile(join(projectRoot, "local", "release.json"), "utf8"),
);
const zipName = `lantern-table-${metadata.version}-windows-x64.zip`,
  zipPath = join(projectRoot, "dist", "release", zipName);
const expectedHash = (await readFile(`${zipPath}.sha256`, "utf8")).split(
  /\s+/,
)[0];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
assert.equal(sha256(await readFile(zipPath)), expectedHash);
const directory = await mkdtemp(
  join(projectRoot, "dist", "release", ".verify-"),
);
try {
  const extraction = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath $env:LANTERN_ZIP -DestinationPath $env:LANTERN_CHECK -Force",
    ],
    {
      env: { ...process.env, LANTERN_ZIP: zipPath, LANTERN_CHECK: directory },
      windowsHide: true,
      stdio: "inherit",
      timeout: 120_000,
    },
  );
  assert.equal(extraction.status, 0);
  const packageDirectory = join(directory, zipName.slice(0, -4));
  const manifest = (
    await readFile(join(packageDirectory, "FILES_SHA256.txt"), "utf8")
  )
    .trim()
    .split(/\r?\n/);
  const names = new Set(["FILES_SHA256.txt"]);
  for (const line of manifest) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    assert.ok(match);
    const filename = resolve(packageDirectory, match[2]);
    assert.equal(filename.startsWith(packageDirectory + sep), true);
    assert.equal(sha256(await readFile(filename)), match[1]);
    names.add(match[2]);
    assert.equal(
      /(^|\/)(node_modules|\.env[^/]*|\.dev\.vars[^/]*|auth\.json|settings\.json|adventures\.sqlite[^/]*)($|\/)/i.test(
        match[2],
      ),
      false,
    );
  }
  async function checkFiles(directory, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isDirectory())
        await checkFiles(join(directory, entry.name), `${name}/`);
      else assert.equal(names.has(name), true);
    }
  }
  await checkFiles(packageDirectory);
  const executable = join(packageDirectory, "runtime", "node.exe");
  assert.equal(
    execFileSync(executable, ["--version"], {
      encoding: "utf8",
      windowsHide: true,
    }).trim(),
    `v${metadata.nodeVersion}`,
  );
  const verification = spawnSync(
    executable,
    [
      join(projectRoot, "scripts", "verify-local.mjs"),
      "--package",
      packageDirectory,
      "--node",
      executable,
    ],
    { windowsHide: true, stdio: "inherit", timeout: 60_000 },
  );
  assert.equal(verification.status, 0);
  console.log(
    `PASS: final ZIP SHA256, every packaged file, forbidden private files absent, bundled Node ${metadata.nodeVersion}, installed runtime verification.`,
  );
} finally {
  assert.equal(
    directory.startsWith(join(projectRoot, "dist", "release") + sep),
    true,
  );
  await rm(directory, { recursive: true, force: true });
}
