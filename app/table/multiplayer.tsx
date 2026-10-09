"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Bootstrap } from "./client";
import type { RoomRequest, RoomSnapshot, RoomReceipt } from "../../local/rooms/types";
import type { Command } from "../../lib/game/engine";
import { createDefaultHeroInput } from "../../lib/game/character-builder";
import { arcaneRecoveryAvailable } from "../../lib/game/spells";
import { CharacterBuilder } from "./character-builder";
import { Adventure } from "./adventure";
import { Settings } from "./settings";
import { Users, Copy, ArrowLeft, LoaderCircle, Shield, Wifi } from "lucide-react";
import "./multiplayer.css";
import { clientJournal } from "./request-journal";

type State = { role: "host" | "guest"; state: string; snapshot?: RoomSnapshot; invitation?: string; pending?: boolean; error?: string; transport?: string; receipt?: RoomReceipt };
type Saved = { hosted: { id: string; title: string; status: string; seats: number }[]; joined: { id: string }[] };
type Pending = { id: string; role: State["role"]; payload: RoomRequest };
async function roomApi<T>(body?: unknown, query = ""): Promise<T> {
  const response = await fetch(`/api/rooms${query}`, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : { cache: "no-store" });
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(result.error || "无法完成房间操作。");
  return result;
}
let cachedPending: Pending | null = null;
function pendingCommand(): Pending | null { return cachedPending; }

