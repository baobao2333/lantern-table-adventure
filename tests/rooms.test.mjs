import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { RoomService, DEFAULT_ROOM_TIMERS, elapseOperation } from '../local/rooms/index.ts';
import { buildHero, createDefaultHeroInput } from '../lib/game/character-builder.ts';

let sequence = 0;
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, options = {}, players = 2, campaign = 'silent-bell') {
  const database = new DatabaseSync(':memory:');
  let mono = 0, wall = 1_000_000;
  const clock = { monotonic: () => mono, wall: () => wall };
  const service = new RoomService(database, { aiReady: () => true, clock, ...options });
  const host = service.create(buildHero(createDefaultHeroInput('fighter', 'host-hero', 'Host')), campaign);
  const seats = [host];
  const send = (seat, type, fields = {}) => {
    const snap = service.snapshot(host.roomId, seat.seatToken);
    return service.request(host.roomId, seat.seatToken, { commandId: `command-${++sequence}`, serverEpoch: snap.serverEpoch, stateVersion: snap.stateVersion, operationId: snap.operation?.id, phaseId: snap.operation?.phaseId, type, ...fields });
  };
  for (let index = 1; index < players; index++) {
    if (index > 1) send(host, 'rotate-invite');
    const invite = service.snapshot(host.roomId, host.seatToken).inviteCode;
    const input = createDefaultHeroInput(index === 1 ? 'rogue' : 'wizard', `guest-${index}`, `Guest ${index}`);
    seats.push(service.join(host.roomId, invite, input));
  }
  const advance = (ms, online = seats) => {
    while (ms > 0) {
      const step = Math.min(ms, 5000); mono += step; wall += step; ms -= step;
      for (const seat of online) service.heartbeat(host.roomId, seat.seatToken);
      service.tick();
    }
  };
  const start = () => { for (const seat of seats) assert.equal(send(seat, 'ready', { ready: true }).status, 'success'); assert.equal(send(host, 'start').status, 'success'); };
  const seed = change => service.store.transaction(() => { const room = service.store.get(host.roomId); change(room); service.store.put(room); });
  const snapshot = seat => service.snapshot(host.roomId, (seat ?? host).seatToken);
  t.after(() => { service.close(); database.close(); });
  return { service, database, clock, host, seats, send, start, seed, snapshot, advance, rawAdvance(ms, wallMs = ms) { mono += ms; wall += wallMs; } };
}
function seedCombat(f, order = [f.host.seatId, 'enemy', f.seats[1].seatId]) {
  f.seed(room => {
    room.game.scene = 2;
    room.game.combat = { enemy: { name: 'Target', hp: 100, maxHp: 100, ac: 10, attackBonus: 0, damageDie: 6, damageBonus: 0, dex: 0 }, order: order.map(id => id === 'enemy' ? id : room.seats.find(seat => seat.id === id).heroId), turn: 0, round: 1, guard: [], next: 3 };
    room.operation = null;
  });
  assert.equal(f.send(f.host, 'pause').status, 'success');
  assert.equal(f.send(f.host, 'resume').status, 'success');
}

test('room creation, one-use invitation, canonical build and private recipient projection', t => {
  const f = fixture(t);
  assert.equal(f.snapshot().view.game.mode, 'party');
  assert.equal(f.snapshot().view.game.players[1].hero.build.profile.backstory, '');
  assert.notEqual(f.snapshot(f.seats[1]).view.game.players[1].hero.build.profile.cooperation, '');
  const encoded = JSON.stringify(f.snapshot(f.seats[1]));
  assert.ok(!encoded.includes(f.host.seatToken)); assert.ok(!encoded.includes(f.seats[1].rejoinToken)); assert.ok(!encoded.includes('tokenHash'));
  assert.throws(() => f.service.join(f.host.roomId, f.host.inviteCode, createDefaultHeroInput('rogue')), /邀请/);
  assert.throws(() => f.service.snapshot(f.host.roomId, 'forged-token'), /凭证/);
  assert.throws(() => f.service.snapshot(f.host.roomId), /席位/);
  f.start(); assert.equal(f.snapshot().status, 'active');
  assert.equal(f.send(f.seats[1], 'build', { build: createDefaultHeroInput('wizard') }).status, 'rejected');
});

test('a forged hero numerical field never enters the joined canonical character', t => {
  const f = fixture(t); f.send(f.host, 'rotate-invite');
  const input = { ...createDefaultHeroInput('rogue'), hp: 999, ac: 999, spellSlots: 99 };
  const joined = f.service.join(f.host.roomId, f.snapshot().inviteCode, input);
  const hero = f.service.snapshot(f.host.roomId, joined.seatToken).view.game.players.at(-1).hero;
  assert.equal(hero.maxHp, 10); assert.notEqual(hero.ac, 999); assert.equal(hero.spellSlots, 0);
});

