"use client";
import { useEffect, useState } from "react";
import { Download, LoaderCircle, Play, ScrollText, Upload } from "lucide-react";
import type { GenerationJob } from "../../local/content-workshop";
import "./workshop.css";

type SavedWorld = { id: string; title: string; revision: number; locations: number; opportunities: number; minutes: string };
type Validation = { issues: string[]; world: Omit<SavedWorld, "minutes"> | null };
type GenerationRequest = { op: "generate"; id: string; brief: string; size: string };
const pendingKey = "lantern.pending-generation.v1";
function readPending(): GenerationRequest | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(pendingKey), request = raw ? JSON.parse(raw) as GenerationRequest : null;
    if (request?.op === "generate" && typeof request.id === "string" && typeof request.brief === "string" && ["short", "campaign"].includes(request.size)) return request;
  } catch {}
  return null;
}
async function content<T>(body?: unknown, query = ""): Promise<T> {
  const response = await fetch(`/api/content${query}`, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : { cache: "no-store" });
  const result = await response.json() as { error?: string };
  if (!response.ok) throw new Error(result.error || "剧本工坊暂时无法完成操作。");
  return result as T;
}
function download(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json;charset=utf-8" }));
  const link = document.createElement("a"); link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function Workshop({ aiReady, settings, refresh, play }: { aiReady: boolean; settings: () => void; refresh: () => Promise<unknown>; play: (id: string) => void }) {
  const [worlds, setWorlds] = useState<SavedWorld[]>([]), [job, setJob] = useState<GenerationJob | null>(null);
  const [brief, setBrief] = useState(""), [size, setSize] = useState("campaign"), [text, setText] = useState("");
  const [validation, setValidation] = useState<Validation | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [pending, setPending] = useState<GenerationRequest | null>(readPending);
  function retainPending(value: GenerationRequest | null) {
    setPending(value);
    try { if (value) sessionStorage.setItem(pendingKey, JSON.stringify(value)); else sessionStorage.removeItem(pendingKey); } catch {}
  }
  useEffect(() => {
    let active = true;
    void content<{ worlds: SavedWorld[]; job: GenerationJob | null }>().then(result => {
      if (!active) return;
      setWorlds(result.worlds); setJob(result.job);
      if (result.job) {
        setBrief(result.job.brief); setSize(result.job.size);
        if (result.job.text) setText(result.job.text);
      }
    }).catch(error => { if (active) setError(error.message); });
    return () => { active = false; };
  }, []);
  const generating = job?.status === "generating";
  const jobId = job?.id;
  useEffect(() => {
    if (!generating || !jobId) return;
    let active = true, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await content<{ job: GenerationJob | null }>(undefined, `?job=${encodeURIComponent(jobId)}`);
        if (!active) return;
        if (!result.job) throw new Error("生成任务不存在，请重新加载工坊。");
        setJob(result.job);
        if (result.job.status !== "generating") {
          if (result.job.text) { setText(result.job.text); setValidation(null); }
          if (result.job.status === "ready") setNotice("AI 草稿已通过结构与引用检查。请阅读故事并保存到剧本库，再开始冒险。");
          return;
        }
      } catch (error) { if (active) setError(error instanceof Error ? error.message : "连接暂时中断，正在重试。生成任务会保留。"); }
      if (active) timer = setTimeout(poll, 2000);
    };
    timer = setTimeout(poll, 1000);
    return () => { active = false; clearTimeout(timer); };
  }, [generating, jobId]);
  async function run(task: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try { await task(); }
    catch (error) { setError(error instanceof Error ? error.message : "操作未完成。"); }
    finally { setBusy(false); }
  }
  function edit(value: string) { setText(value); setValidation(null); setNotice(""); }
  return <main className="page-content workshop">
    <div className="page-heading"><div><p className="eyebrow">WRITE YOUR NEXT ADVENTURE</p><h1>剧本工坊</h1><p>从一个念头，写成下一场冒险。支持持续战役格式；编辑器中包含主持人的秘密与结局。</p></div><ScrollText size={30} /></div>
    {error && <div className="alert error" role="alert">{error}</div>}
    {notice && <div className="alert" role="status">{notice}</div>}
    <div className="workshop-layout">
      <section className="workshop-panel">
        <h2>让 AI 写一份草稿</h2><p>使用本机 AI 设置。生成会调用你的模型，最多等待两分钟；不会自动保存或开始游戏。</p>
        <label>你想跑怎样的故事？<textarea value={pending?.brief ?? brief} maxLength={2400} rows={6} disabled={generating || !!pending} placeholder="例如：海边小城收到一份百年前的遗嘱。希望有调查、古怪但可信的人物、两难选择，战斗可以绕过。" onChange={event => setBrief(event.target.value)} /></label>
        <label>故事规模<select value={pending?.size ?? size} disabled={generating || !!pending} onChange={event => setSize(event.target.value)}><option value="short">小型局势 · 4–6 地点</option><option value="campaign">多晚冒险 · 8–12 地点</option></select></label>
        {!aiReady && <p className="workshop-hint">还没有接入 AI。你也可以直接导入其他 AI 按规范生成的 JSON。<button className="text-button" onClick={settings}>登录 Codex / 接入 API</button></p>}
        <div className="workshop-buttons">
          <button className="button primary" disabled={busy || generating || (!aiReady && !pending) || !(pending?.brief ?? brief).trim()} onClick={() => void run(async () => {
            const request: GenerationRequest = pending ?? { op: "generate", id: crypto.randomUUID(), brief, size };
            retainPending(request);
            const result = await content<{ job: GenerationJob }>(request); setJob(result.job); retainPending(null);
            if (result.job.text) { setText(result.job.text); setValidation(null); }
          })}>{generating ? <LoaderCircle className="spin" size={16} /> : <ScrollText size={16} />}{generating ? "正在生成，任务已保留…" : pending ? "恢复同一生成请求" : "生成剧本草稿"}</button>
          {generating && <button className="button secondary" disabled={busy} onClick={() => void run(async () => { const result = await content<{ job: GenerationJob }>({ op: "cancel", id: jobId }); setJob(result.job); })}>取消生成</button>}
          {pending && !generating && <button className="text-button" disabled={busy} onClick={() => void run(async () => {
            const result = await content<{ job: GenerationJob | null }>(undefined, `?job=${encodeURIComponent(pending.id)}`);
            if (result.job?.status === "generating") setJob((await content<{ job: GenerationJob }>({ op: "cancel", id: pending.id })).job);
            else if (result.job) { setJob(result.job); if (result.job.text) edit(result.job.text); }
            setBrief(pending.brief); setSize(pending.size); retainPending(null);
          })}>取消这次提交</button>}
        </div>
        {pending && <p className="workshop-hint">上次提交尚未确认。恢复会重用原请求 ID，已接受的生成不会再次调用模型。</p>}
        {job && job.status !== "generating" && job.issues.length > 0 && <div className="workshop-issues" role="status"><strong>{job.status === "failed" ? "草稿未通过，请修改后再校验" : "生成任务状态"}</strong><ul>{job.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul></div>}
        <button className="text-button" disabled={busy} onClick={() => void run(async () => download("lantern-world-authoring-contract.json", JSON.stringify(await content(undefined, "?contract=1"), null, 2)))}><Download size={15} />下载生成规范与范例</button>
        <p className="workshop-hint">规范检查保证配置可读取，并检查主要依赖。它不能证明故事有趣或所有动态路线都通畅；保存后应试玩成功、失败和回访路线。</p>
      </section>
      <section className="workshop-panel">
        <div className="workshop-row"><h2>JSON 草稿</h2><label className="button secondary workshop-upload"><Upload size={15} />导入 JSON<input type="file" accept=".json,application/json" disabled={busy || generating} onChange={event => {
          const file = event.target.files?.[0]; event.target.value = "";
          if (file) void run(async () => { if (file.size > 512000) throw new Error("JSON 文件需小于 512 KB。"); edit(await file.text()); });
        }} /></label></div>
        <textarea className="workshop-json" aria-label="剧本 JSON 草稿" spellCheck={false} value={text} disabled={generating} onChange={event => edit(event.target.value)} placeholder="在这里粘贴 situation-v1 JSON，或在左侧生成草稿。" />
        <div className="workshop-buttons">
          <button className="button secondary" disabled={busy || generating || !text.trim()} onClick={() => void run(async () => setValidation(await content<Validation>({ op: "validate", text })))}>校验草稿</button>
          <button className="button primary" disabled={busy || generating || !text.trim()} onClick={() => void run(async () => {
            const result = await content<{ saved: { id: string } }>({ op: "save", text });
            setWorlds((await content<{ worlds: SavedWorld[] }>()).worlds); await refresh();
            setNotice(`已保存 ${result.saved.id}。在下方选择开始冒险。旧存档保持原剧本版本。`);
          })}>保存到我的剧本</button>
          <button className="text-button" disabled={!text.trim() || generating} onClick={() => download(`${validation?.world?.id || "adventure-draft"}.json`, text)}><Download size={15} />导出草稿</button>
        </div>
        {validation && <div className={validation.issues.length ? "workshop-issues" : "workshop-valid"} role="status">{validation.world ? <p>校验通过 · {validation.world.title} · {validation.world.locations} 地点 / {validation.world.opportunities} 机会 · 修订 {validation.world.revision}</p> : <><strong>未通过校验</strong><ul>{validation.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul></>}</div>}
      </section>
    </div>
    <section className="workshop-library"><h2>我的剧本</h2><p>保存在这台电脑。相同 ID 的修改需增加 revision；开团时会把当前版本保存进独立存档。</p>
      {!worlds.length ? <p className="workshop-hint">还没有自定义剧本。先生成或导入一份，再保存。</p> : <div className="workshop-worlds">{worlds.map(world => <article className="workshop-panel" key={world.id}><h3>{world.title}</h3><p>{world.minutes} · {world.locations} 地点 / {world.opportunities} 机会</p><small>{world.id} · 修订 {world.revision}</small><div className="workshop-buttons"><button className="button primary" onClick={() => play(world.id)}><Play size={15} />开始冒险</button><button className="text-button" disabled={busy || generating} onClick={() => void run(async () => { edit((await content<{ text: string }>(undefined, `?id=${encodeURIComponent(world.id)}`)).text); })}>载入编辑</button></div></article>)}</div>}
    </section>
  </main>;
}
