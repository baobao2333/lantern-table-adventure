import test from 'node:test';
import assert from 'node:assert/strict';
import { createHero } from '../lib/game/characters.ts';
import { buildHero, createDefaultHeroInput } from '../lib/game/character-builder.ts';
import {
  createGame, currentPlayer, resolve, resolveDefaultCombatTurn,
  resolvePartyShortRest, settleEnemyTurn,
} from '../lib/game/engine.ts';
import { stageIdea } from '../lib/game/world-engine.ts';

function dice(...values) {
  return sides => { const value = values.shift(); assert.ok(value >= 1 && value <= sides, `Missing/out-of-range d${sides}: ${value}`); return value; };
}
const noDice = () => { throw new Error('This operation must not roll'); };
function party(campaignId = 'silent-bell') {
  const state = createGame('game', 'owner', createHero('owner-hero', 'fighter', 'Host'), campaignId, 'party', 'ABC234');
  state.players.push({ userId: 'guest', hero: createHero('guest-hero', 'rogue', 'Guest') });
  state.status = 'active';
  if (state.world) for (const clock of state.campaignSnapshot.world.clocks) { clock.max = 100; clock.thresholds = []; delete clock.stoppedBy; }
  return state;
}
function battle(state = party(), order = ['owner-hero', 'enemy', 'guest-hero']) {
  state.scene = 2;
  state.combat = { enemy: {name: 'Target', hp: 100, maxHp: 100, ac: 10, attackBonus: 10, damageDie: 6, damageBonus: 0, dex: 0}, order, turn: 0, round: 1, guard: [], next: 3 };
  return state;
}
function idea(fields = {}) { return { title: 'Study', approach: 'Compare visible marks', skill: 'investigation', success: 'Prepare', failure: 'Delay', ...fields }; }

test('party attacks stop at the enemy boundary without rolling damage before room AFK checks', () => {
  const state = battle(), before = structuredClone(state);
  const result = resolve(state, 'owner', {kind: 'attack'}, dice(10, 2));
  assert.equal(result.rolls.length, 1);
  assert.equal(result.state.combat.order[result.state.combat.turn], 'enemy');
  assert.equal(result.state.players[0].hero.hp, 12);
  assert.deepEqual(state, before);
  const settled = settleEnemyTurn(result.state, dice(10, 2));
  assert.equal(settled.rolls.length, 1); assert.equal(settled.state.players[0].hero.hp, 10);
  assert.equal(currentPlayer(settled.state).userId, 'guest');
  assert.match(settled.fact, /Target → Host.*造成 2/);
  assert.throws(() => settleEnemyTurn(settled.state, noDice), /没有等待/);
});

test('party enemy-first initiative also waits for separate enemy settlement', () => {
  const state = party(); state.scene = 2;
  const result = resolve(state, 'owner', {kind: 'action', actionId: 'fight-shadow'}, dice(1, 2, 20));
  assert.equal(result.rolls.length, 3);
  assert.equal(result.state.combat.order[result.state.combat.turn], 'enemy');
  assert.equal(result.state.players[0].hero.hp, 12);
});

test('zero HP incapacitates only that character, drops concentration and excludes them from enemy targets', () => {
  let state = battle(); state.combat.turn = 1; state.players[0].hero.hp = 1;
  state.players[0].hero.activeSpellEffects = [
    {spellId: 'detect-magic', casterId: 'owner-hero', startedAt: 0, expiresAt: 10, concentration: true, description: 'Detect'},
    {spellId: 'light', casterId: 'owner-hero', startedAt: 0, expiresAt: 60, concentration: false, description: 'Light'},
  ];
  state = settleEnemyTurn(state, dice(10, 2)).state;
  assert.equal(state.status, 'active'); assert.equal(state.players[0].hero.hp, 0);
  assert.deepEqual(state.players[0].hero.activeSpellEffects.map(effect => effect.spellId), ['light']);
  for (const kind of ['attack', 'wind', 'potion', 'spell']) assert.throws(() => resolve(state, 'owner', {kind}, noDice), /倒地/);
  assert.throws(() => resolve(state, 'owner', {kind: 'attack'}, noDice, {teamDecision: true}), /倒地/);
  state = resolve(state, 'guest', {kind: 'attack'}, dice(10, 2)).state;
  assert.equal(state.combat.order[state.combat.turn], 'enemy', 'The downed hero is skipped');
  const result = settleEnemyTurn(state, dice(10, 2));
  assert.match(result.rolls[0].label, /Guest/); assert.doesNotMatch(result.rolls[0].label, /Host/);
  assert.equal(result.state.players[0].hero.hp, 0);
});