test('only approved timer ranges are configurable and a rejected mixed update is atomic', t => {
  const f = fixture(t);
  const original = f.snapshot().timers;
  for (const timers of [{ operationMs: 29_999 }, { operationMs: 180_001 }, { confirmMs: 9999 }, { confirmMs: 60_001 }, { voteMs: 14_999 }, { voteMs: 90_001 }, { aiMs: 14_999 }, { aiMs: 60_001 }, { offlineMs: 60_000 }, { narrationMs: 30_000 }, { operationMs: 60_000, aiMs: 70_000 }]) assert.equal(f.send(f.host, 'rules', { timers }).status, 'rejected');
  assert.deepEqual(f.snapshot().timers, original);
  assert.equal(f.send(f.host, 'rules', { timers: { operationMs: 30_000, confirmMs: 60_000, voteMs: 90_000, aiMs: 60_000 } }).status, 'success');
  assert.equal(f.snapshot().timers.offlineMs, 30_000);
});

test('ready state does not allow an offline seat to start an adventure', t => {
  const f = fixture(t); for (const seat of f.seats) f.send(seat, 'ready', { ready: true }); f.advance(35_000, [f.host]);
  assert.equal(f.send(f.host, 'start').status, 'rejected'); assert.equal(f.snapshot().status, 'lobby');
  f.service.heartbeat(f.host.roomId, f.seats[1].seatToken); assert.equal(f.send(f.host, 'start').status, 'success');
});

test('FIFO claim, one slot per seat, fresh phase and zero-time cancellation', t => {
  const f = fixture(t, {}, 3); f.start();
  f.send(f.host, 'claim'); f.send(f.seats[1], 'claim'); f.send(f.seats[1], 'claim'); f.send(f.seats[2], 'claim');
  assert.deepEqual(f.snapshot().queue, [f.seats[1].seatId, f.seats[2].seatId]);
  f.send(f.host, 'command', { command: { kind: 'action', actionId: 'read-letter' } });
  assert.equal(f.snapshot().operation.phase, 'confirm');
  const before = f.snapshot().view.game;
  f.send(f.host, 'command', { command: { kind: 'cancel' } });
  assert.equal(f.snapshot().currentSeatId, f.seats[1].seatId);
  assert.equal(f.snapshot().view.game.elapsedMinutes, before.elapsedMinutes);
  assert.equal(f.snapshot().view.game.turns, before.turns);
});

test('persisted receipt wins before old phase, epoch and deadline checks; conflicting content is rejected', t => {
  let rolls = 0; const f = fixture(t, { die: () => { rolls++; return 10; } }); f.start(); f.send(f.host, 'claim');
  f.send(f.host, 'command', { command: { kind: 'action', actionId: 'read-letter' } });
  const snap = f.snapshot(), payload = { commandId: 'durable-roll', serverEpoch: snap.serverEpoch, stateVersion: snap.stateVersion, operationId: snap.operation.id, phaseId: snap.operation.phaseId, type: 'command', command: { kind: 'roll' } };
  const first = f.service.request(f.host.roomId, f.host.seatToken, payload); assert.equal(first.status, 'success');
  f.advance(100_000);
  assert.deepEqual(f.service.request(f.host.roomId, f.host.seatToken, payload), first); assert.equal(rolls, 1);
  assert.throws(() => f.service.request(f.host.roomId, f.host.seatToken, { ...payload, command: { kind: 'dodge' } }), /commandId/);
});

test('wire JSON normalization does not change a command digest after an undefined optional field', t => {
  const f = fixture(t);
  const payload = { commandId: 'wire-json', serverEpoch: 1, type: 'chat', text: 'Same request', phaseId: undefined, operationId: undefined };
  const first = f.service.request(f.host.roomId, f.host.seatToken, payload);
  assert.deepEqual(f.service.request(f.host.roomId, f.host.seatToken, JSON.parse(JSON.stringify(payload))), first);
});

test('late unaccepted confirm is rejected and repeated timeout ticks execute no rolls or story time', t => {
  const f = fixture(t, { die: () => { throw new Error('Must not roll'); } }); f.start(); f.send(f.host, 'claim');
  f.send(f.host, 'command', { command: { kind: 'action', actionId: 'read-letter' } });
  const snap = f.snapshot(), game = snap.view.game;
  f.advance(30_000);
  const late = f.service.request(f.host.roomId, f.host.seatToken, { commandId: 'late', serverEpoch: snap.serverEpoch, stateVersion: snap.stateVersion, operationId: snap.operation.id, phaseId: snap.operation.phaseId, type: 'command', command: { kind: 'roll' } });
  assert.equal(late.status, 'rejected'); assert.equal(f.snapshot().view.game.turns, game.turns); assert.equal(f.snapshot().view.game.elapsedMinutes, game.elapsedMinutes);
  const count = f.database.prepare("SELECT COUNT(*) AS n FROM room_receipts WHERE seat_id='$system'").get().n;
  f.service.tick(); f.service.tick(); assert.equal(f.database.prepare("SELECT COUNT(*) AS n FROM room_receipts WHERE seat_id='$system'").get().n, count);
});

test('transaction failure cannot persist state, dice receipt or an orphan event', t => {
  const f = fixture(t); f.start(); f.send(f.host, 'claim');
  const before = f.snapshot();
  f.database.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON room_receipts WHEN NEW.command_id='atomic-failure' BEGIN SELECT RAISE(ABORT,'fixture transaction failure'); END;");
  assert.throws(() => f.send(f.host, 'command', { commandId: 'atomic-failure', command: { kind: 'action', actionId: 'ask-eve' } }), /transaction failure/);
  const after = f.snapshot(); assert.equal(after.stateVersion, before.stateVersion); assert.equal(after.eventSeq, before.eventSeq); assert.deepEqual(after.view.game, before.view.game);
});