export function Multiplayer({ data, back, help, refresh }: { data: Bootstrap; back(): void; help(): void; refresh(): Promise<unknown> }) {
  const [saved, setSaved] = useState<Saved>({ hosted: [], joined: [] });
  const [state, setState] = useState<State | null>(null), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [heroId, setHeroId] = useState(data.heroes[0]?.id || ""), [campaignId, setCampaignId] = useState(data.campaigns[0]?.id || "moonbridge-conspiracy");
  const [build, setBuild] = useState(() => createDefaultHeroInput("fighter", "preview", "旅人"));
  const [invitation, setInvitation] = useState(""), [joining, setJoining] = useState(false), [settings, setSettings] = useState(false);
  const [signalConfig, setSignalConfig] = useState(""), [advertisedHost, setAdvertisedHost] = useState("");
  const [port, setPort] = useState(4174), [transport, setTransport] = useState<"signal" | "address">("signal");
  const [text, setText] = useState(""), [chat, setChat] = useState("");
  const [now, setNow] = useState(0), [restHitDie, setRestHitDie] = useState(false), [restArcane, setRestArcane] = useState(false);
  const current = useRef<State | null>(null), operating = useRef(false);
  const sessionGeneration = useRef(0);
  const [receivedAt, setReceivedAt] = useState(0);
  const [pending, setPending] = useState<Pending | null>(null);
  function clearSession() { sessionGeneration.current++; current.current = null; setState(null); }
  function accept(next: State, generation = sessionGeneration.current) {
    if (generation !== sessionGeneration.current) return;
    const prior = current.current;
    if (prior?.snapshot && next.snapshot && prior.snapshot.id === next.snapshot.id &&
        (next.snapshot.serverEpoch < prior.snapshot.serverEpoch || (next.snapshot.serverEpoch === prior.snapshot.serverEpoch && next.snapshot.eventSeq < prior.snapshot.eventSeq))) return;
    if (prior?.snapshot && next.snapshot && prior.snapshot.id === next.snapshot.id && next.snapshot.serverEpoch === prior.snapshot.serverEpoch && next.snapshot.eventSeq === prior.snapshot.eventSeq &&
        (next.snapshot.stateVersion < prior.snapshot.stateVersion || (next.snapshot.stateVersion === prior.snapshot.stateVersion && next.snapshot.serverTime < prior.snapshot.serverTime))) return;
    const updated = { ...next, invitation: next.invitation ?? (next.role === "host" && prior?.snapshot?.id === next.snapshot?.id ? prior?.invitation : undefined) };
    const timestamp = performance.now(); setReceivedAt(timestamp); setNow(timestamp);
    current.current = updated; setState(updated);
  }
  async function act(task: () => Promise<void>) {
    if (operating.current) return false;
    operating.current = true; setBusy(true); setError("");
    try { await task(); return true; } catch (e) { setError(e instanceof Error ? e.message : "无法完成操作。"); return false; }
    finally { operating.current = false; setBusy(false); }
  }
  useEffect(() => {
    let active = true;
    Promise.all([roomApi<Saved>(), clientJournal<Pending>("room")]).then(([value, request]) => { if (active) { setSaved(value); cachedPending = request; setPending(request); } }).catch(e => { if (active) setError(e.message); });
    const timer = setInterval(() => setNow(performance.now()), 250);
    return () => { active = false; clearInterval(timer); };
  }, []);
  const roomId = state?.snapshot?.id;
  const role = state?.role;
  useEffect(() => {
    if (!roomId || !role) return;
    const generation = sessionGeneration.current;
    let active = true, fetching = false;
    const poll = async () => {
      if (fetching) return;
      fetching = true;
      try { const result = await roomApi<State>(undefined, `?id=${encodeURIComponent(roomId)}&role=${role}`); if (active) accept(result, generation); }
      catch (e) { if (active) setError(e instanceof Error ? e.message : "连接正在恢复。"); }
      finally { fetching = false; }
    };
    const timer = setInterval(() => void poll(), 1000);
    return () => { active = false; clearInterval(timer); };
  }, [roomId, role]);
  // The initial guest handshake is asynchronous; poll the local session until a snapshot arrives.
  const awaitingGuest = state?.role === "guest" && !state.snapshot;
  useEffect(() => {
    if (!awaitingGuest) return;
    const generation = sessionGeneration.current;
    let active = true, fetching = false;
    const timer = setInterval(() => {
      if (fetching) return;
      fetching = true;
      void roomApi<Saved & { active?: { id: string } }>().then(async list => {
        if (!list.active || !active) return;
        const next = await roomApi<State>(undefined, `?id=${list.active.id}&role=guest`);
        if (active) accept(next, generation);
      }).catch(e => { if (active) setError(e.message); }).finally(() => { fetching = false; });
    }, 1000);
    return () => { active = false; clearInterval(timer); };
  }, [awaitingGuest]);
  const submit = useCallback(async (payload: RoomRequest, id: string, role: State["role"]) => {
    const generation = sessionGeneration.current;
    const request = { id, role, payload };
    await clientJournal("room", { op: "save", payload: request }); cachedPending = request; setPending(request);
    const result = await roomApi<State>({ op: "request", ...request });
    if (generation !== sessionGeneration.current) return;
    accept(result, generation);
    if (result.receipt?.status !== "processing") { await clientJournal("room", { op: "clear", requestId: payload.commandId }); cachedPending = null; setPending(null); }
    if (result.receipt?.status === "rejected" || result.receipt?.status === "interrupted") throw new Error(result.receipt.error || "行动未执行。");
    if (result.receipt?.fact) setNotice(result.receipt.fact);
  }, []);
  async function send(fields: Partial<RoomRequest> & { type: RoomRequest["type"] }) {
    return act(async () => {
      const value = current.current, snapshot = value?.snapshot;
      if (!value || !snapshot) throw new Error("正在等待房主同步。");
      if (pendingCommand()) throw new Error("上次行动尚未确认，请先恢复。");
      await submit({ commandId: crypto.randomUUID(), serverEpoch: snapshot.serverEpoch, stateVersion: snapshot.stateVersion,
        operationId: snapshot.operation?.id, phaseId: snapshot.operation?.phaseId, ...fields }, snapshot.id, value.role);
    });
  }
  const pendingId = pending?.payload.commandId;
  const connectionState = state?.state;
  async function leaveRecovery() {
    const request = pendingCommand();
    if (!request) return;
    await roomApi({ op: "exit-session" });
    const remaining = await clientJournal<Pending>("room", { op: "clear", requestId: request.payload.commandId });
    cachedPending = remaining; setPending(remaining);
    if (remaining) throw new Error("待确认请求已变化，请先恢复当前请求。");
    clearSession();
    setSaved(await roomApi<Saved>());
    setNotice("已停止本机重试。房主可能已经结算的行动仍保留在原房间，重新连接该房间时可查询。");
  }
  useEffect(() => {
    if (!pendingId || !roomId || !role || (role === "guest" && connectionState !== "connected")) return;
    const timer = setInterval(() => {
      const request = pendingCommand();
      if (request?.id === roomId && request.role === role && request.payload.commandId === pendingId)
        void act(() => submit(request.payload, request.id, request.role));
    }, 2500);
    return () => clearInterval(timer);
  }, [pendingId, roomId, role, connectionState, submit]);
  const snapshot = state?.snapshot, me = snapshot?.seats.find(seat => seat.id === snapshot.mySeatId);
  const myHero = snapshot?.view.game.players.find(player => player.userId === me?.userId)?.hero;
  const canUseHitDie = !!myHero && myHero.hitDice > 0 && myHero.hp < myHero.maxHp;
  const canUseArcaneRecovery = !!snapshot && !!myHero && arcaneRecoveryAvailable(snapshot.view.game, myHero);
  const acting = snapshot?.currentSeatId === me?.id;
  const operation = snapshot?.operation;
  const remaining = operation ? Math.max(0, Math.ceil((operation.deadline - snapshot!.serverTime - (snapshot!.status === "active" ? Math.max(0, now - receivedAt) : 0)) / 1000)) : 0;
  const disconnected = state?.role === "guest" && state.state !== "connected";
  const blocked = busy || disconnected || !!pending || snapshot?.status !== "active" || !acting || ["ai", "vote", "rest"].includes(operation?.phase || "");
  const actor = snapshot?.view.game.players.find(player => snapshot.seats.find(seat => seat.id === snapshot.currentSeatId)?.userId === player.userId)?.hero.name;
  return <main className="multiplayer-page page-content">
    <div className="page-heading"><div><p className="eyebrow">GATHER AROUND THE TABLE</p><h1><Users size={26} /> 多人冒险</h1><p>2–4 位旅人，同一张桌，同一个世界。角色与规则由房主保存。</p></div><button className="button secondary" onClick={back}><ArrowLeft size={16} />单人大厅</button></div>
    {error && <div className="alert error" role="alert">{error}<button onClick={() => setError("")}>关闭</button></div>}
    {notice && <p className="scope-note" role="status">{notice}</p>}
    {pending && <div className="alert"><span>有一项行动等待确认。恢复会查询原请求，保留已经结算的骰子。也可以停止重试并离开此桌；这不会撤销房主已经结算的行动。</span><button disabled={busy} onClick={() => void act(() => submit(pending.payload, pending.id, pending.role))}>恢复上次行动</button><button disabled={busy} onClick={() => void act(leaveRecovery)}>结束恢复并离开此桌</button></div>}
    {!state ? <>
      <div className="mode-grid">
        <section className="room-card"><Shield /><h2>创建房间</h2><p>你是房主，连接自己的 AI 主持人，并负责保存进度。</p>
          <button className="text-button" onClick={() => setSettings(true)}>{data.aiReady ? "查看 AI 设置" : "配置 API 或登录 Codex"}</button>
          <label className="field">出发角色<select value={heroId} onChange={e => setHeroId(e.target.value)}>{data.heroes.map(hero => <option key={hero.id} value={hero.id}>{hero.name} · {hero.species}</option>)}</select></label>
          {!data.heroes.length && <p>请先回单人大厅创建一位角色。</p>}
          <label className="field">冒险剧本<select value={campaignId} onChange={e => setCampaignId(e.target.value)}>{data.campaigns.map(campaign => <option key={campaign.id} value={campaign.id}>{campaign.title}</option>)}</select></label>
          <button className="button primary" disabled={busy || !heroId} onClick={() => void act(async () => accept(await roomApi<State>({ op: "create", heroId, campaignId })))}>创建房间</button>
        </section>
        <section className="room-card"><Wifi /><h2>加入朋友</h2><p>粘贴房主的邀请，创建自己的角色。无需账号、API Key 或 Codex 登录。</p>
          <label className="field">房间邀请<textarea rows={4} value={invitation} onChange={e => setInvitation(e.target.value)} placeholder="lantern://join/…" spellCheck={false} /></label>
          <button className="button primary" disabled={busy || !invitation.trim()} onClick={() => setJoining(true)}>选择角色并加入</button>
        </section>
      </div>
      {(saved.hosted.length > 0 || saved.joined.length > 0) && <section className="room-card"><h2>继续上次的桌</h2><div className="saved-list">{saved.hosted.map(room => <button className="saved-row" key={room.id} disabled={busy} onClick={() => void act(async () => accept(await roomApi<State>(undefined, `?id=${room.id}&role=host`)))}><strong>{room.title}</strong><span>{room.seats} 人 · {room.status === "paused" ? "已暂停" : room.status === "lobby" ? "准备中" : room.status === "complete" ? "已结束" : "进行中"}</span></button>)}{saved.joined.map(room => <button className="saved-row" key={room.id} disabled={busy} onClick={() => void act(async () => accept(await roomApi<State>({ op: "reconnect", id: room.id })))}><strong>恢复朋友的房间</strong><small>{room.id.slice(0, 8)}</small></button>)}</div></section>}
    </> : !snapshot ? <section className="room-card"><LoaderCircle className="spin" /><h2>正在与房主建立连接…</h2><p>{state.error || "正在验证邀请中的房主身份，连接成功后同步角色与存档。"}</p><button className="button secondary" onClick={() => void act(async () => { await roomApi({ op: "leave" }); clearSession(); })}>取消加入</button></section> : <>
      <section className="room-card room-status"><div><strong>{state.role === "host" ? "你是房主" : "已加入朋友"}</strong><span className={disconnected ? "form-error" : "setting-success"}>{disconnected ? "连接中断，正在恢复…" : state.transport === "p2p" ? "加密 P2P 直连" : state.role === "guest" ? "加密直连" : "房主规则服务就绪"}</span><small>存档版本 {snapshot.stateVersion} · 事件 {snapshot.eventSeq}</small></div><div className="room-buttons">{state.role === "host" && ["active", "paused"].includes(snapshot.status) && <button className="button secondary" disabled={busy} onClick={() => void send({ type: snapshot.status === "active" ? "pause" : "resume" })}>{snapshot.status === "active" ? "暂停冒险" : "继续冒险"}</button>}<button className="text-button" disabled={busy} onClick={() => void act(async () => { if (state.role === "host" && snapshot.status === "active") throw new Error("请先暂停冒险，再返回房间列表。"); if (state.role === "guest") await roomApi({ op: "leave" }); clearSession(); setSaved(await roomApi<Saved>()); })}>房间列表</button></div></section>
      <div className="party-seats">{snapshot.seats.map(seat => { const hero = snapshot.view.game.players.find(player => player.hero.id === seat.heroId)?.hero; return <div className={`party-seat ${seat.id === snapshot.currentSeatId ? "acting" : ""}`} key={seat.id}><strong>{hero?.name}{seat.host ? " · 房主" : ""}{seat.id === me?.id ? " · 你" : ""}</strong><span>{seat.online ? "在线" : "离线"} · {hero?.hp}/{hero?.maxHp} HP{hero?.hp === 0 ? " · 倒地" : ""}</span><small>{seat.ready ? "已准备" : "未准备"}</small>{me?.host && !seat.host && snapshot.status !== "active" && <button className="text-button" onClick={() => void send({ type: "kick", seatId: seat.id })}>移出席位</button>}</div>; })}</div>
      {(snapshot.status === "lobby" || snapshot.status === "paused") && <section className="room-card"><h2>{snapshot.status === "lobby" ? "出发前，先坐到桌边" : "冒险已暂停"}</h2><p>{snapshot.pauseReason || "所有旅人准备后，由房主开始。每次行动有共享时限，取消裁定不会重新计时。"}</p><div className="room-buttons">{snapshot.status === "lobby" && <button className="button primary" disabled={busy || disconnected || !!pending} onClick={() => void send({ type: "ready", ready: !me?.ready })}>{me?.ready ? "取消准备" : "我已准备"}</button>}{me?.host && snapshot.status === "lobby" && <button className="button secondary" disabled={busy || snapshot.seats.length < 2 || !snapshot.seats.every(seat => seat.ready)} onClick={() => void send({ type: "start" })}>全员准备，开始冒险</button>}{me?.host && <button className="text-button" onClick={() => setSettings(true)}>AI 主持人设置</button>}</div>
        {me?.host && <details className="host-network" open={!state.invitation}><summary>分享房间邀请</summary><p>自部署信令只负责牵线；实际游戏数据直接连接房主。每份邀请仅供一位新玩家使用。房主重启应用后，需要重新发布入口；原席位保留，队友用原存档恢复连接。</p><label className="field">连接方式<select value={transport} onChange={e => setTransport(e.target.value as "signal" | "address")}><option value="signal">自部署信令 + STUN</option><option value="address">高级地址直连（局域网／公网映射）</option></select></label>{transport === "signal" ? <label className="field">部署包生成的连接配置 JSON<textarea rows={4} value={signalConfig} onChange={e => setSignalConfig(e.target.value)} spellCheck={false} placeholder={'{"url":"wss://服务器IP:8443/signal","tlsPin":"…","certificate":"…","stunServers":["stun:服务器IP:3478"]}'} /></label> : <><label className="field">朋友能访问的房主 IP 或域名<input value={advertisedHost} onChange={e => setAdvertisedHost(e.target.value)} placeholder="例如 192.168.1.8 或公网 IPv6" /></label><label className="field">公开房间端口<input type="number" min={1024} max={65535} value={port} onChange={e => setPort(Number(e.target.value))} /></label><p className="subtle-note">开启后监听房间端口，外网 IPv4 需要路由器映射；IPv6 需要放行该端口。管理页面与 AI 密钥仍只在本机。</p></>}
          <button className="button secondary" disabled={busy} onClick={() => void act(async () => {
            const configuration = transport === "signal" ? { signal: JSON.parse(signalConfig) } : { address: { advertisedHost, port, host: advertisedHost.includes(":") ? "::" : "0.0.0.0" } };
            const result = await roomApi<State>({ op: "publish", id: snapshot.id, configuration });
            accept({ ...result, role: "host" });
          })}>生成邀请</button>{state.invitation && <label className="field">邀请（仅分享给朋友）<textarea readOnly rows={3} value={state.invitation} /><button className="text-button" onClick={() => void navigator.clipboard.writeText(state.invitation!).then(() => setNotice("邀请已复制。"))}><Copy size={14} />复制邀请</button></label>}
          <p className="subtle-note">新朋友加入后，先点击“更新邀请”，再重新生成并分享给下一位。</p><button className="text-button" disabled={busy} onClick={() => void send({ type: "rotate-invite" })}>更新邀请</button>
        </details>}
        {me?.host && snapshot.status === "lobby" && <details><summary>行动时限</summary><div className="timer-settings">{([['operationMs', '整次行动', 30, 180], ['confirmMs', '确认裁定', 10, 60], ['voteMs', '团队投票', 15, 90], ['aiMs', 'AI 意图', 15, 60]] as const).map(([key, label, minimum, maximum]) => <label className="field" key={key}>{label}（秒）<input type="number" min={minimum} max={maximum} defaultValue={snapshot.timers[key] / 1000} onBlur={e => { const value = Number(e.target.value); if (value >= minimum && value <= maximum && value * 1000 !== snapshot.timers[key]) void send({ type: "rules", timers: { [key]: value * 1000 } }); }} /></label>)}</div></details>}
      </section>}
      {snapshot.status === "active" && <section className="room-card phase-bar"><strong>{acting ? "轮到你了" : actor ? `等待 ${actor}` : "自由探索：申请行动"}</strong><span>{operation ? `${operation.phase === "ai" ? "主持人理解中" : operation.phase === "vote" ? "团队投票" : operation.phase === "rest" ? "选择短休资源" : operation.phase === "confirm" ? "确认裁定" : "行动阶段"} · ${remaining} 秒` : "每人一次主要行动，完成后释放席位"}</span><div className="room-buttons">{!snapshot.view.game.combat && !acting && <button className="button primary" disabled={busy || disconnected || !!pending || snapshot.queue.includes(me?.id || "")} onClick={() => void send({ type: "claim" })}>{snapshot.queue.includes(me?.id || "") ? "已加入行动队列" : "我来行动"}</button>}{acting && <button className="button secondary" disabled={busy || !!pending} onClick={() => void send({ type: "pass" })}>结束我的行动</button>}</div></section>}
      {snapshot.vote && <section className="room-card"><h2>{snapshot.vote.approved ? "短休已获准：选择自己的资源" : "团队决定"}</h2><p>旅行、休息、撤退与结束本次游玩由参与冒险的席位过半同意。离线不会减少票数。</p>{!snapshot.vote.approved ? <div className="room-buttons"><span>{Object.values(snapshot.vote.ballots).filter(Boolean).length} / {snapshot.vote.eligible.length} 赞成</span><button className="button primary" disabled={busy || !!pending || !snapshot.vote.eligible.includes(me?.id || "")} onClick={() => void send({ type: "vote", yes: true })}>赞成</button><button className="button secondary" disabled={busy || !!pending} onClick={() => void send({ type: "vote", yes: false })}>反对</button></div> : <><label><input type="checkbox" disabled={!canUseHitDie} checked={canUseHitDie && restHitDie} onChange={e => setRestHitDie(e.target.checked)} />花费自己的生命骰恢复</label><label><input type="checkbox" disabled={!canUseArcaneRecovery} checked={canUseArcaneRecovery && restArcane} onChange={e => setRestArcane(e.target.checked)} />使用自己的奥术恢复</label><button className="button primary" disabled={busy || !!pending} onClick={() => void send({ type: "rest-choice", choice: { hitDie: canUseHitDie && restHitDie, arcaneRecovery: canUseArcaneRecovery && restArcane } })}>提交我的短休选择</button><p>不选择就不消耗。全员提交或时限结束后统一结算。</p></>}</section>}
      <Adventure view={snapshot.view} data={{ ...data, userId: me?.userId || "", aiReady: snapshot.aiReady }} busy={!!blocked} command={async (command: Command) => send({ type: "command", command })} navigate={back} help={help} text={text} setText={setText} talk={async () => { if (await send({ type: "talk", text })) setText(""); }} legacyProposal={operation?.proposedCommand?.actionId || null} dismissProposal={() => void send({ type: "command", command: { kind: "cancel" } })} />
      <section className="room-card"><details><summary>桌上事件与主持人补充</summary><div className="room-event-list" aria-label="桌上事件">{snapshot.events.filter(event => event.type !== "chat-message").map(event => {
        const original = event.narrationFor ? snapshot.events.find(candidate => candidate.commandId === event.narrationFor && candidate.type !== "narration") : undefined;
        return <article id={`room-event-${event.seq}`} key={event.seq}><small>#{event.seq} · {event.type === "narration" ? "AI 主持人补充" : "规则事件"}</small>{event.narrationFor && <blockquote>{original?.fact || "对应较早的已结算行动"}</blockquote>}<p>{event.fact}</p>{!!event.rolls?.length && <small>{event.rolls.map(roll => `${roll.label}：${roll.total}`).join("；")}</small>}</article>;
      })}</div></details></section>
      <section className="room-card"><h2>桌边聊天</h2><div className="room-chat-log" role="log" aria-label="桌边聊天记录">{snapshot.events.filter(event => event.type === "chat-message").map(event => <p key={event.seq}><strong>{snapshot.view.game.players.find(player => player.userId === snapshot.seats.find(seat => seat.id === event.actorSeatId)?.userId)?.hero.name || "旅人"}：</strong>{event.fact}</p>)}</div><p>聊天不占行动，也不会推动故事或消耗资源。</p><form className="composer" onSubmit={e => { e.preventDefault(); void send({ type: "chat", text: chat }).then(ok => { if (ok) setChat(""); }); }}><input aria-label="桌边聊天" value={chat} maxLength={700} onChange={e => setChat(e.target.value)} placeholder="和队友商量一下…" /><button className="button primary" disabled={busy || disconnected || !!pending || !chat.trim()}>发送</button></form></section>
    </>}
    {joining && <div className="modal-backdrop"><section className="modal room-builder"><h2>带上你的角色</h2><p>服务端会重新计算角色数值，设定中的超能力不会自动成为实际能力。恢复已有席位会沿用原角色，重新粘贴邀请只更新连接位置。</p><CharacterBuilder value={build} onChange={setBuild} disabled={busy} /><div className="room-buttons"><button className="button secondary" disabled={busy} onClick={() => setJoining(false)}>返回</button><button className="button primary" disabled={busy} onClick={() => void act(async () => { accept(await roomApi<State>({ op: "join", invitation: invitation.trim(), build })); setJoining(false); })}>确认角色并加入</button></div></section></div>}
    {settings && <Settings onClose={() => setSettings(false)} onSaved={refresh} />}
  </main>;
}
