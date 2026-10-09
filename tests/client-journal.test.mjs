import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = process.env.LANTERN_TEST_SOURCE || projectRoot;
const require = createRequire(join(sourceRoot, "package.json"));
const { build } = await import(pathToFileURL(require.resolve("esbuild")).href);
const compiled = await build({
  entryPoints: [join(projectRoot, "local", "client-journal.ts")],
  bundle: true, write: false, platform: "node", format: "esm", target: "node24",
});
const { ClientJournal } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`);

function solo(overrides = {}) {
  return { op: "game.command", id: randomUUID(), requestId: randomUUID(), expectedVersion: 4,
    command: { kind: "action", actionId: "ask-witness" }, ...overrides };
}
function room(overrides = {}) {
  return { id: randomUUID(), role: "guest", payload: { commandId: randomUUID(), serverEpoch: 2,
    operationId: randomUUID(), phaseId: randomUUID(), type: "talk", text: "检查桥边的灯。" }, ...overrides };
}
function memory(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  return new ClientJournal(db);
}

test("client journal restores both complete pending payloads after SQLite and service restart", async t => {
  const directory = await mkdtemp(join(tmpdir(), "lantern-client-journal-"));
  const filename = join(directory, "client.sqlite");
  let db;
  t.after(async () => { db?.close(); await rm(directory, { recursive: true, force: true }); });
  db = new DatabaseSync(filename);
  let journal = new ClientJournal(db);
  const action = solo(), command = room();
  journal.save("solo", action);
  journal.save("room", command);
  db.close();
  db = new DatabaseSync(filename);
  journal = new ClientJournal(db);
  assert.deepEqual(journal.read("solo"), action);
  assert.deepEqual(journal.read("room"), command);
  const returned = journal.read("room");
  returned.payload.text = "Changed only in caller memory";
  assert.deepEqual(journal.read("room"), command);
});

test("a committed prewrite is visible to another connection before send and survives lost response", async t => {
  const directory = await mkdtemp(join(tmpdir(), "lantern-journal-send-"));
  const filename = join(directory, "client.sqlite"), db = new DatabaseSync(filename);
  t.after(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });
  const journal = new ClientJournal(db), action = solo({ op: "game.talk", text: "询问渡船的去向。" });
  journal.save("solo", action);
  const send = () => {
    const observer = new DatabaseSync(filename);
    try { assert.deepEqual(new ClientJournal(observer).read("solo"), action); }
    finally { observer.close(); }
    throw new Error("Response was lost after request send.");
  };
  assert.throws(send, /Response was lost/);
  assert.deepEqual(journal.read("solo"), action);
});

test("same request retries compare canonical JSON while preserving array order", t => {
  const journal = memory(t), action = solo({ extra: { z: [3, 1, { b: 2, a: 1 }], a: "标记" } });
  journal.save("solo", action);
  journal.save("solo", { extra: { a: "标记", z: [3, 1, { a: 1, b: 2 }] },
    command: { actionId: "ask-witness", kind: "action" }, expectedVersion: 4,
    requestId: action.requestId, id: action.id, op: action.op });
  assert.deepEqual(journal.read("solo"), action);
  assert.throws(() => journal.save("solo", { ...action, extra: { ...action.extra, z: [1, 3, { b: 2, a: 1 }] } }), e => e.status === 409);
  assert.deepEqual(journal.read("solo"), action);
});

test("different IDs or changed content cannot replace a pending request in either namespace", t => {
  const journal = memory(t), action = solo(), command = room();
  journal.save("solo", action); journal.save("room", command);
  for (const changed of [{ ...action, requestId: randomUUID() }, { ...action, expectedVersion: 5 }, { ...action, id: randomUUID() }])
    assert.throws(() => journal.save("solo", changed), e => e.status === 409);
  assert.throws(() => journal.save("room", { ...command, role: "host" }), e => e.status === 409);
  assert.throws(() => journal.save("room", { ...command, payload: { ...command.payload, commandId: randomUUID() } }), e => e.status === 409);
  assert.deepEqual(journal.read("solo"), action);
  assert.deepEqual(journal.read("room"), command);
});

test("clear fences by namespace and original request ID, including late old responses", t => {
  const journal = memory(t), action = solo(), command = room();
  journal.save("solo", action); journal.save("room", command);
  assert.equal(journal.clear("solo", command.payload.commandId), false);
  assert.equal(journal.clear("solo", action.requestId), true);
  const next = solo(); journal.save("solo", next);
  assert.equal(journal.clear("solo", action.requestId), false);
  assert.deepEqual(journal.read("solo"), next);
  assert.deepEqual(journal.read("room"), command);
  assert.equal(journal.clear("room", command.payload.commandId), true);
  assert.equal(journal.clear("room", command.payload.commandId), false);
  assert.equal(journal.read("room"), null);
});

test("journal rejects unsupported operations, invalid UUIDs, roles, and non-JSON objects", t => {
  const journal = memory(t);
  for (const payload of [null, [], "request", solo({ op: "hero.build" }), solo({ id: "room" }),
    solo({ requestId: "request" }), solo({ command: undefined }), solo({ extra: NaN }),
    solo({ extra: new Date() }), solo({ extra: () => true }), solo({ extra: 1n })])
    assert.throws(() => journal.save("solo", payload), e => e.status === 400);
  const cyclic = solo(); cyclic.extra = cyclic;
  assert.throws(() => journal.save("solo", cyclic), e => e.status === 400);
  for (const payload of [room({ role: "owner" }), room({ role: ["host"] }), room({ payload: [] }),
    room({ payload: { commandId: "command" } })])
    assert.throws(() => journal.save("room", payload), e => e.status === 400);
  assert.throws(() => journal.read("unknown"), e => e.status === 400);
  assert.throws(() => journal.save("unknown", solo()), e => e.status === 400);
  assert.throws(() => journal.clear("solo", "invalid"), e => e.status === 400);
  assert.equal(journal.read("solo"), null);
  assert.equal(journal.read("room"), null);
});

test("64 KiB limit counts UTF-8 bytes and rejects excessive JSON nesting", t => {
  const journal = memory(t), oversized = solo({ text: "灯".repeat(22_000) });
  assert.ok(JSON.stringify(oversized).length < 64 * 1024);
  assert.throws(() => journal.save("solo", oversized), e => e.status === 413);
  let nested = "end";
  for (let index = 0; index < 55; index++) nested = { next: nested };
  assert.throws(() => journal.save("solo", solo({ nested })), e => e.status === 400);
  const small = solo({ text: "灯".repeat(10_000) });
  journal.save("solo", small);
  assert.deepEqual(journal.read("solo"), small);
});

test("storage failures are safe LocalErrors and cannot report a successful prewrite", () => {
  const db = new DatabaseSync(":memory:"), journal = new ClientJournal(db);
  db.close();
  for (const operation of [() => journal.read("solo"), () => journal.save("solo", solo()),
    () => journal.clear("solo", randomUUID())])
    assert.throws(operation, e => e.status === 503 && !/SQL|closed|database/i.test(e.message));
});
