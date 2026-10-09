import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = process.env.LANTERN_TEST_SOURCE || projectRoot;
const require = createRequire(join(sourceRoot, "package.json"));
const { build } = await import(pathToFileURL(require.resolve("esbuild")).href);
const compiled = await build({
  entryPoints: [join(projectRoot, "local", "provider.ts")],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  target: "node24",
});
const { completionSchema, createProvider } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`
);
test("Codex structured output distinguishes world proposals, legacy options and narration", () => {
  const world = completionSchema("You are a DM", {
    situation: { location: "inn" },
    eligibleTargets: [],
    skillIds: ["persuasion"],
  });
  assert.deepEqual(world.properties.kind.enum, [
    "question",
    "impossible",
    "proposal",
  ]);
  const idea = world.properties.idea.anyOf[0];
  assert.equal(idea.additionalProperties, false);
  assert.deepEqual(idea.required, [
    "title",
    "approach",
    "skill",
    "goalId",
    "travelTo",
    "npcId",
    "spellId",
    "success",
    "failure",
  ]);
  assert.deepEqual(idea.properties.goalId.type, ["string", "null"]);
  assert.deepEqual(
    completionSchema("Output kind(action/question/impossible)", {}).properties
      .kind.enum,
    ["action", "question", "impossible"],
  );
  assert.deepEqual(completionSchema("Return JSON text", {}).required, ["text"]);
});

test("Codex keeps saved auth without partial MCP transport overrides", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lantern-provider-cli-test-"));
  const fake = join(directory, "cli.mjs");
  await writeFile(
    fake,
    `
    import assert from "node:assert/strict";
    import { writeFile } from "node:fs/promises";
    const args = process.argv.slice(2);
    assert.equal(args[0], "exec");
    for (const flag of ["--ignore-user-config", "--ignore-rules", "--ephemeral", "project_doc_max_bytes=0", "features.code_mode_host=false"]) assert.ok(args.includes(flag));
    assert.equal(args[args.indexOf("--sandbox") + 1], "read-only");
    assert.equal(args.some(value => value.startsWith("mcp_servers.")), false);
    assert.equal(args.some(value => value.startsWith("model_reasoning_effort=")), false);
    for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "OPENAI_BASE_URL", "CODEX_REMOTE", "CODEX_CLI_PATH"]) assert.equal(process.env[key], undefined);
    let input = ""; for await (const chunk of process.stdin) input += chunk;
    assert.equal(JSON.parse(input).task, "fixture-connection-test");
    await writeFile(args[args.indexOf("--output-last-message") + 1], JSON.stringify({text:"fixture-connected"}));
  `,
  );
  try {
    const provider = createProvider(
      {
        snapshot: () => ({
          provider: "codex",
          model: "",
          baseUrl: "https://example.org/v1",
          apiKey: "",
        }),
      },
      { command: process.execPath, prefix: [fake] },
    );
    assert.deepEqual(
      await provider.completion("Return only JSON text.", {
        task: "fixture-connection-test",
      }),
      { text: "fixture-connected" },
    );
  } finally {
    assert.ok(
      directory.startsWith(join(tmpdir(), "lantern-provider-cli-test-")),
    );
    await rm(directory, { recursive: true, force: true });
  }
});

test("an installed CLI is unavailable until official authentication is confirmed", async () => {
  let authenticated = false;
  const provider = createProvider(
    { snapshot: () => ({ provider: "codex", model: "", baseUrl: "https://example.org/v1", apiKey: "" }) },
    { command: process.execPath, prefix: ["this-file-must-not-execute.mjs"] },
    undefined,
    () => authenticated,
  );
  assert.equal(provider.codexAvailable, true);
  assert.equal(provider.ready(), false);
  await assert.rejects(provider.completion("Return JSON text.", { task: "test" }), /尚未登录/);
  authenticated = true;
  assert.equal(provider.ready(), true);
  authenticated = false;
  assert.equal(provider.ready(), false);
});

test("Codex campaign generation uses its own schema and bounded UTF-8 output budget", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "lantern-provider-campaign-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fake = join(directory, "cli.mjs");
  await writeFile(fake, `
    import assert from "node:assert/strict";
    import { readFile, writeFile } from "node:fs/promises";
    const args = process.argv.slice(2);
    const schema = JSON.parse(await readFile(args[args.indexOf("--output-schema") + 1], "utf8"));
    const instructions = args.find(value => value.startsWith("model_instructions_file="));
    const instructionText = await readFile(JSON.parse(instructions.slice("model_instructions_file=".length)), "utf8");
    assert.match(instructionText, /supplied tabletop task/);
    assert.match(instructionText, /Ignore unrelated global or project AGENTS\.md instructions/);
    assert.match(instructionText, /Do not add personal greetings, catchphrases, sign-offs, or meta commentary/);
    assert.match(instructionText, /use the narrator or NPC voice defined by the game/);
    assert.match(instructionText, /Use no tools/);
    let input=""; for await (const chunk of process.stdin) input += chunk;
    const prompt = JSON.parse(input);
    assert.deepEqual(schema.required, prompt.explicitSchema ? ["campaign"] : ["text"]);
    const result = prompt.explicitSchema ? {campaign:"地".repeat(10000)} : {text:"x".repeat(21000)};
    await writeFile(args[args.indexOf("--output-last-message") + 1], JSON.stringify(result));
  `);
  const provider = createProvider(
    { snapshot: () => ({ provider: "codex", model: "", baseUrl: "https://example.org/v1", apiKey: "" }) },
    { command: process.execPath, prefix: [fake] },
  );
  const schema = {type:"object", properties:{campaign:{type:"string"}}, required:["campaign"], additionalProperties:false};
  const output = await provider.completion("Generate a tabletop campaign.", {explicitSchema:true}, undefined,
    {schema, maxOutputBytes:40000, timeoutMs:120000});
  assert.equal(output.campaign.length, 10000);
  await assert.rejects(provider.completion("Generate a tabletop campaign.", {explicitSchema:true}, undefined,
    {schema, maxOutputBytes:20000}), /内容过长/);
  await assert.rejects(provider.completion("Return only JSON text.", {}, undefined), /内容过长/);
});

test("Codex reasoning effort is explicit, scoped to one task and validated before spawning", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "lantern-provider-reasoning-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fake = join(directory, "cli.mjs");
  await writeFile(fake, `
    import assert from "node:assert/strict";
    import { writeFile } from "node:fs/promises";
    const args = process.argv.slice(2);
    let input=""; for await (const chunk of process.stdin) input += chunk;
    const prompt = JSON.parse(input);
    const overrides = args.filter(value => value.startsWith("model_reasoning_effort="));
    assert.deepEqual(overrides, prompt.effort ? ["model_reasoning_effort=" + JSON.stringify(prompt.effort)] : []);
    if (overrides.length) assert.equal(args[args.indexOf(overrides[0]) - 1], "-c");
    await writeFile(args[args.indexOf("--output-last-message") + 1], JSON.stringify({text:"fixture-reasoning-checked"}));
  `);
  const provider = createProvider(
    { snapshot: () => ({ provider:"codex", model:"", baseUrl:"https://example.org/v1", apiKey:"" }) },
    { command:process.execPath, prefix:[fake] },
  );
  for (const effort of ["low", "medium"])
    assert.deepEqual(await provider.completion("Return only JSON text.", {effort}, undefined,
      {codexReasoningEffort:effort}), {text:"fixture-reasoning-checked"});
  assert.deepEqual(await provider.completion("Return only JSON text.", {}), {text:"fixture-reasoning-checked"});
  const mustNotSpawn = createProvider(
    { snapshot: () => { throw new Error("Invalid reasoning must be rejected before settings and spawn"); } },
    { command:process.execPath, prefix:["this-file-must-not-execute.mjs"] },
  );
  for (const effort of ["high", "ultra", "", null, 1])
    await assert.rejects(mustNotSpawn.completion("Invalid request.", {}, undefined,
      {codexReasoningEffort:effort}), /推理强度/);
});

test("API campaign generation keeps JSON compatibility and enforces output and timeout budgets", async (t) => {
  let calls = 0;
  const server = createServer(async (request, response) => {
    let input=""; for await (const chunk of request) input += chunk;
    const payload = JSON.parse(input), prompt = JSON.parse(payload.messages[1].content);
    calls++;
    assert.equal(request.headers.authorization, "Bearer fixture-key");
    assert.equal(payload.response_format.type, "json_object");
    assert.equal(Object.hasOwn(payload, "model_reasoning_effort"), false);
    assert.equal(Object.hasOwn(payload, "reasoning_effort"), false);
    assert.equal(Object.hasOwn(payload, "codexReasoningEffort"), false);
    if (prompt.explicitSchema) assert.match(payload.messages[0].content, /"required":\["campaign"\]/);
    if (prompt.hang) return;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({choices:[{message:{content:JSON.stringify({campaign:"地".repeat(10000)})}}]}));
  });
  await new Promise(resolve => server.listen(0,"127.0.0.1",resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const provider = createProvider({snapshot: () => ({provider:"api", model:"fixture", baseUrl:`http://127.0.0.1:${server.address().port}/v1`, apiKey:"fixture-key"})});
  const schema = {type:"object",properties:{campaign:{type:"string"}},required:["campaign"],additionalProperties:false};
  const output = await provider.completion("Generate a tabletop campaign.", {explicitSchema:true}, undefined,
    {schema, maxOutputBytes:40000, timeoutMs:120000, codexReasoningEffort:"low"});
  assert.equal(output.campaign.length,10000);
  await assert.rejects(provider.completion("Generate a tabletop campaign.", {}, undefined,
    {maxOutputBytes:20000}), /内容过长/);
  await assert.rejects(provider.completion("Generate a tabletop campaign.", {hang:true}, undefined,
    {timeoutMs:20}), error => error.name === "TimeoutError");
  const before = calls;
  await assert.rejects(provider.completion("Invalid request.", {}, undefined, {maxOutputBytes:262145}), /预算/);
  await assert.rejects(provider.completion("Invalid request.", {}, undefined, {timeoutMs:120001}), /时限/);
  assert.equal(calls,before);
});
