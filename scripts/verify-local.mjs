import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { createServer as createSocket } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageIndex = process.argv.indexOf("--package");
const packageDirectory =
  packageIndex < 0
    ? resolve(projectRoot, "dist", "local")
    : resolve(process.argv[packageIndex + 1]);
const release = JSON.parse(
  await readFile(join(packageDirectory, "release.json"), "utf8"),
);
const nodeIndex = process.argv.indexOf("--node"),
  executable =
    nodeIndex < 0 ? process.execPath : resolve(process.argv[nodeIndex + 1]);
const dataDirectory = await mkdtemp(join(tmpdir(), "lantern-runtime-test-"));
const socket = createSocket();
await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
const origin = `http://127.0.0.1:${port}`;
let child,
  output = "";
function start(directory = dataDirectory, noCli = false) {
  output = "";
  child = spawn(
    executable,
    [
      "--disable-warning=ExperimentalWarning",
      join(packageDirectory, "server.mjs"),
    ],
    {
      cwd: packageDirectory,
      env: {
        ...process.env,
        LANTERN_PORT: String(port),
        LANTERN_DATA_DIR: directory,
        ...(noCli ? { PATH: "" } : {}),
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", (bytes) => (output += bytes));
  child.stderr.on("data", (bytes) => (output += bytes));
  return ready();
}
async function ready() {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null)
      throw new Error(`Local server failed to start: ${output}`);
    try {
      const response = await fetch(`${origin}/api/table`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Local server did not become ready: ${output}`);
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const stopped = new Promise((resolve) => child.once("close", resolve));
  child.kill();
  await stopped;
}
async function request(path, body, extra = {}) {
  const response = await fetch(
    origin + path,
    body
      ? {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: origin,
            ...extra,
          },
          body: JSON.stringify(body),
        }
      : { headers: extra },
  );
  const result = await response.json();
  return { status: response.status, result };
}
const testKey = "fixture-key-for-local-runtime-test";
let apiCalls = 0;
let authorCalls = 0;
const customWorldId = "fixture-generated-world";
const soloQuestion = "fixture-success-solo-question";
const soloReply = "守钟人认真听完你的问题，解释眼前可见的处境，等待你决定下一步。";
const mock = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  assert.equal(request.url, "/v1/chat/completions");
  assert.equal(request.headers.authorization === `Bearer ${testKey}`, true);
  const payload = JSON.parse(body);
  assert.equal(payload.response_format.type, "json_object");
  const prompt = JSON.parse(payload.messages[1].content);
  let result = { text: "连接成功" };
  if (prompt.playerInput === soloQuestion)
    result = { kind: "question", response: soloReply };
  if (prompt.task === "author-world") {
    authorCalls++;
    assert.equal(prompt.schema.type, "object");
    assert.equal(prompt.example.format, "situation-v1");
    assert.ok(prompt.reservedIds.includes("moonbridge-conspiracy"));
    assert.equal(prompt.size, "campaign");
    assert.match(payload.messages[0].content, /"required":\["json"\]/);
    const world = structuredClone(prompt.example);
    world.id = customWorldId;
    world.revision = 3;
    world.title = "Fixture 验收：月桥续篇";
    world.hook = "Fixture 原始开场：旅人回到月桥旅店，继续调查河灯。";
    world.locations[0].description = "Fixture 原始地点：炉火摇动，旅店老板正在擦拭柜台。";
    result = { json: JSON.stringify(world) };
  }
  apiCalls++;
  response.setHeader("Content-Type", "application/json");
  response.end(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify(result) } }],
    }),
  );
});
await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
try {
  await start();
  const bootstrap = (await request("/api/table")).result;
  assert.equal(bootstrap.userId, "local-owner");
  assert.equal(bootstrap.local, true);
  assert.equal(bootstrap.version, release.version);
  assert.equal(bootstrap.aiReady, false);
  assert.equal(
    (
      await request("/api/settings", undefined, {
        Origin: "https://example.org",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(
        "/api/settings",
        { op: "save", provider: "none" },
        { Origin: "https://example.org" },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await request(
        "/api/settings",
        { op: "save", provider: "none" },
        { "Content-Type": "text/plain" },
      )
    ).status,
    415,
  );
  const rejectedHost = await new Promise((resolve, reject) => {
    const req = httpRequest(
      `${origin}/api/table`,
      { headers: { Host: "example.org" } },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      },
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(rejectedHost, 403);
  const created = await request("/api/table", {
    op: "hero.create",
    name: "本机验证旅人",
    classId: "rogue",
    background: "自动验证存档",
  });
  assert.equal(created.status, 200);
  const heroId = created.result.hero.id;
  assert.equal(
    (
      await request("/api/table", {
        op: "game.create",
        heroId,
        campaignId: "silent-bell",
        mode: "party",
      })
    ).status,
    400,
  );
  const game = await request("/api/table", {
    op: "game.create",
    heroId,
    campaignId: "silent-bell",
    mode: "solo",
  });
  assert.equal(game.status, 200);
  const gameId = game.result.view.game.id;
  const saved = await request("/api/settings", {
    op: "save",
    provider: "api",
    baseUrl: `http://127.0.0.1:${mock.address().port}/v1`,
    model: "fixture",
    apiKey: testKey,
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.result.config.hasKey, true);
  assert.equal("apiKey" in saved.result.config, false);
  assert.equal(
    (await readFile(join(dataDirectory, "settings.json"), "utf8")).includes(
      testKey,
    ),
    false,
  );
  assert.equal(
    (await request("/api/settings", { op: "test" })).result.ok,
    true,
  );
  assert.equal(apiCalls, 1);
  await stop();
  await start();
  const restored = (await request("/api/table")).result;
  assert.equal(restored.heroes[0].id, heroId);
  assert.equal(restored.games[0].id, gameId);
  assert.equal(restored.aiReady, true);
  assert.equal(
    (
      await request("/api/settings", {
        op: "save",
        provider: "api",
        model: "fixture-2",
      })
    ).result.config.hasKey,
    true,
  );
  assert.equal(
    (await request("/api/settings", { op: "test" })).result.ok,
    true,
  );
  assert.equal(apiCalls, 2);
  const startPayload = { op: "game.command", id: gameId, expectedVersion: game.result.view.version,
    requestId: crypto.randomUUID(), command: { kind: "action", actionId: game.result.view.actions[0].id } };
  assert.equal((await request("/api/client-journal?kind=solo", { kind: "solo", op: "save", payload: startPayload })).status, 200);
  const started = await request("/api/table", startPayload);
  assert.equal(started.status, 200);
  await stop(); await start();
  const journal = (await request("/api/client-journal?kind=solo")).result.pending;
  assert.deepEqual(journal, startPayload);
  const recovered = await request("/api/table", journal);
  assert.equal(recovered.result.view.version, started.result.view.version);
  assert.deepEqual(recovered.result.view.game.messages, started.result.view.game.messages);
  assert.equal((await request("/api/client-journal?kind=solo", { kind: "solo", op: "clear", requestId: journal.requestId })).result.pending, null);
  const stale = await request("/api/table", { ...startPayload, requestId: crypto.randomUUID() });
  assert.equal(stale.status, 409); assert.equal(stale.result.code, "stale_version");
  const failedIntent = await request("/api/table", { op: "game.talk", id: gameId, expectedVersion: recovered.result.view.version,
    requestId: crypto.randomUUID(), text: "如何向守钟人打听失踪的钟声？" });
  assert.equal(failedIntent.status, 503); assert.equal(failedIntent.result.code, "intent_failed");
  const afterFailure = (await request(`/api/table?id=${gameId}`)).result.view;
  assert.equal(afterFailure.version, recovered.result.view.version);

  const successfulTalk = await request("/api/table", {
    op: "game.talk", id: gameId, expectedVersion: afterFailure.version,
    requestId: crypto.randomUUID(), text: soloQuestion,
  });
  assert.equal(successfulTalk.status, 200);
  const talked = successfulTalk.result.view;
  assert.equal(talked.version, afterFailure.version + 1);
  assert.equal(talked.game.messages.at(-1).text, soloReply);
  assert.equal(talked.game.messages.at(-1).ai, true);
  const { messages: beforeMessages, ...beforeMechanics } = afterFailure.game;
  const { messages: afterMessages, ...afterMechanics } = talked.game;
  assert.equal(afterMessages.length, beforeMessages.length + 2);
  assert.deepEqual(afterMechanics, beforeMechanics, "A question must not execute rules, consume resources or roll dice.");

  const contractResponse = await request("/api/content?contract=1");
  assert.equal(contractResponse.status, 200);
  const contract = contractResponse.result;
  assert.equal(contract.format, "situation-v1");
  assert.equal(contract.schema.type, "object");
  assert.equal(contract.schema.properties.locations.type, "array");
  assert.equal(contract.example.id, "moonbridge-conspiracy");
  assert.ok(contract.guide.length > 0);
  assert.ok(contract.prompt.length > 0);
  const invalidText = JSON.stringify({ format: "situation-v1", id: "invalid-fixture" });
  const invalidValidation = await request("/api/content", { op: "validate", text: invalidText });
  assert.equal(invalidValidation.status, 200);
  assert.equal(invalidValidation.result.world, null);
  assert.ok(invalidValidation.result.issues.length > 0);
  const invalidSave = await request("/api/content", { op: "save", text: invalidText });
  assert.equal(invalidSave.status, 400);
  assert.ok(invalidSave.result.error);
  assert.equal((await request("/api/content")).result.worlds.length, 0);

  const jobId = crypto.randomUUID();
  const generation = { op: "generate", id: jobId, brief: "Fixture：沿用契约范例，生成可保存的持续战役。", size: "campaign" };
  const generated = await request("/api/content", generation);
  assert.equal(generated.status, 202);
  assert.equal(generated.result.job.id, jobId);
  const duplicateJob = await request("/api/content", generation);
  assert.equal(duplicateJob.status, 202);
  assert.equal(duplicateJob.result.job.id, jobId);
  assert.equal((await request("/api/content", { ...generation, brief: "Different fixture brief" })).status, 409);
  let readyJob;
  for (let attempt = 0; attempt < 100; attempt++) {
    const polled = await request(`/api/content?job=${jobId}`);
    assert.equal(polled.status, 200);
    readyJob = polled.result.job;
    assert.equal(readyJob.id, jobId);
    if (readyJob.status !== "generating") break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(readyJob.status, "ready", JSON.stringify(readyJob.issues));
  assert.deepEqual(readyJob.issues, []);
  assert.equal(authorCalls, 1, "Retrying a generation request must not send another model request.");
  assert.equal((await request("/api/content")).result.worlds.length, 0, "Generation must not implicitly publish to the local library.");
  const customText = readyJob.text;
  const validated = await request("/api/content", { op: "validate", text: customText });
  assert.equal(validated.status, 200);
  assert.deepEqual(validated.result.issues, []);
  assert.equal(validated.result.world.id, customWorldId);
  const customSaved = await request("/api/content", { op: "save", text: customText });
  assert.equal(customSaved.status, 200);
  assert.deepEqual(customSaved.result.saved, { id: customWorldId, revision: 3 });
  const customRead = await request(`/api/content?id=${customWorldId}`);
  assert.equal(customRead.status, 200);
  assert.deepEqual(JSON.parse(customRead.result.text), JSON.parse(customText));
  assert.ok((await request("/api/table")).result.campaigns.some(campaign => campaign.id === customWorldId));

  const customGame = await request("/api/table", { op: "game.create", heroId, campaignId: customWorldId, mode: "solo" });
  assert.equal(customGame.status, 200);
  const customGameId = customGame.result.view.game.id;
  assert.equal(customGame.result.view.game.campaignRevision, 3);
  assert.equal(customGame.result.view.game.campaignId, customWorldId);
  assert.equal(customGame.result.view.scene.description, "Fixture 原始地点：炉火摇动，旅店老板正在擦拭柜台。");
  const updatedWorld = JSON.parse(customText);
  updatedWorld.revision = 4;
  updatedWorld.title = "Fixture 验收：月桥续篇修订版";
  updatedWorld.hook = "Fixture 新版开场：河灯已经修好，旅店迎来了新客人。";
  updatedWorld.locations[0].description = "Fixture 新版地点：河灯照亮窗沿，旅店老板正在迎接来客。";
  const revisedText = JSON.stringify(updatedWorld);
  assert.equal((await request("/api/content", { op: "save", text: revisedText })).status, 200);
  assert.equal((await request("/api/content", { op: "save", text: customText })).status, 409);
  const oldGameAfterUpdate = await request(`/api/table?id=${customGameId}`);
  assert.equal(oldGameAfterUpdate.status, 200);
  assert.deepEqual(oldGameAfterUpdate.result.view, customGame.result.view, "Library revisions must not mutate a saved game's content snapshot.");
  const revisedGame = await request("/api/table", { op: "game.create", heroId, campaignId: customWorldId, mode: "solo" });
  assert.equal(revisedGame.status, 200);
  assert.equal(revisedGame.result.view.game.campaignRevision, 4);
  assert.equal(revisedGame.result.view.title, updatedWorld.title);
  assert.equal(revisedGame.result.view.scene.description, updatedWorld.locations[0].description);

  await stop(); await start();
  const libraryAfterRestart = await request("/api/content");
  assert.equal(libraryAfterRestart.status, 200);
  assert.ok(libraryAfterRestart.result.worlds.some(world => world.id === customWorldId && world.revision === 4));
  assert.equal((await request(`/api/content?job=${jobId}`)).result.job.status, "ready");
  assert.deepEqual(JSON.parse((await request(`/api/content?id=${customWorldId}`)).result.text), updatedWorld);
  assert.ok((await request("/api/table")).result.campaigns.some(campaign => campaign.id === customWorldId));
  assert.deepEqual((await request(`/api/table?id=${customGameId}`)).result.view, customGame.result.view);
  assert.deepEqual((await request(`/api/table?id=${revisedGame.result.view.game.id}`)).result.view, revisedGame.result.view);
  assert.deepEqual((await request(`/api/table?id=${gameId}`)).result.view, talked);
  await stop();
  const missingCliDirectory = join(dataDirectory, "missing-cli");
  await start(missingCliDirectory, true);
  assert.equal(
    (
      await request("/api/settings", {
        op: "save",
        provider: "codex",
        model: "",
      })
    ).status,
    200,
  );
  const unavailable = await request("/api/settings", { op: "test" });
  assert.equal(unavailable.status, 503);
  assert.match(unavailable.result.error, /Codex CLI/);
  console.log(
    "PASS: packaged localhost runtime, origin/host boundaries, real SQLite persistence, DPAPI key storage, fixture API connection and solo dialogue, retained key, missing Codex diagnostics, custom campaign contract/validation/generation/save, idempotent jobs, content revisions and immutable saved snapshots across restart. No live paid model calls.",
  );
} finally {
  await stop();
  await new Promise((resolve) => mock.close(resolve));
  await rm(dataDirectory, { recursive: true, force: true });
}
