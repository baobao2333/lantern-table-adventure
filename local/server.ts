import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFile, stat } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { join, resolve, extname, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { handleGET, handlePOST } from "@/lib/server/service";
import { configureRuntime } from "@/lib/server/runtime";
import { SQLiteD1 } from "./sqlite";
import { SettingsStore, LocalError } from "./settings";
import { createProvider, stopProvider } from "./provider";

export const VERSION = "0.2.0";
const releaseDirectory = dirname(fileURLToPath(import.meta.url));
const dataDirectory = process.env.LANTERN_DATA_DIR
  ? resolve(process.env.LANTERN_DATA_DIR)
  : join(
      process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"),
      "LanternTable",
    );
const port = Number(process.env.LANTERN_PORT || 4173);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("LANTERN_PORT must be an integer from 1024 to 65535.");
mkdirSync(dataDirectory, { recursive: true });
const database = new SQLiteD1(
  join(dataDirectory, "adventures.sqlite"),
  join(releaseDirectory, "migrations"),
);
const settings = new SettingsStore(dataDirectory),
  provider = createProvider(settings);
function updateRuntime() {
  configureRuntime({
    DB: database as unknown as D1Database,
    local: true,
    aiReady: provider.ready(),
    completion: provider.completion,
  });
}
updateRuntime();
const staticRoot = resolve(releaseDirectory, "client"),
  origin = `http://127.0.0.1:${port}`;
const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};
const headers = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};
function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers });
}
function boundary(request: IncomingMessage) {
  if (
    request.socket.remoteAddress !== "127.0.0.1" &&
    request.socket.remoteAddress !== "::ffff:127.0.0.1"
  )
    throw new LocalError("本机服务只接受 localhost 请求。", 403);
  if (request.headers.host !== `127.0.0.1:${port}`)
    throw new LocalError("请使用启动窗口显示的 127.0.0.1 地址。", 403);
  if (request.headers.origin && request.headers.origin !== origin)
    throw new LocalError("请从本机灯火之下页面发起操作。", 403);
  if (
    request.headers["sec-fetch-site"] &&
    !["same-origin", "none"].includes(String(request.headers["sec-fetch-site"]))
  )
    throw new LocalError("请从本机灯火之下页面发起操作。", 403);
  if (
    request.method === "POST" &&
    !String(request.headers["content-type"] || "")
      .toLowerCase()
      .startsWith("application/json")
  )
    throw new LocalError("操作需要 JSON 请求。", 415);
}
async function bodyOf(request: IncomingMessage) {
  if (Number(request.headers["content-length"]) > 16_384)
    throw new LocalError("输入太长。", 413);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 16_384) throw new LocalError("输入太长。", 413);
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}
async function dispatch(incoming: IncomingMessage): Promise<Response> {
  boundary(incoming);
  const url = new URL(incoming.url || "/", origin);
  if (url.origin !== origin) throw new LocalError("请使用本机服务地址。", 403);
  if (!["GET", "POST"].includes(incoming.method || ""))
    return json({ error: "不支持的请求方式。" }, 405);
  if (url.pathname === "/api/settings") {
    if (incoming.method === "GET")
      return json({ config: settings.safe(provider.codexAvailable) });
    const input = JSON.parse(await bodyOf(incoming));
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new LocalError("设置格式不正确。");
    if (input.op === "save") {
      settings.save(input);
      updateRuntime();
      return json({ config: settings.safe(provider.codexAvailable) });
    }
    if (input.op === "test") {
      try {
        const result = await provider.completion(
          'Return only JSON {"text":"连接成功"}. You are testing a tabletop narrator connection. No tools.',
          { task: "connection-test" },
        );
        if (
          !result ||
          typeof result !== "object" ||
          typeof (result as { text?: unknown }).text !== "string"
        )
          throw new LocalError("AI 返回的 JSON 格式不正确。", 503);
        return json({
          config: settings.safe(provider.codexAvailable),
          ok: true,
          message: "AI 连接成功。",
        });
      } catch (error) {
        throw error instanceof LocalError
          ? error
          : new LocalError(
              "AI 连接测试失败。请检查地址、密钥、模型和 JSON 输出支持。",
              503,
            );
      }
    }
    throw new LocalError("未知设置操作。");
  }
  if (url.pathname === "/api/table") {
    const body =
      incoming.method === "POST" ? await bodyOf(incoming) : undefined;
    if (body) {
      const input = JSON.parse(body);
      if (
        input?.op === "game.join" ||
        (input?.op === "game.create" && input?.mode === "party")
      )
        throw new LocalError(
          "本机 0.2 版本支持单人冒险；局域网组队将在 0.3 版本开放。",
        );
    }
    const request = new Request(url, {
      method: incoming.method,
      headers: incoming.headers as Record<string, string>,
      ...(body !== undefined ? { body } : {}),
    });
    const response =
      incoming.method === "GET"
        ? await handleGET(request, "local-owner")
        : await handlePOST(request, "local-owner");
    if (incoming.method === "GET" && !url.search && response.ok)
      return json({
        ...((await response.json()) as object),
        local: true,
        version: VERSION,
      });
    return response;
  }
  if (url.pathname.startsWith("/api/"))
    return json({ error: "接口不存在。" }, 404);
  if (incoming.method !== "GET") return json({ error: "接口不存在。" }, 404);
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return json({ error: "地址格式不正确。" }, 400);
  }
  if (pathname.includes("\\") || pathname.includes("\0"))
    return json({ error: "地址格式不正确。" }, 400);
  const filename = resolve(
    staticRoot,
    pathname === "/" ? "index.html" : `.${pathname}`,
  );
  if (!filename.startsWith(staticRoot + sep))
    return json({ error: "文件不存在。" }, 404);
  try {
    if (!(await stat(filename)).isFile())
      return json({ error: "文件不存在。" }, 404);
    return new Response(await readFile(filename), {
      headers: {
        ...headers,
        "Content-Type": types[extname(filename)] || "application/octet-stream",
      },
    });
  } catch {
    return json({ error: "页面不存在。" }, 404);
  }
}
async function respond(incoming: IncomingMessage, outgoing: ServerResponse) {
  let response: Response;
  try {
    response = await dispatch(incoming);
  } catch (error) {
    response = json(
      {
        error:
          error instanceof LocalError
            ? error.message
            : "本机服务未能完成操作，请检查输入或稍后重试。",
      },
      error instanceof LocalError ? error.status : 400,
    );
  }
  outgoing.writeHead(response.status, {
    ...headers,
    ...Object.fromEntries(response.headers),
  });
  outgoing.end(Buffer.from(await response.arrayBuffer()));
}
const server = createServer((request, response) => {
  void respond(request, response);
});
server.requestTimeout = 85_000;
server.headersTimeout = 15_000;
server.timeout = 85_000;
server.on("error", (error) => {
  console.error(
    (error as NodeJS.ErrnoException).code === "EADDRINUSE"
      ? `端口 ${port} 已被占用。请关闭旧的灯火之下窗口，或设置 LANTERN_PORT 后重试。`
      : "本机服务启动失败。请检查数据目录权限。",
  );
  database.close();
  process.exitCode = 1;
});
server.listen(port, "127.0.0.1", () => {
  console.log(
    `灯火之下 ${VERSION}\n本机地址：${origin}\n存档目录：${dataDirectory}\n按 Ctrl+C 停止服务；存档会保留。`,
  );
  if (process.argv.includes("--open") && process.platform === "win32") {
    const browser = spawn(
      "rundll32.exe",
      ["url.dll,FileProtocolHandler", origin],
      { windowsHide: true, stdio: "ignore", detached: true },
    );
    browser.on("error", () => console.log("请复制本机地址到浏览器。"));
    browser.unref();
  }
});
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  stopProvider();
  server.close(() => {
    database.close();
    process.exit(0);
  });
  server.closeIdleConnections();
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
