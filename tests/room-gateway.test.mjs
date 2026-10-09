import test, { after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "esbuild";
import rtc from "node-datachannel";
import { connectRoom, parseInvitation, encodeInvitation, createIdentity } from "../local/network/index.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
mkdirSync(join(root, ".codex"), { recursive: true });
const compiled = mkdtempSync(join(root, ".codex", "room-gateway-tests-"));
const entry = join(compiled, "entry.mjs");
await build({ stdin: { contents: 'export { RoomGateway } from "./local/room-gateway.ts"; export { RoomService } from "./local/rooms/index.ts"; export { buildHero, createDefaultHeroInput } from "./lib/game/character-builder.ts";', resolveDir: root },
  outfile: entry, bundle: true, platform: "node", format: "esm", target: "node24", external: ["node-datachannel", "ws", "selfsigned"] });
const { RoomGateway, RoomService, buildHero, createDefaultHeroInput } = await import(pathToFileURL(entry).href);
after(() => { rtc.cleanup(); rmSync(compiled, { recursive: true, force: true }); });
const windows = { skip: process.platform !== "win32", timeout: 15_000 };

async function waitFor(check, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (!check()) { if (Date.now() > deadline) throw new Error("Gateway condition timed out."); await delay(20); }
}
async function availablePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "lantern-gateway-"));
  const hostDatabasePath = join(directory, "host.sqlite");
  const hostDb = new DatabaseSync(hostDatabasePath), guestDb = new DatabaseSync(":memory:");
  const hostDirectory = join(directory, "host"), guestDirectory = join(directory, "guest");
  mkdirSync(hostDirectory); mkdirSync(guestDirectory);
  let host;
  const hostRooms = new RoomService(hostDb, { aiReady: () => true, protectSecret: (value, decrypt) => protection(value, decrypt), onUpdate: (id) => host?.onUpdate(id) });
  const guestRooms = new RoomService(guestDb);
  host = new RoomGateway(hostRooms, hostDb, hostDirectory);
  const guest = new RoomGateway(guestRooms, guestDb, guestDirectory);
  const created = hostRooms.create(buildHero(createDefaultHeroInput("fighter", randomUUID(), "Host")), "silent-bell");
  const published = await host.publish(created.roomId, { address: { host: "127.0.0.1", advertisedHost: "127.0.0.1", port: await availablePort() } });
  return { host, guest, hostRooms, guestRooms, hostDb, guestDb, created, invitation: published.invitation, hostDatabasePath, hostDirectory,
    guestInput: createDefaultHeroInput("wizard", randomUUID(), "Guest"),
    async close() { guest.close(); if (hostDb.isOpen) host.close(); guestRooms.close(); hostRooms.close(); await delay(50); guestDb.close(); if (hostDb.isOpen) hostDb.close(); rmSync(directory, { recursive: true, force: true }); } };
}
const { protectSecret: protection } = await import("../local/network/identity.mjs");
function guestReady(f) { const state = f.guest.state(f.created.roomId, "guest"); return state.state === "connected" && state.snapshot?.mySeatId; }

test("two independent services share a WSS room without guest AI credentials", windows, async () => {
  const f = await fixture();
  try {
    await f.guest.join(f.invitation, f.guestInput);
    await waitFor(() => guestReady(f));
    let state = f.guest.state(f.created.roomId, "guest");
    assert.equal(state.transport, "address"); assert.equal(state.snapshot.seats.length, 2);
    assert.equal(f.guestRooms.list().length, 0);
    assert.equal(state.snapshot.inviteCode, undefined);
    const ready = { type: "ready", ready: true, commandId: randomUUID(), serverEpoch: state.snapshot.serverEpoch };
    const first = await f.guest.request(f.created.roomId, "guest", ready);
    const second = await f.guest.request(f.created.roomId, "guest", ready);
    assert.equal(first.receipt.status, "success"); assert.deepEqual(second.receipt, first.receipt);
    const hostState = f.host.state(f.created.roomId, "host");
    assert.equal(hostState.snapshot.seats.find((seat) => seat.id === state.snapshot.mySeatId).ready, true);
    assert.equal(f.hostRooms.store.db.prepare("SELECT count(*) AS count FROM room_receipts WHERE command_id=?").get(ready.commandId).count, 1);
    await f.guest.request(f.created.roomId, "guest", { type: "chat", text: "A cooperative plan", commandId: randomUUID(), serverEpoch: state.snapshot.serverEpoch });
    state = f.guest.state(f.created.roomId, "guest");
    assert.ok(state.snapshot.events.some((event) => event.fact === "A cooperative plan"));
  } finally { await f.close(); }
});

