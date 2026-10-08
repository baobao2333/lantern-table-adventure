import {
  CANTRIP_OPTIONS,
  FIRST_LEVEL_SPELL_OPTIONS,
} from "./character-builder.ts";
import { attackRoll, checkRoll, randomDie, type Die } from "./dice.ts";
import type {
  CantripId,
  FirstLevelSpellId,
  Game,
  Hero,
  Roll,
  SpellEffect,
} from "./types.ts";

export type SpellId = CantripId | FirstLevelSpellId;
export type SpellOptions = { ritual?: boolean; inCombat?: boolean };
export type SpellAvailability = {
  allowed: boolean;
  reason?: string;
  slotCost: number;
  castMinutes: number;
};
export type SpellResult = {
  fact: string;
  rolls: Roll[];
  castMinutes: number;
  resolvedConflict?: boolean;
};
type SpellDefinition = {
  name: string;
  description: string;
  level: 0 | 1;
  capability: "combat" | "exploration";
  castMinutes: number;
  durationMinutes: number;
  ritual: boolean;
  concentration: boolean;
};
export const SPELLS: Record<SpellId, SpellDefinition> = {
  "fire-bolt": {
    ...CANTRIP_OPTIONS["fire-bolt"],
    level: 0,
    castMinutes: 0.1,
    durationMinutes: 0,
    ritual: false,
    concentration: false,
  },
  light: {
    ...CANTRIP_OPTIONS.light,
    level: 0,
    castMinutes: 0.1,
    durationMinutes: 60,
    ritual: false,
    concentration: false,
  },
  "mage-hand": {
    ...CANTRIP_OPTIONS["mage-hand"],
    level: 0,
    castMinutes: 0.1,
    durationMinutes: 1,
    ritual: false,
    concentration: false,
  },
  "minor-illusion": {
    ...CANTRIP_OPTIONS["minor-illusion"],
    level: 0,
    castMinutes: 0.1,
    durationMinutes: 1,
    ritual: false,
    concentration: false,
  },
  prestidigitation: {
    ...CANTRIP_OPTIONS.prestidigitation,
    level: 0,
    castMinutes: 0.1,
    durationMinutes: 60,
    ritual: false,
    concentration: false,
  },
  mending: {
    ...CANTRIP_OPTIONS.mending,
    level: 0,
    castMinutes: 1,
    durationMinutes: 0,
    ritual: false,
    concentration: false,
  },
  "magic-missile": {
    ...FIRST_LEVEL_SPELL_OPTIONS["magic-missile"],
    level: 1,
    castMinutes: 0.1,
    durationMinutes: 0,
    ritual: false,
    concentration: false,
  },
  "mage-armor": {
    ...FIRST_LEVEL_SPELL_OPTIONS["mage-armor"],
    level: 1,
    capability: "exploration",
    castMinutes: 0.1,
    durationMinutes: 480,
    ritual: false,
    concentration: false,
  },
  sleep: {
    ...FIRST_LEVEL_SPELL_OPTIONS.sleep,
    level: 1,
    castMinutes: 0.1,
    durationMinutes: 1,
    ritual: false,
    concentration: false,
  },
  "burning-hands": {
    ...FIRST_LEVEL_SPELL_OPTIONS["burning-hands"],
    level: 1,
    castMinutes: 0.1,
    durationMinutes: 0,
    ritual: false,
    concentration: false,
  },
  "disguise-self": {
    ...FIRST_LEVEL_SPELL_OPTIONS["disguise-self"],
    level: 1,
    castMinutes: 0.1,
    durationMinutes: 60,
    ritual: false,
    concentration: false,
  },
  "comprehend-languages": {
    ...FIRST_LEVEL_SPELL_OPTIONS["comprehend-languages"],
    level: 1,
    castMinutes: 0.1,
    durationMinutes: 60,
    ritual: true,
    concentration: false,
  },
  "detect-magic": {
    ...FIRST_LEVEL_SPELL_OPTIONS["detect-magic"],
    level: 1,
    castMinutes: 0.1,
    durationMinutes: 10,
    ritual: true,
    concentration: true,
  },
};
export function halflingLucky(hero: Hero): boolean {
  return !!hero.build?.traits.includes("halfling-lucky");
}
export function activeSpellEffects(hero: Hero, game: Game): SpellEffect[] {
  const now = game.elapsedMinutes ?? 0;
  return (hero.activeSpellEffects ?? []).filter(
    (effect) => effect.expiresAt > now && effect.startedAt <= now,
  );
}
export function advanceSpellTime(game: Game, minutes: number): void {
  if (!Number.isFinite(minutes) || minutes < 0)
    throw new Error("法术时间必须是非负的有限分钟数。");
  game.elapsedMinutes = (game.elapsedMinutes ?? 0) + minutes;
  for (const { hero } of game.players) {
    if (hero.activeSpellEffects)
      hero.activeSpellEffects = hero.activeSpellEffects.filter(
        (effect) => effect.expiresAt > game.elapsedMinutes!,
      );
  }
}
export function isExplorationSpell(id: string): id is SpellId {
  return (
    Object.hasOwn(SPELLS, id) &&
    SPELLS[id as SpellId].capability === "exploration"
  );
}
export function spellAvailability(
  hero: Hero,
  id: string,
  options: SpellOptions = {},
): SpellAvailability {
  const unavailable = (reason: string): SpellAvailability => ({
    allowed: false,
    reason,
    slotCost: 0,
    castMinutes: 0,
  });
  if (!Object.hasOwn(SPELLS, id)) return unavailable("这个法术尚未支持。");
  const spellId = id as SpellId,
    spell = SPELLS[spellId],
    ritual = !!options.ritual;
  if (ritual && (!spell.ritual || hero.classId !== "wizard"))
    return unavailable("只有法师法术书中的仪式法术可以这样施放。");
  if (options.inCombat && (ritual || spell.castMinutes > 0.1))
    return unavailable("这个法术所需时间超过一个战斗动作。");
  if (!options.inCombat && spell.capability === "combat")
    return unavailable(
      "这个法术需要当前冲突目标；探索行动不能凭法术自动取得目标。",
    );
  if (!hero.build) {
    if (
      hero.classId !== "wizard" ||
      !["fire-bolt", "magic-missile"].includes(spellId) ||
      ritual
    )
      return unavailable("旧教学角色只支持模板中的火焰箭与魔法飞弹。");
  } else if (spell.level === 0) {
    if (
      !hero.build.cantrips.includes(spellId as CantripId) &&
      hero.build.racialCantrip !== spellId
    )
      return unavailable("你的角色没有学习这个戏法。");
  } else {
    if (
      hero.classId !== "wizard" ||
      !hero.build.spellbook.includes(spellId as FirstLevelSpellId)
    )
      return unavailable("这个法术不在你的法术书中。");
    if (
      !ritual &&
      !hero.build.preparedSpells.includes(spellId as FirstLevelSpellId)
    )
      return unavailable("这个法术尚未准备；本存档沿用创建时的准备列表。");
  }
  if (spellId === "mage-armor" && hero.build?.armorId !== "none")
    return unavailable("法师护甲只能施放在未穿护甲的自己身上。");
  const slotCost = spell.level === 1 && !ritual ? 1 : 0;
  if (slotCost && hero.spellSlots < slotCost)
    return unavailable("你已经没有可用的一环法术位。");
  return {
    allowed: true,
    slotCost,
    castMinutes: spell.castMinutes + (ritual ? 10 : 0),
  };
}
export function effectiveArmorClass(hero: Hero, game: Game): number {
  if (
    hero.build?.armorId !== "none" ||
    !activeSpellEffects(hero, game).some(
      (effect) => effect.spellId === "mage-armor",
    )
  )
    return hero.ac;
  return Math.max(
    hero.ac,
    13 +
      Math.floor((hero.abilities.DEX - 10) / 2) +
      (hero.build.shieldEquipped ? 2 : 0),
  );
}
function damageRoll(
  label: string,
  values: number[],
  modifier: number,
  amount?: number,
): Roll {
  const sum = values.reduce((a, b) => a + b, 0),
    total = amount ?? Math.max(0, sum + modifier);
  return {
    label,
    rolls: values,
    kept: sum,
    modifier,
    total,
    damage: total,
    target: 0,
    success: true,
    kind: "damage",
    explanation: `伤害骰 ${values.join(" + ")}，固定加值 ${modifier}，结算 ${total} 点伤害。`,
  };
}
/** Mutates only the canonical actor, encounter and spell effects; callers own world clocks and elapsed time. */
export function castSpell(
  game: Game,
  hero: Hero,
  id: string,
  die: Die = randomDie,
  options: SpellOptions = {},
): SpellResult {
  const availability = spellAvailability(hero, id, {
    ...options,
    inCombat: !!game.combat,
  });
  if (!availability.allowed) throw new Error(availability.reason);
  const spellId = id as SpellId,
    spell = SPELLS[spellId],
    rolls: Roll[] = [],
    combat = game.combat;
  if (spell.capability === "combat" && !combat)
    throw new Error("这里没有可结算的冲突目标。");
  hero.spellSlots -= availability.slotCost;
  const resource = availability.slotCost
    ? "消耗 1 个一环法术位。"
    : options.ritual
      ? "仪式施法额外花费 10 分钟，不消耗法术位。"
      : "不消耗法术位。";
  let fact = "",
    resolvedConflict = false;
  if (spellId === "fire-bolt") {
    const modifier =
      hero.build?.spellAttackBonus ??
      Math.floor((hero.abilities.INT - 10) / 2) + 2;
    const roll = attackRoll("火焰箭", modifier, combat!.enemy.ac, die, false, {
      lucky: halflingLucky(hero),
    });
    if (roll.success) {
      const values = Array.from({ length: roll.kept === 20 ? 2 : 1 }, () =>
        die(10),
      );
      roll.damage = values.reduce((a, b) => a + b, 0);
      combat!.enemy.hp = Math.max(0, combat!.enemy.hp - roll.damage);
      roll.explanation += ` 伤害骰 ${values.join(" + ")}，固定加值 0，共 ${roll.damage} 点火焰伤害。`;
    }
    rolls.push(roll);
    fact = `${hero.name}施放火焰箭，${roll.success ? `造成 ${roll.damage} 点火焰伤害` : "未能命中"}。`;
  } else if (spellId === "magic-missile") {
    const values = [die(4), die(4), die(4)],
      roll = damageRoll("魔法飞弹", values, 3);
    roll.explanation +=
      "三枚飞弹同时击中当前可见目标；本桌只结算这个冲突目标。";
    combat!.enemy.hp = Math.max(0, combat!.enemy.hp - roll.total);
    rolls.push(roll);
    fact = `${hero.name}施放魔法飞弹，三枚飞弹造成 ${roll.total} 点力场伤害。`;
  } else if (spellId === "sleep") {
    const values = Array.from({ length: 5 }, () => die(8)),
      pool = values.reduce((a, b) => a + b, 0),
      immune = !!combat!.enemy.sleepImmune;
    resolvedConflict = !immune && combat!.enemy.hp <= pool;
    rolls.push({
      label: "睡眠术生命池",
      rolls: values,
      kept: pool,
      modifier: 0,
      total: pool,
      target: combat!.enemy.hp,
      success: resolvedConflict,
      kind: "damage",
      explanation: `5d8 得到 ${pool} 点生命池；这是效果阈值，不造成伤害。${immune ? "目标免疫魔法睡眠。" : `当前目标生命 ${combat!.enemy.hp}。`}单目标抽象不包含其他生物。`,
    });
    fact = resolvedConflict
      ? `${hero.name}施放睡眠术，目标进入可被唤醒的 1 分钟魔法睡眠。队伍安全控制现场，以非致命方式结束冲突；目标没有受到伤害或死亡。`
      : `${hero.name}施放睡眠术，${immune ? "目标免疫魔法睡眠" : "生命池不足以影响当前目标"}；法术位仍已消耗。`;
  } else if (spellId === "burning-hands") {
    const values = [die(6), die(6), die(6)],
      sum = values.reduce((a, b) => a + b, 0);
    const dc =
      hero.build?.spellSaveDc ?? 10 + Math.floor((hero.abilities.INT - 10) / 2);
    const save = checkRoll(
      `${combat!.enemy.name}的敏捷豁免`,
      combat!.enemy.dex,
      dc,
      false,
      die,
    );
    save.explanation =
      "单目标抽象：当前敌人位于 15 尺锥形内。" +
      save.explanation.replace("技能检定", "豁免");
    const roll = damageRoll(
      "燃烧之手",
      values,
      0,
      save.success ? Math.floor(sum / 2) : sum,
    );
    roll.explanation += save.success
      ? "敏捷豁免成功，伤害向下取整减半。"
      : "敏捷豁免失败，承受全额伤害。";
    combat!.enemy.hp = Math.max(0, combat!.enemy.hp - roll.total);
    rolls.push(save, roll);
    fact = `${hero.name}施放燃烧之手，目标敏捷豁免${save.success ? "成功" : "失败"}，受到 ${roll.total} 点火焰伤害；锥形区域只结算当前冲突目标。`;
  } else {
    const now = game.elapsedMinutes ?? 0,
      starts = now + availability.castMinutes;
    hero.activeSpellEffects = (hero.activeSpellEffects ?? []).filter(
      (effect) =>
        effect.expiresAt > now &&
        effect.spellId !== spellId &&
        (!spell.concentration || !effect.concentration),
    );
    if (spell.durationMinutes)
      hero.activeSpellEffects.push({
        spellId,
        casterId: hero.id,
        startedAt: starts,
        expiresAt: starts + spell.durationMinutes,
        concentration: spell.concentration,
        description: spell.description,
      });
    fact = `${hero.name}施放${spell.name}。${spell.description}${spell.durationMinutes ? `效果持续 ${spell.durationMinutes} 分钟${spell.concentration ? "，需要保持专注" : ""}。` : "效果为即时的有限修补。"}这不会自动授予线索、成功或对人物的控制。`;
  }
  return {
    fact: fact + resource,
    rolls,
    castMinutes: availability.castMinutes,
    ...(resolvedConflict ? { resolvedConflict: true } : {}),
  };
}
export function checkConcentration(
  game: Game,
  hero: Hero,
  amount: number,
  die: Die = randomDie,
): Roll | null {
  if (
    amount <= 0 ||
    !activeSpellEffects(hero, game).some((effect) => effect.concentration)
  )
    return null;
  const modifier =
    Math.floor((hero.abilities.CON - 10) / 2) +
    (hero.build?.savingThrowProficiencies.includes("CON") ? 2 : 0);
  const roll = checkRoll(
    `${hero.name}的专注体质豁免`,
    modifier,
    Math.max(10, Math.floor(amount / 2)),
    false,
    die,
    { lucky: halflingLucky(hero) },
  );
  roll.explanation =
    "受伤后检查法术专注：DC 为 10 或伤害的一半，取较高值。" +
    roll.explanation.replace("技能检定", "豁免");
  if (!roll.success)
    hero.activeSpellEffects = (hero.activeSpellEffects ?? []).filter(
      (effect) => !effect.concentration,
    );
  return roll;
}
function chapter(game: Game): number {
  return game.world?.session ?? 1;
}
export function arcaneRecoveryAvailable(game: Game, hero: Hero): boolean {
  return (
    !!hero.build &&
    hero.classId === "wizard" &&
    hero.spellSlots < hero.build.spellSlotMaximum &&
    hero.arcaneRecoveryUsedChapter !== chapter(game)
  );
}
export function recoverArcane(game: Game, hero: Hero): number {
  if (!arcaneRecoveryAvailable(game, hero)) return 0;
  hero.arcaneRecoveryUsedChapter = chapter(game);
  const restored = Math.min(1, hero.build!.spellSlotMaximum - hero.spellSlots);
  hero.spellSlots += restored;
  return restored;
}