test('team majority is frozen across a revoked seat and already cast ballots survive pause', t => {
  const f = fixture(t, {}, 4); f.start(); f.send(f.host, 'claim');
  f.send(f.host, 'command', { command: { kind: 'action', actionId: 'leave-inn' } });
  assert.equal(f.snapshot().vote.eligible.length, 4);
  f.send(f.host, 'kick', { seatId: f.seats[3].seatId });
  f.send(f.seats[1], 'vote', { yes: true }); assert.equal(f.snapshot().view.game.scene, 0);
  const operationId = f.snapshot().operation.id, phase = f.snapshot().operation.phaseId;
  f.send(f.host, 'pause'); f.send(f.host, 'resume');
  assert.equal(f.snapshot().operation.id, operationId); assert.notEqual(f.snapshot().operation.phaseId, phase); assert.equal(f.snapshot().vote.eligible.length, 4);
  f.send(f.seats[2], 'vote', { yes: true }); assert.equal(f.snapshot().view.game.scene, 1); assert.equal(f.snapshot().vote, null);
});

test('short rest commits only individual authorizations once with one shared hour', t => {
  const f = fixture(t, { die: () => 4 }); f.start();
  f.seed(room => { room.game.players[0].hero.hp = 0; room.game.players[1].hero.hp = 2; });
  f.send(f.seats[1], 'claim'); f.send(f.seats[1], 'command', { command: { kind: 'rest' } }); f.send(f.host, 'vote', { yes: true });
  const first = f.send(f.host, 'rest-choice', { choice: { hitDie: true } });
  assert.match(first.fact, /尚未消耗/); assert.equal(f.snapshot().view.game.players[0].hero.hitDice, 1); assert.equal(f.snapshot().view.game.players[0].hero.hp, 0);
  const final = f.send(f.seats[1], 'rest-choice', { choice: {} }); assert.equal(final.status, 'success');
  const game = f.snapshot().view.game; assert.equal(game.elapsedMinutes, 60); assert.equal(game.players[0].hero.hitDice, 0); assert.equal(game.players[0].hero.hp, 6); assert.equal(game.players[1].hero.hitDice, 1); assert.equal(game.players[1].hero.hp, 2);
  assert.equal(f.send(f.seats[1], 'rest-choice', { choice: { hitDie: true } }).status, 'rejected'); assert.equal(f.snapshot().view.game.elapsedMinutes, 60);
});

test('approved short rest deadline applies missing personal choices as zero consumption', t => {
  const f = fixture(t, { die: () => { throw new Error('Missing choices must not roll'); } }); f.start(); f.send(f.host, 'claim');
  f.send(f.host, 'command', { command: { kind: 'rest' } }); f.send(f.seats[1], 'vote', { yes: true }); f.advance(45_000);
  const game = f.snapshot().view.game; assert.equal(game.elapsedMinutes, 60); assert.deepEqual(game.players.map(p => p.hero.hitDice), [1, 1]); assert.equal(f.snapshot().vote, null);
});

test('combat bonus actions and vote windows retain the same whole-turn operation budget', t => {
  const f = fixture(t, { die: () => 3 }); f.start(); seedCombat(f);
  f.seed(room => { room.game.players[0].hero.hp = 5; });
  const id = f.snapshot().operation.id; f.advance(20_000); f.send(f.host, 'command', { command: { kind: 'wind' } });
  assert.equal(f.snapshot().operation.id, id); assert.equal(f.snapshot().operation.remainingMs, 70_000);
  f.send(f.host, 'command', { command: { kind: 'retreat' } }); f.advance(45_000);
  assert.equal(f.snapshot().operation.id, id); assert.equal(f.snapshot().operation.phase, 'action'); assert.equal(f.snapshot().operation.remainingMs, 25_000);
});

test('all living heroes timeout pauses before enemy settlement and resume authorizes one held response', t => {
  let rolls = 0; const f = fixture(t, { die: () => { rolls++; return 2; } }); f.start(); seedCombat(f, [f.host.seatId, f.seats[1].seatId, 'enemy']);
  f.advance(90_000); assert.equal(f.snapshot().currentSeatId, f.seats[1].seatId);
  f.advance(90_000); assert.equal(f.snapshot().status, 'paused'); assert.equal(rolls, 0);
  const timed = f.service.store.get(f.host.roomId).timeoutHeroIds; assert.equal(timed.length, 2);
  f.send(f.host, 'resume'); assert.equal(f.snapshot().status, 'active'); assert.equal(rolls, 2); assert.deepEqual(f.service.store.get(f.host.roomId).timeoutHeroIds, timed);
  f.advance(90_000); assert.equal(f.snapshot().status, 'paused'); assert.equal(rolls, 2);
});

