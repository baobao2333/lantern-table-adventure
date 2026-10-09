import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
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
const { codexExecutable, createCodexAuth, unpackCodexArchive } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`
);

test("missing or unverified CLI never executes PATH candidates or reports authenticated", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "lantern-codex-auth-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manager = createCodexAuth(directory);
  const state = await manager.status();
  assert.equal(state.installed, false);
  assert.equal(state.authenticated, false);
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

test("CLI archive must match the pinned official integrity before any extraction", () => {
  assert.throws(
    () => unpackCodexArchive(Buffer.from("untrusted download")),
    /校验失败/,
  );
});