test("lost join and rotating rejoin replies recover one seat and fence old credentials", windows, async () => {
  const f = await fixture();
  let dropCredentials = 1, dropped = 0;
  const accept = f.host.acceptPeer.bind(f.host);
  f.host.acceptPeer = (id, peer) => {
    const send = peer.send.bind(peer);
    peer.send = (message) => {
      if (dropCredentials && message.type === "response" && message.result?.seatToken) { dropCredentials--; dropped++; peer.close("Injected lost credential response."); return; }
      send(message);
    };
    accept(id, peer);
  };
  try {
    await f.guest.join(f.invitation, f.guestInput);
    await waitFor(() => guestReady(f));
    assert.equal(dropped, 1);
    const before = structuredClone(f.guest.guest.secret.credentials);
    assert.ok(before.seatId); assert.equal(f.hostRooms.list()[0].seats, 2);
    dropCredentials = 1;
    f.guest.guest.peer.close("Injected disconnect before credential rotation.");
    await waitFor(() => dropped === 2 && guestReady(f) && f.guest.guest.secret.credentials.rejoinToken !== before.rejoinToken);
    const after = f.guest.guest.secret.credentials;
    assert.equal(after.seatId, before.seatId); assert.notEqual(after.seatToken, before.seatToken);
    assert.equal(f.hostRooms.list()[0].seats, 2);
    assert.throws(() => f.hostRooms.snapshot(f.created.roomId, before.seatToken), /凭证/);
    assert.equal(f.hostRooms.snapshot(f.created.roomId, after.seatToken).mySeatId, before.seatId);
    assert.equal(f.host.hostClients.size, 1);
  } finally { await f.close(); }
});

test("rejoin synchronization blocks fresh commands until durable credentials and snapshot are ready", windows, async () => {
  const f = await fixture();
  let hold = false, release;
  const accept = f.host.acceptPeer.bind(f.host);
  f.host.acceptPeer = (id, peer) => {
    const send = peer.send.bind(peer);
    peer.send = (message) => {
      if (hold && message.type === "response" && message.result?.seatToken) { hold = false; release = () => send(message); return; }
      send(message);
    };
    accept(id, peer);
  };
  try {
    await f.guest.join(f.invitation, f.guestInput); await waitFor(() => guestReady(f));
    const snapshot = f.guest.state(f.created.roomId, "guest").snapshot;
    hold = true; f.guest.guest.peer.close("Injected reconnect.");
    await waitFor(() => release);
    assert.notEqual(f.guest.state(f.created.roomId, "guest").state, "connected");
    await assert.rejects(f.guest.request(f.created.roomId, "guest", { type: "ready", ready: true, commandId: randomUUID(), serverEpoch: snapshot.serverEpoch }), /连接|同步/);
    assert.equal(f.guestDb.prepare("SELECT pending FROM lantern_room_clients WHERE id=?").get(f.created.roomId).pending, null);
    release(); await waitFor(() => guestReady(f));
  } finally { await f.close(); }
});

test("malformed unauthenticated commands cannot consume the invite or create a seat", windows, async () => {
  const f = await fixture();
  let peer;
  try {
    peer = await connectRoom({ invitation: f.invitation });
    peer.send({ type: "request", id: randomUUID(), op: "command", input: { type: "ready", ready: true, serverEpoch: 1, commandId: randomUUID() } });
    await waitFor(() => peer.closed);
    assert.equal(f.hostRooms.list()[0].seats, 1);
    assert.equal(f.host.state(f.created.roomId, "host").snapshot.inviteCode, f.created.inviteCode);
    await f.guest.join(f.invitation, f.guestInput); await waitFor(() => guestReady(f));
    assert.equal(f.hostRooms.list()[0].seats, 2);
  } finally { peer?.close(); await f.close(); }
});