test('manual successful combat action resets AFK membership, invalid action and chat do not', t => {
  const f = fixture(t, { die: () => 2 }); f.start(); seedCombat(f, [f.host.seatId, f.seats[1].seatId, 'enemy']);
  f.advance(90_000); const room = () => f.service.store.get(f.host.roomId);
  assert.equal(room().timeoutHeroIds.length, 1);
  f.send(f.seats[1], 'chat', { text: 'Still here' }); assert.equal(room().timeoutHeroIds.length, 1);
  f.send(f.seats[1], 'command', { command: { kind: 'spell', actionId: 'magic-missile' } }); assert.equal(room().timeoutHeroIds.length, 1);
  f.send(f.seats[1], 'command', { command: { kind: 'dodge' } }); assert.deepEqual(room().timeoutHeroIds, []); assert.equal(f.snapshot().status, 'active');
});

test('all nonhost seats offline pauses even while host heartbeats, reconnect does not auto resume', t => {
  const f = fixture(t); f.start(); f.send(f.host, 'claim'); f.advance(30_000, [f.host]);
  assert.equal(f.snapshot().status, 'paused'); f.service.heartbeat(f.host.roomId, f.seats[1].seatToken); assert.equal(f.snapshot().status, 'paused');
  f.send(f.host, 'resume'); assert.equal(f.snapshot().status, 'active');
});

test('one offline guest does not pause a room with another live guest', t => {
  const f = fixture(t, {}, 3); f.start(); f.send(f.host, 'claim'); f.advance(35_000, [f.host, f.seats[2]]);
  assert.equal(f.snapshot().status, 'active'); assert.equal(f.snapshot().seats[1].online, false);
});

test('server restart increments epoch, pauses and keeps both phase budget and original receipts', t => {
  const f = fixture(t); f.start(); f.send(f.host, 'claim'); f.advance(12_000);
  const snap = f.snapshot(), payload = { commandId: 'pre-crash', serverEpoch: snap.serverEpoch, type: 'chat', text: 'Checkpoint' };
  const receipt = f.service.request(f.host.roomId, f.host.seatToken, payload); f.service.close();
  const next = new RoomService(f.database, { aiReady: () => true }); t.after(() => next.close());
  const hostToken = next.hostSeatToken(f.host.roomId), restored = next.snapshot(f.host.roomId, hostToken);
  assert.equal(restored.serverEpoch, snap.serverEpoch + 1); assert.equal(restored.status, 'paused'); assert.equal(restored.operation.id, snap.operation.id); assert.notEqual(restored.operation.phaseId, snap.operation.phaseId); assert.equal(restored.operation.remainingMs, 78_000);
  assert.deepEqual(next.request(f.host.roomId, hostToken, payload), receipt);
  assert.equal(next.request(f.host.roomId, hostToken, { ...payload, commandId: 'old-epoch' }).status, 'rejected');
});

test('join/rejoin lost replies are recovered by original proof, without plaintext secrets in SQLite', t => {
  const protectSecret = (value, decrypt = false) => decrypt ? Buffer.from(value.slice(7), 'base64').toString() : `sealed:${Buffer.from(value).toString('base64')}`;
  const f = fixture(t, { protectSecret }); f.send(f.host, 'rotate-invite'); const invite = f.snapshot().inviteCode;
  const input = createDefaultHeroInput('wizard'), exchange = { joinAttemptId: 'join-attempt', recoveryProof: 'proof1' };
  const joined = f.service.join(f.host.roomId, invite, input, exchange), repeated = f.service.join(f.host.roomId, invite, input, exchange);
  assert.equal(repeated.seatToken, joined.seatToken); assert.equal(repeated.seatId, joined.seatId);
  assert.throws(() => f.service.join(f.host.roomId, invite, input, { ...exchange, recoveryProof: 'wrong' }), /身份/);
  const recovery = { joinAttemptId: 'rejoin-attempt', recoveryProof: 'proof2' };
  const recovered = f.service.rejoin(f.host.roomId, joined.rejoinToken, recovery), again = f.service.rejoin(f.host.roomId, joined.rejoinToken, recovery);
  assert.equal(again.seatToken, recovered.seatToken); assert.equal(again.seatId, joined.seatId); assert.throws(() => f.service.snapshot(f.host.roomId, joined.seatToken), /凭证/);
  assert.throws(() => f.service.join(f.host.roomId, invite, input, exchange), /过期/);
  const stored = JSON.stringify(f.database.prepare('SELECT * FROM room_states').all()); assert.ok(!stored.includes(recovered.seatToken)); assert.ok(!stored.includes(recovered.rejoinToken));
});

test('invalid join and recovery credentials reject before character construction or expensive protection', t => {
  let calls = 0; const protectSecret = () => { calls++; throw new Error('Protection must not run'); };
  const f = fixture(t, { protectSecret });
  assert.throws(() => f.service.join(f.host.roomId, 'bad-invite', { classId: 'not-a-class' }, { joinAttemptId: 'bad-join', recoveryProof: 'proof' }), /邀请/);
  assert.throws(() => f.service.rejoin(f.host.roomId, 'bad-recovery', { joinAttemptId: 'bad-rejoin', recoveryProof: 'proof' }), /恢复凭证/);
  assert.equal(calls, 0);
});

