import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const compiled = await build({ stdin: { contents: 'export * from "./local/content-workshop.ts"; export {createGame} from "./lib/game/engine.ts"; export {createHero} from "./lib/game/characters.ts";', resolveDir: root }, bundle: true, write: false, platform: "node", format: "esm", target: "node24" });
const { ContentWorkshop, checkWorld, createGame, createHero, authoringContract } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`);
const template = JSON.parse(await readFile(new URL("../content/worlds/moonbridge-conspiracy.json", import.meta.url), "utf8"));
function custom(id = "custom-archipelago") { return { ...structuredClone(template), id, title: "群岛的回声" }; }
const tick = () => new Promise(resolve => setTimeout(resolve, 10));

test("runtime imports use the canonical schema and semantic checks", () => {
  assert.equal(checkWorld(JSON.stringify(custom())).issues.length, 0);
  const invalid = custom(); invalid.locations[0].exits.push("missing-port");
  assert.match(checkWorld(JSON.stringify(invalid)).issues.join(" "), /unknown reference|reachable/);
  assert.equal(checkWorld(JSON.stringify({ ...custom(), script: "execute()" })).world, null);
  assert.equal(checkWorld("```json\n{}\n```").world, null);
  assert.equal(checkWorld("汉".repeat(200000)).world, null);
  assert.equal(authoringContract().schema.properties.format.const, "situation-v1");
});

test("library revisions persist without changing existing game snapshots", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lantern-content-")), path = join(directory, "test.sqlite");
  let database = new DatabaseSync(path);
  try {
    let store = new ContentWorkshop(database, async () => ({}), () => false);
    assert.throws(() => store.save(JSON.stringify(template)), /内置/);
    const world = custom(); store.save(JSON.stringify(world));
    assert.equal(store.save(JSON.stringify(world)).revision, 1);
    const game = createGame("game", "owner", createHero("hero", "rogue", "Echo", ""), world.id, "solo", "SOLO", store.campaign(world.id));
    world.title = "修订后的群岛";
    assert.throws(() => store.save(JSON.stringify(world)), /revision/);
    world.revision++; store.save(JSON.stringify(world));
    assert.equal(game.campaignSnapshot.title, "群岛的回声");
    assert.equal(game.campaignSnapshot.world.id, world.id);
    assert.equal(store.campaign(world.id).title, world.title);
    store.close(); database.close(); database = new DatabaseSync(path);
    store = new ContentWorkshop(database, async () => ({}), () => false);
    assert.equal(store.list()[0].revision, 2);
    assert.equal(JSON.parse(store.read(world.id)).title, world.title);
    store.close();
  } finally { database.close(); await rm(directory, { recursive: true, force: true }); }
});

test("generation is bounded, idempotent, validated, and never auto-saved", async () => {
  const database = new DatabaseSync(":memory:");
  let calls = 0, release;
  const store = new ContentWorkshop(database, async (system, input, signal, options) => {
    calls++; assert.equal(input.task, "author-world"); assert.equal(options.timeoutMs, 120000); assert.equal(options.schema.properties.json.type, "string");
    assert.match(system, /No markdown/); assert.equal(signal.aborted, false);
    return await new Promise(resolve => { release = () => resolve({ json: JSON.stringify(custom()) }); });
  }, () => true);
  try {
    const id = crypto.randomUUID();
    assert.equal(store.generate(id, "群岛悬疑", "campaign").status, "generating");
    store.generate(id, "群岛悬疑", "campaign"); assert.equal(calls, 1);
    assert.throws(() => store.generate(id, "其他需求", "campaign"), /ID/);
    assert.throws(() => store.generate(crypto.randomUUID(), "另一个", "short"), /已有/);
    release(); await tick();
    assert.equal(store.job(id).status, "ready"); assert.equal(store.list().length, 0);
    store.save(store.job(id).text); assert.equal(store.list().length, 1);
  } finally { store.close(); database.close(); }
});

test("invalid AI content is recoverable but cannot enter the library", async () => {
  const database = new DatabaseSync(":memory:");
  const store = new ContentWorkshop(database, async () => ({ json: '{"format":"situation-v1"}' }), () => true);
  try {
    const id = crypto.randomUUID(); store.generate(id, "悬疑", "short"); await tick();
    assert.equal(store.job(id).status, "failed"); assert.ok(store.job(id).issues.length);
    assert.throws(() => store.save(store.job(id).text), /校验/); assert.equal(store.list().length, 0);
  } finally { store.close(); database.close(); }
});

test("cancellation fences late output and startup marks unfinished work interrupted", async () => {
  const database = new DatabaseSync(":memory:"); let release;
  const store = new ContentWorkshop(database, async () => await new Promise(resolve => { release = resolve; }), () => true);
  try {
    const id = crypto.randomUUID(); store.generate(id, "群岛", "short"); store.cancel(id);
    release({ json: JSON.stringify(custom()) }); await tick();
    assert.equal(store.job(id).status, "cancelled"); assert.equal(store.job(id).text, "");
    const unfinished = { ...store.job(id), id: crypto.randomUUID(), status: "generating" };
    database.prepare("INSERT INTO content_jobs VALUES(?,?,?)").run(unfinished.id, "fixture", JSON.stringify(unfinished));
    const restarted = new ContentWorkshop(database, async () => ({}), () => false);
    assert.equal(restarted.job(unfinished.id).status, "interrupted");
    assert.throws(() => restarted.generate(crypto.randomUUID(), "群岛", "short"), /登录 Codex/); restarted.close();
  } finally { store.close(); database.close(); }
});

test("background storage failures stay contained and retain an exportable draft", async () => {
  const database = new DatabaseSync(":memory:");
  const store = new ContentWorkshop(database, async () => ({ json: JSON.stringify(custom()) }), () => true);
  try {
    database.exec("CREATE TRIGGER fixture_storage_failure BEFORE UPDATE ON content_jobs BEGIN SELECT RAISE(ABORT,'fixture disk full'); END;");
    const id = crypto.randomUUID(); store.generate(id, "群岛", "short"); await tick();
    assert.equal(store.job(id).status, "failed"); assert.match(store.job(id).issues[0], /无法保存/);
    assert.equal(JSON.parse(store.job(id).text).id, "custom-archipelago");
    assert.equal(database.prepare("SELECT 1 AS alive").get().alive, 1);
  } finally { store.close(); database.close(); }
});
