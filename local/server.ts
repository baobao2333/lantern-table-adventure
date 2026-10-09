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
import { createCodexAuth } from "./codex-auth";
import { migrateDesktopData } from "./migrate-desktop";
import { acquireServiceOwnership } from "../desktop/ownership.mjs";
import { timingSafeEqual, randomUUID } from "node:crypto";
import { RoomService } from "./rooms/index";
import { RoomGateway } from "./room-gateway";
import { protectSecret } from "./network/identity.mjs";
import { interpret, interpretWorld, narrate } from "../lib/server/narrator";
import { ownedHero, ApiError } from "../lib/server/repository";
import type { HeroBuildInput } from "../lib/game/types";
import type { RoomRequest } from "./rooms/types";
import { ClientJournal } from "./client-journal";

export const VERSION = "0.3.0-beta.1";
const releaseDirectory = dirname(fileURLToPath(import.meta.url));
const dataDirectory = process.env.LANTERN_DATA_DIR
  ? resolve(process.env.LANTERN_DATA_DIR)
  : join(
      process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"),
      "LanternTable",
    );
const desktop = process.env.LANTERN_DESKTOP === "1";
const instanceId = process.env.LANTERN_INSTANCE_ID || randomUUID();
const adminToken = process.env.LANTERN_ADMIN_TOKEN;
if (desktop && (!adminToken || adminToken.length < 32 || !process.send))
  throw new Error("Desktop service requires an authenticated parent process.");
let port = Number(process.env.LANTERN_PORT || (desktop ? 0 : 4173));
if (!Number.isInteger(port) || (port !== 0 && port < 1024) || port > 65535 || (!desktop && port === 0))
  throw new Error("LANTERN_PORT must be an integer from 1024 to 65535.");
mkdirSync(dataDirectory, { recursive: true });
const releaseOwnership = desktop ? acquireServiceOwnership(dataDirectory, instanceId) : () => {};
process.once("exit", releaseOwnership);
const databasePath = desktop
  ? migrateDesktopData({
      legacyDirectory: process.env.LANTERN_LEGACY_DATA_DIR || dirname(dataDirectory),
      desktopDirectory: dataDirectory,
      migrationsDirectory: join(releaseDirectory, "migrations"),
    }).databasePath
  : join(dataDirectory, "adventures.sqlite");
const database = new SQLiteD1(
  databasePath,
  join(releaseDirectory, "migrations"),
);
const settings = new SettingsStore(dataDirectory),
  provider = createProvider(settings, undefined, dataDirectory);