test('AI cumulative budget includes queue time while player timer is frozen and a question never rolls', async t => {
  let release; const f = fixture(t, { interpret: () => new Promise(resolve => { release = resolve; }) }); f.start(); f.send(f.host, 'claim'); f.advance(10_000);
  const id = f.snapshot().operation.id, receipt = f.send(f.host, 'talk', { text: 'What do we see?' }); assert.equal(receipt.status, 'processing'); await flush();
  f.advance(20_000); assert.equal(f.snapshot().operation.remainingMs, 80_000); assert.equal(f.snapshot().operation.aiUsedMs, 20_000);
  release({ kind: 'question', response: '眼前只有已经公开的旅店与信件。' }); await flush(); await flush();
  assert.equal(f.snapshot().operation.id, id); assert.equal(f.snapshot().operation.remainingMs, 80_000); assert.equal(f.snapshot().operation.phase, 'action');
  assert.equal(f.service.store.receipt(f.host.roomId, f.host.seatId, receipt.commandId).receipt.status, 'success'); assert.equal(f.snapshot().view.game.elapsedMinutes ?? 0, 0);
});

test('AI callbacks receive the canonical acting user ID rather than a transport seat identifier', async t => {
  const actors = [];
  const f = fixture(t, {
    interpret: async (game, actorUserId) => { actors.push(['interpret', actorUserId, game.players.find(player => player.userId === actorUserId)?.hero.name]); return { kind: 'question', response: '请先观察可见线索。' }; },
    narrate: async (game, _fact, actorUserId) => { actors.push(['narrate', actorUserId, game.players.find(player => player.userId === actorUserId)?.hero.name]); return '灯火微微晃动，眼前的线索仍然清楚。'; },
  });
  f.seed(room => { room.seats[1].userId = 'canonical-guest-user'; room.game.players[1].userId = 'canonical-guest-user'; });
  f.start(); f.send(f.seats[1], 'claim'); f.send(f.seats[1], 'talk', { text: 'Who is present?' }); await flush(); await flush();
  f.send(f.seats[1], 'command', { command: { kind: 'action', actionId: 'ask-eve' } }); await flush(); await flush();
  assert.deepEqual(actors, [['interpret', 'canonical-guest-user', 'Guest 1'], ['narrate', 'canonical-guest-user', 'Guest 1']]);
});

test('late AI result after pause is fenced, processing receipt becomes interrupted', async t => {
  let release, signal; const f = fixture(t, { interpret: (_game, _actor, _text, abort) => { signal = abort; return new Promise(resolve => { release = resolve; }); } }); f.start(); f.send(f.host, 'claim');
  const receipt = f.send(f.host, 'talk', { text: 'Read the letter' }); await flush(); f.send(f.host, 'pause'); assert.equal(signal.aborted, true);
  release({ kind: 'action', actionId: 'read-letter', response: '先确认如何阅读。' }); await flush(); await flush();
  assert.equal(f.snapshot().view.game.pending, null); assert.equal(f.snapshot().operation.proposedCommand, undefined);
  assert.equal(f.service.store.receipt(f.host.roomId, f.host.seatId, receipt.commandId).receipt.status, 'interrupted');
});

test('AI timeout preserves used allowance and gives no fresh 45-second budget', async t => {
  const f = fixture(t, { interpret: (_game, _actor, _text, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))) }); f.start(); f.send(f.host, 'claim');
  f.send(f.host, 'talk', { text: 'Look closely' }); await flush(); f.advance(45_000); await flush();
  assert.equal(f.snapshot().operation.phase, 'action'); assert.equal(f.snapshot().operation.aiUsedMs, 45_000); assert.equal(f.snapshot().operation.remainingMs, 90_000);
  assert.equal(f.send(f.host, 'talk', { text: 'Try again' }).status, 'rejected');
});

test('queued AI intent expires before inference and never receives a fresh queue budget', async t => {
  let calls = 0;
  const f = fixture(t, { interpret: (_game, _actor, _text, signal) => { calls++; return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))); } });
  f.start(); f.send(f.host, 'claim'); f.send(f.host, 'talk', { text: 'First room action' }); await flush();
  const host2 = f.service.create(buildHero(createDefaultHeroInput('fighter', 'host2', 'Other host')), 'silent-bell');
  const guest2 = f.service.join(host2.roomId, host2.inviteCode, createDefaultHeroInput('rogue'));
  const request2 = (seat, type, fields = {}) => { const snap = f.service.snapshot(host2.roomId, seat.seatToken); return f.service.request(host2.roomId, seat.seatToken, { commandId: `queue-${++sequence}`, serverEpoch: snap.serverEpoch, stateVersion: snap.stateVersion, operationId: snap.operation?.id, phaseId: snap.operation?.phaseId, type, ...fields }); };
  request2(host2, 'ready', { ready: true }); request2(guest2, 'ready', { ready: true }); request2(host2, 'start'); request2(host2, 'claim');
  const queued = request2(host2, 'talk', { text: 'Queued second room action' }); assert.equal(queued.status, 'processing');
  for (let index = 0; index < 9; index++) { f.rawAdvance(5000); for (const seat of f.seats) f.service.heartbeat(f.host.roomId, seat.seatToken); for (const seat of [host2, guest2]) f.service.heartbeat(host2.roomId, seat.seatToken); f.service.tick(); }
  await flush(); await flush();
  assert.equal(calls, 1); assert.equal(f.service.snapshot(host2.roomId, host2.seatToken).operation.aiUsedMs, 45_000);
  assert.equal(f.service.store.receipt(host2.roomId, host2.seatId, queued.commandId).receipt.status, 'interrupted');
});