test('a teammate potion uses actor inventory and a main action; the rescued hero waits for their own next turn', () => {
  const state = battle(party(), ['owner-hero', 'guest-hero', 'enemy']);
  state.players[1].hero.hp = 0;
  const result = resolve(state, 'owner', {kind: 'potion', targetHeroId: 'guest-hero'}, dice(1, 2));
  assert.equal(result.state.players[0].hero.potions, 1);
  assert.equal(result.state.players[1].hero.potions, 2);
  assert.equal(result.state.players[1].hero.hp, 5);
  assert.equal(currentPlayer(result.state).userId, 'guest');
  assert.equal(result.rolls.length, 1); assert.match(result.fact, /消耗主要动作.*下次自己的回合/);
  const acted = resolve(result.state, 'guest', {kind: 'attack'}, dice(10, 1, 1));
  assert.equal(acted.state.combat.order[acted.state.combat.turn], 'enemy');

  const later = battle(party(), ['guest-hero', 'owner-hero', 'enemy']);
  later.players[1].hero.hp = 0; later.combat.turn = 1;
  const rescued = resolve(later, 'owner', {kind: 'potion', targetHeroId: 'guest-hero'}, dice(1, 1)).state;
  assert.equal(rescued.combat.order[rescued.combat.turn], 'enemy');
  assert.throws(() => resolve(rescued, 'guest', {kind: 'attack'}, noDice), /轮到/);
});

test('potion target validation cannot heal an absent or conscious ally or consume their inventory', () => {
  for (const targetHeroId of ['absent', 'guest-hero']) {
    const state = battle(), before = structuredClone(state);
    assert.throws(() => resolve(state, 'owner', {kind: 'potion', targetHeroId}, noDice), /目标|倒地/);
    assert.deepEqual(state, before);
  }
});

test('the whole party being incapacitated triggers rescue rather than another round', () => {
  const state = battle(); state.players[0].hero.hp = 0; state.players[1].hero.hp = 1; state.combat.turn = 1;
  const result = settleEnemyTurn(state, dice(10, 2));
  assert.equal(result.state.status, 'complete'); assert.equal(result.state.ending, 'retreat'); assert.equal(result.state.combat, null);
  assert.match(result.fact, /全队失能/);
  assert.ok(result.state.messages.some(message => message.text.includes('没有进行标准死亡豁免')));
});

test('timeout defaults only Dodge or skip, clear unconfirmed checks and never spend rare resources', () => {
  const state = battle(); state.players[0].hero.hp = 4;
  state.pending = {id: 'pending', actorId: 'owner-hero', actionId: 'unused', title: 'Unused', skill: 'athletics', dc: 12, modifier: 4, advantage: false, consequence: 'Unused'};
  const resources = structuredClone(state.players.map(player => player.hero));
  const result = resolveDefaultCombatTurn(state, 'timeout', noDice);
  assert.equal(result.state.pending, null); assert.equal(result.state.combat.order[result.state.combat.turn], 'enemy');
  assert.ok(result.state.combat.guard.includes('owner-hero'));
  assert.deepEqual(result.state.players.map(player => player.hero), resources);
  assert.match(result.fact, /操作超时.*系统执行合法闪避/);
  assert.equal(result.rolls.length, 0);
  const fallen = battle(); fallen.players[0].hero.hp = 0;
  const skipped = resolveDefaultCombatTurn(fallen, 'timeout', noDice);
  assert.match(skipped.fact, /倒地.*跳过/); assert.equal(skipped.rolls.length, 0);
  assert.equal(skipped.state.combat.order[skipped.state.combat.turn], 'enemy');
});

