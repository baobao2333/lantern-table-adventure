import test from "node:test";
import assert from "node:assert/strict";
import {
  buildHero,
  createDefaultHeroInput,
} from "../lib/game/character-builder.ts";
import { CAMPAIGNS } from "../lib/game/campaigns.ts";
import { createGame, resolve, gameView } from "../lib/game/engine.ts";
import { checkRoll, attackRoll, initiativeRoll } from "../lib/game/dice.ts";
import {
  activeSpellEffects,
  advanceSpellTime,
  arcaneRecoveryAvailable,
  castSpell,
  checkConcentration,
  effectiveArmorClass,
  spellAvailability,
} from "../lib/game/spells.ts";
import { stageIdea } from "../lib/game/world-engine.ts";

function dice(...values) {
  return (sides) => {
    const value = values.shift();
    assert.ok(
      value >= 1 && value <= sides,
      `Missing/out-of-range d${sides}: ${value}`,
    );
    return value;
  };
}
function source(classId = "fighter", speciesId = "human") {
  return createDefaultHeroInput(classId, "hero", "Tester", speciesId);
}
function game(build = source(), campaignId = "silent-bell") {
  return createGame(
    "game",
    "owner",
    buildHero(build),
    campaignId,
    "solo",
    "ABC234",
  );
}
function battle(state, enemyOverrides = {}) {
  state.combat = {
    enemy: {
      name: "Target",
      hp: 100,
      maxHp: 100,
      ac: 10,
      attackBonus: 0,
      damageDie: 6,
      damageBonus: 0,
      dex: 0,
      ...enemyOverrides,
    },
    order: [state.players[0].hero.id, "enemy"],
    turn: 0,
    round: 1,
    guard: [],
    next: 2,
  };
  return state;
}
function command(state, kind, die = dice(1), actionId) {
  return resolve(state, "owner", { kind, actionId }, die);
}
function spellInput(...prepared) {
  const build = source("wizard");
  build.spellbook = [
    "magic-missile",
    "mage-armor",
    "sleep",
    "burning-hands",
    "disguise-self",
    "comprehend-languages",
  ];
  build.preparedSpells = prepared.length
    ? prepared
    : ["magic-missile", "mage-armor", "sleep", "burning-hands"];
  return build;
}
function worldGame(build = source()) {
  const campaign = CAMPAIGNS.find((value) => value.world),
    state = game(build, campaign.id);
  for (const clock of state.campaignSnapshot.world.clocks) {
    clock.max = 100;
    clock.thresholds = [];
    delete clock.stoppedBy;
  }
  return state;
}

test("Lucky records original and replacement; a replacement 1 is never rerolled again", () => {
  const roll = checkRoll("Lucky", 2, 12, false, dice(1, 1), { lucky: true });
  assert.deepEqual(roll.rolls, [1]);
  assert.equal(roll.kept, 1);
  assert.deepEqual(roll.rerolls, [
    { dieIndex: 0, original: 1, replacement: 1 },
  ]);
  assert.match(roll.explanation, /原值 1.*重掷为 1/);
});

test("Lucky rerolls only one die with advantage, and advantage/disadvantage cancel", () => {
  const roll = checkRoll("Double ones", 0, 12, true, dice(1, 1, 18), {
    lucky: true,
  });
  assert.deepEqual(roll.rolls, [18, 1]);
  assert.equal(roll.rerolls.length, 1);
  assert.equal(roll.kept, 18);
  const cancel = checkRoll("Cancel", 0, 12, true, dice(15), {
    disadvantage: true,
  });
  assert.deepEqual(cancel.rolls, [15]);
  assert.match(cancel.explanation, /抵消/);
  const attack = attackRoll("Heavy", 4, 15, dice(20, 1, 7), true, {
    lucky: true,
  });
  assert.equal(attack.kept, 7);
  assert.equal(attack.success, false);
});