test('a provider ignoring abort cannot hold the global AI slot after an interrupted intent', async t => {
  let calls = 0; const f = fixture(t, { interpret: async () => { calls++; if (calls === 1) return new Promise(() => {}); return { kind: 'question', response: '现在轮到新的裁定。' }; } });
  f.start(); f.send(f.host, 'claim'); f.send(f.host, 'talk', { text: 'First' }); await flush(); f.send(f.host, 'pause'); f.send(f.host, 'resume');
  f.send(f.host, 'talk', { text: 'Second' }); await flush(); await flush();
  assert.equal(calls, 2); assert.equal(f.snapshot().operation.phase, 'action');
});

test('restart interrupts pending AI and never automatically reissues a paid request', async t => {
  let calls = 0; const f = fixture(t, { interpret: () => { calls++; return new Promise(() => {}); } }); f.start(); f.send(f.host, 'claim');
  const receipt = f.send(f.host, 'talk', { text: 'Pending during crash' }); await flush(); f.advance(10_000); f.service.close();
  const next = new RoomService(f.database, { clock: f.clock, aiReady: () => true, interpret: async () => { calls++; return { kind: 'question', response: 'Unexpected' }; } }); t.after(() => next.close());
  const hostToken = next.hostSeatToken(f.host.roomId), snap = next.snapshot(f.host.roomId, hostToken);
  assert.equal(snap.status, 'paused'); assert.equal(snap.operation.aiUsedMs, 10_000); assert.equal(snap.operation.remainingMs, 90_000);
  assert.equal(next.store.receipt(f.host.roomId, f.host.seatId, receipt.commandId).receipt.status, 'interrupted'); assert.equal(calls, 1);
});

test('partially authorized rest survives restart under a new phase and settles each resource once', t => {
  const f = fixture(t, { die: () => 4 }); f.start(); f.seed(room => { room.game.players[0].hero.hp = 2; }); f.send(f.host, 'claim');
  f.send(f.host, 'command', { command: { kind: 'rest' } }); f.send(f.seats[1], 'vote', { yes: true }); f.send(f.host, 'rest-choice', { choice: { hitDie: true } }); f.advance(10_000);
  const prior = f.snapshot(); f.service.close(); const next = new RoomService(f.database, { clock: f.clock, aiReady: () => true, die: () => 4 }); t.after(() => next.close());
  const hostToken = next.hostSeatToken(f.host.roomId); next.heartbeat(f.host.roomId, f.seats[1].seatToken);
  next.request(f.host.roomId, hostToken, { commandId: 'resume-rest', serverEpoch: prior.serverEpoch + 1, type: 'resume' });
  const snap = next.snapshot(f.host.roomId, f.seats[1].seatToken); assert.equal(snap.vote.restChoices[f.host.seatId].hitDie, true); assert.equal(snap.operation.phaseRemainingMs, 35_000);
  assert.equal(next.request(f.host.roomId, f.seats[1].seatToken, { commandId: 'old-choice', serverEpoch: snap.serverEpoch, stateVersion: snap.stateVersion, operationId: prior.operation.id, phaseId: prior.operation.phaseId, type: 'rest-choice', choice: {} }).status, 'rejected');
  const result = next.request(f.host.roomId, f.seats[1].seatToken, { commandId: 'final-choice', serverEpoch: snap.serverEpoch, stateVersion: snap.stateVersion, operationId: snap.operation.id, phaseId: snap.operation.phaseId, type: 'rest-choice', choice: {} });
  assert.equal(result.status, 'success'); const game = next.snapshot(f.host.roomId, hostToken).view.game; assert.equal(game.elapsedMinutes, 60); assert.equal(game.players[0].hero.hitDice, 0); assert.equal(game.players[0].hero.hp, 8);
});

test('a downed earlier timeout does not count an unacted living teammate as AFK', t => {
  const f = fixture(t, { die: sides => sides }); f.start(); seedCombat(f);
  f.seed(room => { room.game.players[0].hero.hp = 1; room.game.combat.enemy.attackBonus = 20; });
  f.advance(90_000);
  const game = f.snapshot().view.game; assert.equal(game.players[0].hero.hp, 0); assert.ok(game.players[1].hero.hp > 0); assert.equal(f.snapshot().currentSeatId, f.seats[1].seatId); assert.equal(f.snapshot().status, 'active');
  assert.deepEqual(f.service.store.get(f.host.roomId).timeoutHeroIds, [game.players[0].hero.id]);
});

