// Opt-in acceptance: uses the current user's existing Codex login and model quota.
import { build } from "esbuild";
import { DatabaseSync } from "node:sqlite";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import assert from "node:assert/strict";
const root = fileURLToPath(new URL("../", import.meta.url));
const compiled = await build({ stdin: { contents: 'export {ContentWorkshop} from "./local/content-workshop.ts";export {createProvider,stopProvider,findCodex} from "./local/provider.ts";export {createGame} from "./lib/game/engine.ts";export {createHero} from "./lib/game/characters.ts";', resolveDir: root }, bundle: true, write: false, platform: "node", format: "esm", target: "node24" });
const { ContentWorkshop, createProvider, stopProvider, findCodex, createGame, createHero } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`);
if (!findCodex()) throw new Error("An existing authenticated official Codex CLI is required. Log in yourself before this optional check.");
const modelIndex = process.argv.indexOf("--model"), model = modelIndex < 0 ? "" : process.argv[modelIndex + 1];
const provider = createProvider({ snapshot: () => ({ provider: "codex", model, apiKey: "", baseUrl: "" }) });
const database = new DatabaseSync(":memory:"), workshop = new ContentWorkshop(database, provider.completion, provider.ready);
const id = crypto.randomUUID(), start = Date.now();
try {
  workshop.generate(id, "写一个原创中文沿海灯塔调查冒险：海雾让信件到达错误年代，NPC各有动机，玩家可谈判或调查，战斗可绕过；保持4个地点和10个机会的小规模，确保两种不同价值选择的结局及失败后替代路径。", "short");
  let job;
  do { await new Promise(resolve => setTimeout(resolve, 1000)); job = workshop.job(id); } while (job.status === "generating");
  assert.equal(job.status, "ready", `Live generation failed: ${job.issues.join("; ")}`);
  const saved = workshop.save(job.text), campaign = workshop.campaign(saved.id);
  const game = createGame(crypto.randomUUID(), "acceptance-owner", createHero(crypto.randomUUID(), "rogue", "Live acceptance", ""), campaign.id, "solo", "LIVE", campaign);
  assert.equal(game.campaignSnapshot.id, saved.id); assert.ok(game.world);
  const directory = join(root, "dist", "acceptance"); await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "generated-world-live.json"), job.text);
  const evidence = { test: "live-codex-content-generation", passed: true, checkedAt: new Date().toISOString(), elapsedMs: Date.now() - start, model: model || "CLI default", world: { id: campaign.id, title: campaign.title, locations: campaign.world.locations.length, opportunities: campaign.world.opportunities.length }, checks: ["real model response", "canonical schema", "semantic references", "local library save", "game snapshot initialization"], limitation: "This does not prove all dynamic story routes or quality. Uses existing account quota; no account credentials are retained." };
  await writeFile(join(directory, "generated-world-live-evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify(evidence));
} finally { workshop.close(); stopProvider(); database.close(); }
