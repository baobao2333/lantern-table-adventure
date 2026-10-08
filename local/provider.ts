import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join, delimiter } from "node:path";
import { tmpdir } from "node:os";
import { LocalError, type SettingsStore, type Settings } from "./settings";

type CLI = { command: string; prefix: string[] };
const activeChildren = new Set<() => void>();
export function stopProvider() {
  for (const terminate of activeChildren) terminate();
}
export function findCodex(): CLI | undefined {
  for (const directory of (process.env.PATH || "").split(delimiter)) {
    if (!directory) continue;
    const executable = join(
      directory,
      process.platform === "win32" ? "codex.exe" : "codex",
    );
    if (existsSync(executable)) return { command: executable, prefix: [] };
    // Execute the official npm entry directly: no cmd.exe interpolation of prompts or model names.
    const entry = join(
      directory,
      "node_modules",
      "@openai",
      "codex",
      "bin",
      "codex.js",
    );
    if (
      process.platform === "win32" &&
      existsSync(join(directory, "codex.cmd")) &&
      existsSync(entry)
    )
      return { command: process.execPath, prefix: [entry] };
  }
}
function run(
  cli: CLI,
  args: string[],
  input: string,
  cwd: string,
  timeout: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const environment = { ...process.env };
    delete environment.OPENAI_API_KEY;
    delete environment.CODEX_API_KEY;
    delete environment.OPENAI_BASE_URL;
    const child: ChildProcess = spawn(cli.command, [...cli.prefix, ...args], {
      cwd,
      env: environment,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "",
      size = 0,
      finished = false;
    const terminate = () => {
      if (process.platform === "win32" && child.pid)
        spawn(
          join(
            process.env.SystemRoot || "C:\\Windows",
            "System32",
            "taskkill.exe",
          ),
          ["/PID", String(child.pid), "/T", "/F"],
          { windowsHide: true, stdio: "ignore" },
        );
      else child.kill("SIGKILL");
    };
    activeChildren.add(terminate);
    const timer = setTimeout(() => {
      terminate();
      done(new LocalError("Codex 等待超时。规则存档已保留，请稍后重试。", 503));
    }, timeout);
    function done(error?: Error) {
      if (finished) return;
      finished = true;
      activeChildren.delete(terminate);
      clearTimeout(timer);
      error ? reject(error) : resolve(stdout);
    }
    child.stdout?.on("data", (chunk) => {
      size += chunk.length;
      if (size > 2_000_000) {
        terminate();
        done(new LocalError("Codex 返回内容过长。", 503));
      } else stdout += chunk.toString("utf8");
    });
    // Never forward CLI diagnostics: they can contain local configuration and prompts.
    child.stderr?.on("data", () => {});
    child.on("error", () =>
      done(
        new LocalError(
          "无法启动 Codex CLI。请安装官方 CLI，并在终端运行 codex login。",
          503,
        ),
      ),
    );
    child.on("close", (code) =>
      done(
        code === 0
          ? undefined
          : new LocalError(
              "Codex 未完成响应。请在终端运行 codex login，检查账户额度与模型权限，并更新官方 CLI。",
              503,
            ),
      ),
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}
export function completionSchema(system: string, prompt: unknown) {
  const context =
    prompt && typeof prompt === "object"
      ? (prompt as Record<string, unknown>)
      : {};
  if (
    Array.isArray(context.eligibleTargets) &&
    Array.isArray(context.skillIds) &&
    context.situation
  ) {
    const nullableId = { type: ["string", "null"] };
    const idea = {
      type: "object",
      properties: {
        title: { type: "string" },
        approach: { type: "string" },
        skill: { type: "string" },
        goalId: nullableId,
        travelTo: nullableId,
        npcId: nullableId,
        spellId: nullableId,
        success: { type: "string" },
        failure: { type: "string" },
      },
      required: [
        "title",
        "approach",
        "skill",
        "goalId",
        "travelTo",
        "npcId",
        "spellId",
        "success",
        "failure",
      ],
      additionalProperties: false,
    };
    return {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["question", "impossible", "proposal"] },
        response: { type: "string" },
        idea: { anyOf: [idea, { type: "null" }] },
      },
      required: ["kind", "response", "idea"],
      additionalProperties: false,
    };
  }
  if (system.includes("kind(action/"))
    return {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["action", "question", "impossible"] },
        actionId: { type: "string" },
        response: { type: "string" },
      },
      required: ["kind", "actionId", "response"],
      additionalProperties: false,
    };
  return {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  };
}
async function codexCompletion(
  cli: CLI,
  settings: Settings,
  system: string,
  prompt: unknown,
) {
  const directory = await mkdtemp(join(tmpdir(), "lantern-codex-"));
  try {
    const schema = completionSchema(system, prompt);
    const schemaFile = join(directory, "response.schema.json"),
      outputFile = join(directory, "response.json"),
      instructionsFile = join(directory, "instructions.md");
    await writeFile(schemaFile, JSON.stringify(schema));
    await writeFile(
      instructionsFile,
      `${system}\nYou are a text-only tabletop narrator. Use no tools, files, shell, web, skills, MCP, plugins, or agents. Respond to the supplied JSON context only. Return the required JSON; do not inspect the working directory. If the required schema has actionId, use an empty string for non-action intent. If the schema has idea, use null for non-proposal intent.`,
    );
    // Keep saved authentication without inherited MCP, hooks, providers or project rules.
    const args = [
      "exec",
      "--ignore-user-config",
      "--ignore-rules",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "--ephemeral",
      "--output-schema",
      schemaFile,
      "--output-last-message",
      outputFile,
      "--color",
      "never",
      "-c",
      'approval_policy="never"',
      "-c",
      'web_search="disabled"',
      "-c",
      'model_provider="openai"',
      "-c",
      "project_doc_max_bytes=0",
      "-c",
      `model_instructions_file=${JSON.stringify(instructionsFile)}`,
    ];
    for (const feature of [
      "shell_tool",
      "unified_exec",
      "apps",
      "plugins",
      "hooks",
      "browser_use",
      "computer_use",
      "view_image",
      "image_generation",
      "code_mode",
      "code_mode_host",
      "multi_agent",
      "memories",
      "skill_search",
      "tool_search",
      "workspace_dependencies",
      "skill_mcp_dependency_install",
    ])
      args.push("-c", `features.${feature}=false`);
    if (settings.model) args.push("--model", settings.model);
    args.push("-");
    await run(cli, args, JSON.stringify(prompt), directory, 70_000);
    const result = await readFile(outputFile, "utf8");
    if (result.length > 20_000)
      throw new LocalError("Codex 返回内容过长。", 503);
    return JSON.parse(result);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
async function apiCompletion(
  settings: Settings,
  system: string,
  prompt: unknown,
) {
  const response = await fetch(`${settings.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify({
      model: settings.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(prompt) },
      ],
      response_format: { type: "json_object" },
    }),
    signal: AbortSignal.timeout(65_000),
    redirect: "error",
  });
  if (!response.ok)
    throw new LocalError(
      response.status === 401 || response.status === 403
        ? "API 拒绝访问。请检查密钥和模型权限。"
        : `API 请求失败（HTTP ${response.status}）。请检查服务地址、模型或额度。`,
      503,
    );
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body?.getReader();
  if (!reader) throw new LocalError("API 没有返回内容。", 503);
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.length;
    if (size > 250_000) {
      await reader.cancel();
      throw new LocalError("API 返回内容过长。", 503);
    }
    chunks.push(next.value);
  }
  const bytes = Buffer.concat(chunks).toString("utf8");
  const payload = JSON.parse(bytes),
    text = payload.choices?.[0]?.message?.content;
  if (typeof text !== "string")
    throw new LocalError(
      "兼容 API 没有返回文本内容。请检查 Chat Completions 支持。",
      503,
    );
  return JSON.parse(text);
}
export function createProvider(store: SettingsStore, cli = findCodex()) {
  return {
    codexAvailable: Boolean(cli),
    ready: () => {
      const s = store.snapshot();
      return s.provider === "api"
        ? Boolean(s.apiKey && s.model)
        : s.provider === "codex" && Boolean(cli);
    },
    completion: async (system: string, prompt: unknown): Promise<unknown> => {
      const settings = store.snapshot();
      if (settings.provider === "api")
        return apiCompletion(settings, system, prompt);
      if (settings.provider === "codex") {
        if (!cli)
          throw new LocalError(
            "没有找到官方 Codex CLI。请安装后运行 codex login，再重启灯火之下。",
            503,
          );
        return codexCompletion(cli, settings, system, prompt);
      }
      throw new LocalError("请在 AI 设置中连接 Codex 或兼容 API。", 503);
    },
  };
}