test("initiative Lucky is an actual auditable initiative roll", () => {
  const roll = initiativeRoll("Initiative", 3, dice(1, 18), true);
  assert.equal(roll.kind, "initiative");
  assert.equal(roll.total, 21);
  assert.deepEqual(roll.rerolls, [
    { dieIndex: 0, original: 1, replacement: 18 },
  ]);
});

test("equipped greatsword deals 2d6 and critical doubles all dice while keeping flat STR", () => {
  const build = source();
  build.equipment.martialWeapons = ["greatsword"];
  build.equippedWeaponId = "greatsword";
  build.weaponGrip = "two-handed";
  build.shieldEquipped = false;
  const result = command(
    battle(game(build)),
    "attack",
    dice(20, 2, 3, 4, 5, 1),
  );
  assert.equal(result.rolls[0].modifier, 5);
  assert.equal(result.rolls[0].damage, 17);
  assert.match(result.rolls[0].explanation, /2 \+ 3 \+ 4 \+ 5/);
  assert.equal(result.state.combat.enemy.hp, 83);
});

test("Dueling and versatile grip use actual equipped weapon bonuses", () => {
  const build = source();
  build.fightingStyle = "dueling";
  const one = command(battle(game(build)), "attack", dice(15, 4, 1));
  assert.equal(one.rolls[0].damage, 9);
  build.weaponGrip = "two-handed";
  build.shieldEquipped = false;
  const two = command(battle(game(build)), "attack", dice(15, 10, 1));
  assert.equal(two.rolls[0].damage, 13);
});

test("Small heavy weapon applies disadvantage in actual engine and Lucky stays auditable", () => {
  const build = source("fighter", "lightfoot-halfling");
  build.equipment.martialWeapons = ["greatsword"];
  build.equippedWeaponId = "greatsword";
  build.weaponGrip = "two-handed";
  build.shieldEquipped = false;
  const result = command(
    battle(game(build)),
    "attack",
    dice(1, 20, 19, 6, 6, 1),
  );
  assert.equal(result.rolls[0].kept, 19);
  assert.equal(result.rolls[0].damage, 14);
  assert.deepEqual(result.rolls[0].rerolls, [
    { dieIndex: 0, original: 1, replacement: 19 },
  ]);
  assert.match(result.rolls[0].explanation, /小体型.*重型/);
});

test("armor stealth disadvantage is staged, and prepared advantage cancels it", () => {
  const state = game();
  state.campaignSnapshot.scenes[0].actions = [
    {
      id: "hide",
      kind: "check",
      title: "Hide",
      description: "Hide",
      skill: "stealth",
      dc: 12,
    },
  ];
  const pending = command(state, "action", dice(), "hide").state;
  assert.equal(pending.pending.disadvantage, true);
  const failed = command(pending, "roll", dice(20, 2));
  assert.equal(failed.rolls[0].kept, 2);
  state.campaignSnapshot.scenes[0].actions[0].advantageFlag = "prepared";
  state.flags.push("prepared");
  const cancelled = command(
    command(state, "action", dice(), "hide").state,
    "roll",
    dice(15),
  );
  assert.deepEqual(cancelled.rolls[0].rolls, [15]);
  assert.equal(cancelled.rolls[0].success, true);
});

test("halfling Lucky reaches actual legacy-scene check and combat initiative paths", () => {
  const state = game(source("rogue", "lightfoot-halfling"));
  state.campaignSnapshot.scenes[0].actions = [
    {
      id: "look",
      kind: "check",
      title: "Look",
      description: "Look",
      skill: "perception",
      dc: 12,
    },
  ];
  const result = command(
    command(state, "action", dice(), "look").state,
    "roll",
    dice(1, 15),
  );
  assert.equal(result.rolls[0].kept, 15);
  assert.equal(result.rolls[0].rerolls.length, 1);
  state.campaignSnapshot.scenes[0].enemy = {
    name: "Target",
    hp: 20,
    maxHp: 20,
    ac: 10,
    attackBonus: 0,
    damageDie: 6,
    damageBonus: 0,
    dex: 0,
  };
  state.campaignSnapshot.scenes[0].actions = [
    {
      id: "fight",
      kind: "combat",
      title: "Fight",
      description: "Fight",
      next: 2,
    },
  ];
  const initiative = command(state, "action", dice(1, 18, 2), "fight");
  assert.equal(initiative.rolls[0].kind, "initiative");
  assert.equal(initiative.rolls[0].rerolls.length, 1);
});

