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
const mock = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  assert.equal(request.url, "/v1/chat/completions");
  assert.equal(request.headers.authorization === `Bearer ${testKey}`, true);
  assert.equal(JSON.parse(body).response_format.type, "json_object");
  apiCalls++;
  response.setHeader("Content-Type", "application/json");
  response.end(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ text: "连接成功" }) } }],
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
    "PASS: packaged localhost runtime, origin/host boundaries, real SQLite persistence, DPAPI key storage, API JSON completion, retained key, missing Codex diagnostics.",
  );
} finally {
  await stop();
  await new Promise((resolve) => mock.close(resolve));
  await rm(dataDirectory, { recursive: true, force: true });
}