test("invalid invitation and recovery credentials are rejected before synchronous secret protection", windows, async () => {
  const f = await fixture();
  let protectionCalls = 0;
  const protect = f.hostRooms.options.protectSecret;
  f.hostRooms.options.protectSecret = (...args) => { protectionCalls++; return protect(...args); };
  const exchange = { joinAttemptId: randomUUID(), recoveryProof: randomUUID() };
  try {
    assert.throws(() => f.hostRooms.join(f.created.roomId, "untrusted-invitation", f.guestInput, exchange));
    assert.equal(protectionCalls, 0);
    assert.throws(() => f.hostRooms.rejoin(f.created.roomId, "untrusted-recovery-token", exchange));
    assert.equal(protectionCalls, 0);
    assert.equal(f.hostRooms.list()[0].seats, 1);
    assert.equal(f.host.state(f.created.roomId, "host").snapshot.inviteCode, f.created.inviteCode);
  } finally { await f.close(); }
});

test("authentication limits apply across transports before room credential work", windows, async () => {
  const f = await fixture();
  let attempts = 0;
  const roomJoin = f.hostRooms.join.bind(f.hostRooms);
  f.hostRooms.join = (...args) => { attempts++; return roomJoin(...args); };
  try {
    for (let index = 0; index < 10; index++) {
      const peer = await connectRoom({ invitation: f.invitation });
      peer.send({ type: "request", id: randomUUID(), op: "join", input: { inviteCode: "invalid", build: f.guestInput, exchange: { joinAttemptId: randomUUID(), recoveryProof: randomUUID() } } });
      await waitFor(() => peer.closed);
    }
    assert.equal(attempts, 8);
    assert.equal(f.hostRooms.list()[0].seats, 1);
    assert.equal(f.host.state(f.created.roomId, "host").snapshot.inviteCode, f.created.inviteCode);
  } finally { await f.close(); }
});

test("only a fresh epoch and transport-bound heartbeat echo extends the authority lease", windows, async () => {
  const f = await fixture();
  try {
    clearInterval(f.host.heartbeat); clearInterval(f.guest.heartbeat);
    await f.guest.join(f.invitation, f.guestInput); await waitFor(() => guestReady(f));
    const guest = f.guest.guest, client = [...f.host.hostClients.values()][0];
    const lastSeen = () => f.hostRooms.store.get(f.created.roomId).seats.find((seat) => seat.id === guest.secret.credentials.seatId).lastSeen;
    const before = lastSeen(), beforeHeartbeat = client.lastHeartbeat;
    await delay(25);
    await f.guest.rpc(guest, "snapshot");
    assert.equal(lastSeen(), before); assert.equal(client.lastHeartbeat, beforeHeartbeat);
    await assert.rejects(f.guest.rpc(guest, "command", { type: "heartbeat", commandId: randomUUID(), serverEpoch: guest.snapshot.serverEpoch }));
    assert.equal(lastSeen(), before);
    const challenge = structuredClone(f.host.challenge(client));
    for (const wrong of [{ ...challenge, serverEpoch: challenge.serverEpoch + 1 }, { ...challenge, generation: randomUUID() }, { ...challenge, nonce: "A".repeat(43) }]) {
      await f.guest.rpc(guest, "snapshot", { heartbeat: wrong });
      assert.equal(lastSeen(), before);
    }
    await f.guest.rpc(guest, "snapshot", { heartbeat: challenge });
    const accepted = lastSeen(); assert.ok(accepted > before); assert.equal(client.challenge, undefined);
    await delay(25); await f.guest.rpc(guest, "snapshot", { heartbeat: challenge });
    assert.equal(lastSeen(), accepted);

    const lastReply = guest.lastReply, nextTime = guest.snapshot.serverTime + 100;
    client.peer.send({ type: "snapshot", snapshot: { ...f.hostRooms.snapshot(f.created.roomId, client.token), serverTime: nextTime } });
    await waitFor(() => guest.snapshot.serverTime === nextTime);
    assert.equal(guest.lastReply, lastReply);
    f.host.pulse();
    await waitFor(() => lastSeen() > accepted && !client.challenge);

    // A lost host-to-player path cannot be kept online with snapshot fetches.
    client.peer.send = () => {};
    const stale = Date.now() - 31_000;
    client.lastHeartbeat = stale;
    guest.peer.send({ type: "request", id: randomUUID(), op: "snapshot" });
    await delay(30); assert.equal(client.lastHeartbeat, stale);
    f.host.pulse(); await waitFor(() => client.peer.closed);
  } finally { await f.close(); }
});

