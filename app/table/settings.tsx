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
                <option value="codex">已登录的 Codex CLI</option>
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
                  {config.codexAvailable
                    ? "已找到 Codex CLI。请先在终端运行 codex login 完成登录，再测试连接。"
                    : "尚未找到 Codex CLI。先按本机使用说明安装 Codex，运行 codex login，然后重启灯火之下。"}
                </p>
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
