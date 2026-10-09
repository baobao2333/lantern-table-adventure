"use client";
import { useEffect, useState } from "react";
import { Check, LoaderCircle, X } from "lucide-react";

type Config = {
  provider: "none" | "api" | "codex";
  baseUrl: string;
  model: string;
  hasKey: boolean;
  codexAvailable: boolean;
};
type CodexStatus = { installed: boolean; authenticated: boolean; loginRunning: boolean; installing: boolean; version: string; error?: string; downloadedBytes?: number; totalBytes?: number };
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
}: {
  onClose: () => void;
  onSaved: () => Promise<unknown>;
}) {
  const [config, setConfig] = useState<Config | null>(null),
    [key, setKey] = useState("");
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState("");
  const [codex, setCodex] = useState<CodexStatus | null>(null);
  useEffect(() => {
    if (config?.provider !== "codex") return;
    let active = true, fetching = false;
    const refresh = () => {
      if (fetching) return;
      fetching = true;
      return fetch("/api/codex", { cache: "no-store", signal: AbortSignal.timeout(15_000) }).then(async r => await r.json() as CodexStatus).then((value) => {
      if (!active) return;
      setCodex(value);
      if (value.error) setError(value.error);
      }).catch(() => { if (active) setError("无法读取 Codex 登录状态。"); }).finally(() => { fetching = false; });
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 2500);
    return () => { active = false; clearInterval(timer); };
  }, [config?.provider]);
  async function codexAction(op: "install" | "login" | "cancel") {
    setError("");
    try {
      const response = await fetch("/api/codex", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op }) });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "无法完成 Codex 操作。");
      setMessage(op === "install" ? "正在下载并校验官方 Codex，请稍候。" : op === "login" ? "请在系统浏览器中完成官方登录，完成后保存设置。" : "已取消。");
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
      setMessage(
        test
          ? (await settings({ op: "test" })).message || "连接成功。"
          : "设置已保存。你可以返回冒险。 ",
      );
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
        <h2 id="settings-title">连接你的 AI 主持人</h2>
        <p className="modal-intro">
          角色和冒险保存在本机。选择你习惯的 AI 接入方式。
        </p>
        {config && (
          <fieldset disabled={busy}>
            <label className="field">
              接入方式
              <select
                value={config.provider}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    provider: e.target.value as Config["provider"],
                    model:
                      e.target.value === "codex"
                        ? ""
                        : config.model || "gpt-4.1-mini",
                  })
                }
              >
                <option value="none">只使用规则桌</option>
                <option value="api">OpenAI 兼容 API</option>
                <option value="codex">登录 Codex</option>
              </select>
            </label>
            {config.provider === "api" && (
              <>
                <label className="field">
                  API 基础地址
                  <input
                    value={config.baseUrl}
                    onChange={(e) =>
                      setConfig({ ...config, baseUrl: e.target.value })
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
                      setConfig({ ...config, model: e.target.value })
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
                    onChange={(e) => setKey(e.target.value)}
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
                <p className="scope-note">
                  {codex?.authenticated ? "已通过官方 Codex 登录。" : codex?.loginRunning ? "正在等待系统浏览器完成登录…" : codex?.installing ? "正在下载并校验官方 Codex…" : codex?.installed ? `官方 Codex ${codex.version} 已安装，请登录。` : "安装官方 Codex 后，即可在系统浏览器中登录。"}
                </p>
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
                      setConfig({ ...config, model: e.target.value })
                    }
                    placeholder="留空使用 Codex 默认模型"
                  />
                </label>
                <p className="subtle-note">
                  使用官方 CLI 已有登录状态。每次调用单独运行，只生成 DM
                  回应；游戏不会读取你的登录凭据。
                </p>
              </>
            )}
            {config.provider === "none" && (
              <p className="scope-note">
                可以创建角色、探索地点并掷骰。自由对话和营地扮演需要连接 AI。
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
                disabled={config.provider === "none"}
                onClick={() => void act(true)}
              >
                保存并测试连接
              </button>
            </div>
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
