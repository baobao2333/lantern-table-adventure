import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";

export class RuntimeController extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.instanceId = randomUUID();
    this.adminToken = randomBytes(32).toString("base64url");
    this.stopping = false;
    this.pending = new Map();
  }
  async start() {
    if (this.child) throw new Error("Runtime is already started.");
    const environment = {
      ...process.env,
      LANTERN_DESKTOP: "1",
      LANTERN_PORT: "0",
      LANTERN_ADMIN_TOKEN: this.adminToken,
      LANTERN_INSTANCE_ID: this.instanceId,
      LANTERN_DATA_DIR: this.options.dataDirectory,
      LANTERN_LEGACY_DATA_DIR: this.options.legacyDirectory,
    };
    for (const name of ["NODE_OPTIONS", "NODE_PATH", "ELECTRON_RUN_AS_NODE"])
      delete environment[name];
    this.child = spawn(this.options.nodeExecutable, [this.options.serverFile], {
      env: environment,
      cwd: this.options.runtimeDirectory,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    // Diagnostics stay in the main process; never expose a child transcript to a renderer.
    this.child.stdout.on("data", () => {});
    this.child.stderr.on("data", () => {});
    this.child.on("message", (message) => {
      if (!message || message.instanceId !== this.instanceId) return;
      const pending = this.pending.get(message.requestId);
      if (pending && message.type === pending.type) pending.resolve(message);
    });
    this.child.on("exit", (code, signal) => {
      for (const pending of this.pending.values())
        pending.reject(new Error("Desktop runtime exited."));
      this.pending.clear();
      if (!this.stopping) this.emit("unexpectedExit", { code, signal });
    });
    this.child.on("error", () => {});
    return new Promise((resolveReady, reject) => {
      let settled = false;
      const timer = setTimeout(
        () => done(new Error("本机服务启动超时。请检查存档目录或旧版服务。")),
        this.options.startTimeout ?? 45_000,
      );
      const onMessage = (message) => {
        if (!message || message.type !== "ready") return;
        if (
          message.instanceId !== this.instanceId ||
          message.version !== this.options.version ||
          !Number.isInteger(message.port) ||
          message.port < 1 ||
          message.port > 65535
        )
          return done(new Error("本机服务身份或版本核验失败。"));
        done(undefined, {
          port: message.port,
          origin: `http://127.0.0.1:${message.port}`,
        });
      };
      const onError = () => done(new Error("无法启动随包提供的 Node 服务。"));
      const onExit = () =>
        done(new Error("本机服务在就绪前退出。请关闭旧版并检查存档。"));
      const done = (error, ready) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.child.off("message", onMessage);
        this.child.off("error", onError);
        this.child.off("exit", onExit);
        if (error) {
          this.stopping = true;
          void this.forceStop().finally(() => reject(error));
        } else {
          this.ready = ready;
          resolveReady(ready);
        }
      };
      this.child.on("message", onMessage);
      this.child.once("error", onError);
      this.child.once("exit", onExit);
    });
  }
  request(type, responseType, timeout = 10_000) {
    if (!this.child?.connected)
      return Promise.reject(new Error("本机服务未连接。"));
    const requestId = randomUUID();
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(
        () => finish(new Error("本机服务保存等待超过 10 秒。")),
        timeout,
      );
      const finish = (error, message) => {
        clearTimeout(timer);
        this.pending.delete(requestId);
        if (error) reject(error);
        else resolveRequest(message);
      };
      this.pending.set(requestId, {
        type: responseType,
        resolve: (message) => finish(undefined, message),
        reject: (error) => finish(error),
      });
      this.child.send(
        { type, requestId, instanceId: this.instanceId },
        (error) => {
          if (error) finish(error);
        },
      );
    });
  }
  pause() {
    return this.request("pause", "paused");
  }
  async stop() {
    if (this.stopping) return;
    this.stopping = true;
    if (
      !this.child ||
      this.child.exitCode !== null ||
      this.child.signalCode !== null
    )
      return;
    const deadline = Date.now() + 10_000;
    try {
      await this.request("shutdown", "stopped", 10_000);
      if (this.child.exitCode === null && this.child.signalCode === null)
        await new Promise((resolveExit) => {
          const timer = setTimeout(
            resolveExit,
            Math.max(1, deadline - Date.now()),
          );
          this.child.once("exit", () => {
            clearTimeout(timer);
            resolveExit();
          });
        });
    } finally {
      await this.forceStop();
    }
  }
  forceStop() {
    if (this.forceStopping) return this.forceStopping;
    if (
      !this.child?.pid ||
      this.child.exitCode !== null ||
      this.child.signalCode !== null
    )
      return Promise.resolve();
    this.forceStopping = new Promise((resolveStop) => {
      const timer = setTimeout(resolveStop, 2000);
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolveStop();
      });
      if (process.platform === "win32")
        spawn(
          join(
            process.env.SystemRoot || "C:\\Windows",
            "System32",
            "taskkill.exe",
          ),
          ["/PID", String(this.child.pid), "/T", "/F"],
          { windowsHide: true, stdio: "ignore" },
        ).on("error", () => this.child.kill("SIGKILL"));
      else this.child.kill("SIGKILL");
    });
    return this.forceStopping;
  }
}