test("new wizard Attack uses the equipped staff, and fire bolt uses a separately learned cantrip", () => {
  const state = battle(game(source("wizard")));
  const weapon = command(state, "attack", dice(15, 4, 1));
  assert.equal(weapon.rolls[0].modifier, 1);
  assert.equal(weapon.rolls[0].damage, 3);
  const fire = command(state, "spell", dice(15, 8, 1), "fire-bolt");
  assert.equal(fire.rolls[0].modifier, 5);
  assert.equal(fire.rolls[0].damage, 8);
  const build = source("wizard");
  build.cantrips = ["light", "mage-hand", "minor-illusion"];
  assert.throws(
    () => command(battle(game(build)), "spell", dice(), "fire-bolt"),
    /没有学习/,
  );
});

test("high elf fighter can actually cast their INT racial fire bolt", () => {
  const result = command(
    battle(game(source("fighter", "high-elf"))),
    "spell",
    dice(15, 8, 1),
    "fire-bolt",
  );
  assert.equal(result.rolls[0].modifier, 2);
  assert.equal(result.rolls[0].damage, 8);
  assert.equal(result.state.players[0].hero.spellSlots, 0);
});

test("new wizard magic missile requires preparation and uses one real spell slot", () => {
  const build = spellInput(
    "mage-armor",
    "sleep",
    "burning-hands",
    "disguise-self",
  );
  assert.throws(
    () => command(battle(game(build)), "missile", dice()),
    /尚未准备/,
  );
  const result = command(
    battle(game(spellInput())),
    "missile",
    dice(1, 2, 3, 1),
  );
  assert.equal(result.state.players[0].hero.spellSlots, 1);
  assert.equal(result.rolls[0].damage, 9);
  assert.equal(result.rolls[0].kind, "damage");
});

test("burning hands uses an actual DEX save and floor-halved 3d6 damage", () => {
  const result = command(
    battle(game(spellInput())),
    "spell",
    dice(1, 2, 4, 20, 1),
    "burning-hands",
  );
  assert.equal(result.rolls[0].success, true);
  assert.equal(result.rolls[0].target, 13);
  assert.equal(result.rolls[1].damage, 3);
  assert.equal(result.state.combat.enemy.hp, 97);
  assert.equal(result.state.players[0].hero.spellSlots, 1);
});

test("sleep compares 5d8 to current HP and ends a qualifying conflict without damage", () => {
  const result = command(
    battle(game(spellInput()), { hp: 4, maxHp: 20 }),
    "spell",
    dice(1, 1, 1, 1, 1),
    "sleep",
  );
  assert.equal(result.state.combat, null);
  assert.equal(result.rolls[0].damage, undefined);
  assert.equal(result.rolls[0].total, 5);
  assert.match(result.fact, /非致命.*没有受到伤害或死亡/);
  assert.equal(result.state.players[0].hero.spellSlots, 1);
});

test("sleep failure and immunity still consume the spell slot without reducing target HP", () => {
  for (const enemy of [{ hp: 6 }, { hp: 1, sleepImmune: true }]) {
    const result = command(
      battle(game(spellInput()), enemy),
      "spell",
      dice(1, 1, 1, 1, 1, 1),
      "sleep",
    );
    assert.equal(result.state.combat.enemy.hp, enemy.hp);
    assert.equal(result.state.players[0].hero.spellSlots, 1);
    assert.equal(result.rolls[0].success, false);
  }
});

