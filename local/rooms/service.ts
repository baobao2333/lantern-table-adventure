import { createHash, randomBytes, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { DatabaseSync } from "node:sqlite";
import { buildHero } from "../../lib/game/character-builder.ts";
import { addMessage, availableActions, createGame, currentPlayer, gameView, resolve, resolveDefaultCombatTurn, resolvePartyShortRest, settleEnemyTurn, type Command } from "../../lib/game/engine.ts";
import { stageIdea } from "../../lib/game/world-engine.ts";
import { arcaneRecoveryAvailable } from "../../lib/game/spells.ts";
import type { Game, Hero, HeroBuildInput, Resolution } from "../../lib/game/types.ts";
import { DEFAULT_ROOM_TIMERS, ROOM_TIMER_BOUNDS, elapseOperation, operationExpired, phaseWindow } from "./clock.ts";
import { RoomStore } from "./store.ts";
import type { JoinExchange, RoomAiIntent, RoomClock, RoomOperation, RoomReceipt, RoomRequest, RoomSeat, RoomServiceOptions, RoomSnapshot, RoomState, RoomTimers } from "./types.ts";

const token = () => randomBytes(32).toString("base64url");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).filter(key => (value as Record<string, unknown>)[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
function validText(value: unknown, maximum: number): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= maximum; }
function errorText(error: unknown): string { return error instanceof Error ? error.message : "这个请求尚未执行，请刷新房间。"; }
type AiJob = { roomId: string; seatId: string; actorUserId: string; commandId: string; epoch: number; version: number; operationId: string; phaseId: string; game: Game; text: string; controller: AbortController; narration: boolean; startedAt?: number; timer?: ReturnType<typeof setTimeout> };

/** Synchronous SQLite authority. Network and model work only run after a commit. */
export class RoomService {
  readonly store: RoomStore;
  readonly options: RoomServiceOptions;
  readonly clock: RoomClock;
  private anchors = new Map<string, { mono: number; wall: number }>();
  private hostTokens = new Map<string, string>();
  private invites = new Map<string, string>();
  private jobs: AiJob[] = [];
  private activeJob: AiJob | null = null;
  private closed = false;

  constructor(database: DatabaseSync, options: RoomServiceOptions = {}) {
    this.store = new RoomStore(database); this.options = options;
    this.clock = options.clock ?? { monotonic: () => performance.now(), wall: () => Date.now() };
    this.store.transaction(() => {
      for (const room of this.store.all()) {
        room.serverEpoch++;
        if (room.status === "active" || room.status === "paused") {
          room.status = "paused"; room.pauseReason = "房主服务重新启动，请确认同步后继续。";
          if (room.operation?.phase === "ai") { room.operation.phase = "action"; room.operation.phaseRemainingMs = room.operation.remainingMs; delete room.operation.aiCommandId; }
          if (room.operation) room.operation.phaseId = randomUUID();
        }
        for (const seat of room.seats) { seat.lastSeen = 0; seat.online = false; }
        this.event(room, "restart", room.pauseReason);
        this.store.interruptProcessing(room, "房主服务已重启；这项 AI 意图没有执行规则行动。");
        this.store.put(room); this.anchor(room.id);
      }
    });
  }

  create(hero: Hero, campaignId: string) {
    this.ensureOpen();
    const id = randomUUID(), seatId = randomUUID(), seatToken = token(), inviteCode = token();
    const room: RoomState = {
      id, game: createGame(id, seatId, hero, campaignId, "party", id.slice(0, 8).toUpperCase(), this.options.campaign?.(campaignId)),
      status: "lobby", stateVersion: 0, eventSeq: 0, serverEpoch: 1,
      seats: [{ id: seatId, userId: seatId, heroId: hero.id, host: true, ready: false, revoked: false, tokenHash: hash(seatToken), recoveryHash: hash(token()), lastSeen: this.clock.wall(), online: true }],
      inviteHash: hash(inviteCode), queue: [], operation: null, vote: null, timeoutHeroIds: [], timers: { ...DEFAULT_ROOM_TIMERS }, contentDigest: "",
    };
    room.contentDigest = hash(canonical(room.game.campaignSnapshot));
    this.store.transaction(() => { this.event(room, "created", "房间已创建，等待队友准备。"); this.store.put(room); });
    this.hostTokens.set(id, seatToken); this.invites.set(id, inviteCode); this.anchor(id); this.notify(id);
    return { roomId: id, seatId, seatToken, inviteCode, snapshot: this.snapshot(id, seatToken) };
  }

  /** This method belongs to the local management surface, never the participant RPC. */
  hostSeatToken(roomId: string): string {
    this.ensureOpen(); const existing = this.hostTokens.get(roomId); if (existing) return existing;
    const seatToken = token();
    this.store.transaction(() => { const room = this.store.get(roomId), seat = room.seats.find(candidate => candidate.host)!; seat.tokenHash = hash(seatToken); seat.lastSeen = this.clock.wall(); this.store.put(room); });
    this.hostTokens.set(roomId, seatToken); return seatToken;
  }

  join(roomId: string, inviteCode: string, input: HeroBuildInput, exchange?: JoinExchange) {
    this.ensureOpen();
    if (!validText(inviteCode, 100)) throw new Error("邀请无效。");
    if (exchange && (!validText(exchange.joinAttemptId, 100) || !validText(exchange.recoveryProof, 200) || !this.options.protectSecret)) throw new Error("加入恢复证明或本机凭证保护器不可用。");
    if (!input || typeof input !== "object" || Array.isArray(input) || Buffer.byteLength(JSON.stringify(input)) > 20_000) throw new Error("角色创建请求格式或长度无效。");
    const digest = hash(canonical(input)), inviteHash = hash(inviteCode), proofHash = exchange ? hash(exchange.recoveryProof) : "";
    if (exchange) {
      const previous = this.store.db.prepare("SELECT * FROM room_joins WHERE room_id=? AND attempt_id=?").get(roomId, exchange.joinAttemptId);
      if (previous) {
        const room = this.store.get(roomId);
        if (previous.invite_hash !== inviteHash || previous.proof_hash !== proofHash || previous.digest !== digest || !room.seats.some(seat => seat.id === previous.seat_id && !seat.revoked)) throw new Error("加入请求身份不一致或席位已撤销。");
        if (!previous.encrypted || Number(previous.expires_at) <= this.clock.wall()) throw new Error("加入恢复回执已过期，请向房主领取恢复邀请。");
        const credentials = JSON.parse(this.options.protectSecret!(previous.encrypted as string, true));
        return { ...credentials, seatId: previous.seat_id as string, snapshot: this.snapshot(roomId, credentials.seatToken) };
      }
    }
    const current = this.store.get(roomId);
    if (current.status !== "lobby" || current.inviteHash !== inviteHash || current.seats.filter(seat => !seat.revoked).length >= 4) throw new Error("邀请已使用、房间已满，或冒险已经开始。");
    const seatId = randomUUID(), hero = buildHero({ ...input, id: randomUUID() }), seatToken = token(), rejoinToken = token();
    const credentials = { seatId, seatToken, rejoinToken };
    const encrypted = exchange ? this.options.protectSecret!(JSON.stringify(credentials)) : null;
    this.store.transaction(() => {
      const room = this.store.get(roomId);
      if (room.status !== "lobby" || room.seats.filter(seat => !seat.revoked).length >= 4 || room.inviteHash !== inviteHash) throw new Error("邀请已使用、房间已满，或冒险已经开始。");
      room.inviteHash = ""; this.invites.delete(roomId);
      room.seats.push({ id: seatId, userId: seatId, heroId: hero.id, host: false, ready: false, revoked: false, tokenHash: hash(seatToken), recoveryHash: hash(rejoinToken), lastSeen: this.clock.wall(), online: true });
      room.game.players.push({ userId: seatId, hero }); room.stateVersion++;
      this.event(room, "joined", `${hero.name}加入了队伍。`, seatId); this.store.put(room);
      if (exchange) this.store.db.prepare("INSERT INTO room_joins(room_id,attempt_id,invite_hash,proof_hash,digest,seat_id,encrypted,expires_at) VALUES(?,?,?,?,?,?,?,?)").run(roomId, exchange.joinAttemptId, inviteHash, proofHash, digest, seatId, encrypted, this.clock.wall() + 600_000);
    });
    this.notify(roomId); return { ...credentials, snapshot: this.snapshot(roomId, seatToken) };
  }

  rejoin(roomId: string, recoveryToken: string, exchange?: JoinExchange) {
    this.ensureOpen();
    if (!validText(recoveryToken, 100)) throw new Error("恢复凭证无效。");
    if (exchange && (!validText(exchange.joinAttemptId, 100) || !validText(exchange.recoveryProof, 200) || !this.options.protectSecret)) throw new Error("恢复证明或本机凭证保护器不可用。");
    const oldHash = hash(recoveryToken), digest = hash(`rejoin:${oldHash}`), attemptId = exchange ? `rejoin:${exchange.joinAttemptId}` : "", proofHash = exchange ? hash(exchange.recoveryProof) : "";
    if (exchange) {
      const previous = this.store.db.prepare("SELECT * FROM room_joins WHERE room_id=? AND attempt_id=?").get(roomId, attemptId);
      if (previous) {
        const room = this.store.get(roomId);
        if (previous.invite_hash !== oldHash || previous.proof_hash !== proofHash || previous.digest !== digest || !room.seats.some(seat => seat.id === previous.seat_id && !seat.revoked)) throw new Error("恢复请求身份不一致或席位已撤销。");
        if (!previous.encrypted || Number(previous.expires_at) <= this.clock.wall()) throw new Error("恢复回执已过期，请联系房主。");
        const credentials = JSON.parse(this.options.protectSecret!(previous.encrypted as string, true));
        return { ...credentials, seatId: previous.seat_id as string, snapshot: this.snapshot(roomId, credentials.seatToken) };
      }
    }
    const current = this.store.get(roomId);
    if (!current.seats.some(seat => !seat.revoked && !seat.host && seat.recoveryHash === oldHash)) throw new Error("恢复凭证无效或席位已经撤销。");
    const seatToken = token(), rejoinToken = token(); let seatId = "";
    const encrypted = exchange ? this.options.protectSecret!(JSON.stringify({ seatToken, rejoinToken })) : null;
    this.store.transaction(() => {
      const room = this.store.get(roomId), seat = room.seats.find(candidate => !candidate.revoked && !candidate.host && candidate.recoveryHash === oldHash);
      if (!seat) throw new Error("恢复凭证无效或席位已经撤销。");
      seatId = seat.id; seat.tokenHash = hash(seatToken); seat.recoveryHash = hash(rejoinToken); seat.lastSeen = this.clock.wall(); seat.online = true;
      this.event(room, "rejoined", "队友已重新连接，暂停状态需要房主明确恢复。", seat.id); this.store.put(room);
      this.store.db.prepare("UPDATE room_joins SET encrypted=NULL WHERE room_id=? AND seat_id=?").run(roomId, seat.id);
      if (exchange) this.store.db.prepare("INSERT INTO room_joins(room_id,attempt_id,invite_hash,proof_hash,digest,seat_id,encrypted,expires_at) VALUES(?,?,?,?,?,?,?,?)").run(roomId, attemptId, oldHash, proofHash, digest, seatId, encrypted, this.clock.wall() + 600_000);
    });
    this.notify(roomId); return { seatId, seatToken, rejoinToken, snapshot: this.snapshot(roomId, seatToken) };
  }

  heartbeat(roomId: string, seatToken: string) {
    this.ensureOpen(); let changed = false;
    this.store.transaction(() => {
      const room = this.store.get(roomId), seat = this.authenticate(room, seatToken);
      changed = seat.online === false || this.clock.wall() - seat.lastSeen >= room.timers.offlineMs; seat.lastSeen = this.clock.wall(); seat.online = true;
      if (changed) this.event(room, "online", "队友重新连接，暂停状态需要房主明确恢复。", seat.id);
      this.store.put(room);
    });
    if (changed) this.notify(roomId);
    return { serverTime: this.clock.wall(), serverEpoch: this.store.get(roomId).serverEpoch };
  }

  list() { return this.store.all().map(room => ({ id: room.id, status: room.status, title: room.game.campaignSnapshot.title, seats: room.seats.filter(seat => !seat.revoked).length, serverEpoch: room.serverEpoch })); }

  snapshot(roomId: string, seatToken?: string): RoomSnapshot {
    const room = this.store.get(roomId);
    if (!seatToken) throw new Error("请先验证房间席位。");
    const seat = this.authenticate(room, seatToken);
    const view = gameView(structuredClone(room.game), room.stateVersion);
    for (const player of view.game.players) if (player.userId !== seat?.userId) {
      player.hero.background = "未公开的个人背景";
      if (player.hero.build) player.hero.build.profile = { personality: ["", ""], ideal: "", bond: "", flaw: "", goal: "", cooperation: "", backstory: "" };
    }
    const operation = room.operation ? structuredClone(room.operation) : null;
    if (operation) delete operation.aiCommandId;
    return {
      id: room.id, status: room.status, pauseReason: room.pauseReason, serverEpoch: room.serverEpoch,
      stateVersion: room.stateVersion, eventSeq: room.eventSeq, serverTime: this.clock.wall(), contentDigest: room.contentDigest,
      seats: room.seats.filter(candidate => !candidate.revoked).map(({ id, userId, heroId, host, ready, lastSeen }) => ({ id, userId, heroId, host, ready, online: this.clock.wall() - lastSeen < room.timers.offlineMs })),
      currentSeatId: operation?.seatId ?? null, operation: operation ? { ...operation, deadline: this.clock.wall() + (operation.phase === "ai" ? room.timers.aiMs - operation.aiUsedMs : operation.phaseRemainingMs) } : null,
      vote: room.vote ? structuredClone(room.vote) : null, queue: [...room.queue], timers: { ...room.timers }, view,
      events: this.store.events(room.id).slice(-100), aiReady: this.options.aiReady?.() ?? !!this.options.interpret,
      mySeatId: seat?.id, ...(seat?.host && this.invites.has(room.id) ? { inviteCode: this.invites.get(room.id) } : {}),
    };
  }

  eventsSince(roomId: string, seatToken: string, afterSeq: number) {
    const room = this.store.get(roomId); this.authenticate(room, seatToken);
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new Error("事件游标无效。");
    const events = this.store.events(roomId, afterSeq);
    return { eventSeq: room.eventSeq, resyncRequired: afterSeq > room.eventSeq || (afterSeq < room.eventSeq && events[0]?.seq !== afterSeq + 1), events };
  }

  request(roomId: string, seatToken: string, payload: RoomRequest): RoomReceipt {
    this.ensureOpen(); this.validatePayload(payload);
    const digest = hash(canonical(payload)); let launch: AiJob | undefined, narration: AiJob | undefined, changed = false;
    const oldInvite = this.invites.get(roomId);
    let result: RoomReceipt;
    try { result = this.store.transaction(() => {
      const room = this.store.get(roomId), seat = this.authenticate(room, seatToken);
      const previous = this.store.receipt(roomId, seat.id, payload.commandId);
      if (previous) {
        if (previous.digest !== digest) throw new Error("同一个 commandId 不能用于不同请求。");
        return previous.receipt;
      }
      const initialSeq = room.eventSeq;
      this.elapse(room);
      if (room.status === "active" && this.disconnected(room)) this.pause(room, "队伍连接中断，请完成同步后由房主继续。");
      const before = structuredClone(room), resourceBefore = this.resources(room.game);
      let status: RoomReceipt["status"] = "success", fact = "", rolls: Resolution["rolls"] = [], error: string | undefined;
      this.store.db.exec("SAVEPOINT room_apply");
      try {
        if (payload.serverEpoch !== room.serverEpoch) throw new Error("服务已经重启，请重新同步房间。");
        this.checkPhase(room, payload);
        const applied = this.apply(room, seat, payload);
        fact = applied.fact; rolls = [...(applied.rolls ?? []), ...this.store.events(room.id, before.eventSeq).filter(event => event.type === "enemy-settlement").flatMap(event => event.rolls ?? [])]; status = applied.processing ? "processing" : "success";
        launch = applied.job;
        if (applied.narrate && this.options.narrate) narration = this.makeJob(room, seat, payload.commandId, fact, true);
        this.store.db.exec("RELEASE room_apply");
      } catch (cause) {
        this.store.db.exec("ROLLBACK TO room_apply"); this.store.db.exec("RELEASE room_apply");
        Object.assign(room, before); status = "rejected"; error = errorText(cause);
      }
      if (status !== "rejected") { this.event(room, payload.type, fact, seat.id, payload.commandId, rolls); changed = true; }
      if (room.eventSeq !== initialSeq) changed = true;
      const receipt: RoomReceipt = { commandId: payload.commandId, status, stateVersion: room.stateVersion, eventSeq: room.eventSeq, serverEpoch: room.serverEpoch, fact: fact || undefined, error, rolls, resources: status === "success" ? this.resourceChanges(resourceBefore, room.game) : undefined };
      this.store.putReceipt(roomId, seat.id, digest, receipt); this.store.put(room); return this.store.receipt(roomId, seat.id, payload.commandId)!.receipt;
    }); } catch (error) {
      if (oldInvite === undefined) this.invites.delete(roomId); else this.invites.set(roomId, oldInvite);
      throw error;
    }
    if (changed) this.notify(roomId);
    if (launch) this.enqueue(launch); else if (narration) this.enqueue(narration);
    return result;
  }

  /** The host owns scheduling; repeated ticks have durable phase-derived receipts. */
  tick() {
    this.ensureOpen();
    for (const saved of this.store.all()) {
      let changed = false;
      this.store.transaction(() => {
        const room = this.store.get(saved.id), priorStatus = room.status;
        this.elapse(room);
        for (const seat of room.seats.filter(candidate => !candidate.revoked)) {
          const online = this.clock.wall() - seat.lastSeen < room.timers.offlineMs;
          if (seat.online !== online) { seat.online = online; this.event(room, "presence", online ? "队友已在线。" : "队友已离线，角色与投票人数保留。", seat.id); changed = true; }
        }
        if (room.status === "active") {
          if (this.disconnected(room)) this.pause(room, "队伍连接中断，请完成同步后由房主继续。");
          else if (room.operation && operationExpired(room.operation, room.timers)) this.timeout(room);
          else if (room.operation && room.operation.phase !== "ai") {
            for (const [threshold, key] of [[15_000, "warning15"], [5_000, "warning5"]] as const) if (room.operation.phaseRemainingMs <= threshold && !room.operation[key]) { room.operation[key] = true; this.event(room, "timer-warning", `当前阶段还剩 ${threshold / 1000} 秒。`); changed = true; }
          }
        }
        if (room.status !== priorStatus) changed = true;
        if (room.eventSeq !== saved.eventSeq) changed = true;
        this.store.put(room);
      });
      if (changed) this.notify(saved.id);
    }
    this.store.db.prepare("UPDATE room_joins SET encrypted=NULL WHERE expires_at<=?").run(this.clock.wall());
    this.store.db.prepare("DELETE FROM room_events WHERE at<?").run(this.clock.wall() - 86_400_000);
    this.pump();
  }

  close() { if (this.closed) return; this.closed = true; for (const job of this.jobs) job.controller.abort(); this.jobs = []; this.activeJob?.controller.abort(); if (this.activeJob?.timer) clearTimeout(this.activeJob.timer); }

  private ensureOpen() { if (this.closed) throw new Error("房间服务已经关闭。"); }
  private anchor(id: string) { this.anchors.set(id, { mono: this.clock.monotonic(), wall: this.clock.wall() }); }
  private authenticate(room: RoomState, seatToken: string): RoomSeat {
    if (!validText(seatToken, 100)) throw new Error("席位凭证无效。");
    const seat = room.seats.find(candidate => !candidate.revoked && candidate.tokenHash === hash(seatToken));
    if (!seat) throw new Error("席位凭证无效或已经撤销。"); return seat;
  }
  private event(room: RoomState, type: string, fact?: string, actorSeatId?: string, commandId?: string, rolls?: Resolution["rolls"]) { return this.store.event(room, { type, fact, actorSeatId, commandId, rolls, at: this.clock.wall() }); }
  private notify(id: string) { this.cancelStaleJobs(); try { this.options.onUpdate?.(id); } catch { /* Observers cannot roll back committed rules. */ } this.pump(); }
  private resources(game: Game) { return game.players.map(({ userId, hero }) => ({ userId, values: { hp: hero.hp, potions: hero.potions, hitDice: hero.hitDice, secondWind: hero.secondWind, spellSlots: hero.spellSlots } })); }
  private resourceChanges(before: ReturnType<RoomService["resources"]>, game: Game) { return this.resources(game).flatMap(after => { const old = before.find(item => item.userId === after.userId); return old && canonical(old.values) !== canonical(after.values) ? [{ userId: after.userId, before: old.values, after: after.values }] : []; }); }

  private elapse(room: RoomState) {
    const prior = this.anchors.get(room.id), mono = this.clock.monotonic(), wall = this.clock.wall(); this.anchors.set(room.id, { mono, wall });
    if (!prior || room.status !== "active") return;
    const elapsed = Math.max(0, mono - prior.mono);
    if (Math.abs((wall - prior.wall) - elapsed) > 5000 || elapsed > 15_000) {
      this.pause(room, "系统时间跳变或主机休眠，已保存剩余时间，请重新同步。");
      return;
    }
    if (room.operation) room.operation = elapseOperation(room.operation, elapsed, room.timers);
  }
  private disconnected(room: RoomState) {
    const seats = room.seats.filter(seat => !seat.revoked), guests = seats.filter(seat => !seat.host);
    const online = (seat: RoomSeat) => this.clock.wall() - seat.lastSeen < room.timers.offlineMs;
    return !seats.some(online) || (guests.length > 0 && !guests.some(online));
  }
  private afk(room: RoomState) { const capable = room.game.players.filter(player => player.hero.hp > 0); return capable.length > 0 && capable.every(player => room.timeoutHeroIds.includes(player.hero.id)); }
  private pause(room: RoomState, reason: string) {
    if (room.status !== "active") return;
    room.status = "paused"; room.pauseReason = reason;
    this.interruptIntent(room, reason); this.event(room, "paused", reason);
  }

  private validatePayload(payload: RoomRequest) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || !validText(payload.commandId, 100) || !Number.isSafeInteger(payload.serverEpoch) || Buffer.byteLength(JSON.stringify(payload)) > 20_000) throw new Error("房间请求格式无效。");
    const common = ["commandId", "serverEpoch", "stateVersion", "operationId", "phaseId", "type"];
    const fields: Record<RoomRequest["type"], string[]> = { start: [], pause: [], resume: [], ready: ["ready"], build: ["build"], claim: [], pass: [], command: ["command"], talk: ["text"], chat: ["text"], vote: ["yes"], "rest-choice": ["choice"], rules: ["timers", "transportFailed"], kick: ["seatId"], "rotate-invite": [], heartbeat: [] };
    if (!Object.hasOwn(fields, payload.type) || Object.keys(payload).some(key => !common.includes(key) && !fields[payload.type].includes(key))) throw new Error("请求包含未支持的字段。");
    if ((payload.type === "talk" || payload.type === "chat") && !validText(payload.text, payload.type === "talk" ? 1200 : 500)) throw new Error("请输入长度合适的文字。");
    if (payload.type === "command") {
      const command = payload.command;
      if (!command || !["action", "roll", "attack", "missile", "dodge", "potion", "wind", "rest", "retreat", "confirm", "cancel", "session", "spell"].includes(command.kind) || Object.keys(command).some(key => !["kind", "actionId", "targetHeroId"].includes(key)) || (command.actionId !== undefined && !validText(command.actionId, 120)) || (command.targetHeroId !== undefined && !validText(command.targetHeroId, 100))) throw new Error("规则命令格式无效。");
    }
  }
  private checkPhase(room: RoomState, payload: RoomRequest) {
    if (["chat", "heartbeat", "pause", "resume", "rules", "kick", "rotate-invite", "ready", "build", "start", "claim"].includes(payload.type)) return;
    const op = room.operation;
    if (room.status !== "active") throw new Error("房间已暂停、尚未开始或已经结束。");
    if (!op || payload.operationId !== op.id || payload.phaseId !== op.phaseId) throw new Error("阶段已结束，请同步当前行动权。");
    if (operationExpired(op, room.timers)) throw new Error("阶段已结束，服务器不接受迟到动作。");
    if (payload.stateVersion !== room.stateVersion) throw new Error("规则状态已更新，请重新确认当前行动。");
  }

  private apply(room: RoomState, seat: RoomSeat, payload: RoomRequest): { fact: string; rolls?: Resolution["rolls"]; processing?: boolean; job?: AiJob; narrate?: boolean } {
    const hostOnly = () => { if (!seat.host) throw new Error("只有房主可以管理房间。"); };
    const active = () => { if (room.status !== "active") throw new Error("请先开始或恢复冒险。"); };
    switch (payload.type) {
      case "heartbeat": seat.lastSeen = this.clock.wall(); seat.online = true; return { fact: "连接已确认。" };
      case "chat": this.event(room, "chat-message", payload.text!.trim(), seat.id); return { fact: "桌边聊天已发送，没有执行角色行动。" };
      case "pause": hostOnly(); active(); this.pause(room, "房主暂停了冒险。"); return { fact: "冒险已暂停，保存原操作的剩余时间。" };
      case "resume": {
        hostOnly(); if (room.status !== "paused") throw new Error("房间没有暂停。");
        if (this.disconnected(room)) throw new Error("请等待至少一位非房主队友完成连接同步。");
        if (room.vote && !this.voteStillValid(room)) { this.clearProposal(room); room.vote = null; room.operation = null; this.event(room, "interrupted", "原团队决定的目标或代价已变化，尚未消耗资源。"); }
        room.status = "active"; delete room.pauseReason;
        if (room.operation) room.operation.phaseId = randomUUID();
        this.anchor(room.id);
        if (!room.operation || room.game.combat?.order[room.game.combat.turn] === "enemy") this.afterSettlement(room, false, true);
        return { fact: "房主恢复了冒险，沿用原操作的剩余时间与 AI 额度。" };
      }
      case "rules": {
        hostOnly();
        if (payload.transportFailed === true) { this.pause(room, "房主检测到所有已启用的游戏传输入口失效。"); return { fact: "已因全部游戏传输入口失效而暂停。" }; }
        if (room.status !== "lobby" || !payload.timers || typeof payload.timers !== "object") throw new Error("计时规则只能在开局前设置。");
        for (const [key, value] of Object.entries(payload.timers)) {
          if (!Object.hasOwn(ROOM_TIMER_BOUNDS, key)) throw new Error("只能配置行动、确认、投票和 AI 意图时限；心跳与叙事时限固定。");
          const [minimum, maximum] = ROOM_TIMER_BOUNDS[key as keyof typeof ROOM_TIMER_BOUNDS];
          if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`这项时限必须为 ${minimum / 1000}–${maximum / 1000} 秒的整数毫秒值。`);
          room.timers[key as keyof RoomTimers] = value;
        }
        return { fact: "房间计时规则已更新，开局后锁定。" };
      }
      case "rotate-invite": {
        hostOnly(); if (room.status !== "lobby") throw new Error("冒险开始后不能新增席位。");
        const inviteCode = token(); room.inviteHash = hash(inviteCode); this.invites.set(room.id, inviteCode);
        return { fact: "已生成新的单次加入邀请，旧邀请失效。" };
      }
      case "kick": {
        hostOnly(); const target = room.seats.find(candidate => candidate.id === payload.seatId && !candidate.revoked && !candidate.host);
        if (!target) throw new Error("不能撤销这个席位。");
        target.revoked = true; target.tokenHash = ""; target.recoveryHash = ""; room.queue = room.queue.filter(id => id !== target.id);
        this.store.db.prepare("UPDATE room_joins SET encrypted=NULL WHERE room_id=? AND seat_id=?").run(room.id, target.id);
        if (room.status === "lobby") { room.game.players = room.game.players.filter(player => player.userId !== target.userId); room.stateVersion++; }
        else if (this.disconnected(room)) this.pause(room, "参与席位已撤销，请确认队伍连接后继续。");
        return { fact: "席位访问已撤销；已开始冒险中的角色与被冻结的投票人数保留。" };
      }
      case "build": {
        if (room.status !== "lobby" || !payload.build) throw new Error("开局后角色卡锁定。");
        const hero = buildHero({ ...payload.build, id: seat.heroId });
        room.game.players.find(player => player.userId === seat.userId)!.hero = hero; seat.ready = false; room.stateVersion++;
        return { fact: `${hero.name}的角色卡已按规则重建，请重新准备。` };
      }
      case "ready": {
        if (room.status !== "lobby" || typeof payload.ready !== "boolean") throw new Error("只能在开局前确认准备。");
        seat.ready = payload.ready; return { fact: payload.ready ? "角色已准备。" : "已取消准备。" };
      }
      case "start": {
        hostOnly(); const players = room.seats.filter(candidate => !candidate.revoked);
        if (room.status !== "lobby" || players.length < 2 || players.length > 4 || players.some(candidate => !candidate.ready || this.clock.wall() - candidate.lastSeen >= room.timers.offlineMs)) throw new Error("需要 2–4 位角色全部在线并准备后开始。");
        if (!(this.options.aiReady?.() ?? !!this.options.interpret)) throw new Error("请先在本机连接 AI 主持人。");
        const result = resolve(room.game, seat.userId, { kind: "start" }, this.options.die);
        room.game = result.state; room.status = "active"; room.stateVersion++; this.anchor(room.id);
        return { fact: result.fact, rolls: result.rolls };
      }
      case "claim": {
        active(); const hero = room.game.players.find(player => player.userId === seat.userId)!.hero;
        if (room.game.combat || hero.hp <= 0) throw new Error("当前按战斗先攻行动，或角色已经倒地。");
        if (room.operation?.seatId === seat.id) return { fact: "你已经拥有当前行动权。" };
        if (!room.queue.includes(seat.id)) room.queue.push(seat.id);
        this.grant(room); return { fact: room.operation?.seatId === seat.id ? "已取得探索行动权，请确认当前目标再行动。" : "已进入行动队列，每个席位只占一位。" };
      }
      case "vote": {
        const vote = room.vote;
        if (!vote || room.operation?.phase !== "vote" || !vote.eligible.includes(seat.id) || typeof payload.yes !== "boolean") throw new Error("当前没有你可以参与的团队投票。");
        vote.ballots[seat.id] = payload.yes;
        return this.maybeApprove(room);
      }
      case "rest-choice": {
        const vote = room.vote, choice = payload.choice;
        if (!vote?.approved || vote.command.kind !== "rest" || room.operation?.phase !== "rest" || !vote.eligible.includes(seat.id) || !choice || typeof choice !== "object" || Array.isArray(choice) || Object.keys(choice).some(key => !["hitDie", "arcaneRecovery"].includes(key)) || Object.values(choice).some(value => typeof value !== "boolean")) throw new Error("当前不能提交这个短休选择。");
        const hero = room.game.players.find(player => player.userId === seat.userId)!.hero;
        if (choice.hitDie && (hero.hitDice < 1 || hero.hp >= hero.maxHp)) throw new Error("生命已满或没有可用生命骰。");
        if (choice.arcaneRecovery && !arcaneRecoveryAvailable(room.game, hero)) throw new Error("当前不能使用奥术回想。");
        vote.restChoices[seat.userId] = { ...choice }; if (!vote.choiceSeats.includes(seat.id)) vote.choiceSeats.push(seat.id);
        if (vote.eligible.every(id => vote.choiceSeats.includes(id))) return this.finishRest(room);
        return { fact: "个人短休授权已登记，尚未消耗；未授权的资源不会使用。" };
      }
      case "pass": {
        this.acting(room, seat);
        this.interruptIntent(room, "玩家结束了当前操作，AI 意图没有执行规则行动。");
        this.clearProposal(room); room.vote = null;
        if (room.game.combat) {
          const result = resolveDefaultCombatTurn(room.game, "pass", this.options.die); room.game = result.state; room.stateVersion++; room.timeoutHeroIds = []; room.operation = null; this.afterSettlement(room);
          return { fact: result.fact, rolls: result.rolls, narrate: true };
        }
        this.release(room, false); return { fact: "已交出行动权；未确认的行动没有掷骰或消耗资源。" };
      }
      case "talk": {
        active(); this.acting(room, seat);
        if (!this.options.interpret || !(this.options.aiReady?.() ?? true)) throw new Error("AI 主持人尚未连接，请选择规则行动。");
        if (room.game.pending || room.game.world?.proposal || room.vote || room.operation!.phase === "ai") throw new Error("请先处理当前提案或等待中的裁定。");
        if (room.operation!.aiUsedMs >= room.timers.aiMs) throw new Error("这个操作的 AI 理解额度已用完，请使用规则行动或结束回合。");
        this.setPhase(room, "ai"); room.operation!.aiCommandId = payload.commandId;
        return { fact: "主持人正在理解意图，玩家操作钟暂时停止；尚未掷骰或消耗。", processing: true, job: this.makeJob(room, seat, payload.commandId, payload.text!, false) };
      }
      case "command": {
        active(); this.acting(room, seat);
        if (room.operation!.phase === "ai") throw new Error("正在理解意图；可以结束操作，不能同时执行另一个行动。");
        if (room.vote) throw new Error("请先完成团队决定。");
        const command = payload.command!;
        if (command.kind === "cancel") {
          this.clearProposal(room); room.operation!.proposedCommand = undefined;
          if (room.game.combat) this.setPhase(room, "action"); else this.release(room, false);
          return { fact: "尚未确认的提案已放弃，零掷骰、零资源消耗、零故事时间。" };
        }
        if (this.collective(room, command)) return this.beginVote(room, seat, command);
        return this.executeCommand(room, seat, command);
      }
    }
  }

  private acting(room: RoomState, seat: RoomSeat) {
    if (room.operation?.seatId !== seat.id) throw new Error("当前行动权属于另一位玩家。");
    if (room.game.players.find(player => player.userId === seat.userId)!.hero.hp <= 0) throw new Error("角色已经倒地，等待同伴救援。");
  }
  private newOperation(room: RoomState, seatId: string, kind: RoomOperation["kind"]) {
    room.operation = { id: randomUUID(), phaseId: randomUUID(), seatId, kind, phase: "action", remainingMs: room.timers.operationMs, phaseRemainingMs: room.timers.operationMs, aiUsedMs: 0 };
  }
  private setPhase(room: RoomState, phase: RoomOperation["phase"]) {
    const operation = room.operation!; operation.phase = phase; operation.phaseId = randomUUID(); operation.phaseRemainingMs = phaseWindow(operation, phase, room.timers); delete operation.warning15; delete operation.warning5;
  }
  private grant(room: RoomState) {
    if (room.status !== "active" || room.operation || room.game.combat) return;
    while (room.queue.length) {
      const id = room.queue.shift()!, seat = room.seats.find(candidate => candidate.id === id && !candidate.revoked);
      if (!seat || this.clock.wall() - seat.lastSeen >= room.timers.offlineMs || !room.game.players.some(player => player.userId === seat.userId && player.hero.hp > 0)) continue;
      this.newOperation(room, seat.id, "exploration"); this.event(room, "granted", "下一位玩家取得探索行动权，需要重新确认当前目标。", seat.id); return;
    }
  }
  private release(room: RoomState, requeue: boolean) {
    const seatId = room.operation?.seatId; room.operation = null; room.vote = null;
    if (requeue && seatId && !room.queue.includes(seatId)) room.queue.push(seatId);
    this.grant(room);
  }
  private clearProposal(room: RoomState) {
    const had = !!room.game.pending || !!room.game.world?.proposal;
    room.game.pending = null; if (room.game.world) room.game.world.proposal = null;
    if (had) room.stateVersion++;
  }
  private collective(room: RoomState, command: Command): boolean {
    if (["rest", "retreat", "session"].includes(command.kind)) return true;
    if (command.kind === "confirm" && room.game.world?.proposal) {
      const proposal = room.game.world.proposal;
      return !!proposal.travelTo || !!room.game.campaignSnapshot.world?.opportunities.find(goal => goal.id === proposal.goalId)?.success.ending;
    }
    if (command.kind === "action") {
      if (command.actionId?.startsWith("travel:")) return true;
      const action = availableActions(room.game).find(candidate => candidate.id === command.actionId);
      return !!action && action.kind !== "combat" && (action.next !== undefined || !!action.ending);
    }
    return false;
  }
  private beginVote(room: RoomState, seat: RoomSeat, command: Command) {
    if (room.game.combat && command.kind !== "retreat") throw new Error("战斗中只能对撤退进行团队投票。");
    if (command.kind === "rest") resolvePartyShortRest(room.game, {}, () => { throw new Error("短休校验不应掷骰。"); });
    if (command.kind === "action" && !availableActions(room.game).some(action => action.id === command.actionId)) throw new Error("团队行动目标已经不可用。");
    if (command.kind === "session" && !room.game.world) throw new Error("当前剧本没有章节休整。");
    const eligible = room.seats.filter(candidate => !candidate.revoked).map(candidate => candidate.id);
    room.vote = { id: randomUUID(), operationId: room.operation!.id, initiator: seat.id, eligible, ballots: { [seat.id]: true }, command: { ...command }, stateVersion: room.stateVersion, restChoices: {}, choiceSeats: [], approved: false };
    this.setPhase(room, "vote"); return this.maybeApprove(room);
  }
  private voteStillValid(room: RoomState) {
    const vote = room.vote; if (!vote || vote.operationId !== room.operation?.id || vote.stateVersion !== room.stateVersion) return false;
    if (vote.command.kind === "rest") {
      try { resolvePartyShortRest(room.game, {}, () => { throw new Error("Validation must not roll"); }); } catch { return false; }
      for (const [userId, choice] of Object.entries(vote.restChoices)) { const hero = room.game.players.find(player => player.userId === userId)?.hero; if (!hero || (choice.hitDie && (hero.hitDice < 1 || hero.hp >= hero.maxHp)) || (choice.arcaneRecovery && !arcaneRecoveryAvailable(room.game, hero))) return false; }
    }
    if (vote.command.kind === "action") return availableActions(room.game).some(action => action.id === vote.command.actionId);
    if (vote.command.kind === "confirm") return !!room.game.world?.proposal;
    return true;
  }
  private maybeApprove(room: RoomState): { fact: string; rolls?: Resolution["rolls"]; narrate?: boolean } {
    const vote = room.vote!;
    if (vote.eligible.filter(id => vote.ballots[id] === true).length <= vote.eligible.length / 2) return { fact: "投票已登记；必须超过冻结参加人数的一半才能执行。" };
    if (!this.voteStillValid(room)) throw new Error("团队行动的目标或代价已变化，请重新提案。");
    vote.approved = true;
    if (vote.command.kind === "rest") { this.setPhase(room, "rest"); return { fact: "短休已通过，请各自选择是否授权消耗生命骰或奥术回想；未选择默认为零消耗。" }; }
    const seat = room.seats.find(candidate => candidate.id === vote.initiator)!; const command = vote.command; room.vote = null;
    return this.executeCommand(room, seat, command, true);
  }
  private finishRest(room: RoomState) {
    if (!this.voteStillValid(room)) throw new Error("短休资源或环境已变化，未消耗任何资源。");
    const result = resolvePartyShortRest(room.game, room.vote!.restChoices, this.options.die); room.game = result.state; room.stateVersion++; room.vote = null;
    this.afterSettlement(room, true); return { fact: result.fact, rolls: result.rolls, narrate: true };
  }
  private executeCommand(room: RoomState, seat: RoomSeat, requested: Command, teamDecision = false) {
    let command = requested;
    const suggested = room.operation?.proposedCommand;
    if (suggested && command.kind === "confirm" && !room.game.world?.proposal && !room.game.pending) { command = suggested; room.operation!.proposedCommand = undefined; if (this.collective(room, command) && !teamDecision) return this.beginVote(room, seat, command); }
    const result = resolve(room.game, seat.userId, command, this.options.die, { teamDecision });
    room.game = result.state; room.stateVersion++;
    const pending = !!room.game.pending || !!room.game.world?.proposal;
    if (pending) this.setPhase(room, "confirm");
    else {
      if (room.game.combat && room.operation?.kind === "combat") room.timeoutHeroIds = [];
      this.afterSettlement(room, true);
    }
    return { fact: result.fact, rolls: result.rolls, narrate: !pending };
  }
  private afterSettlement(room: RoomState, requeue = false, resumeAuthorization = false) {
    if (room.game.status === "complete") { room.status = "complete"; room.operation = null; room.vote = null; return; }
    if (room.game.combat) {
      if (this.disconnected(room)) { this.pause(room, "队伍连接中断，敌方尚未结算。"); return; }
      if (this.afk(room) && !resumeAuthorization) { this.pause(room, "每个可行动角色均已超时，敌方尚未结算；请房主确认队友返回后继续。"); return; }
      if (room.game.combat.order[room.game.combat.turn] === "enemy") {
        const result = settleEnemyTurn(room.game, this.options.die); room.game = result.state; room.stateVersion++;
        this.event(room, "enemy-settlement", result.fact, undefined, undefined, result.rolls);
        if (room.game.status === "complete") { room.status = "complete"; room.operation = null; room.vote = null; return; }
      }
      const player = currentPlayer(room.game), seat = room.seats.find(candidate => candidate.userId === player?.userId);
      if (seat && (room.operation?.seatId !== seat.id || room.operation.kind !== "combat")) this.newOperation(room, seat.id, "combat");
      else if (room.operation) this.setPhase(room, "action");
      return;
    }
    if (room.operation?.kind === "combat") { room.operation = null; room.vote = null; }
    else if (requeue) this.release(room, true);
    this.grant(room);
  }

  private timeout(room: RoomState) {
    const operation = room.operation!, commandId = `$timeout:${operation.phaseId}`;
    if (this.store.receipt(room.id, "$system", commandId)) return;
    const before = this.resources(room.game), beforeSeq = room.eventSeq; let fact: string, rolls: Resolution["rolls"] = [];
    if (operation.phase === "ai") {
      this.interruptIntent(room, "AI 理解额度已用完，未执行规则行动。请使用当前规则按钮。");
      this.setPhase(room, "action"); fact = "AI 理解累计等待超时，玩家操作钟继续，剩余预算没有重置。";
    } else if (operation.phase === "rest" && room.vote?.approved) {
      const result = this.finishRest(room); fact = result.fact; rolls = result.rolls;
    } else {
      this.clearProposal(room); room.vote = null;
      if (operation.kind === "combat" && operation.remainingMs > 0 && operation.phase !== "action") { this.setPhase(room, "action"); fact = "确认或投票阶段已结束，返回本回合剩余时间。"; }
      else if (operation.kind === "combat") {
        const player = currentPlayer(room.game); if (player && !room.timeoutHeroIds.includes(player.hero.id)) room.timeoutHeroIds.push(player.hero.id);
        const result = resolveDefaultCombatTurn(room.game, "timeout", this.options.die); room.game = result.state; room.stateVersion++; fact = result.fact; rolls = result.rolls; room.operation = null;
        this.afterSettlement(room);
      } else { this.release(room, false); fact = "探索操作超时，取消尚未执行的提案；零掷骰、零资源、零故事时间，交给下一位。"; }
    }
    rolls.push(...this.store.events(room.id, beforeSeq).filter(event => event.type === "enemy-settlement").flatMap(event => event.rolls ?? []));
    this.event(room, "timeout", fact, operation.seatId, commandId, rolls);
    const receipt: RoomReceipt = { commandId, status: "success", stateVersion: room.stateVersion, eventSeq: room.eventSeq, serverEpoch: room.serverEpoch, fact, rolls, resources: this.resourceChanges(before, room.game) };
    this.store.putReceipt(room.id, "$system", hash(commandId), receipt);
  }

  private makeJob(room: RoomState, seat: RoomSeat, commandId: string, text: string, narration: boolean): AiJob {
    return { roomId: room.id, seatId: seat.id, actorUserId: seat.userId, commandId, epoch: room.serverEpoch, version: room.stateVersion, operationId: room.operation?.id ?? "", phaseId: room.operation?.phaseId ?? "", game: structuredClone(room.game), text, controller: new AbortController(), narration };
  }
  private interruptIntent(room: RoomState, reason: string) {
    const operation = room.operation;
    if (operation?.phase !== "ai") return;
    if (operation.aiCommandId) {
      const previous = this.store.receipt(room.id, operation.seatId, operation.aiCommandId);
      if (previous?.receipt.status === "processing") this.store.putReceipt(room.id, operation.seatId, previous.digest, { ...previous.receipt, status: "interrupted", error: reason, eventSeq: room.eventSeq, stateVersion: room.stateVersion });
    }
    operation.phase = "action"; operation.phaseRemainingMs = operation.remainingMs; operation.phaseId = randomUUID(); delete operation.aiCommandId;
  }

  private cancelStaleJobs() {
    const stale = (job: AiJob) => {
      const room = this.store.get(job.roomId);
      return room.serverEpoch !== job.epoch || room.status === "paused" || !room.seats.some(seat => seat.id === job.seatId && !seat.revoked) || (!job.narration && (room.status !== "active" || room.stateVersion !== job.version || room.operation?.id !== job.operationId || room.operation.phaseId !== job.phaseId));
    };
    this.jobs = this.jobs.filter(job => { if (!stale(job)) return true; job.controller.abort(); return false; });
    if (this.activeJob && stale(this.activeJob)) { this.activeJob.controller.abort(); if (this.activeJob.timer) clearTimeout(this.activeJob.timer); this.activeJob = null; }
  }

  private enqueue(job: AiJob) {
    if (this.closed) return;
    if (!job.narration && this.activeJob?.narration) { this.activeJob.controller.abort(); if (this.activeJob.timer) clearTimeout(this.activeJob.timer); this.activeJob = null; }
    if (job.narration) this.jobs = this.jobs.filter(queued => !queued.narration || queued.roomId !== job.roomId);
    this.jobs.push(job); this.pump();
  }
  private pump() {
    if (this.closed || this.activeJob) return;
    this.jobs.sort((left, right) => Number(left.narration) - Number(right.narration));
    const job = this.jobs.shift(); if (!job) return;
    if (job.controller.signal.aborted) { this.pump(); return; }
    let changed = false;
    const room = this.store.transaction(() => {
      const current = this.store.get(job.roomId), seq = current.eventSeq; this.elapse(current);
      if (current.status === "active" && this.disconnected(current)) this.pause(current, "队伍连接中断，请同步后继续。");
      if (!job.narration && current.status === "active" && current.operation?.id === job.operationId && current.operation.phaseId === job.phaseId && operationExpired(current.operation, current.timers)) this.timeout(current);
      changed = current.eventSeq !== seq; this.store.put(current); return current;
    });
    if (changed) { try { this.options.onUpdate?.(job.roomId); } catch { /* The persisted transition remains authoritative. */ } }
    if (room.serverEpoch !== job.epoch || (!job.narration && (room.status !== "active" || room.operation?.id !== job.operationId || room.operation.phaseId !== job.phaseId))) { this.pump(); return; }
    const remaining = job.narration ? room.timers.narrationMs : room.timers.aiMs - (room.operation?.aiUsedMs ?? room.timers.aiMs);
    if (remaining <= 0) { this.tick(); return; }
    this.activeJob = job; job.startedAt = this.clock.monotonic();
    job.timer = setTimeout(() => { job.controller.abort(); if (!job.narration && !this.closed) this.tick(); }, remaining); job.timer.unref?.();
    const task = Promise.resolve().then<RoomAiIntent | string>(() => job.narration ? this.options.narrate!(job.game, job.text, job.actorUserId, job.controller.signal) : this.options.interpret!(job.game, job.actorUserId, job.text, job.controller.signal));
    void Promise.resolve(task).then(result => this.finishAi(job, result), () => this.failAi(job)).finally(() => { if (job.timer) clearTimeout(job.timer); if (this.activeJob === job) this.activeJob = null; this.pump(); });
  }

  private finishAi(job: AiJob, result: RoomAiIntent | string) {
    if (this.closed || job.controller.signal.aborted) return;
    let changed = false;
    this.store.transaction(() => {
      const room = this.store.get(job.roomId); this.elapse(room);
      if (room.serverEpoch !== job.epoch) return;
      if (job.narration) {
        if (typeof result !== "string" || !validText(result, 1600) || this.clock.monotonic() - job.startedAt! > room.timers.narrationMs) return;
        this.store.event(room, { type: "narration", at: this.clock.wall(), fact: result, narrationFor: job.commandId, actorSeatId: job.seatId }); this.store.put(room); changed = true; return;
      }
      const operation = room.operation, previous = this.store.receipt(room.id, job.seatId, job.commandId);
      if (room.status !== "active" || room.stateVersion !== job.version || operation?.id !== job.operationId || operation.phaseId !== job.phaseId || !previous || previous.receipt.status !== "processing") { this.store.put(room); return; }
      if (operationExpired(operation, room.timers)) { this.timeout(room); this.store.put(room); changed = true; return; }
      let fact = "", status: RoomReceipt["status"] = "success", error: string | undefined;
      try {
        if (!result || typeof result === "string" || !["action", "question", "impossible", "proposal"].includes(result.kind) || !validText(result.response, 1200)) throw new Error("主持人的意图格式不完整，请使用规则按钮或重新描述。");
        fact = result.response;
        const seat = room.seats.find(candidate => candidate.id === job.seatId && !candidate.revoked);
        if (!seat) throw new Error("席位已经撤销，AI 意图没有执行。");
        if (result.kind === "proposal" && "idea" in result && result.idea && room.game.world) {
          stageIdea(room.game, room.game.players.find(player => player.userId === seat.userId)!.hero, result.idea); room.stateVersion++; this.setPhase(room, "confirm");
        } else if (result.kind === "action" && "actionId" in result && availableActions(room.game).some(action => action.id === result.actionId)) {
          operation.proposedCommand = { kind: "action", actionId: result.actionId }; this.setPhase(room, "confirm");
        } else if (result.kind === "proposal" || result.kind === "action") throw new Error("主持人提出了当前不可用的行动，尚未执行。");
        else this.setPhase(room, "action");
        delete operation.aiCommandId; addMessage(room.game, "player", job.text, room.game.players.find(player => player.userId === seat.userId)!.hero.name); addMessage(room.game, "dm", fact, undefined, undefined, true);
      } catch (cause) { status = "rejected"; error = errorText(cause); this.setPhase(room, "action"); delete operation.aiCommandId; }
      this.event(room, "intent-result", fact || error, job.seatId, job.commandId);
      this.store.putReceipt(room.id, job.seatId, previous.digest, { commandId: job.commandId, status, fact: fact || undefined, error, rolls: [], stateVersion: room.stateVersion, serverEpoch: room.serverEpoch, eventSeq: room.eventSeq });
      this.store.put(room); changed = true;
    });
    if (changed) this.notify(job.roomId);
  }
  private failAi(job: AiJob) {
    if (this.closed || job.narration) return;
    let changed = false;
    this.store.transaction(() => {
      const room = this.store.get(job.roomId); this.elapse(room);
      const operation = room.operation;
      if (room.serverEpoch !== job.epoch || room.status !== "active" || operation?.id !== job.operationId || operation.phaseId !== job.phaseId) { this.store.put(room); return; }
      this.interruptIntent(room, "AI 主持人暂时无法回应；尚未执行规则行动，请选择规则按钮。");
      this.event(room, "intent-interrupted", "AI 主持人暂时无法回应，玩家操作钟继续，原 AI 额度不会重置。", job.seatId, job.commandId); this.store.put(room); changed = true;
    });
    if (changed) this.notify(job.roomId);
  }
}
