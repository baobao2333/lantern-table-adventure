import { randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { HeroBuildInput } from "../lib/game/types";
import type { RoomService } from "./rooms/index";
import type { RoomRequest, RoomSnapshot, RoomReceipt } from "./rooms/types";
import * as networkModule from "./network/index.mjs";
import { protectSecret } from "./network/identity.mjs";
import { LocalError } from "./settings";

type Peer = {
  id: string; transport: string; route: unknown; closed: boolean;
  send(value: unknown): void; close(reason?: string): void;
  onMessage(listener: (value: unknown) => void): () => void;
  onClose(listener: (reason: string) => void): () => void;
};
type Invitation = { roomId: string; joinToken: string; expiresAt: number; hostFingerprint: string; [key: string]: unknown };
type NetworkHost = { close(): void; status: string; invitationFields: Record<string, unknown> };
type Connector = { close(): void; reconnect(): void; peer?: Peer; status: string };
const network = networkModule as unknown as {
  loadHostIdentity(directory: string): unknown;
  parseInvitation(value: unknown, options?: { allowExpired?: boolean }): Invitation;
  encodeInvitation(fields: unknown): string;
  startHostNetwork(input: Record<string, unknown>): Promise<NetworkHost>;
  startAddressHost(input: Record<string, unknown>): Promise<NetworkHost>;
  createRoomConnector(input: { invitation: Invitation; onPeer(peer: Peer): void; onState(state: string): void }): Connector;
};
type Credentials = { seatId: string; seatToken: string; rejoinToken: string };
type ClientSecret = { invitation: Invitation; credentials?: Credentials; build?: HeroBuildInput; exchange: { joinAttemptId: string; recoveryProof: string } };
type RpcRequest = { type: "request"; id: string; op: "join" | "rejoin" | "snapshot" | "command"; input?: unknown };
type HeartbeatChallenge = { nonce: string; serverEpoch: number; generation: string };
type LiveGuest = {
  id: string; secret: ClientSecret; connector?: Connector; peer?: Peer; generation: number; readyGeneration?: number;
  snapshot?: RoomSnapshot; state: string; error?: string; lastReply: number;
  heartbeatGeneration?: string; heartbeatNonce?: string;
  requests: Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>;
};
type HostClient = {
  peer: Peer; token: string; roomId: string; lastHeartbeat: number; generation: string;
  challenge?: HeartbeatChallenge; challengeAt?: number;
};
type AuthenticationWindow = { started: number; count: number; burstStarted: number; burstCount: number };

// Only this loopback controller can access management methods or AI credentials.
// Network peers receive the explicitly bounded room RPC surface below.
export class RoomGateway {
  private host?: { id: string; hosts: NetworkHost[]; invitation: string; configuration: Record<string, unknown> };
  private hostClients = new Map<string, HostClient>();
  private hostTokens = new Map<string, string>();
  private authenticationWindows = new Map<string, AuthenticationWindow>();
  private publishing = false;
  private guest?: LiveGuest;
  private heartbeat: NodeJS.Timeout;
  constructor(private rooms: RoomService, private database: DatabaseSync, private directory: string) {
    database.exec("CREATE TABLE IF NOT EXISTS lantern_room_clients (id TEXT PRIMARY KEY, secret TEXT NOT NULL, pending TEXT)");
    this.heartbeat = setInterval(() => this.pulse(), 10_000);
    this.heartbeat.unref();
  }
  private hostToken(id: string) {
    let token = this.hostTokens.get(id);
    if (!token) { token = this.rooms.hostSeatToken(id); this.hostTokens.set(id, token); }
    return token;
  }
  hostSnapshot(id: string) { return this.rooms.snapshot(id, this.hostToken(id)); }
  private activeHost(exceptId?: string) { return this.rooms.list().some(room => room.id !== exceptId && room.status === "active"); }
  list() {
    return {
      hosted: this.rooms.list(),
      joined: this.database.prepare("SELECT id FROM lantern_room_clients ORDER BY rowid DESC").all().map(row => ({ id: row.id })),
      active: this.guest ? { id: this.guest.id, role: "guest", state: this.guest.state } : this.host ? { id: this.host.id, role: "host", state: "connected" } : null,
    };
  }
  private persistGuest(guest: LiveGuest) {
    const encrypted = protectSecret(JSON.stringify(guest.secret));
    this.database.prepare("INSERT INTO lantern_room_clients (id,secret) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET secret=excluded.secret").run(guest.id, encrypted);
  }
  private stopGuest() {
    const guest = this.guest;
    this.guest = undefined;
    if (!guest) return;
    guest.generation++;
    guest.connector?.close();
    for (const entry of guest.requests.values()) { clearTimeout(entry.timer); entry.reject(new Error("房间连接已关闭。")); }
    guest.requests.clear();
  }
  private stopHost() {
    if (!this.host) return;
    for (const host of this.host.hosts) host.close();
    for (const client of this.hostClients.values()) client.peer.close("Host stopped sharing.");
    this.hostClients.clear();
    this.host = undefined;
  }
  async publish(id: string, configuration: Record<string, unknown>) {
    if (this.publishing) throw new LocalError("正在调整联机入口，请稍候。");
    let snapshot = this.hostSnapshot(id);
    if (snapshot.status === "active") throw new LocalError("请先暂停冒险，再调整联机入口。");
    if (this.guest) throw new LocalError("请先离开当前朋友的房间。");
    if (this.activeHost(id))
      throw new LocalError("请先暂停当前房间。");
    this.stopHost();
    if (!snapshot.inviteCode && snapshot.status === "lobby") {
      const receipt = this.rooms.request(id, this.hostToken(id), { type: "rotate-invite", commandId: randomUUID(), serverEpoch: snapshot.serverEpoch });
      if (receipt.status !== "success") throw new LocalError("未能生成有效的房间邀请。");
      snapshot = this.hostSnapshot(id);
    }
    const identity = network.loadHostIdentity(this.directory);
    const hosts: NetworkHost[] = [];
    const fields: Record<string, unknown> = {};
    const onConnection = (peer: Peer) => this.acceptPeer(id, peer);
    this.publishing = true;
    try {
      if (configuration.signal) {
        const host = await network.startHostNetwork({ identity, roomId: id, serverEpoch: snapshot.serverEpoch, signal: configuration.signal, onConnection });
        hosts.push(host); Object.assign(fields, host.invitationFields);
      }
      if (configuration.address && typeof configuration.address === "object") {
        const address = configuration.address as { advertisedHost?: string; port?: number; host?: string };
        if (!address.advertisedHost || !Number.isInteger(address.port) || address.port! < 1024 || address.port! > 65535 || !["0.0.0.0", "::", "127.0.0.1", "::1"].includes(address.host || ""))
          throw new LocalError("请填写具体房主地址、有效端口及监听范围。");
        const host = await network.startAddressHost({ identity, roomId: id, serverEpoch: snapshot.serverEpoch, directory: this.directory, ...address, onConnection });
        hosts.push(host); Object.assign(fields, host.invitationFields);
      }
      if (!hosts.length) throw new LocalError("请选择自部署信令配置，或填写高级直连地址。");
      // Locked adventures publish a recovery address, never a new seat credential.
      const invitation = network.encodeInvitation({ ...fields, roomId: id, joinToken: snapshot.status === "lobby" ? snapshot.inviteCode : randomBytes(32).toString("base64url"), expiresAt: Date.now() + 24 * 60 * 60_000 });
      this.host = { id, hosts, invitation, configuration };
      return { invitation, snapshot, state: "connected" };
    } catch (error) { for (const host of hosts) host.close(); throw error; }
    finally { this.publishing = false; }
  }
  private chargeAuthentication(roomId: string) {
    const now = Date.now();
    for (const [id, window] of this.authenticationWindows) if (now - window.started >= 60_000) this.authenticationWindows.delete(id);
    let window = this.authenticationWindows.get(roomId);
    if (!window) {
      if (this.authenticationWindows.size >= 64) this.authenticationWindows.delete(this.authenticationWindows.keys().next().value!);
      window = { started: now, count: 0, burstStarted: now, burstCount: 0 };
      this.authenticationWindows.set(roomId, window);
    }
    if (now - window.burstStarted >= 10_000) { window.burstStarted = now; window.burstCount = 0; }
    if (++window.count > 32 || ++window.burstCount > 8) throw new Error("Room authentication rate exceeded.");
  }
  private challenge(client: HostClient): HeartbeatChallenge {
    if (!client.challenge) {
      client.challenge = { nonce: randomBytes(32).toString("base64url"), serverEpoch: this.rooms.snapshot(client.roomId, client.token).serverEpoch, generation: client.generation };
      client.challengeAt = Date.now();
    }
    return client.challenge;
  }
  private acceptHeartbeat(client: HostClient, input: unknown) {
    if (input === undefined) return;
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => key !== "heartbeat")) throw new Error("Invalid heartbeat response.");
    const echo = (input as { heartbeat?: HeartbeatChallenge }).heartbeat;
    if (!echo || typeof echo !== "object" || Object.keys(echo).length !== 3 || typeof echo.nonce !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(echo.nonce) || !Number.isSafeInteger(echo.serverEpoch) || typeof echo.generation !== "string") throw new Error("Invalid heartbeat response.");
    const pending = client.challenge;
    if (!pending || echo.nonce !== pending.nonce || echo.serverEpoch !== pending.serverEpoch || echo.generation !== pending.generation || Date.now() - client.challengeAt! >= 30_000) return;
    if (this.rooms.snapshot(client.roomId, client.token).serverEpoch !== pending.serverEpoch) throw new Error("Room heartbeat epoch changed.");
    // A snapshot fetch, replay, or one-way stream cannot extend a seat's lease.
    client.challenge = undefined; client.challengeAt = undefined;
    this.rooms.heartbeat(client.roomId, client.token);
    client.lastHeartbeat = Date.now();
  }
  private acceptPeer(roomId: string, peer: Peer) {
    let token = "", generation = 0, count = 0, windowStart = Date.now(), processing = false;
    const authTimer = setTimeout(() => { if (!token) peer.close("Room authentication timed out."); }, 20_000);
    authTimer.unref();
    const answer = (id: string, result?: unknown, error?: string) => {
      if (!peer.closed) peer.send({ type: "response", id, result, error });
    };
    peer.onClose(() => { clearTimeout(authTimer); this.hostClients.delete(peer.id); generation++; });
    peer.onMessage(value => {
      const current = generation;
      try {
        if (!value || typeof value !== "object" || Array.isArray(value) || Buffer.byteLength(JSON.stringify(value)) > 40_000) throw new Error("Invalid room request.");
        const request = value as RpcRequest;
        if (request.type !== "request" || typeof request.id !== "string" || !/^[0-9a-f-]{36}$/.test(request.id) || Object.keys(request).some(key => !["type", "id", "op", "input"].includes(key))) throw new Error("Invalid room request.");
        if (Date.now() - windowStart > 60_000) { count = 0; windowStart = Date.now(); }
        if (++count > 180 || processing) { peer.close("Room request rate exceeded."); return; }
        processing = true;
        let result: unknown;
        if (!token) {
          this.chargeAuthentication(roomId);
          const input = request.input as { inviteCode?: string; build?: HeroBuildInput; rejoinToken?: string; exchange?: ClientSecret["exchange"] };
          if (request.op === "join") result = this.rooms.join(roomId, input?.inviteCode || "", input?.build as HeroBuildInput, input?.exchange);
          else if (request.op === "rejoin") result = this.rooms.rejoin(roomId, input?.rejoinToken || "", input?.exchange);
          else throw new Error("Room authentication required.");
          const credentials = result as Credentials;
          token = credentials.seatToken;
          clearTimeout(authTimer);
          // A newer authenticated transport for a seat fences the older one.
          for (const client of this.hostClients.values()) {
            if (client.roomId !== roomId) continue;
            try {
              const old = this.rooms.snapshot(roomId, client.token);
              if (old.mySeatId === credentials.seatId) client.peer.close("Seat connected elsewhere.");
            } catch { client.peer.close("Seat credentials replaced."); }
          }
          const client: HostClient = { peer, token, roomId, lastHeartbeat: Date.now(), generation: randomUUID() };
          this.hostClients.set(peer.id, client);
          result = { ...result as object, heartbeat: this.challenge(client) };
        } else if (request.op === "snapshot") {
          const client = this.hostClients.get(peer.id);
          if (!client) throw new Error("Room connection was replaced.");
          this.acceptHeartbeat(client, request.input);
          result = this.rooms.snapshot(roomId, token);
        } else if (request.op === "command") {
          const payload = request.input as RoomRequest;
          if (payload?.type === "heartbeat") throw new Error("Use the authenticated heartbeat exchange.");
          result = this.rooms.request(roomId, token, payload);
        } else throw new Error("Unknown room operation.");
        if (current === generation) answer(request.id, result);
      } catch {
        if (!token) peer.close("Room authentication rejected.");
        else if (value && typeof value === "object" && "id" in value && typeof value.id === "string" && /^[0-9a-f-]{36}$/.test(value.id)) answer(value.id, undefined, "房间拒绝了请求，请检查角色、阶段或重新连接。");
        else peer.close("Invalid room request envelope.");
      }
      finally { processing = false; }
    });
  }
  onUpdate(roomId: string) {
    for (const client of this.hostClients.values()) {
      if (client.roomId !== roomId) continue;
      try { client.peer.send({ type: "snapshot", snapshot: this.rooms.snapshot(roomId, client.token) }); }
      catch { client.peer.close("Room synchronization failed."); }
    }
  }
  private rpc(guest: LiveGuest, op: RpcRequest["op"], input?: unknown): Promise<unknown> {
    const peer = guest.peer;
    if (!peer || peer.closed) return Promise.reject(new LocalError("与房主的连接尚未恢复，不能提交新行动。", 503));
    if (guest.requests.size >= 8) return Promise.reject(new LocalError("正在等待房主确认，请稍候。", 429));
    const id = randomUUID();
    return new Promise((resolveRpc, reject) => {
      const timer = setTimeout(() => { guest.requests.delete(id); reject(new LocalError("等待房主确认超时；原请求已保留，重连后查询。", 503)); }, 15_000);
      guest.requests.set(id, { resolve: resolveRpc, reject, timer });
      try { peer.send({ type: "request", id, op, input }); }
      catch (error) { clearTimeout(timer); guest.requests.delete(id); reject(error); }
    });
  }
  private applySnapshot(guest: LiveGuest, snapshot: RoomSnapshot) {
    if (!snapshot || snapshot.id !== guest.id || !Number.isSafeInteger(snapshot.eventSeq)) return;
    const prior = guest.snapshot;
    if (prior && (snapshot.serverEpoch < prior.serverEpoch || (snapshot.serverEpoch === prior.serverEpoch && snapshot.eventSeq < prior.eventSeq))) return;
    if (prior && snapshot.serverEpoch === prior.serverEpoch && snapshot.eventSeq === prior.eventSeq &&
        (snapshot.stateVersion < prior.stateVersion || snapshot.serverTime < prior.serverTime)) return;
    guest.snapshot = snapshot;
  }
  async join(invitationText: string, build: HeroBuildInput) {
    if (this.publishing) throw new LocalError("正在调整联机入口，请稍候。");
    const invitation = network.parseInvitation(invitationText);
    if (this.activeHost()) throw new LocalError("请先暂停自己的房间。");
    let secret: ClientSecret = { invitation, build, exchange: this.exchange() };
    const previous = this.database.prepare("SELECT secret FROM lantern_room_clients WHERE id=?").get(invitation.roomId);
    if (previous) {
      const saved = JSON.parse(protectSecret(String(previous.secret), true)) as ClientSecret;
      if (saved.invitation.roomId !== invitation.roomId || saved.invitation.hostFingerprint !== invitation.hostFingerprint) throw new LocalError("房主身份与本机保存的房间不符，不能替换已有席位凭据。");
      // Updating a trusted host's address retains the character and retry exchange.
      secret = { ...saved, invitation };
    }
    this.stopHost(); this.stopGuest();
    const guest: LiveGuest = { id: invitation.roomId, secret, generation: 0, state: "connecting", lastReply: 0, requests: new Map() };
    this.persistGuest(guest); this.connectGuest(guest);
    return this.guestState(guest);
  }
  async reconnect(id: string) {
    if (this.publishing) throw new LocalError("正在调整联机入口，请稍候。");
    if (this.guest?.id === id) return this.guestState(this.guest);
    if (this.activeHost()) throw new LocalError("请先暂停自己的房间。");
    const row = this.database.prepare("SELECT secret FROM lantern_room_clients WHERE id=?").get(id);
    if (!row) throw new LocalError("找不到本机加入凭据。");
    const secret = JSON.parse(protectSecret(String(row.secret), true)) as ClientSecret;
    this.stopHost(); this.stopGuest();
    const guest: LiveGuest = { id, secret, generation: 0, state: "connecting", lastReply: 0, requests: new Map() };
    this.connectGuest(guest);
    return this.guestState(guest);
  }
  private exchange() { return { joinAttemptId: randomUUID(), recoveryProof: randomBytes(32).toString("base64url") }; }
  private connectGuest(guest: LiveGuest) {
    this.guest = guest;
    guest.connector = network.createRoomConnector({ invitation: guest.secret.invitation,
      onState: state => { if (this.guest === guest) { if (state !== "connected") guest.readyGeneration = undefined; guest.state = state === "connected" ? "synchronizing" : state; } },
      onPeer: peer => {
        if (this.guest !== guest) { peer.close(); return; }
        const generation = ++guest.generation;
        guest.readyGeneration = undefined; guest.state = "synchronizing";
        guest.heartbeatGeneration = undefined; guest.heartbeatNonce = undefined;
        guest.peer = peer; guest.lastReply = Date.now();
        peer.onMessage(value => {
          if (this.guest !== guest || generation !== guest.generation || !value || typeof value !== "object") return;
          const message = value as { type?: string; id?: string; result?: unknown; error?: string; snapshot?: RoomSnapshot; heartbeat?: HeartbeatChallenge };
          if (message.type === "snapshot" && message.snapshot) this.applySnapshot(guest, message.snapshot);
          if (message.type === "heartbeat" && guest.readyGeneration === generation) void this.echoHeartbeat(guest, generation, message.heartbeat).catch(() => { if (generation === guest.generation) peer.close("Room heartbeat failed."); });
          if (message.type === "response" && message.id) {
            const pending = guest.requests.get(message.id);
            if (!pending) return;
            clearTimeout(pending.timer); guest.requests.delete(message.id); guest.lastReply = Date.now();
            if (message.error) pending.reject(new LocalError(message.error));
            else pending.resolve(message.result);
          }
        });
        peer.onClose(() => { if (generation === guest.generation) { guest.readyGeneration = undefined; guest.peer = undefined; for (const pending of guest.requests.values()) { clearTimeout(pending.timer); pending.reject(new LocalError("连接已断开，原请求已保留。", 503)); } guest.requests.clear(); } });
        void this.authenticateGuest(guest, generation).catch(() => { if (this.guest === guest && generation === guest.generation) { guest.error = "未能恢复席位，请确认邀请有效、房主在线。"; peer.close("Room authentication failed."); } });
      },
    });
  }
  private async authenticateGuest(guest: LiveGuest, generation: number) {
    const secret = guest.secret;
    const result = await this.rpc(guest, secret.credentials ? "rejoin" : "join", secret.credentials
      ? { rejoinToken: secret.credentials.rejoinToken, exchange: secret.exchange }
      : { inviteCode: secret.invitation.joinToken, build: secret.build, exchange: secret.exchange }) as Credentials & { snapshot: RoomSnapshot; heartbeat: HeartbeatChallenge };
    if (this.guest !== guest || generation !== guest.generation) return;
    secret.credentials = { seatId: result.seatId, seatToken: result.seatToken, rejoinToken: result.rejoinToken };
    delete secret.build;
    secret.exchange = this.exchange();
    this.persistGuest(guest);
    guest.error = undefined; this.applySnapshot(guest, result.snapshot);
    guest.heartbeatGeneration = result.heartbeat?.generation;
    await this.echoHeartbeat(guest, generation, result.heartbeat);
    if (this.guest !== guest || generation !== guest.generation) return;
    await this.recoverPending(guest);
    if (this.guest === guest && generation === guest.generation) { guest.readyGeneration = generation; guest.state = "connected"; }
  }
  private async echoHeartbeat(guest: LiveGuest, generation: number, challenge?: HeartbeatChallenge) {
    if (this.guest !== guest || generation !== guest.generation) return;
    if (!challenge || typeof challenge.nonce !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(challenge.nonce) || !Number.isSafeInteger(challenge.serverEpoch) || challenge.serverEpoch !== guest.snapshot?.serverEpoch || !/^[0-9a-f-]{36}$/.test(challenge.generation) || challenge.generation !== guest.heartbeatGeneration) throw new Error("Invalid host heartbeat challenge.");
    if (guest.heartbeatNonce === challenge.nonce) return;
    guest.heartbeatNonce = challenge.nonce;
    const snapshot = await this.rpc(guest, "snapshot", { heartbeat: challenge }) as RoomSnapshot;
    if (this.guest === guest && generation === guest.generation) this.applySnapshot(guest, snapshot);
  }
  private async recoverPending(guest: LiveGuest) {
    const row = this.database.prepare("SELECT pending FROM lantern_room_clients WHERE id=?").get(guest.id);
    if (!row?.pending) return;
    await this.sendGuestCommand(guest, JSON.parse(String(row.pending)) as RoomRequest);
  }
  private async sendGuestCommand(guest: LiveGuest, payload: RoomRequest) {
    const receipt = await this.rpc(guest, "command", payload) as RoomReceipt;
    if (receipt.status !== "processing") this.database.prepare("UPDATE lantern_room_clients SET pending=NULL WHERE id=? AND pending=?").run(guest.id, JSON.stringify(payload));
    const snapshot = await this.rpc(guest, "snapshot") as RoomSnapshot;
    this.applySnapshot(guest, snapshot);
    return { receipt, ...this.guestState(guest) };
  }
  private guestState(guest: LiveGuest) {
    return { role: "guest", state: guest.state, error: guest.error, snapshot: guest.snapshot,
      pending: Boolean(this.database.prepare("SELECT pending FROM lantern_room_clients WHERE id=?").get(guest.id)?.pending),
      transport: guest.peer?.transport, hostFingerprint: guest.secret.invitation.hostFingerprint };
  }
  state(id: string, role: "host" | "guest") {
    if (role === "host") return { role, state: "connected", snapshot: this.hostSnapshot(id), invitation: this.host?.id === id ? this.host.invitation : undefined };
    if (this.guest?.id !== id) throw new LocalError("请先恢复房间连接。");
    return this.guestState(this.guest);
  }
  async request(id: string, role: "host" | "guest", payload: RoomRequest) {
    if (role === "host") {
      if (["start", "resume"].includes(payload.type) && (this.publishing || this.guest || this.activeHost(id))) throw new LocalError("请等待联机入口就绪，退出朋友的房间，或暂停本机的另一场冒险。");
      const receipt = this.rooms.request(id, this.hostToken(id), payload);
      if (payload.type === "rotate-invite" && this.host?.id === id && receipt.status === "success") await this.publish(id, this.host.configuration);
      return { receipt, ...this.state(id, role) };
    }
    const guest = this.guest;
    if (!guest || guest.id !== id || guest.readyGeneration !== guest.generation || !guest.snapshot || !guest.secret.credentials || Date.now() - guest.lastReply > 30_000) throw new LocalError("正在重新连接房主，不能提交新行动。", 503);
    const row = this.database.prepare("SELECT pending FROM lantern_room_clients WHERE id=?").get(id);
    if (row?.pending && String(row.pending) !== JSON.stringify(payload)) throw new LocalError("上次行动尚未确认，请先恢复原请求。", 409);
    this.database.prepare("UPDATE lantern_room_clients SET pending=? WHERE id=?").run(JSON.stringify(payload), id);
    return this.sendGuestCommand(guest, payload);
  }
  async recover(id: string) {
    if (!this.guest || this.guest.id !== id) throw new LocalError("请先恢复连接。");
    await this.recoverPending(this.guest);
    return this.guestState(this.guest);
  }
  leave() { this.stopGuest(); return { ok: true }; }
  pause() {
    for (const item of this.rooms.list()) {
      const id = item.id;
      const snapshot = this.hostSnapshot(id);
      if (snapshot.status === "active") this.rooms.request(id, this.hostToken(id), { type: "pause", commandId: randomUUID(), serverEpoch: snapshot.serverEpoch });
    }
  }
  private pulse() {
    if (this.host) {
      try { this.rooms.heartbeat(this.host.id, this.hostToken(this.host.id)); } catch {}
    }
    for (const client of this.hostClients.values()) {
      try {
        if (Date.now() - client.lastHeartbeat >= 30_000) client.peer.close("Host heartbeat expired.");
        else client.peer.send({ type: "heartbeat", heartbeat: this.challenge(client) });
      } catch { client.peer.close("Room heartbeat failed."); }
    }
    const guest = this.guest;
    if (!guest?.peer || !guest.secret.credentials || guest.readyGeneration !== guest.generation) return;
    if (Date.now() - guest.lastReply > 30_000) { guest.connector?.reconnect(); return; }
    void this.rpc(guest, "snapshot").then(value => { if (this.guest === guest) this.applySnapshot(guest, value as RoomSnapshot); }).catch(() => {});
  }
  close() { this.pause(); clearInterval(this.heartbeat); this.stopGuest(); this.stopHost(); }
}
