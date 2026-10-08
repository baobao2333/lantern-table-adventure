import type { Roll } from "./types.ts";
export type Die = (sides: number) => number;
export function randomDie(sides: number) {
  const limit = Math.floor(0x100000000 / sides) * sides;
  const buffer = new Uint32Array(1);
  do {
    crypto.getRandomValues(buffer);
  } while (buffer[0] >= limit);
  return (buffer[0] % sides) + 1;
}
export type D20Options = {
  disadvantage?: boolean;
  advantage?: boolean;
  lucky?: boolean;
  disadvantageReason?: string;
};
function d20(
  advantage: boolean,
  disadvantage: boolean,
  lucky: boolean,
  die: Die,
) {
  const mode =
    advantage === disadvantage
      ? "normal"
      : advantage
        ? "advantage"
        : "disadvantage";
  const rolls = mode === "normal" ? [die(20)] : [die(20), die(20)];
  const rerolls: NonNullable<Roll["rerolls"]> = [];
  // Advantage/disadvantage permits rerolling only one of the two dice.
  const index = lucky ? rolls.indexOf(1) : -1;
  if (index >= 0) {
    const replacement = die(20);
    rerolls.push({ dieIndex: index, original: 1, replacement });
    rolls[index] = replacement;
  }
  const kept =
    mode === "disadvantage" ? Math.min(...rolls) : Math.max(...rolls);
  const explanation = `${mode === "advantage" ? "优势：两颗 d20 取高值。" : mode === "disadvantage" ? "劣势：两颗 d20 取低值。" : advantage && disadvantage ? "优势与劣势抵消，一颗 d20。" : "一颗 d20。"}${rerolls.length ? `半身人幸运：第 ${index + 1} 颗原值 1，重掷为 ${rolls[index]}，必须使用新值，不再次重掷。` : ""}`;
  return { rolls, kept, rerolls, explanation };
}
export function checkRoll(
  label: string,
  modifier: number,
  target: number,
  advantage: boolean,
  die: Die = randomDie,
  options: D20Options = {},
): Roll {
  const rolled = d20(advantage, !!options.disadvantage, !!options.lucky, die);
  const total = rolled.kept + modifier;
  return {
    ...rolled,
    label,
    modifier,
    total,
    target,
    success: total >= target,
    kind: "check",
    explanation:
      rolled.explanation +
      "总值达到难度即成功；技能检定自然 1 和 20 没有额外效果。",
  };
}
export function attackRoll(
  label: string,
  modifier: number,
  ac: number,
  die: Die = randomDie,
  disadvantage = false,
  options: D20Options = {},
): Roll {
  const rolled = d20(
    !!options.advantage,
    disadvantage || !!options.disadvantage,
    !!options.lucky,
    die,
  );
  const total = rolled.kept + modifier;
  return {
    ...rolled,
    label,
    modifier,
    total,
    target: ac,
    success: rolled.kept === 20 || (rolled.kept !== 1 && total >= ac),
    kind: "attack",
    explanation:
      rolled.explanation +
      (options.disadvantageReason ? `${options.disadvantageReason}。` : "") +
      (rolled.kept === 20
        ? "自然 20：必定命中，伤害骰翻倍，固定加值不翻倍。"
        : rolled.kept === 1
          ? "自然 1：攻击必定失手。"
          : "命中总值达到护甲等级即命中。"),
  };
}
export function initiativeRoll(
  label: string,
  modifier: number,
  die: Die = randomDie,
  lucky = false,
): Roll {
  const rolled = d20(false, false, lucky, die);
  return {
    ...rolled,
    label,
    modifier,
    total: rolled.kept + modifier,
    target: 0,
    success: true,
    kind: "initiative",
    explanation:
      rolled.explanation + "d20 + 敏捷调整值；高者先行动，同值时冒险者优先。",
  };
}