test('room AI utility proposal is staged, then one confirmation checks and casts once', async t => {
  let checks = 0;
  const f = fixture(t, { die: () => { checks++; return 20; }, interpret: async () => ({ kind: 'proposal', response: '先说明怎样借助法师护甲准备，再确认行动。', idea: { title: 'Study song', approach: 'Read the visible text', skill: 'investigation', goalId: 'hear-old-song', spellId: 'mage-armor', success: 'Bounded progress', failure: 'Bounded delay' } }) }, 2, 'moonbridge-conspiracy');
  const input = createDefaultHeroInput('wizard', 'ignored', 'Host wizard'); input.spellbook = ['magic-missile', 'mage-armor', 'burning-hands', 'disguise-self', 'comprehend-languages', 'detect-magic']; input.preparedSpells = ['mage-armor', 'disguise-self', 'comprehend-languages', 'detect-magic'];
  f.send(f.host, 'build', { build: input }); f.start(); f.send(f.host, 'claim'); const pending = f.send(f.host, 'talk', { text: 'Study the song with my prepared mage armor' }); await flush(); await flush();
  assert.equal(f.snapshot().operation.phase, 'confirm'); assert.equal(f.snapshot().view.game.players[0].hero.spellSlots, 2); assert.equal(checks, 0);
  const result = f.send(f.host, 'command', { command: { kind: 'confirm' } }); assert.equal(result.status, 'success');
  assert.equal(f.snapshot().view.game.players[0].hero.spellSlots, 1); assert.equal(checks, 1); assert.equal(f.snapshot().view.game.elapsedMinutes, 10.1); assert.ok(f.snapshot().view.game.clues.includes('old-vow'));
  assert.equal(f.service.store.receipt(f.host.roomId, f.host.seatId, pending.commandId).receipt.status, 'success');
});

test('a two-seat world campaign completes through real claims, travel votes, goal checks and a final vote', t => {
  const f = fixture(t, { die: () => 20 }, 2, 'moonbridge-conspiracy'); f.start(); f.send(f.host, 'claim');
  const configuration = f.service.store.get(f.host.roomId).game.campaignSnapshot.world;
  const execute = command => {
    const result = f.send(f.host, 'command', { command }); assert.equal(result.status, 'success', result.error);
    if (f.snapshot().vote) { const vote = f.send(f.seats[1], 'vote', { yes: true }); assert.equal(vote.status, 'success', vote.error); }
  };
  const travel = target => {
    const from = configuration.locations[f.snapshot().view.game.scene].id, queue = [[from]], seen = new Set([from]); let route;
    while (queue.length) { const path = queue.shift(), here = path.at(-1); if (here === target) { route = path; break; } for (const next of configuration.locations.find(location => location.id === here).exits) if (!seen.has(next)) { seen.add(next); queue.push([...path, next]); } }
    assert.ok(route, `No route to ${target}`); for (const location of route.slice(1)) execute({ kind: 'action', actionId: `travel:${location}` });
  };
  for (const id of ['hear-old-song', 'trace-market-cargo', 'isolate-siphon-valve', 'improvise-ferry-crossing', 'decode-old-calibration', 'repair-at-observatory']) {
    travel(configuration.opportunities.find(goal => goal.id === id).location); execute({ kind: 'action', actionId: `goal:${id}` }); execute({ kind: 'confirm' }); assert.equal(f.snapshot().status, 'active');
  }
  travel('council'); const ending = configuration.opportunities.find(goal => goal.success.ending === 'shared-repair'); execute({ kind: 'action', actionId: `goal:${ending.id}` }); execute({ kind: 'confirm' });
  assert.equal(f.snapshot().status, 'complete'); assert.equal(f.snapshot().view.game.ending, 'shared-repair'); assert.equal(f.snapshot().operation, null); assert.equal(f.snapshot().vote, null);
});

test('downed party member cannot act and receives an actor-owned potion before their next normal turn', t => {
  const f = fixture(t, { die: () => 2 }); f.start(); seedCombat(f, [f.host.seatId, f.seats[1].seatId, 'enemy']);
  f.seed(room => { room.game.players[0].hero.potions = 1; room.game.players[1].hero.hp = 0; room.game.players[1].hero.potions = 0; });
  assert.equal(f.send(f.seats[1], 'command', { command: { kind: 'attack' } }).status, 'rejected');
  const before = f.snapshot().view.game.players[0].hero.potions;
  const healed = f.send(f.host, 'command', { command: { kind: 'potion', targetHeroId: f.snapshot().view.game.players[1].hero.id } }); assert.equal(healed.status, 'success', healed.error);
  assert.equal(f.snapshot().view.game.players[0].hero.potions, before - 1); assert.equal(f.snapshot().view.game.players[1].hero.hp, 6); assert.equal(f.snapshot().view.game.players[1].hero.potions, 0); assert.equal(f.snapshot().currentSeatId, f.seats[1].seatId);
});

test('intent preempts background narration and narration never modifies the rule version', async t => {
  let narrationSignal, resolveNarration; const f = fixture(t, {
    narrate: (_game, _fact, _actor, signal) => { narrationSignal = signal; return new Promise(resolve => { resolveNarration = resolve; }); },
    interpret: async () => ({ kind: 'question', response: '你可以先观察旅店。' }),
  }); f.start(); f.send(f.host, 'claim'); f.send(f.seats[1], 'claim');
  f.send(f.host, 'command', { command: { kind: 'action', actionId: 'ask-eve' } }); await flush();
  assert.equal(f.snapshot().currentSeatId, f.seats[1].seatId);
  const version = f.snapshot().stateVersion; f.send(f.seats[1], 'talk', { text: 'What is here?' }); await flush(); await flush();
  assert.equal(narrationSignal.aborted, true); resolveNarration('Old sensory details'); await flush();
  assert.equal(f.snapshot().stateVersion, version); assert.ok(!f.snapshot().events.some(event => event.fact === 'Old sensory details'));
});