test("an active room cannot replace its published listeners", windows, async () => {
  const f = await fixture();
  try {
    await f.guest.join(f.invitation, f.guestInput); await waitFor(() => guestReady(f));
    const epoch = f.guest.guest.snapshot.serverEpoch;
    await f.guest.request(f.created.roomId, "guest", { type: "ready", ready: true, commandId: randomUUID(), serverEpoch: epoch });
    await f.host.request(f.created.roomId, "host", { type: "ready", ready: true, commandId: randomUUID(), serverEpoch: epoch });
    const started = await f.host.request(f.created.roomId, "host", { type: "start", commandId: randomUUID(), serverEpoch: epoch });
    assert.equal(started.receipt.status, "success");
    const listeners = f.host.host.hosts, peer = f.guest.guest.peer;
    await assert.rejects(f.host.publish(f.created.roomId, { address: { host: "127.0.0.1", advertisedHost: "127.0.0.1", port: await availablePort() } }), /暂停/);
    assert.equal(f.host.host.hosts, listeners); assert.equal(peer.closed, false);
    assert.equal(f.host.state(f.created.roomId, "host").snapshot.status, "active");
  } finally { await f.close(); }
});

test("one local session fences other host starts and guest joins even without published host metadata", windows, async () => {
  const f = await fixture();
  let published;
  try {
    await f.guest.join(f.invitation, f.guestInput); await waitFor(() => guestReady(f));
    const epoch = f.guest.guest.snapshot.serverEpoch;
    await f.guest.request(f.created.roomId, "guest", { type: "ready", ready: true, commandId: randomUUID(), serverEpoch: epoch });
    await f.host.request(f.created.roomId, "host", { type: "ready", ready: true, commandId: randomUUID(), serverEpoch: epoch });
    await f.host.request(f.created.roomId, "host", { type: "start", commandId: randomUUID(), serverEpoch: epoch });
    const other = f.hostRooms.create(buildHero(createDefaultHeroInput("fighter", randomUUID(), "Other Host")), "silent-bell");
    published = f.host.host; f.host.host = undefined;
    for (const type of ["start", "resume"]) await assert.rejects(f.host.request(other.roomId, "host", { type, commandId: randomUUID(), serverEpoch: 1 }), /另一场/);
    await assert.rejects(f.host.join(f.invitation, f.guestInput), /暂停/);
    await assert.rejects(f.host.publish(other.roomId, { address: {} }), /暂停/);
    f.hostDb.prepare("INSERT INTO lantern_room_clients (id,secret) VALUES (?,?)").run(f.created.roomId, protection(JSON.stringify(f.guest.guest.secret)));
    await assert.rejects(f.host.reconnect(f.created.roomId), /暂停/);
    await assert.rejects(f.guest.request(other.roomId, "host", { type: "start", commandId: randomUUID(), serverEpoch: 1 }), /退出朋友/);
    assert.equal(f.host.state(f.created.roomId, "host").snapshot.status, "active");
  } finally { if (published) f.host.host = published; await f.close(); }
});

test("publishing is exclusive with a competing publish or session switch", windows, async () => {
  const f = await fixture();
  try {
    const port = await availablePort();
    const publishing = f.host.publish(f.created.roomId, { address: { host: "127.0.0.1", advertisedHost: "127.0.0.1", port } });
    await assert.rejects(f.host.publish(f.created.roomId, {}), /请稍候/);
    await assert.rejects(f.host.join(f.invitation, f.guestInput), /请稍候/);
    await assert.rejects(f.host.reconnect(f.created.roomId), /请稍候/);
    await assert.rejects(f.host.request(f.created.roomId, "host", { type: "start", commandId: randomUUID(), serverEpoch: 1 }), /入口就绪/);
    const result = await publishing;
    assert.ok(result.invitation); assert.equal(f.host.publishing, false);
  } finally { await f.close(); }
});

