import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHero, createDefaultHeroInput } from '../lib/game/character-builder.ts';
import { createGame, resolve } from '../lib/game/engine.ts';
import { activeSpellEffects, effectiveArmorClass } from '../lib/game/spells.ts';
import { stageIdea } from '../lib/game/world-engine.ts';

function game() {
  const input = createDefaultHeroInput('wizard', 'hero', 'Tester', 'human');
  input.spellbook = ['magic-missile', 'mage-armor', 'burning-hands', 'disguise-self', 'comprehend-languages', 'detect-magic'];
  input.preparedSpells = ['mage-armor', 'disguise-self', 'comprehend-languages', 'detect-magic'];
  const state = createGame('game', 'owner', buildHero(input), 'moonbridge-conspiracy', 'solo', 'ABC234');
  for (const clock of state.campaignSnapshot.world.clocks) {
    clock.max = 100; clock.thresholds = []; delete clock.stoppedBy;
  }
  return state;
}
function proposal(state, spellId) {
  const goal = state.campaignSnapshot.world.opportunities.find(value => value.id === 'hear-old-song');
  return stageIdea(state, state.players[0].hero, {
    title: 'Study the song', approach: 'Study the supplied text without assuming success',
    skill: 'investigation', goalId: goal.id, spellId,
    success: 'Server owns the result', failure: 'Server owns the consequence',
  });
}
function confirm(state, value = 20) {
  let rolls = 0;
  const result = resolve(state, 'owner', { kind: 'confirm' }, sides => {
    assert.equal(sides, 20); rolls++; return value;
  });
  assert.equal(rolls, 1, 'A utility-assisted goal must still have one actual goal check');
  return result;
}

test('world staging rejects unlearned, unprepared and exhausted spells without mutating the original state', () => {
  const cases = [
    { spellId: 'minor-illusion', change: () => {}, error: /没有学习/ },
    { spellId: 'comprehend-languages', change: state => {
      state.players[0].hero.build.preparedSpells = ['mage-armor', 'disguise-self', 'detect-magic', 'magic-missile'];
    }, error: /尚未准备/ },
    { spellId: 'mage-armor', change: state => { state.players[0].hero.spellSlots = 0; }, error: /没有可用/ },
  ];
  for (const item of cases) {
    const state = game(); item.change(state);
    const before = structuredClone(state);
    assert.throws(() => proposal(state, item.spellId), item.error);
    assert.deepEqual(state, before);
  }
});

test('world confirmation casts once, consumes one slot, checks the goal and advances each time component once', () => {
  const state = game(), baseAc = state.players[0].hero.ac;
  proposal(state, 'mage-armor');
  assert.equal(state.players[0].hero.spellSlots, 2);
  assert.equal(state.elapsedMinutes ?? 0, 0);
  const result = confirm(state), hero = result.state.players[0].hero;
  assert.equal(hero.spellSlots, 1);
  assert.equal(result.rolls.length, 1);
  assert.ok(result.state.clues.includes('old-vow'));
  assert.equal(result.state.world.proposal, null);
  assert.equal(result.state.elapsedMinutes, 10.1);
  assert.ok(Object.values(result.state.world.clocks).every(value => value === 1));
  assert.equal(result.state.messages.filter(message => message.text.startsWith('Tester施放法师护甲。')).length, 1);
  assert.equal(state.players[0].hero.spellSlots, 2, 'Resolution must not mutate the staged input');
  assert.equal(hero.ac, baseAc);
  assert.equal(effectiveArmorClass(hero, result.state), 15);
  const effect = activeSpellEffects(hero, result.state)[0];
  assert.equal(effect.startedAt, .1); assert.equal(effect.expiresAt, 480.1);
  const settled = structuredClone(result.state);
  assert.throws(() => confirm(result.state), /没有可确认/);
  assert.deepEqual(result.state, settled, 'A replay must not consume another slot');
});

test('cancelling a staged utility spell consumes no slots, spell time, clocks or turns', () => {
  const state = game(); proposal(state, 'mage-armor');
  const before = { slots: state.players[0].hero.spellSlots, time: state.elapsedMinutes,
    clocks: structuredClone(state.world.clocks), turns: state.turns };
  const result = resolve(state, 'owner', { kind: 'cancel' }, () => { throw new Error('Cancel must not roll'); }).state;
  assert.equal(result.world.proposal, null);
  assert.equal(result.players[0].hero.spellSlots, before.slots);
  assert.equal(result.elapsedMinutes, before.time);
  assert.deepEqual(result.world.clocks, before.clocks);
  assert.equal(result.turns, before.turns);
  assert.deepEqual(result.players[0].hero.activeSpellEffects ?? [], []);
});

test('world utility durations begin after casting and expire after the actual goal activity, not after a second casting charge', () => {
  for (const [id, duration, slotCost] of [['mage-hand', 1, 0], ['detect-magic', 10, 1], ['disguise-self', 60, 1], ['comprehend-languages', 60, 1]]) {
    const state = game(); proposal(state, id);
    const result = confirm(state).state, hero = result.players[0].hero;
    assert.equal(result.elapsedMinutes, 10.1);
    assert.equal(hero.spellSlots, 2 - slotCost);
    assert.ok(Object.values(result.world.clocks).every(value => value === 1));
    const effects = activeSpellEffects(hero, result);
    if (duration <= 10) assert.equal(effects.length, 0, `${id} must expire after the ten-minute goal activity`);
    else {
      assert.equal(effects.length, 1); assert.equal(effects[0].startedAt, .1);
      assert.equal(effects[0].expiresAt, duration + .1);
      assert.ok(Math.abs(effects[0].expiresAt - result.elapsedMinutes - (duration - 10)) < 1e-9);
    }
  }
});

test('a failed spell-assisted goal consumes one slot and adds the configured failure time once', () => {
  const state = game(); proposal(state, 'mage-armor');
  const result = confirm(state, 1).state;
  assert.equal(result.players[0].hero.spellSlots, 1);
  assert.equal(result.clues.includes('old-vow'), false);
  assert.equal(result.elapsedMinutes, 20.1);
  assert.ok(Object.values(result.world.clocks).every(value => value === 2));
  assert.equal(activeSpellEffects(result.players[0].hero, result)[0].expiresAt, 480.1);
});

test('chapter rest advances a real eight hours, clears effects and restores the bounded level-one resources', () => {
  let state = game();
  state = resolve(state, 'owner', { kind: 'spell', actionId: 'light' }).state;
  state = resolve(state, 'owner', { kind: 'spell', actionId: 'mage-armor' }).state;
  const hero = state.players[0].hero, elapsed = state.elapsedMinutes, clocks = structuredClone(state.world.clocks);
  hero.hp--; hero.hitDice = 0; hero.spellSlots = 0; hero.arcaneRecoveryUsedChapter = state.world.session;
  assert.equal(activeSpellEffects(hero, state).length, 2);
  const result = resolve(state, 'owner', { kind: 'session' }).state, rested = result.players[0].hero;
  assert.equal(result.elapsedMinutes, elapsed + 480);
  for (const [id, value] of Object.entries(result.world.clocks)) assert.equal(value, clocks[id] + 8);
  assert.equal(result.world.session, 2);
  assert.deepEqual(rested.activeSpellEffects, []);
  assert.equal(rested.arcaneRecoveryUsedChapter, undefined);
  assert.equal(rested.hp, rested.maxHp); assert.equal(rested.hitDice, 1); assert.equal(rested.spellSlots, 2);
  assert.equal(rested.potions, 0);
  assert.equal(effectiveArmorClass(rested, result), rested.ac);
});
