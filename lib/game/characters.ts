import type { Ability, Hero, HeroClass, Skill } from "./types";

export const ABILITIES: Record<Ability, string> = { STR: "力量", DEX: "敏捷", CON: "体质", INT: "智力", WIS: "感知", CHA: "魅力" };
export const SKILLS: Record<Skill, { name: string; ability: Ability }> = {
  athletics: { name: "运动", ability: "STR" }, stealth: { name: "隐匿", ability: "DEX" },
  investigation: { name: "调查", ability: "INT" }, perception: { name: "察觉", ability: "WIS" },
  insight: { name: "洞悉", ability: "WIS" }, persuasion: { name: "游说", ability: "CHA" },
  arcana: { name: "奥秘", ability: "INT" },
};
export const CLASSES = {
  fighter: { name: "战士", subtitle: "可靠的前线守护者", icon: "sword", color: "#dba16b", hp: 12, ac: 16,
    abilities: { STR: 16, DEX: 12, CON: 14, INT: 10, WIS: 13, CHA: 8 }, skills: ["athletics", "perception"] as Skill[],
    feature: "复苏之风：用附赠动作恢复 1d10 + 1 生命；短休后恢复使用次数。", weapon: "长剑", die: 8, ability: "STR" as Ability },
  rogue: { name: "游荡者", subtitle: "从蛛丝马迹中找到出路", icon: "key", color: "#a29ad7", hp: 9, ac: 14,
    abilities: { STR: 10, DEX: 16, CON: 12, INT: 13, WIS: 14, CHA: 8 }, skills: ["stealth", "investigation", "perception", "insight"] as Skill[],
    feature: "隐匿与调查专精；满足条件时，偷袭额外造成 1d6 伤害。", weapon: "短弓", die: 6, ability: "DEX" as Ability },
  wizard: { name: "法师", subtitle: "用知识照亮未知", icon: "spark", color: "#73b9d1", hp: 7, ac: 12,
    abilities: { STR: 8, DEX: 14, CON: 12, INT: 16, WIS: 13, CHA: 10 }, skills: ["arcana", "investigation"] as Skill[],
    feature: "火焰箭戏法不消耗法术位；魔法飞弹消耗 1 个法术位，自动命中并造成 3d4 + 3 伤害。", weapon: "火焰箭", die: 10, ability: "INT" as Ability },
};
export function abilityMod(score: number) { return Math.floor((score - 10) / 2); }
export function skillMod(hero: Hero, skill: Skill) {
  const proficient = hero.skills.includes(skill);
  const expertise = hero.classId === "rogue" && ["stealth", "investigation"].includes(skill);
  return abilityMod(hero.abilities[SKILLS[skill].ability]) + (proficient ? expertise ? 4 : 2 : 0);
}
export function createHero(id: string, classId: HeroClass, name: string, background = "") : Hero {
  const preset = CLASSES[classId];
  return { id, name, classId, species: "人类", background: background || "第一次离开家乡，带着好奇与一点紧张上路。",
    abilities: { ...preset.abilities }, skills: [...preset.skills], hp: preset.hp, maxHp: preset.hp, ac: preset.ac,
    potions: 2, hitDice: 1, secondWind: classId === "fighter" ? 1 : 0, spellSlots: classId === "wizard" ? 2 : 0 };
}