test("mage armor is a timed base-AC effect, and public display does not corrupt stored armor", () => {
  const state = command(
      game(spellInput()),
      "spell",
      dice(),
      "mage-armor",
    ).state,
    hero = state.players[0].hero;
  assert.equal(hero.ac, 12);
  assert.equal(effectiveArmorClass(hero, state), 15);
  assert.equal(gameView(state, 1).game.players[0].hero.ac, 15);
  assert.equal(hero.ac, 12);
  const fight = command(battle(state), "spell", dice(15, 1, 13), "fire-bolt");
  assert.equal(fight.rolls.at(-1).target, 15);
  assert.equal(fight.rolls.at(-1).success, false);
  advanceSpellTime(state, 480);
  assert.equal(effectiveArmorClass(hero, state), 12);
});

test("rituals require the book, bypass preparation and slots, and add ten minutes", () => {
  const state = game(spellInput()),
    hero = state.players[0].hero;
  hero.spellSlots = 0;
  assert.equal(spellAvailability(hero, "comprehend-languages").allowed, false);
  const result = castSpell(state, hero, "comprehend-languages", dice(), {
    ritual: true,
  });
  assert.equal(result.castMinutes, 10.1);
  assert.equal(hero.spellSlots, 0);
  advanceSpellTime(state, result.castMinutes);
  assert.ok(
    activeSpellEffects(hero, state).some(
      (effect) => effect.spellId === "comprehend-languages",
    ),
  );
  advanceSpellTime(state, 60);
  assert.deepEqual(activeSpellEffects(hero, state), []);
  assert.equal(
    spellAvailability(hero, "mage-armor", { ritual: true }).allowed,
    false,
  );
});

test("detect magic requires concentration and expires after ten active minutes", () => {
  const build = spellInput();
  build.spellbook[2] = "detect-magic";
  build.preparedSpells[2] = "detect-magic";
  const state = game(build),
    hero = state.players[0].hero;
  const result = castSpell(state, hero, "detect-magic", dice());
  advanceSpellTime(state, result.castMinutes);
  assert.equal(activeSpellEffects(hero, state)[0].concentration, true);
  assert.match(result.fact, /不自动鉴定.*发现秘密/);
  advanceSpellTime(state, 10);
  assert.deepEqual(activeSpellEffects(hero, state), []);
});

test("concentration takes an actual CON save and drops only concentration effects on failure", () => {
  const build = spellInput();
  build.spellbook[2] = "detect-magic";
  build.preparedSpells[2] = "detect-magic";
  const state = game(build),
    hero = state.players[0].hero;
  let result = castSpell(state, hero, "light", dice());
  advanceSpellTime(state, result.castMinutes);
  result = castSpell(state, hero, "detect-magic", dice());
  advanceSpellTime(state, result.castMinutes);
  const success = checkConcentration(state, hero, 24, dice(20));
  assert.equal(success.target, 12);
  assert.equal(success.success, true);
  const failure = checkConcentration(state, hero, 1, dice(1));
  assert.equal(failure.target, 10);
  assert.equal(failure.success, false);
  assert.deepEqual(
    activeSpellEffects(hero, state).map((effect) => effect.spellId),
    ["light"],
  );
});

test("unavailable, unknown, nonritual and slow combat spells cannot consume resources", () => {
  const state = game(spellInput()),
    hero = state.players[0].hero;
  for (const id of ["constructor", "wish", "disguise-self"])
    assert.throws(() => castSpell(state, hero, id, dice()));
  assert.equal(hero.spellSlots, 2);
  assert.equal(
    spellAvailability(hero, "mending", { inCombat: true }).allowed,
    false,
  );
  assert.equal(
    spellAvailability(hero, "comprehend-languages", {
      ritual: true,
      inCombat: true,
    }).allowed,
    false,
  );
});

