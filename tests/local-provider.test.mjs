import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
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
