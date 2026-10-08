import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ABILITY_OPTIONS, BACKGROUND_OPTIONS, BUILDER_SKILLS, CANTRIP_OPTIONS,
  CharacterBuildError, CLASS_OPTIONS, FIRST_LEVEL_SPELL_OPTIONS, SPECIES_OPTIONS,
  buildHero, createDefaultHeroInput, pointBuyCost,
} from '../lib/game/character-builder.ts';

function input(classId = 'fighter', speciesId = 'human') {
  return createDefaultHeroInput(classId, 'hero-1', 'Tester', speciesId);
}
function rejects(source, code, field) {
  assert.throws(() => buildHero(source), error => error instanceof CharacterBuildError
    && error.code === code && (!field || error.field === field));
}
function equip(source, weapon, grip = 'one-handed', shield = false) {
  source.equippedWeaponId = weapon; source.weaponGrip = grip; source.shieldEquipped = shield;
  return source;
}

test('all twelve class/species defaults are legal, deterministic and do not mutate input', () => {
  for (const classId of Object.keys(CLASS_OPTIONS)) for (const speciesId of Object.keys(SPECIES_OPTIONS)) {
    const source = input(classId, speciesId), before = structuredClone(source);
    const hero = buildHero(source);
    assert.deepEqual(source, before);
    assert.deepEqual(buildHero(source), hero);
    assert.equal(hero.build.rulesVersion, 'srd-5.1-table-2');
    assert.equal(hero.build.level, 1);
    assert.equal(hero.potions, 0);
    assert.equal(hero.skills.length, 2 + CLASS_OPTIONS[classId].skillCount + (speciesId === 'high-elf' ? 1 : 0));
    assert.equal(hero.skills.length, new Set(hero.skills).size);
    assert.equal(hero.maxHp, hero.hp);
  }
});