test("short rest gives a new wizard at most one slot, once per chapter", () => {
  const state = game(spellInput());
  state.campaignSnapshot.scenes[0].safeRest = true;
  state.players[0].hero.spellSlots = 0;
  const first = command(state, "rest", dice()).state,
    hero = first.players[0].hero;
  assert.equal(hero.spellSlots, 1);
  assert.equal(hero.arcaneRecoveryUsedChapter, 1);
  assert.equal(first.elapsedMinutes, 60);
  hero.spellSlots = 0;
  hero.hp--;
  delete first.lastRestScene;
  const second = command(first, "rest", dice(1)).state;
  assert.equal(second.players[0].hero.spellSlots, 0);
  assert.equal(arcaneRecoveryAvailable(second, second.players[0].hero), false);
});

test("world rest refuses a pending proposal and allows recovery in a later chapter", () => {
  const state = worldGame(spellInput()),
    hero = state.players[0].hero;
  hero.spellSlots = 0;
  stageIdea(state, hero, {
    title: "Observe",
    approach: "Observe the courtyard",
    skill: "insight",
    success: "Prepare",
    failure: "Delay",
  });
  assert.throws(() => command(state, "rest", dice()), /提案/);
  state.world.proposal = null;
  const first = command(state, "rest", dice()).state;
  assert.equal(first.players[0].hero.spellSlots, 1);
  first.world.session++;
  first.players[0].hero.spellSlots = 0;
  const second = command(first, "rest", dice()).state;
  assert.equal(second.players[0].hero.spellSlots, 1);
  assert.equal(second.players[0].hero.arcaneRecoveryUsedChapter, 2);
});

test("world conflict uses its actual encounter, advances clocks once and keeps the location on victory", () => {
  const state = worldGame(),
    cfg = state.campaignSnapshot.world,
    goal = cfg.opportunities.find((value) => value.encounter);
  state.scene = cfg.locations.findIndex((value) => value.id === goal.location);
  state.clues.push(...goal.requires);
  const location = state.scene;
  const started = command(
    state,
    "action",
    dice(20, 1),
    `fight:${goal.id}`,
  ).state;
  assert.equal(started.combat.enemy.name, goal.encounter.name);
  for (const value of Object.values(started.world.clocks))
    assert.equal(value, 1);
  assert.equal(started.elapsedMinutes ?? 0, 0);
  const clocks = structuredClone(started.world.clocks);
  started.combat.enemy.hp = 1;
  const result = command(started, "attack", dice(15, 8));
  assert.equal(result.state.scene, location);
  assert.deepEqual(result.state.world.clocks, clocks);
  assert.ok(result.state.flags.includes(`worldgoal:${goal.id}`));
  assert.ok(
    result.state.messages.some((message) =>
      message.text.includes("仍在当前地点"),
    ),
  );
});

test("world utility action uses integer clock units and exact spell casting minutes", () => {
  const state = worldGame(spellInput());
  const light = command(state, "spell", dice(), "light").state;
  assert.equal(light.elapsedMinutes, 0.1);
  for (const value of Object.values(light.world.clocks)) assert.equal(value, 1);
  assert.ok(
    activeSpellEffects(light.players[0].hero, light).some(
      (effect) => effect.spellId === "light",
    ),
  );
  const ritual = command(
    state,
    "spell",
    dice(),
    "ritual:comprehend-languages",
  ).state;
  assert.equal(ritual.elapsedMinutes, 10.1);
  for (const value of Object.values(ritual.world.clocks))
    assert.equal(value, 2);
});

test("new world copy uses its actual clocks and cannot inherit teaching-mode ending additions", () => {
  const state = worldGame();
  assert.ok(
    state.messages.some((message) => message.text.includes("叙事时钟")),
  );
  assert.equal(
    state.messages.some((message) =>
      message.text.includes("达到 4 时会影响结局"),
    ),
    false,
  );
  state.danger = 6;
  state.ending = Object.keys(state.campaignSnapshot.endings)[0];
  assert.equal(
    gameView(state, 1).ending.text,
    state.campaignSnapshot.endings[state.ending].text,
  );
});

test("unsupported mode commands reject instead of silently consuming a turn", () => {
  const state = game();
  assert.throws(() => command(state, "session", dice()), /不支持/);
  assert.equal(state.turns, 0);
});
