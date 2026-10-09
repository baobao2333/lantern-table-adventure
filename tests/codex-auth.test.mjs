import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const compiled = await build({
  entryPoints: [join(root, "local", "codex-auth.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  write: false,
});
const { codexEnvironment, codexExecutable, createCodexAuth, findCodex, resolveCodex, unpackCodexArchive } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`
);

test("missing or unverified managed CLI never reports authenticated without an existing CLI", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "lantern-codex-auth-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manager = createCodexAuth(directory, null);
  assert.equal(manager.authenticated(), false);
  const state = await manager.status();
  assert.equal(state.installed, false);
  assert.equal(state.source, "none");
  assert.equal(state.authenticated, false);
  assert.equal(manager.authenticated(), false);
  assert.equal(codexExecutable(directory), undefined);
  await assert.rejects(manager.login(), /先在应用内安装/);
  const fake = join(directory, "tools", `codex-${state.version}`);
  await mkdir(fake, { recursive: true });
  await writeFile(
    join(fake, "verified-install.json"),
    JSON.stringify({
      version: state.version,
      integrity: "fake",
      sha256: "fake",
    }),
  );
  assert.equal(codexExecutable(directory), undefined);
});

test("existing CLI command and prefix support login status and report their actual version", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "lantern-codex-existing-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const entry = join(directory, "official-cli-fixture.mjs");
  await writeFile(entry, `
    import { readFile, writeFile } from "node:fs/promises";
    const args = process.argv.slice(2);
    if (args[0] === "--version") console.log("codex-cli 0.161.9");
    else if (args[0] === "login" && args[1] === "status") {
      try { await readFile("fixture-authenticated"); console.log("Logged in using ChatGPT"); }
      catch { process.exitCode = 1; }
    } else if (args[0] === "login") await writeFile("fixture-authenticated", "yes");
    else throw new Error("Unexpected fixture command");
  `);
  const cli = { command: process.execPath, prefix: [entry] };
  assert.deepEqual(resolveCodex(directory, cli), { ...cli, source: "existing" });
  const manager = createCodexAuth(directory, cli);
  const before = await manager.status();
  assert.equal(before.installed, true);
  assert.equal(before.source, "existing");
  assert.equal(before.version, "0.161.9");
  assert.equal(before.authenticated, false);
  assert.equal(manager.authenticated(), false);
  const after = await manager.login();
  assert.equal(after.authenticated, true);
  assert.equal(after.version, "0.161.9");
  assert.equal(manager.authenticated(), true);
});

test("the hash-verified managed CLI takes precedence over an existing CLI", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "lantern-codex-priority-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const release = JSON.parse(await readFile(join(root, "desktop", "codex-release.json"), "utf8"));
  const managedRoot = join(directory, "tools", `codex-${release.version}`);
  const executable = join(managedRoot, "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe");
  const bytes = Buffer.from("fixture-for-resolution-only-never-executed");
  await mkdir(dirname(executable), { recursive: true });
  await writeFile(executable, bytes);
  await writeFile(join(managedRoot, "verified-install.json"), JSON.stringify({
    version: release.version, integrity: release.archiveIntegrity,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  }));
  assert.deepEqual(resolveCodex(directory, { command: "must-not-run", prefix: [] }), {
    command: executable, prefix: [], source: "managed",
  });
});

test("Windows PATH npm entry uses the same resolver for authentication", { skip: process.platform !== "win32" }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "lantern-codex-path-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const entry = join(directory, "node_modules", "@openai", "codex", "bin", "codex.js");
  await mkdir(dirname(entry), { recursive: true });
  await writeFile(join(directory, "codex.cmd"), "fixture marker: never execute via cmd.exe");
  await writeFile(entry, `
    if (process.argv[2] === "--version") console.log("codex-cli 0.162.0");
    else if (process.argv[2] === "login" && process.argv[3] === "status") console.log("Logged in using ChatGPT");
    else throw new Error("Only read-only fixture status is allowed");
  `);
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = directory;
    assert.deepEqual(findCodex(), { command: process.execPath, prefix: [entry] });
    const manager = createCodexAuth(directory);
    const state = await manager.status();
    assert.equal(state.source, "existing");
    assert.equal(state.version, "0.162.0");
    assert.equal(state.authenticated, true);
    assert.equal(manager.authenticated(), true);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

test("Codex operations never inherit unrelated API credentials or remote execution configuration", () => {
  const keys = ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "OPENAI_BASE_URL", "CODEX_REMOTE", "CODEX_CLI_PATH"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    for (const key of keys) process.env[key] = "fixture-value-that-must-not-reach-cli";
    const environment = codexEnvironment();
    for (const key of keys) assert.equal(environment[key], undefined);
    const pathKey = Object.keys(environment).find(key => key.toUpperCase() === "PATH");
    assert.ok(pathKey);
    assert.equal(environment[pathKey], process.env.PATH);
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test("CLI archive must match the pinned official integrity before any extraction", () => {
  assert.throws(
    () => unpackCodexArchive(Buffer.from("untrusted download")),
    /校验失败/,
  );
});
