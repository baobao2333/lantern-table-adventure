import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { RuntimeController } from "../desktop/runtime-controller.mjs";
import { acquireServiceOwnership } from "../desktop/ownership.mjs";

async function fixture(t, extra = "") {
  const directory = await mkdtemp(join(tmpdir(), "lantern-runtime-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const serverFile = join(directory, "server.mjs");
  await writeFile(
    serverFile,
    `
    const instanceId = process.env.LANTERN_INSTANCE_ID;
    ${extra}
    process.send({ type: 'ready', port: 32123, version: '0.3.0', instanceId });
    process.on('message', message => {
      if (message.instanceId !== instanceId) return;
      if (message.type === 'pause') process.send({ type: 'paused', instanceId, requestId: message.requestId });
      if (message.type === 'shutdown') process.send({ type: 'stopped', instanceId, requestId: message.requestId }, () => process.exit(0));
    });
    process.on('disconnect', () => process.exit(0));
  `,
  );
  const runtime = new RuntimeController({
    nodeExecutable: process.execPath,
    serverFile,
    runtimeDirectory: directory,
    dataDirectory: directory,
    legacyDirectory: join(directory, "old"),
    version: "0.3.0",
    startTimeout: 2000,
  });
  t.after(() => runtime.forceStop());
  return runtime;
}

test("desktop accepts only its child identity and shuts down through the matching receipt", async (t) => {
  const runtime = await fixture(t);
  const ready = await runtime.start();
  assert.equal(ready.origin, "http://127.0.0.1:32123");
  assert.ok(!ready.origin.includes(runtime.adminToken));
  assert.deepEqual(runtime.child.spawnargs.slice(1), [
    runtime.options.serverFile,
  ]);
  await runtime.pause();
  await runtime.stop();
  assert.equal(runtime.child.exitCode, 0);
});

test("desktop rejects a mismatched runtime version before loading a page", async (t) => {
  const runtime = await fixture(t);
  runtime.options.version = "0.3.1";
  await assert.rejects(runtime.start(), /版本/);
});

test("management-channel loss stops the child rather than leaving an unowned service", async (t) => {
  const runtime = await fixture(t);
  await runtime.start();
  runtime.stopping = true;
  const exited = once(runtime.child, "exit");
  runtime.child.disconnect();
  const [code] = await exited;
  assert.equal(code, 0);
});

test("service ownership rejects another live owner and reclaims a known dead process", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "lantern-runtime-owner-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const release = acquireServiceOwnership(directory, "first");
  assert.throws(
    () => acquireServiceOwnership(directory, "second"),
    /Another desktop service/,
  );
  release();
  await mkdir(join(directory, "service.lock"));
  await writeFile(
    join(directory, "service.lock", "owner.json"),
    JSON.stringify({ pid: 2147483647, instanceId: "dead" }),
  );
  const releaseNew = acquireServiceOwnership(directory, "new");
  assert.equal(
    JSON.parse(
      await readFile(join(directory, "service.lock", "owner.json"), "utf8"),
    ).instanceId,
    "new",
  );
  releaseNew();
});