test('all eighteen skills use the actual ability map and stable camelCase IDs', () => {
  assert.equal(Object.keys(BUILDER_SKILLS).length, 18);
  assert.equal(BUILDER_SKILLS.sleightOfHand.ability, 'DEX');
  assert.equal(BUILDER_SKILLS.animalHandling.ability, 'WIS');
  assert.equal(BUILDER_SKILLS.intimidation.ability, 'CHA');
  assert.equal(BUILDER_SKILLS.nature.ability, 'INT');
  assert.deepEqual(Object.keys(ABILITY_OPTIONS), ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA']);
});

test('standard array requires exactly the six canonical values before racial bonuses', () => {
  const source = input(); source.baseScores.STR = 14;
  rejects(source, 'invalid_standard_array');
  const missing = input(); delete missing.baseScores.CON;
  rejects(missing, 'invalid_ability_scores');
  const extra = input(); extra.baseScores.LUCK = 15;
  rejects(extra, 'invalid_ability_scores');
});

test('point buy uses non-linear prices and allows spending up to 27', () => {
  const source = input(); source.abilityMethod = 'point-buy';
  source.baseScores = {STR:15, DEX:15, CON:15, INT:8, WIS:8, CHA:8};
  assert.equal(pointBuyCost(source.baseScores), 27);
  assert.equal(buildHero(source).abilities.STR, 16);
  source.baseScores.INT = 9; rejects(source, 'point_buy_budget');
  source.baseScores = {STR:8, DEX:8, CON:8, INT:8, WIS:8, CHA:8};
  assert.equal(pointBuyCost(source.baseScores), 0);
  assert.equal(buildHero(source).abilities.CON, 9);
});

test('point buy rejects non-integers, non-finite values and inherited scores', () => {
  for (const value of [7, 16, 10.5, NaN, Infinity, '15']) {
    const source = input(); source.abilityMethod = 'point-buy'; source.baseScores.STR = value;
    rejects(source, 'invalid_ability_score', 'baseScores.STR');
  }
  const source = input(); source.abilityMethod = 'point-buy';
  source.baseScores = Object.assign(Object.create(source.baseScores), {a:1,b:2,c:3,d:4,e:5,f:6});
  rejects(source, 'invalid_ability_score');
});

test('human, hill dwarf, high elf and halfling derive their real level-one values', () => {
  const human = buildHero(input());
  assert.deepEqual(human.abilities, {STR:16, DEX:13, CON:15, INT:11, WIS:14, CHA:9});
  assert.equal(human.hp, 12);
  const dwarf = buildHero(input('fighter', 'hill-dwarf'));
  assert.equal(dwarf.abilities.CON, 16); assert.equal(dwarf.abilities.WIS, 14);
  assert.equal(dwarf.hp, 14); assert.equal(dwarf.build.darkvision, 60);
  assert.ok(dwarf.build.toolProficiencies.includes('mason'));
  const elf = buildHero(input('wizard', 'high-elf'));
  assert.equal(elf.abilities.DEX, 16); assert.equal(elf.abilities.INT, 16);
  assert.ok(elf.skills.includes('perception'));
  assert.equal(elf.build.cantrips.length, 3); assert.ok(elf.build.racialCantrip);
  const halfling = buildHero(input('rogue', 'lightfoot-halfling'));
  assert.equal(halfling.abilities.DEX, 17); assert.equal(halfling.build.size, 'Small');
  assert.ok(halfling.build.traits.includes('halfling-lucky'));
});

test('backgrounds permit exactly two custom skill proficiencies and two extras', () => {
  const source = input(); source.backgroundId = 'custom';
  source.backgroundSkills = ['medicine', 'nature'];
  source.backgroundExtras = ['tool:smith', 'language:orc'];
  const hero = buildHero(source);
  assert.ok(hero.skills.includes('medicine')); assert.ok(hero.build.toolProficiencies.includes('smith'));
  assert.ok(hero.build.languages.includes('orc'));
  source.backgroundSkills.push('religion'); rejects(source, 'invalid_choice_count', 'backgroundSkills');
});

test('duplicate race/background/class skills require replacement and cannot inflate proficiency', () => {
  const source = input(); source.classSkills = ['athletics', 'insight'];
  rejects(source, 'duplicate_proficiency');
  const elf = input('fighter', 'high-elf'); elf.backgroundSkills = ['athletics', 'perception'];
  rejects(elf, 'duplicate_proficiency');
  const repeated = input(); repeated.backgroundSkills = ['history', 'history'];
  rejects(repeated, 'duplicate_choice');
  const wrongClass = input(); wrongClass.classSkills = ['arcana', 'insight'];
  rejects(wrongClass, 'invalid_option', 'classSkills');
});

test('languages and tools reject repeated sources and Acolyte keeps two languages', () => {
  const repeated = input(); repeated.backgroundExtras = ['language:common', 'tool:mason'];
  rejects(repeated, 'duplicate_proficiency');
  const rogue = input('rogue'); rogue.backgroundExtras = ['tool:thieves', 'tool:mason'];
  rejects(rogue, 'duplicate_proficiency');
  const source = input(); source.backgroundId = 'acolyte';
  source.backgroundSkills = [...BACKGROUND_OPTIONS.acolyte.skills];
  source.classSkills = ['athletics', 'intimidation'];
  source.backgroundExtras = ['tool:smith', 'language:orc'];
  rejects(source, 'invalid_acolyte_extras');
  source.backgroundExtras = ['language:elvish', 'language:orc'];
  const hero = buildHero(source);
  assert.ok(hero.build.inventory.some(item => item.id === 'holy-symbol'));
});

test('rogue chooses two expertise skills from any proficient source', () => {
  const source = input('rogue'); source.expertise = ['survival', 'stealth'];
  assert.deepEqual(buildHero(source).build.expertise, ['survival', 'stealth']);
  source.expertise = ['arcana', 'stealth']; rejects(source, 'expertise_not_proficient');
  source.expertise = ['stealth', 'stealth']; rejects(source, 'duplicate_choice');
  const fighter = input(); fighter.expertise = ['athletics', 'insight'];
  rejects(fighter, 'invalid_choice_count', 'expertise');
});

test('armor, shield, Defense and proficiency derive AC and attack independently', () => {
  const hero = buildHero(input());
  assert.equal(hero.ac, 19); assert.equal(hero.build.armorStealthDisadvantage, true);
  assert.equal(hero.build.weapon.attackBonus, 5);
  assert.equal(hero.build.weapon.damageBonus, 3);
  assert.equal(hero.build.weapon.damageDie, 8);
  const rogue = buildHero(input('rogue'));
  assert.equal(rogue.ac, 14); assert.equal(rogue.build.weapon.ability, 'DEX');
  assert.equal(rogue.build.weapon.attackBonus, 5);
  assert.equal(rogue.build.weapon.damageBonus, 3);
});

test('Dueling supports a shield but no two-handed bonus', () => {
  const source = input(); source.fightingStyle = 'dueling';
  assert.equal(buildHero(source).build.weapon.damageBonus, 5);
  equip(source, 'longsword', 'two-handed');
  const hero = buildHero(source);
  assert.equal(hero.build.weapon.damageDie, 10);
  assert.equal(hero.build.weapon.damageBonus, 3);
  assert.equal(hero.ac, 16);
});

test('greatsword keeps 2d6, and a Small wielder receives the heavy-weapon disadvantage marker', () => {
  const source = input('fighter', 'lightfoot-halfling');
  source.equipment.martialWeapons = ['greatsword']; equip(source, 'greatsword', 'two-handed');
  const weapon = buildHero(source).build.weapon;
  assert.equal(weapon.damageDice, 2); assert.equal(weapon.damageDie, 6);
  assert.deepEqual(weapon.disadvantageReasons, ['small-heavy-weapon']);
});

test('Archery applies to a ranged weapon, never to a thrown handaxe', () => {
  const source = input(); source.fightingStyle = 'archery';
  source.equipment.armorPackage = 'leather-longbow';
  equip(source, 'longbow', 'two-handed');
  assert.equal(buildHero(source).build.weapon.attackBonus, 5);
  source.equipment.extraWeapons = 'two-handaxes';
  equip(source, 'handaxe'); source.attackMode = 'ranged';
  const weapon = buildHero(source).build.weapon;
  assert.equal(weapon.attackBonus, 5); assert.equal(weapon.ability, 'STR');
  assert.deepEqual(weapon.range, {normal:20,long:60});
});

test('heavy armor reduces speed for low Strength, except for a dwarf', () => {
  for (const [species, expectedSpeed] of [['human',20], ['hill-dwarf',25]]) {
    const source = input('fighter', species);
    [source.baseScores.STR, source.baseScores.CHA] = [source.baseScores.CHA, source.baseScores.STR];
    assert.equal(buildHero(source).build.speed, expectedSpeed);
  }
});

test('owned weapon, shield, grip, weapon package and class requirements are enforced', () => {
  const foreign = input('wizard'); foreign.equippedWeaponId = 'rapier';
  rejects(foreign, 'weapon_not_owned');
  const shield = input('rogue'); shield.shieldEquipped = true;
  rejects(shield, 'shield_not_owned');
  const conflict = input(); conflict.weaponGrip = 'two-handed';
  rejects(conflict, 'shield_hand_conflict');
  const grip = input('rogue'); grip.weaponGrip = 'two-handed';
  rejects(grip, 'invalid_weapon_grip');
  const invalid = input(); invalid.equipment.martialWeapons = ['dagger'];
  rejects(invalid, 'invalid_weapon_category');
  const classMismatch = input('wizard'); classMismatch.equipment = input().equipment;
  rejects(classMismatch, 'invalid_equipment_class');
});

test('two-weapon starting package may own two equal weapons without granting an extra attack', () => {
  const source = input(); source.equipment.weaponPackage = 'two-weapons';
  source.equipment.martialWeapons = ['shortsword', 'shortsword'];
  equip(source, 'shortsword');
  const hero = buildHero(source);
  assert.equal(hero.build.inventory.find(item => item.id === 'shortsword').quantity, 2);
  assert.equal(hero.build.inventory.some(item => item.id === 'shield'), false);
  assert.equal(hero.build.weapon.damageDice, 1);
});

test('wizard has three class cantrips, six book spells, INT+1 prepared and two spell slots', () => {
  const hero = buildHero(input('wizard'));
  assert.equal(hero.build.cantrips.length, 3); assert.equal(hero.build.spellbook.length, 6);
  assert.equal(hero.build.preparedSpells.length, 4);
  assert.equal(hero.build.spellAttackBonus, 5); assert.equal(hero.build.spellSaveDc, 13);
  assert.equal(hero.spellSlots, 2); assert.equal(hero.build.arcaneRecovery, 1);
  assert.equal(Object.keys(CANTRIP_OPTIONS).length, 6);
  assert.equal(Object.keys(FIRST_LEVEL_SPELL_OPTIONS).length, 7);
});

test('wizard knows supported rituals without inventing abilities or accepting unsupported spells', () => {
  const source = input('wizard'); source.spellbook[5] = 'detect-magic';
  source.preparedSpells[3] = 'detect-magic';
  assert.ok(buildHero(source).build.preparedSpells.includes('detect-magic'));
  assert.equal(FIRST_LEVEL_SPELL_OPTIONS['detect-magic'].ritual, true);
  source.spellbook[0] = 'wish'; rejects(source, 'invalid_option', 'spellbook');
});

test('wizard rejects duplicate lists, wrong preparation count and spells absent from the book', () => {
  const duplicate = input('wizard'); duplicate.cantrips[1] = duplicate.cantrips[0];
  rejects(duplicate, 'duplicate_choice');
  const count = input('wizard'); count.preparedSpells.pop();
  rejects(count, 'invalid_choice_count', 'preparedSpells');
  const missing = input('wizard'); missing.preparedSpells[3] = 'detect-magic';
  rejects(missing, 'spell_not_in_book');
  const fighter = input(); fighter.cantrips = ['fire-bolt'];
  rejects(fighter, 'invalid_choice_count', 'cantrips');
});

test('racial cantrip stays separate and cannot duplicate a wizard class cantrip', () => {
  const source = input('wizard', 'high-elf'); source.racialCantrip = 'fire-bolt';
  rejects(source, 'duplicate_cantrip');
  const fighter = buildHero(input('fighter', 'high-elf'));
  assert.equal(fighter.build.racialCantrip, 'fire-bolt'); assert.deepEqual(fighter.build.cantrips, []);
  assert.equal(fighter.build.spellSlotMaximum, 0);
});

test('profile fields are bounded story hooks and never mechanical authority', () => {
  const source = input(); source.profile.backstory = '我自称远古神祇，并说我拥有无限生命。';
  const hero = buildHero(source);
  assert.equal(hero.hp, 12); assert.equal(hero.build.profile.backstory, source.profile.backstory);
  source.profile.cooperation = ' '; rejects(source, 'invalid_text', 'profile.cooperation');
  const long = input(); long.profile.flaw = 'a'.repeat(301);
  rejects(long, 'invalid_text', 'profile.flaw');
  const traits = input(); traits.profile.personality = ['One'];
  rejects(traits, 'invalid_choice_count', 'profile.personality');
});

test('catalog validation rejects prototype names rather than looking them up', () => {
  const source = input(); source.classId = 'constructor'; rejects(source, 'invalid_option', 'classId');
  const skill = input(); skill.backgroundSkills[0] = 'toString'; rejects(skill, 'invalid_option');
  const spell = input('wizard'); spell.spellbook[0] = '__proto__'; rejects(spell, 'invalid_option');
});

test('returned arrays and profile do not alias request or default metadata', () => {
  const source = input(), before = structuredClone(source), hero = buildHero(source);
  hero.build.equipment.martialWeapons.push('rapier'); hero.build.profile.personality[0] = 'Changed';
  hero.build.classSkills.push('perception'); hero.build.weapon.properties.push('invented');
  assert.deepEqual(source, before);
  assert.deepEqual(buildHero(input()).build.weapon.properties, ['versatile']);
});

test('request cannot inject mechanical fields or persist arbitrary equipment scripts', () => {
  const source = input(); source.hp = 1000; source.ac = 1000;
  source.equipment.script = 'grantUnlimitedAttacks()';
  const hero = buildHero(source);
  assert.equal(hero.hp, 12); assert.equal(hero.ac, 19);
  assert.equal(Object.hasOwn(hero.build.equipment, 'script'), false);
});

test('starting pack produces real finite gear and quantities', () => {
  const inventory = buildHero(input()).build.inventory;
  assert.equal(inventory.find(item => item.id === 'hempen-rope-50ft').quantity, 1);
  assert.equal(inventory.find(item => item.id === 'torch').quantity, 10);
  assert.equal(inventory.find(item => item.id === 'rations-day').quantity, 10);
  const rogue = buildHero(input('rogue')).build.inventory;
  assert.equal(rogue.find(item => item.id === 'ball-bearings').quantity, 1000);
  assert.equal(rogue.find(item => item.id === 'oil-flask').quantity, 2);
  const wizard = buildHero(input('wizard')).build.inventory;
  assert.equal(wizard.find(item => item.id === 'parchment').quantity, 10);
  assert.equal(wizard.some(item => item.id === 'torch'), false);
});
