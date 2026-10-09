import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { existsSync, readFileSync, statSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve, sep, dirname, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import release from "../desktop/codex-release.json";
import { LocalError } from "./settings";

const relativeExecutable = "vendor/x86_64-pc-windows-msvc/bin/codex.exe";
const installDirectory = (directory: string) =>
  join(directory, "tools", `codex-${release.version}`);
const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const verified = new Map<
  string,
  { size: number; mtime: number; ctime: number; receipt: string }
>();
export type CLI = { command: string; prefix: string[] };
type ResolvedCLI = CLI & { source: "managed" | "existing" };

export function findCodex(): CLI | undefined {
  for (const directory of (process.env.PATH || "").split(delimiter)) {
    if (!directory) continue;
    const executable = join(directory, process.platform === "win32" ? "codex.exe" : "codex");
    if (existsSync(executable)) return { command: executable, prefix: [] };
    // Run the official npm entry directly without cmd.exe prompt interpolation.
    const entry = join(directory, "node_modules", "@openai", "codex", "bin", "codex.js");
    if (process.platform === "win32" && existsSync(join(directory, "codex.cmd")) && existsSync(entry))
      return { command: process.execPath, prefix: [entry] };
  }
}

export function resolveCodex(directory?: string, existing?: CLI | null): ResolvedCLI | undefined {
  const installed = directory && codexExecutable(directory);
  if (installed) return { command: installed, prefix: [], source: "managed" };
  const fallback = existing === null ? undefined : existing ?? findCodex();
  return fallback ? { ...fallback, source: "existing" } : undefined;
}

export function codexExecutable(directory: string): string | undefined {
  const root = installDirectory(directory);
  const executable = join(root, relativeExecutable);
  try {
    const receiptText = readFileSync(
      join(root, "verified-install.json"),
      "utf8",
    );
    const receipt = JSON.parse(receiptText);
    if (
      receipt.version !== release.version ||
      receipt.integrity !== release.archiveIntegrity
    )
      return undefined;
    const file = statSync(executable),
      cached = verified.get(executable);
    if (
      !cached ||
      cached.size !== file.size ||
      cached.mtime !== file.mtimeMs ||
      cached.ctime !== file.ctimeMs ||
      cached.receipt !== receiptText
    ) {
      if (receipt.sha256 !== sha256(readFileSync(executable))) return undefined;
      verified.set(executable, {
        size: file.size,
        mtime: file.mtimeMs,
        ctime: file.ctimeMs,
        receipt: receiptText,
      });
    }
    return executable;
  } catch {
    return undefined;
  }
}

export function unpackCodexArchive(archive: Uint8Array) {
  const integrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
  if (integrity !== release.archiveIntegrity)
    throw new LocalError(
      "官方 Codex 下载校验失败；没有安装或运行下载文件。",
      503,
    );
  const tar = gunzipSync(archive, { maxOutputLength: 512 * 1024 * 1024 });
  const files = new Map<string, Buffer>();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const stringAt = (start: number, length: number) =>
      header
        .subarray(start, start + length)
        .toString("utf8")
        .split("\0", 1)[0];
    const prefix = stringAt(345, 155),
      name = stringAt(0, 100);
    const pathname = prefix ? `${prefix}/${name}` : name;
    const size = Number.parseInt(stringAt(124, 12).trim(), 8);
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      offset + 512 + size > tar.length
    )
      throw new LocalError("官方 Codex 归档格式无效。", 503);
    const kind = stringAt(156, 1);
    if (
      (kind === "0" || kind === "") &&
      pathname.startsWith("package/vendor/")
    ) {
      const relative = pathname.slice("package/".length);
      if (
        relative.includes("\\") ||
        relative
          .split("/")
          .some((part) => !part || part === ".." || part === ".") ||
        files.has(relative)
      )
        throw new LocalError("官方 Codex 归档包含无效路径。", 503);
      files.set(relative, tar.subarray(offset + 512, offset + 512 + size));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (!files.has(relativeExecutable))
    throw new LocalError("官方 Codex 归档缺少 Windows 可执行文件。", 503);
  return files;
}

export function codexEnvironment() {
  const environment = { ...process.env };
  const excluded = new Set([
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
    "CODEX_ACCESS_TOKEN",
    "OPENAI_BASE_URL",
    "CODEX_REMOTE",
    "CODEX_CLI_PATH",
  ]);
  for (const key of Object.keys(environment))
    if (excluded.has(key.toUpperCase())) delete environment[key];
  return environment;
}

export function createCodexAuth(directory: string, existing?: CLI | null) {
  let authenticated = false;
  let active: ChildProcess | undefined;
  let busy: "install" | "login" | undefined;
  let installing: AbortController | undefined;
  let downloadedBytes = 0;
  let totalBytes = 0;
  function cancel() {
    installing?.abort();
    if (active?.pid) {
      if (process.platform === "win32") {
        const child = active;
        spawn(
          join(
            process.env.SystemRoot || "C:\\Windows",
            "System32",
            "taskkill.exe",
          ),
          ["/PID", String(child.pid), "/T", "/F"],
          { windowsHide: true, stdio: "ignore" },
        ).on("error", () => child.kill("SIGKILL"));
      } else active.kill("SIGKILL");
    }
  }
  function run(
    cli: CLI,
    args: string[],
    timeout: number,
    track = false,
  ): Promise<{ code: number; output: string }> {
    return new Promise((resolveRun, reject) => {
      const child = spawn(cli.command, [...cli.prefix, ...args], {
        env: codexEnvironment(),
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        cwd: directory,
      });
      if (track) active = child;
      let output = "",
        bytes = 0,
        settled = false;
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        done(new LocalError("Codex 操作等待超时，请重试。", 503));
      }, timeout);
      function done(error?: Error, code = 1) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (active === child) active = undefined;
        if (error) reject(error);
        else resolveRun({ code, output });
      }
      const collect = (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 64 * 1024) {
          child.kill("SIGKILL");
          done(new LocalError("Codex 状态输出异常。", 503));
        } else output += chunk.toString("utf8");
      };
      child.stdout?.on("data", collect);
      child.stderr?.on("data", collect);
      child.once("error", () =>
        done(new LocalError("无法启动已验证的官方 Codex CLI。", 503)),
      );
      child.once("close", (code) => done(undefined, code ?? 1));
    });
  }
  async function status() {
    const cli = resolveCodex(directory, existing);
    if (!cli) {
      authenticated = false;
      return {
        installed: false,
        source: "none" as const,
        version: release.version,
        authenticated: false,
        loginRunning: busy === "login",
        installing: busy === "install",
        downloadedBytes,
        totalBytes,
      };
    }
    let result;
    let version: string = release.version;
    try {
      if (cli.source === "existing") {
        const checked = await run(cli, ["--version"], 10_000);
        const match = checked.output.trim().match(/^codex-cli (\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/);
        if (checked.code !== 0 || !match)
          throw new LocalError("既有 Codex CLI 未返回可识别的版本，请检查安装或在应用内安装官方 CLI。", 503);
        version = match[1];
      }
      result = await run(cli, ["login", "status"], 10_000);
      authenticated = result.code === 0;
    } catch (error) {
      authenticated = false;
      throw error;
    }
    return {
      installed: true,
      source: cli.source,
      version,
      authenticated,
      loginRunning: busy === "login",
      installing: busy === "install",
      downloadedBytes,
      totalBytes,
    };
  }
  async function install() {
    if (process.platform !== "win32" || process.arch !== "x64")
      throw new LocalError("当前官方 Codex 安装引导仅支持 Windows x64。", 503);
    if (busy) throw new LocalError("Codex 安装或登录正在进行。");
    if (codexExecutable(directory)) return status();
    busy = "install";
    installing = new AbortController();
    downloadedBytes = 0;
    totalBytes = 0;
    const timeout = setTimeout(() => installing?.abort(), 600_000);
    const tools = join(directory, "tools");
    let staging: string | undefined;
    try {
      await mkdir(tools, { recursive: true });
      staging = await mkdtemp(join(tools, ".codex-install-"));
      const response = await fetch(release.archiveUrl, {
        headers: { Range: "bytes=0-", "Accept-Encoding": "identity" },
        redirect: "error",
        signal: installing.signal,
      });
      if (
        !response.ok ||
        Number(response.headers.get("content-length")) > 180 * 1024 * 1024
      )
        throw new LocalError("无法下载官方 Codex CLI，请检查网络后重试。", 503);
      totalBytes = Number(response.headers.get("content-length")) || 0;
      if (!response.body)
        throw new LocalError("官方 Codex 下载没有返回内容。", 503);
      const archivePath = join(staging, "download.tgz");
      const archiveFile = await open(archivePath, "wx");
      try {
        const reader = response.body.getReader();
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          const chunk = next.value;
          downloadedBytes += chunk.length;
          if (downloadedBytes > 180 * 1024 * 1024) {
            installing.abort();
            throw new LocalError("官方 Codex 下载体积异常。", 503);
          }
          await archiveFile.writeFile(chunk);
        }
      } finally {
        await archiveFile.close();
      }
      const files = unpackCodexArchive(await readFile(archivePath));
      await rm(archivePath);
      for (const [name, bytes] of files) {
        const filename = resolve(staging, name);
        if (!filename.startsWith(resolve(staging) + sep))
          throw new Error("Invalid verified archive path.");
        await mkdir(resolve(filename, ".."), { recursive: true });
        await writeFile(filename, bytes);
      }
      const executable = join(staging, relativeExecutable);
      const checked = await run({ command: executable, prefix: [] }, ["--version"], 10_000);
      if (
        checked.code !== 0 ||
        checked.output.trim() !== `codex-cli ${release.version}`
      )
        throw new LocalError("官方 Codex CLI 版本核验失败。", 503);
      await writeFile(
        join(staging, "LICENSE.txt"),
        await readFile(
          join(dirname(fileURLToPath(import.meta.url)), "CODEX_LICENSE.txt"),
        ),
      );
      await writeFile(
        join(staging, "verified-install.json"),
        JSON.stringify({
          version: release.version,
          integrity: release.archiveIntegrity,
          sha256: sha256(await readFile(executable)),
          source: release.source,
          license: release.license,
        }),
        { mode: 0o600 },
      );
      const destination = installDirectory(directory);
      if (existsSync(destination))
        throw new LocalError(
          "Codex 安装目录已有未验证文件。请备份并移走该目录，再重试。",
          503,
        );
      await rename(staging, destination);
    } catch (error) {
      if (error instanceof LocalError) throw error;
      throw new LocalError(
        installing.signal.aborted
          ? "Codex 下载已取消或超过 10 分钟，请检查网络后重试。"
          : "无法安装官方 Codex CLI，请检查网络与本机数据目录权限后重试。",
        503,
      );
    } finally {
      clearTimeout(timeout);
      installing = undefined;
      busy = undefined;
      if (staging) await rm(staging, { recursive: true, force: true });
    }
    return status();
  }
  async function login() {
    if (busy) throw new LocalError("Codex 安装或登录正在进行。");
    const cli = resolveCodex(directory, existing);
    if (!cli)
      throw new LocalError("请先在应用内安装并验证官方 Codex CLI。", 503);
    busy = "login";
    try {
      const result = await run(cli, ["login"], 5 * 60_000, true);
      if (result.code !== 0)
        throw new LocalError(
          "官方 Codex 登录未完成。请在系统浏览器中完成登录后重试。",
          503,
        );
    } finally {
      busy = undefined;
    }
    return status();
  }
  return {
    authenticated: () => authenticated,
    status,
    install,
    login,
    cancel,
    executable: () => codexExecutable(directory),
  };
}
