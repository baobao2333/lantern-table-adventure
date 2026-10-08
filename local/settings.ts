import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
export type Provider = "none" | "api" | "codex";
export type Settings = {
  provider: Provider;
  baseUrl: string;
  model: string;
  apiKey: string;
};
export class LocalError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
const defaults: Settings = {
  provider: "none",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4.1-mini",
  apiKey: "",
};

function protect(value: string, decrypt = false): string {
  if (!value) return "";
  if (process.platform !== "win32")
    throw new LocalError("本发行包的凭据存储仅支持 Windows。", 503);
  const command = `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Add-Type -AssemblyName System.Security; $v=[Console]::In.ReadToEnd(); ${
    decrypt
      ? "[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($v),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))"
      : "[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($v),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))"
  }`;
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    { input: value, encoding: "utf8", windowsHide: true, timeout: 10_000 },
  );
  if (result.status !== 0 || result.error)
    throw new LocalError("无法使用当前 Windows 账户保存或读取 API 密钥。", 503);
  return result.stdout.trim();
}
export function validateBaseUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new LocalError(
      "请填写完整的兼容 API 地址，例如 https://api.openai.com/v1。",
    );
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["https:", "http:"].includes(url.protocol) ||
    (url.protocol === "http:" && !loopback)
  )
    throw new LocalError(
      "API 地址需要 HTTPS；本机模型服务可以使用 localhost HTTP。地址不能包含凭据、查询参数或片段。",
    );
  return url.href.replace(/\/+$/, "");
}
export class SettingsStore {
  private current: Settings;
  readonly filename: string;
  constructor(directory: string) {
    this.filename = join(directory, "settings.json");
    this.current = { ...defaults };
    if (existsSync(this.filename)) {
      try {
        const saved = JSON.parse(readFileSync(this.filename, "utf8"));
        if (!["none", "api", "codex"].includes(saved.provider))
          throw new Error("Invalid provider");
        this.current = {
          provider: saved.provider,
          baseUrl: validateBaseUrl(saved.baseUrl),
          model: String(saved.model || ""),
          apiKey: protect(saved.apiKeyEncrypted || "", true),
        };
      } catch {
        throw new LocalError(
          "本机 AI 设置无法读取。请使用原 Windows 账户启动，或备份后移走 settings.json 再配置。",
          503,
        );
      }
    }
  }
  snapshot() {
    return { ...this.current };
  }
  safe(codexAvailable: boolean) {
    const { provider, baseUrl, model, apiKey } = this.current;
    return {
      provider,
      baseUrl,
      model,
      hasKey: Boolean(apiKey),
      codexAvailable,
    };
  }
  save(input: Record<string, unknown>) {
    if (!["none", "api", "codex"].includes(String(input.provider)))
      throw new LocalError("请选择 AI 接入方式。");
    const provider = input.provider as Provider;
    const baseUrl =
      typeof input.baseUrl === "string"
        ? validateBaseUrl(input.baseUrl.trim())
        : this.current.baseUrl;
    const model =
      typeof input.model === "string"
        ? input.model.trim()
        : provider === "codex" && this.current.provider !== "codex"
          ? ""
          : this.current.model;
    if (model.length > 160 || /[\u0000-\u001f]/.test(model))
      throw new LocalError("模型名称格式不正确。");
    const apiKey =
      input.apiKey === undefined
        ? this.current.apiKey
        : typeof input.apiKey === "string"
          ? input.apiKey.trim()
          : null;
    if (apiKey === null || apiKey.length > 8192 || /[\r\n\u0000]/.test(apiKey))
      throw new LocalError("API 密钥格式不正确。");
    if (provider === "api" && (!model || !apiKey))
      throw new LocalError("兼容 API 需要模型名称和 API 密钥。");
    const next = { provider, baseUrl, model, apiKey };
    const temporary = `${this.filename}.tmp`;
    writeFileSync(
      temporary,
      JSON.stringify(
        { provider, baseUrl, model, apiKeyEncrypted: protect(apiKey) },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    renameSync(temporary, this.filename);
    this.current = next;
  }
}