test('party short rest consumes only explicit personal choices and advances time once', () => {
  const state = party('moonbridge-conspiracy');
  const wizard = buildHero(createDefaultHeroInput('wizard', 'wizard-hero', 'Wizard', 'human'));
  wizard.hp--; wizard.spellSlots = 0;
  state.players.push({userId: 'wizard', hero: wizard});
  state.players[0].hero.hp = 3; state.players[0].hero.secondWind = 0;
  state.players[1].hero.hp = 0;
  const result = resolvePartyShortRest(state, {guest: {hitDie: true}, wizard: {arcaneRecovery: true}}, dice(2));
  assert.equal(result.state.players[0].hero.hp, 3); assert.equal(result.state.players[0].hero.hitDice, 1);
  assert.equal(result.state.players[0].hero.secondWind, 1);
  assert.equal(result.state.players[1].hero.hp, 3); assert.equal(result.state.players[1].hero.hitDice, 0);
  assert.equal(result.state.players[2].hero.spellSlots, 1); assert.equal(result.state.players[2].hero.hitDice, 1);
  assert.equal(result.state.elapsedMinutes, 60); assert.equal(result.state.turns, 1);
  assert.ok(Object.values(result.state.world.clocks).every(value => value === 6));
  assert.equal(result.rolls.length, 1);
  assert.equal(state.players[1].hero.hp, 0);
  assert.throws(() => resolvePartyShortRest(result.state, {}, noDice), /休息过/);
});

test('party short rest validates every choice before rolling, and no choice means no personal resource spend', () => {
  const state = party(); state.players[0].hero.hp = 4; state.players[1].hero.hp = 3;
  const before = structuredClone(state);
  assert.throws(() => resolvePartyShortRest(state, {owner: {hitDie: true}, guest: {arcaneRecovery: true}}, noDice), /奥术回想/);
  assert.throws(() => resolvePartyShortRest(state, {outsider: {hitDie: true}}, noDice), /属于队伍/);
  assert.deepEqual(state, before);
  const rested = resolvePartyShortRest(state, {}, noDice).state;
  assert.equal(rested.players[0].hero.hitDice, 1); assert.equal(rested.players[1].hero.hitDice, 1);
  assert.equal(rested.players[0].hero.hp, 4); assert.equal(rested.players[1].hero.hp, 3);
  assert.equal(rested.elapsedMinutes, 60); assert.equal(rested.danger, 2);
});

test('world proposals belong to their actor; room system timeout can cancel without spending time', () => {
  const state = party('moonbridge-conspiracy'); stageIdea(state, state.players[0].hero, idea());
  assert.throws(() => resolve(state, 'guest', {kind: 'cancel'}, noDice), /所属玩家/);
  const result = resolve(state, 'guest', {kind: 'cancel'}, noDice, {system: true}).state;
  assert.equal(result.world.proposal, null); assert.equal(result.elapsedMinutes, undefined); assert.equal(result.turns, 0);
  state.players[0].hero.hp = 0; state.world.proposal = null;
  assert.throws(() => stageIdea(state, state.players[0].hero, idea()), /倒地/);
  assert.throws(() => resolve(state, 'owner', {kind: 'action', actionId: 'goal:hear-old-song'}, noDice), /倒地/);
});

test('party movement, chapter rest and retreat require a trusted completed team decision', () => {
  const state = party('moonbridge-conspiracy'), next = state.campaignSnapshot.world.locations[0].exits[0];
  const travel = {kind: 'action', actionId: `travel:${next}`};
  assert.throws(() => resolve(state, 'owner', travel, noDice), /团队投票/);
  assert.notEqual(resolve(state, 'owner', travel, noDice, {teamDecision: true}).state.scene, 0);
  assert.throws(() => resolve(state, 'owner', {kind: 'session'}, noDice), /团队投票/);
  assert.equal(resolve(state, 'owner', {kind: 'session'}, noDice, {teamDecision: true}).state.world.session, 2);
  assert.throws(() => resolve(state, 'owner', {kind: 'retreat'}, noDice), /团队投票/);
  assert.equal(resolve(state, 'guest', {kind: 'retreat'}, noDice, {teamDecision: true}).state.status, 'complete');
  assert.throws(() => resolve(state, 'owner', {kind: 'rest'}, noDice), /团队投票/);
});

test('solo retains automatic enemy settlement and immediate zero-HP rescue', () => {
  const state = createGame('solo', 'owner', createHero('owner-hero', 'fighter', 'Solo'), 'silent-bell', 'solo', 'ABC234');
  battle(state, ['owner-hero', 'enemy']); state.players[0].hero.hp = 1;
  const result = resolve(state, 'owner', {kind: 'dodge'}, dice(20, 20, 6, 6));
  assert.equal(result.state.status, 'complete'); assert.equal(result.state.combat, null); assert.equal(result.state.ending, 'retreat');
});