const codex = createCodexAuth(dataDirectory);
let authError = "";
function updateRuntime() {
  configureRuntime({
    DB: database as unknown as D1Database,
    local: true,
    aiReady: provider.ready(),
    completion: provider.completion,
  });
}
updateRuntime();
const rooms = new RoomService(database.sqlite, {
  aiReady: provider.ready,
  interpret: (game, actorId, text, signal) => game.world ? interpretWorld(game, text, { actorId, signal }) : interpret(game, text, { actorId, signal }),
  narrate: (game, fact, actorId, signal) => narrate(game, fact, { actorId, signal }),
  protectSecret,
  onUpdate: id => gateway?.onUpdate(id),
});
const gateway = new RoomGateway(rooms, database.sqlite, dataDirectory);
const clientJournal = new ClientJournal(database.sqlite);
const roomTimer = setInterval(() => rooms.tick(), 250);
roomTimer.unref();
const staticRoot = resolve(releaseDirectory, "client");
let origin = `http://127.0.0.1:${port}`;
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
async function bodyOf(request: IncomingMessage, maximum = 16_384) {
  if (Number(request.headers["content-length"]) > maximum)
    throw new LocalError("输入太长。", 413);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > maximum) throw new LocalError("输入太长。", 413);
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
  if (desktop && url.pathname.startsWith("/api/")) {
    const cookie = String(incoming.headers.cookie || "").split(";").map(value => value.trim()).find(value => value.startsWith("lantern_admin="))?.slice(14) || "";
    const expected = Buffer.from(adminToken!);
    const received = Buffer.from(cookie);
    if (received.length !== expected.length || !timingSafeEqual(expected, received))
      throw new LocalError("本机管理会话已失效，请重新启动应用。", 401);
  }
  if (url.pathname === "/api/client-journal") {
    const kind = url.searchParams.get("kind");
    if (kind !== "solo" && kind !== "room") throw new LocalError("未知的待确认行动类型。");
    if (incoming.method === "POST") {
      const input = JSON.parse(await bodyOf(incoming, 65_536));
      if (!input || input.kind !== kind) throw new LocalError("待确认行动格式不正确。");
      if (input.op === "save") clientJournal.save(kind, input.payload);
      else if (input.op === "clear") clientJournal.clear(kind, input.requestId);
      else throw new LocalError("未知的待确认行动操作。");
    }
    return json({ pending: clientJournal.read(kind) });
  }
  if (url.pathname === "/api/codex") {
    if (incoming.method === "GET") return json({ ...(await codex.status()), error: authError });
    const input = JSON.parse(await bodyOf(incoming));
    if (input?.op === "cancel") {
      codex.cancel();
      return json({ ok: true });
    }
    if (input?.op !== "install" && input?.op !== "login") throw new LocalError("未知 Codex 操作。");
    authError = "";
    void codex[input.op as "install" | "login"]().then(updateRuntime).catch(() => {
      authError = input.op === "install" ? "官方 Codex 安装未完成，请检查网络后重试。" : "官方 Codex 登录未完成，请在系统浏览器中完成登录后重试。";
    });
    return json({ accepted: true }, 202);
  }
  if (url.pathname === "/api/rooms") {
    if (incoming.method === "GET") {
      const id = url.searchParams.get("id");
      if (!id) return json(gateway.list());
      const role = url.searchParams.get("role") === "guest" ? "guest" : "host";
      if (role === "host") rooms.heartbeat(id, rooms.hostSeatToken(id));
      return json(gateway.state(id, role));
    }
    const input = JSON.parse(await bodyOf(incoming, 65_536));
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new LocalError("房间请求格式不正确。");
    if (input.op === "create") {
      const hero = await ownedHero(String(input.heroId || ""), "local-owner");
      const created = rooms.create(hero, String(input.campaignId || ""));
      return json({ role: "host", state: "connected", snapshot: created.snapshot });
    }
    if (input.op === "join") return json(await gateway.join(String(input.invitation || ""), input.build as HeroBuildInput));
    if (input.op === "reconnect") return json(await gateway.reconnect(String(input.id || "")));
    if (input.op === "leave") return json(gateway.leave());
    if (input.op === "exit-session") { gateway.pause(); gateway.leave(); return json({ ok: true }); }
    if (input.op === "publish") return json(await gateway.publish(String(input.id || ""), input.configuration || {}));
    if (input.op === "recover") return json(await gateway.recover(String(input.id || "")));
    if (input.op === "request") return json(await gateway.request(String(input.id || ""), input.role === "guest" ? "guest" : "host", input.payload as RoomRequest));
    throw new LocalError("未知房间操作。");
  }
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
      if (["game.create", "game.command", "game.talk"].includes(input?.op) &&
          (rooms.list().some(room => room.status === "active") || gateway.list().active?.role === "guest"))
        throw new LocalError("请先暂停或离开多人冒险，再开始单人行动。", 409);
      if (
        input?.op === "game.join" ||
        (input?.op === "game.create" && input?.mode === "party")
      )
        throw new LocalError(
          "请从多人组队入口创建房间；单人存档不能直接转换为多人存档。",
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
          error instanceof LocalError || error instanceof ApiError
            ? error.message
            : "本机服务未能完成操作，请检查输入或稍后重试。",
      },
      error instanceof LocalError || error instanceof ApiError ? error.status : 400,
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
  port = (server.address() as import("node:net").AddressInfo).port;
  origin = `http://127.0.0.1:${port}`;
  process.send?.({ type: "ready", port, version: VERSION, instanceId });
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
function stop(requestId?: string) {
  if (stopping) return;
  stopping = true;
  stopProvider();
  codex.cancel();
  clearInterval(roomTimer);
  gateway.close();
  rooms.close();
  server.close(() => {
    database.close();
    process.send?.({ type: "stopped", instanceId, requestId });
    process.exit(0);
  });
  server.closeIdleConnections();
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
if (desktop) {
  process.on("message", (message: unknown) => {
    const input = message as { type?: string; instanceId?: string; requestId?: string };
    if (input.instanceId !== instanceId) return;
    if (input.type === "shutdown") stop(input.requestId);
    if (input.type === "pause") {
      stopProvider();
      gateway.pause();
      process.send?.({ type: "paused", instanceId, requestId: input.requestId });
    }
  });
  process.on("disconnect", () => stop());
}