test("a host service restart recovers existing seats at the same or a newly shared address without admitting new or kicked seats", { ...windows, timeout: 25_000 }, async () => {
  const f = await fixture();
  let restored, restoredRooms, restoredDb;
  const restart = async configuration => {
    if (restored) { restored.close(); restoredRooms.close(); restoredDb.close(); }
    else { f.host.close(); f.hostRooms.close(); f.hostDb.close(); }
    await delay(50);
    restoredDb = new DatabaseSync(f.hostDatabasePath);
    restoredRooms = new RoomService(restoredDb, { aiReady: () => true, protectSecret: protection, onUpdate: id => restored?.onUpdate(id) });
    restored = new RoomGateway(restoredRooms, restoredDb, f.hostDirectory);
    return restored.publish(f.created.roomId, configuration);
  };
  let rejectedPeer;
  try {
    await f.guest.join(f.invitation, f.guestInput); await waitFor(() => guestReady(f));
    const seat = f.guest.guest.secret.credentials.seatId, heroId = f.guest.guest.snapshot.seats.find(candidate => candidate.id === seat).heroId;
    const epoch = f.guest.guest.snapshot.serverEpoch;
    await f.guest.request(f.created.roomId, "guest", { type: "ready", ready: true, commandId: randomUUID(), serverEpoch: epoch });
    await f.host.request(f.created.roomId, "host", { type: "ready", ready: true, commandId: randomUUID(), serverEpoch: epoch });
    await f.host.request(f.created.roomId, "host", { type: "start", commandId: randomUUID(), serverEpoch: epoch });
    const configuration = structuredClone(f.host.host.configuration);
    const sameAddress = await restart(configuration);
    assert.equal(sameAddress.snapshot.status, "paused");
    await waitFor(() => guestReady(f) && f.guest.guest.snapshot.serverEpoch === epoch + 1);
    assert.equal(f.guest.guest.secret.credentials.seatId, seat);
    assert.equal(restoredRooms.list()[0].seats, 2);

    f.guest.leave();
    const changed = await restart({ address: { ...configuration.address, port: await availablePort() } });
    await f.guest.join(changed.invitation, createDefaultHeroInput("rogue", randomUUID(), "Must not replace the saved hero"));
    await waitFor(() => guestReady(f) && f.guest.guest.snapshot.serverEpoch === epoch + 2);
    assert.equal(f.guest.guest.secret.credentials.seatId, seat);
    assert.equal(f.guest.guest.snapshot.seats.find(candidate => candidate.id === seat).heroId, heroId);
    assert.equal(restoredRooms.list()[0].seats, 2);
    const otherIdentity = createIdentity(), saved = f.guestDb.prepare("SELECT secret FROM lantern_room_clients WHERE id=?").get(f.created.roomId).secret;
    const substitute = encodeInvitation({ ...parseInvitation(changed.invitation), hostPublicKey: otherIdentity.publicKey, hostFingerprint: otherIdentity.fingerprint });
    await assert.rejects(f.guest.join(substitute, f.guestInput), /身份/);
    assert.equal(f.guestDb.prepare("SELECT secret FROM lantern_room_clients WHERE id=?").get(f.created.roomId).secret, saved);
    assert.ok(guestReady(f));

    rejectedPeer = await connectRoom({ invitation: changed.invitation });
    rejectedPeer.send({ type: "request", id: randomUUID(), op: "join", input: { inviteCode: parseInvitation(changed.invitation).joinToken, build: f.guestInput, exchange: { joinAttemptId: randomUUID(), recoveryProof: randomUUID() } } });
    await waitFor(() => rejectedPeer.closed); assert.equal(restoredRooms.list()[0].seats, 2);
    const credentials = structuredClone(f.guest.guest.secret.credentials), exchange = structuredClone(f.guest.guest.secret.exchange);
    f.guest.leave();
    const kicked = await restored.request(f.created.roomId, "host", { type: "kick", seatId: seat, commandId: randomUUID(), serverEpoch: epoch + 2 });
    assert.equal(kicked.receipt.status, "success");
    rejectedPeer = await connectRoom({ invitation: changed.invitation });
    rejectedPeer.send({ type: "request", id: randomUUID(), op: "rejoin", input: { rejoinToken: credentials.rejoinToken, exchange } });
    await waitFor(() => rejectedPeer.closed); assert.equal(restoredRooms.list()[0].seats, 1);
  } finally {
    rejectedPeer?.close(); f.guest.leave(); restored?.close(); restoredRooms?.close();
    await delay(50); if (restoredDb?.isOpen) restoredDb.close(); await f.close();
  }
});