test('event retention gap requires snapshot without deleting permanent receipts', t => {
  const f = fixture(t);
  for (let index = 0; index < 505; index++) f.send(f.host, 'chat', { text: `Chat ${index}` });
  const events = f.service.eventsSince(f.host.roomId, f.host.seatToken, 0);
  assert.equal(events.resyncRequired, true); assert.equal(events.events.length, 1000);
  assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM room_receipts').get().n, 505);
});

test('wall clock jump or long host sleep pauses with bounded saved player budget', t => {
  const f = fixture(t); f.start(); f.send(f.host, 'claim'); f.rawAdvance(1000, 100_000); f.service.tick();
  assert.equal(f.snapshot().status, 'paused'); assert.equal(f.snapshot().operation.remainingMs, 90_000);
});

for (const [name, monoGap, wallGap] of [['long monotonic sleep', 60_000, 60_000], ['wall clock jump', 1000, 100_000]]) {
  test(`${name} preserves a five-second combat checkpoint and resume cannot default the turn`, t => {
    let rolls = 0;
    const f = fixture(t, { die: () => { rolls++; return 4; } }); f.start(); seedCombat(f);
    f.advance(85_000);
    const checkpoint = f.snapshot(), timeoutCount = () => f.database.prepare("SELECT COUNT(*) AS n FROM room_receipts WHERE seat_id='$system'").get().n;
    assert.equal(checkpoint.operation.remainingMs, 5000);
    const priorTimeouts = timeoutCount();
    f.rawAdvance(monoGap, wallGap); f.service.tick();
    const paused = f.snapshot();
    assert.equal(paused.status, 'paused');
    assert.match(paused.pauseReason, /系统时间跳变|主机休眠/);
    assert.equal(paused.operation.remainingMs, 5000);
    assert.equal(paused.operation.phaseRemainingMs, 5000);
    assert.deepEqual(paused.view.game, checkpoint.view.game);
    for (const seat of f.seats) f.service.heartbeat(f.host.roomId, seat.seatToken);
    assert.equal(f.send(f.host, 'resume').status, 'success');
    f.service.tick();
    const resumed = f.snapshot();
    assert.equal(resumed.status, 'active');
    assert.equal(resumed.operation.id, checkpoint.operation.id);
    assert.notEqual(resumed.operation.phaseId, checkpoint.operation.phaseId);
    assert.equal(resumed.operation.remainingMs, 5000);
    assert.equal(resumed.currentSeatId, f.host.seatId);
    assert.deepEqual(resumed.view.game, checkpoint.view.game);
    assert.equal(timeoutCount(), priorTimeouts); assert.equal(rolls, 0);
    f.advance(4000);
    assert.equal(f.snapshot().operation.remainingMs, 1000); assert.equal(timeoutCount(), priorTimeouts);
    f.advance(1000);
    assert.equal(timeoutCount(), priorTimeouts + 1);
    assert.ok(f.service.store.get(f.host.roomId).timeoutHeroIds.includes(checkpoint.view.game.players[0].hero.id));
  });
}

test('sleep preserves a pending confirmation window and continuation permits its original roll', t => {
  let rolls = 0;
  const f = fixture(t, { die: () => { rolls++; return 10; } }); f.start(); f.send(f.host, 'claim');
  f.send(f.host, 'command', { command: { kind: 'action', actionId: 'read-letter' } }); f.advance(25_000);
  const checkpoint = f.snapshot();
  assert.equal(checkpoint.operation.remainingMs, 65_000); assert.equal(checkpoint.operation.phaseRemainingMs, 5000);
  f.rawAdvance(60_000); f.service.tick();
  const paused = f.snapshot();
  assert.equal(paused.status, 'paused');
  assert.equal(paused.operation.remainingMs, checkpoint.operation.remainingMs);
  assert.equal(paused.operation.phaseRemainingMs, checkpoint.operation.phaseRemainingMs);
  assert.deepEqual(paused.view.game.pending, checkpoint.view.game.pending);
  for (const seat of f.seats) f.service.heartbeat(f.host.roomId, seat.seatToken);
  assert.equal(f.send(f.host, 'resume').status, 'success'); f.service.tick();
  assert.equal(f.snapshot().operation.phase, 'confirm'); assert.equal(f.snapshot().operation.phaseRemainingMs, 5000);
  assert.equal(f.send(f.host, 'command', { command: { kind: 'roll' } }).status, 'success'); assert.equal(rolls, 1);
});

test('pure clock keeps confirm under parent budget and accumulates AI separately', () => {
  const op = { id: 'op', phaseId: 'phase', seatId: 'seat', kind: 'combat', phase: 'confirm', remainingMs: 10_000, phaseRemainingMs: 30_000, aiUsedMs: 0 };
  const next = elapseOperation(op, 1000, DEFAULT_ROOM_TIMERS); assert.equal(next.phaseRemainingMs, 9000); assert.equal(op.remainingMs, 10_000);
  const ai = elapseOperation({ ...next, phase: 'ai' }, 12_000, DEFAULT_ROOM_TIMERS); assert.equal(ai.remainingMs, 9000); assert.equal(ai.aiUsedMs, 12_000);
});
