"use client";
import { useEffect, useState } from "react";
import { Check, LoaderCircle, X } from "lucide-react";
import "./settings.css";

type Config = {
  provider: "none" | "api" | "codex";
  baseUrl: string;
  model: string;
  hasKey: boolean;
  codexAvailable: boolean;
};
type CodexStatus = {
  source?: "managed" | "existing" | "none";
  installed: boolean;
  authenticated: boolean;
  loginRunning: boolean;
  installing: boolean;
  version: string;
  error?: string;
  downloadedBytes?: number;
  totalBytes?: number;
};
async function settings(body?: unknown) {
  const response = await fetch(
    "/api/settings",
    body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : { cache: "no-store" },
  );
  const result = (await response.json()) as {
    config: Config;
    message?: string;
    error?: string;
  };
  if (!response.ok) throw new Error(result.error || "无法保存本机设置。");
  return result as { config: Config; message?: string };
}
export function Settings({
  onClose,
  onSaved,
  context = "solo",
}: {
  onClose: () => void;
  onSaved: () => Promise<unknown>;
  context?: "solo" | "host";
}) {
  const [config, setConfig] = useState<Config | null>(null),
    [key, setKey] = useState("");
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState("");
  const [codex, setCodex] = useState<CodexStatus | null>(null);
  const [tested, setTested] = useState(false);
  useEffect(() => {
    if (config?.provider !== "codex") return;
    let active = true, fetching = false;
    const refresh = async () => {
      if (fetching) return;
      fetching = true;
      try {
        const response = await fetch("/api/codex", { cache: "no-store", signal: AbortSignal.timeout(15_000) });
        const value = await response.json() as CodexStatus;
        if (!response.ok) throw new Error(value.error || "无法读取 Codex 登录状态。");
        if (!active) return;
        setCodex(value);
        if (value.error) setError(value.error);
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : "无法读取 Codex 登录状态。");
      } finally { fetching = false; }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 2500);
    return () => { active = false; clearInterval(timer); };
  }, [config?.provider]);
  async function codexAction(op: "install" | "login" | "cancel") {
    setError("");
    setTested(false);
    try {
      const response = await fetch("/api/codex", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op }) });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "无法完成 Codex 操作。");
      setMessage(op === "install" ? "正在下载并校验官方 Codex，请稍候。" : op === "login" ? "请在系统浏览器中完成官方登录，然后点击“保存并测试连接”。" : "已取消。");
      setCodex(previous => previous ? { ...previous, installing: op === "install", loginRunning: op === "login" } : previous);
    } catch (e) { setError(e instanceof Error ? e.message : "无法完成 Codex 操作。"); }
  }
  useEffect(() => {
    settings()
      .then((r) => setConfig(r.config))
      .catch((e) => setError(e.message));
  }, []);
  async function act(test = false) {
    if (!config || busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    setTested(false);
    try {
      const saved = await settings({
        op: "save",
        provider: config.provider,
        baseUrl: config.baseUrl,
        model: config.model,
        ...(key ? { apiKey: key } : {}),
      });
      setConfig(saved.config);
      setKey("");
      await onSaved();
      if (test) {
        const checked = await settings({ op: "test" });
        setTested(true);
        setMessage(checked.message || "AI 连接成功。单人冒险和剧本生成均可使用此连接。");
      } else setMessage(config.provider === "none"
        ? "规则模式已保存。你可以探索预设故事与掷骰，随时回来接入 AI。"
        : "接入设置已保存。请测试连接，确认模型可用后返回冒险。");
    } catch (e) {
      setError(e instanceof Error ? e.message : "无法完成设置。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <section
        className="modal settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        <button
          className="modal-close icon-button"
          aria-label="关闭设置"
          disabled={busy}
          onClick={onClose}
        >
          <X size={20} />
        </button>
        <p className="eyebrow">YOUR LOCAL TABLE</p>
        <h2 id="settings-title">{context === "host" ? "连接房主的 AI 主持人" : "单人冒险 · AI 主持人"}</h2>
        <p className="modal-intro">
          单人冒险和多人房主共用本机 AI 设置。接入后可自由对话、即兴裁定与生成剧本；角色和冒险始终保存在本机。多人参与者无需登录或填写密钥。
        </p>
        {config && (
          <fieldset disabled={busy}>
            <label className="field">
              接入方式
              <select
                value={config.provider}
                onChange={(e) => {
                  setTested(false); setMessage(""); setError("");
                  setConfig({
                    ...config,
                    provider: e.target.value as Config["provider"],
                    model:
                      e.target.value === "codex"
                        ? ""
                        : config.model || "gpt-4.1-mini",
                  });
                }}
              >
                <option value="none">只使用规则桌</option>
                <option value="api">OpenAI 兼容 API</option>
                <option value="codex">登录 Codex</option>
              </select>
            </label>
            {config.provider === "api" && (
              <>
                <ol className="ai-connection-steps" aria-label="API 接入步骤">
                  <li>填写服务商的地址、模型与密钥</li>
                  <li>保存并测试连接</li>
                  <li>返回单人冒险或生成剧本</li>
                </ol>
                <label className="field">
                  API 基础地址
                  <input
                    value={config.baseUrl}
                    onChange={(e) =>
                      { setTested(false); setConfig({ ...config, baseUrl: e.target.value }); }
                    }
                    placeholder="https://api.openai.com/v1"
                    spellCheck={false}
                  />
                </label>
                <label className="field">
                  模型名称
                  <input
                    value={config.model}
                    onChange={(e) =>
                      { setTested(false); setConfig({ ...config, model: e.target.value }); }
                    }
                    placeholder="由你的服务商提供"
                    spellCheck={false}
                  />
                </label>
                <label className="field">
                  API Key
                  <input
                    type="password"
                    autoComplete="off"
                    value={key}
                    onChange={(e) => { setTested(false); setKey(e.target.value); }}
                    placeholder={
                      config.hasKey
                        ? "已保存 · 留空保留现有密钥"
                        : "输入你的 API Key"
                    }
                  />
                </label>
                <p className="subtle-note">
                  密钥由当前 Windows 账户加密保存。AI
                  请求按你的服务商计费；兼容接口需要支持 JSON 输出。
                </p>
              </>
            )}
            {config.provider === "codex" && (
              <>
                <ol className="ai-connection-steps" aria-label="Codex 接入步骤">
                  <li className={codex?.installed ? "complete" : ""}>{codex?.installed ? "✓ " : ""}{codex?.source === "existing" ? "检测本机已有 CLI" : "安装并校验官方 CLI"}</li>
                  <li className={codex?.authenticated ? "complete" : ""}>{codex?.authenticated ? "✓ " : ""}在系统浏览器登录</li>
                  <li className={tested ? "complete" : ""}>{tested ? "✓ " : ""}保存并测试连接</li>
                </ol>
                <p className="scope-note">
                  {!codex ? "正在读取官方 Codex 状态…" : codex.authenticated ? "已通过官方 Codex 登录。保存并测试连接后，即可返回冒险。" : codex.loginRunning ? "正在等待系统浏览器完成登录…" : codex.installing ? "正在下载并校验官方 Codex…" : codex.installed ? `官方 Codex ${codex.version} 已安装，请登录。` : "安装官方 Codex 后，即可在系统浏览器中登录。"}
                </p>
                {codex?.source === "existing" && <p className="subtle-note">使用本机已有 Codex CLI v{codex.version}。此版本由你的本机安装提供，未执行应用内归档校验。</p>}
                {codex?.installing && <p className="subtle-note">首次下载约 160 MB：已下载 {((codex.downloadedBytes || 0) / 1_048_576).toFixed(1)} MB{codex.totalBytes ? ` / ${(codex.totalBytes / 1_048_576).toFixed(1)} MB` : ""}。完成后会校验官方归档；可随时取消。</p>}
                <div className="settings-actions">
                  {!codex?.installed && <button className="button secondary" disabled={!codex || codex.installing} onClick={() => void codexAction("install")}>安装官方 Codex</button>}
                  {codex?.installed && <button className="button secondary" disabled={codex.loginRunning} onClick={() => void codexAction("login")}>{codex.authenticated ? "重新登录" : "登录 Codex"}</button>}
                  {(codex?.loginRunning || codex?.installing) && <button className="text-button" onClick={() => void codexAction("cancel")}>取消</button>}
                </div>
                <label className="field">
                  Codex 模型 <span>选填</span>
                  <input
                    value={config.model}
                    onChange={(e) =>
                      { setTested(false); setConfig({ ...config, model: e.target.value }); }
                    }
                    placeholder="留空使用 Codex 默认模型"
                  />
                </label>
                <p className="subtle-note">
                  登录与凭据管理由官方 CLI 完成。本游戏不会读取或展示登录凭据，也不会修改你的 Codex 配置。使用额度取决于你的账户与所选模型。
                </p>
              </>
            )}
            {config.provider === "none" && (
              <p className="scope-note">
                规则模式可以创建角色、探索预设故事并掷骰。自由对话、即兴裁定与 AI 生成剧本需要连接 Codex 或兼容 API；你可以随时在冒险中切换。
              </p>
            )}
            <div className="settings-actions">
              <button className="button primary" onClick={() => void act()}>
                {busy ? (
                  <LoaderCircle className="spin" size={16} />
                ) : (
                  <Check size={16} />
                )}
                保存设置
              </button>
              <button
                className="button secondary"
                disabled={config.provider === "none" || (config.provider === "codex" && (!codex?.authenticated || codex.loginRunning || codex.installing))}
                onClick={() => void act(true)}
              >
                保存并测试连接
              </button>
            </div>
            {config.provider !== "none" && <p className="subtle-note">测试连接会发送一次简短模型请求，可能使用你的账户额度或产生 API 费用。保存设置本身不会调用模型。</p>}
          </fieldset>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {message && (
          <p className="setting-success" role="status">
            {message}
          </p>
        )}
      </section>
    </div>
  );
}
