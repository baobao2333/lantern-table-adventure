import { campaignById, campaignForGame } from "./campaigns.ts";
import { abilityMod, CLASSES, skillMod, SKILLS } from "./characters.ts";
import type {
  Action,
  Enemy,
  Game,
  GameResolutionOptions,
  Hero,
  PartyRestChoices,
  Player,
  Resolution,
  Roll,
  View,
} from "./types.ts";
import {
  initializeWorld,
  resolveWorld,
  worldActions,
  worldView,
  eligibleGoals,
  completeWorldGoal,
  advanceTime,
} from "./world-engine.ts";
import {
  advanceSpellTime,
  arcaneRecoveryAvailable,
  castSpell,
  checkConcentration,
  effectiveArmorClass,
  halflingLucky,
  recoverArcane,
} from "./spells.ts";

import {
  randomDie,
  checkRoll,
  attackRoll,
  initiativeRoll,
  type Die,
} from "./dice.ts";
export { randomDie, checkRoll, attackRoll } from "./dice.ts";
export type { Die } from "./dice.ts";
export type { GameResolutionOptions, PartyRestChoice, PartyRestChoices } from "./types.ts";
export type Command = {
  kind:
    | "action"
    | "roll"
    | "attack"
    | "missile"
    | "dodge"
    | "potion"
    | "wind"
    | "rest"
    | "retreat"
    | "start"
    | "confirm"
    | "cancel"
    | "session"
    | "spell";
  actionId?: string;
  targetHeroId?: string;
};

export function addMessage(
  game: Game,
  role: "dm" | "player" | "system",
  text: string,
  actor?: string,
  roll?: Roll,
  ai = false,
) {
  game.messages.push({ id: crypto.randomUUID(), role, text, actor, roll, ai });
  if (game.messages.length > 180)
    game.messages.splice(0, game.messages.length - 180);
}
export function createGame(
  id: string,
  owner: string,
  hero: Hero,
  campaignId: string,
  mode: "solo" | "party",
  roomCode: string,
  campaign = campaignById(campaignId),
): Game {
  if (campaign.id !== campaignId) throw new Error("冒险模组与所选 ID 不一致。");
  const state: Game = {
    id,
    owner,
    roomCode,
    mode,
    campaignId,
    campaignRevision: campaign.revision,
    campaignSnapshot: structuredClone(campaign),
    players: [{ userId: owner, hero: structuredClone(hero) }],
    status: mode === "solo" ? "active" : "waiting",
    scene: 0,
    clues: [],
    flags: [],
    danger: 0,
    turns: 0,
    pending: null,
    combat: null,
    messages: [],
    ending: null,
    requestIds: [],
  };
  addMessage(state, "dm", campaign.hook);
  initializeWorld(state);
  addMessage(
    state,
    "system",
    state.world
      ? `这是 SRD 5.1 一级规则子集与公开房规的持续战役。你可以点选行动，也可以用自己的话和主持人交流。行动先说明规则与后果，再确认执行。${mode === "party" ? "个人生命降至 0 时倒地，全队失能才由新手救援结束冒险。" : "生命降至 0 时使用新手救援房规：本次冒险结束，角色获救。"}叙事时钟记录局势，法术持续时间另按真实分钟记录。`
      : `这是一级角色教学冒险。你可以点选行动，也可以用自己的话和主持人交流。所有检定会先展示规则；${mode === "party" ? "个人生命降至 0 时倒地，全队失能才由新手救援结束冒险。" : "生命降至 0 时使用新手救援房规：冒险结束，角色获救。"}危险刻度记录失败与延误，达到 4 时会影响结局。`,
  );
  if (mode === "party") addMessage(state, "system", "多人救援房规：0 生命角色倒地，不能行动且失去专注；敌人不攻击倒地者。同伴可花费主要动作与自己的一瓶治疗药水救起，目标从下次自己的回合开始行动。全队失能才结束本次冒险并获救，不进行标准死亡豁免。");
  return state;
}
function attemptFlag(game: Game, action: Action) {
  return `attempt:${game.scene}:${action.id}`;
}
export function availableActions(game: Game) {
  if (game.world) return worldActions(game);
  if (game.status !== "active" || game.pending || game.combat) return [];
  return campaignForGame(game).scenes[game.scene].actions.filter(
    (action) =>
      !(action.requiresClue && !game.clues.includes(action.requiresClue)) &&
      !(
        (action.clue || action.flag) &&
        action.next === undefined &&
        !action.ending &&
        (!action.clue || game.clues.includes(action.clue)) &&
        (!action.flag || game.flags.includes(action.flag))
      ) &&
      !game.flags.includes(attemptFlag(game, action)),
  );
}
function endGame(game: Game, ending: string) {
  game.status = "complete";
  game.ending = ending;
  game.pending = null;
  game.combat = null;
}
function damage(
  game: Game,
  hero: Hero,
  amount: number,
  rolls: Roll[],
  die: Die,
) {
  hero.hp = Math.max(0, hero.hp - Math.max(0, amount));
  if (hero.hp === 0) {
    hero.activeSpellEffects = (hero.activeSpellEffects ?? []).filter(
      (effect) => !effect.concentration,
    );
    if (game.mode === "party") {
      if (game.combat) game.combat.guard = game.combat.guard.filter(id => id !== hero.id);
      addMessage(game, "system", `${hero.name}的生命降至 0，已经倒地，不能行动且失去专注。敌人不再攻击这位倒地者；同伴可以使用自己的治疗药水救援。`);
      if (game.players.every(player => player.hero.hp <= 0)) rescueParty(game);
      return;
    }
    // This explicitly advertised house rule replaces death saves in the teaching mode.
    endGame(game, "retreat");
    addMessage(
      game,
      "system",
      `${hero.name}的生命降至 0。同伴或附近居民将你带回安全地带；本次冒险结束。新手救援房规生效，没有进行标准死亡豁免。`,
    );
  } else {
    const concentration = checkConcentration(game, hero, amount, die);
    if (concentration) rolls.push(concentration);
  }
}
function rescueParty(game: Game) {
  endGame(game, "retreat");
  addMessage(game, "system", "全队已经失去行动能力。附近居民或旅人将队伍带回安全地带，本次冒险结束。多人新手救援房规生效，没有进行标准死亡豁免。");
}
function finishAction(
  game: Game,
  action: Action,
  success: boolean,
  hero: Hero,
  rolls: Roll[],
  die: Die,
) {
  if (success) {
    if (action.clue && !game.clues.includes(action.clue))
      game.clues.push(action.clue);
    if (action.flag && !game.flags.includes(action.flag))
      game.flags.push(action.flag);
    if (action.timeCost) game.danger += action.timeCost;
    if (action.next !== undefined) game.scene = action.next;
    if (action.ending) endGame(game, action.ending);
  } else {
    game.danger++;
    if (action.failureDamage)
      damage(game, hero, action.failureDamage, rolls, die);
  }
  game.danger = Math.min(6, game.danger);
}
function healingRoll(
  label: string,
  sides: number,
  count: number,
  modifier: number,
  die: Die,
): Roll {
  const rolls = Array.from({ length: count }, () => die(sides));
  const total = Math.max(0, rolls.reduce((a, b) => a + b, 0) + modifier);
  return {
    label,
    rolls,
    kept: rolls.reduce((a, b) => a + b, 0),
    modifier,
    total,
    target: 0,
    success: true,
    kind: "healing",
    explanation: `${count}d${sides} ${modifier < 0 ? "−" : "+"} ${Math.abs(modifier)}；治疗不超过最大生命。`,
  };
}
export function currentPlayer(game: Game): Player | undefined {
  const combat = game.combat;
  return combat
    ? game.players.find((p) => p.hero.id === combat.order[combat.turn])
    : undefined;
}
function victory(game: Game, asleep = false) {
  const combat = game.combat!;
  if (!game.world) game.scene = combat.next;
  game.combat = null;
  if (game.world?.battleGoal) {
    const goal = game.campaignSnapshot.world!.opportunities.find(
      (g) => g.id === game.world!.battleGoal,
    )!;
    completeWorldGoal(game, goal);
    delete game.world.battleGoal;
    addMessage(game, "system", goal.success.text);
  }
  if (combat.clue && !game.clues.includes(combat.clue))
    game.clues.push(combat.clue);
  addMessage(
    game,
    "system",
    `${asleep ? "对手陷入可以唤醒的魔法睡眠，队伍控制了现场，非致命冲突结束。" : "对手失去战斗能力，冲突结束。"}${game.world ? "队伍仍在当前地点，可以继续探索或自行移动。" : "你进入下一处场景。"}${combat.clue ? "并发现一条线索。" : ""}`,
  );
}
function enemyTurn(game: Game, rolls: Roll[], die: Die) {
  const combat = game.combat;
  if (!combat) return;
  const targets = game.mode === "party" ? game.players.filter(player => player.hero.hp > 0) : game.players;
  if (!targets.length) { rescueParty(game); return; }
  const target = targets[(combat.round - 1) % targets.length].hero;
  const roll = attackRoll(
    `${combat.enemy.name} → ${target.name}`,
    combat.enemy.attackBonus,
    effectiveArmorClass(target, game),
    die,
    combat.guard.includes(target.id),
    {
      disadvantageReason: combat.guard.includes(target.id)
        ? "目标正在闪避"
        : undefined,
    },
  );
  if (roll.success) {
    const count = roll.kept === 20 ? 2 : 1;
    const values = Array.from({ length: count }, () =>
      die(combat.enemy.damageDie),
    );
    roll.damage = Math.max(
      0,
      values.reduce((a, b) => a + b, 0) + combat.enemy.damageBonus,
    );
    roll.explanation += ` 伤害：${values.join(" + ")} + ${combat.enemy.damageBonus} = ${roll.damage}。`;
    damage(game, target, roll.damage, rolls, die);
  }
  rolls.push(roll);
  addMessage(
    game,
    "system",
    roll.success
      ? `${target.name}受到 ${roll.damage} 点伤害。`
      : `${target.name}避开了攻击。`,
    undefined,
    roll,
  );
}
function advancePartyCursor(game: Game) {
  const combat = game.combat;
  if (!combat) return;
  if (game.players.every(player => player.hero.hp <= 0)) { rescueParty(game); return; }
  for (let step = 0; step < combat.order.length; step++) {
    combat.turn = (combat.turn + 1) % combat.order.length;
    if (combat.turn === 0) combat.round++;
    const next = combat.order[combat.turn];
    combat.guard = combat.guard.filter(id => id !== next);
    if (next === "enemy" || game.players.some(player => player.hero.id === next && player.hero.hp > 0)) return;
  }
  throw new Error("战斗顺序中没有可行动角色。");
}
function advanceCombat(game: Game, rolls: Roll[], die: Die) {
  const combat = game.combat;
  if (!combat) return;
  advanceSpellTime(game, 0.1);
  if (game.mode === "party") { advancePartyCursor(game); return; }
  combat.turn = (combat.turn + 1) % combat.order.length;
  if (combat.turn === 0) combat.round++;
  if (combat.order[combat.turn] === "enemy") {
    enemyTurn(game, rolls, die);
    if (!game.combat) return;
    combat.turn = (combat.turn + 1) % combat.order.length;
    if (combat.turn === 0) combat.round++;
  }
  const next = combat.order[combat.turn];
  combat.guard = combat.guard.filter((id) => id !== next);
}
function enterCombat(
  game: Game,
  action: Action,
  rolls: Roll[],
  die: Die,
  enemyOverride?: Enemy,
) {
  const enemy = enemyOverride ?? campaignForGame(game).scenes[game.scene].enemy;
  if (!enemy) throw new Error("这里没有战斗对象。");
  const entries = game.players.map((player) => ({
    id: player.hero.id,
    name: player.hero.name,
    dex: abilityMod(player.hero.abilities.DEX),
  }));
  entries.push({ id: "enemy", name: enemy.name, dex: enemy.dex });
  const scored = entries
    .map((entry) => {
      const actor = game.players.find(
        (player) => player.hero.id === entry.id,
      )?.hero;
      const roll = initiativeRoll(
        `${entry.name}的先攻`,
        entry.dex,
        die,
        !!actor && halflingLucky(actor),
      );
      rolls.push(roll);
      addMessage(
        game,
        "system",
        `${entry.name}的先攻为 ${roll.total}。`,
        undefined,
        roll,
      );
      return { ...entry, total: roll.total };
    })
    .sort(
      (a, b) =>
        b.total - a.total || (a.id === "enemy" ? 1 : b.id === "enemy" ? -1 : 0),
    );
  game.combat = {
    enemy: {
      ...enemy,
      hp: enemy.hp + 4 * (game.players.length - 1),
      maxHp: enemy.hp + 4 * (game.players.length - 1),
    },
    order: scored.map((p) => p.id),
    turn: 0,
    round: 1,
    guard: [],
    next: action.next!,
    clue: action.clue,
  };
  if (scored[0].id === "enemy") {
    if (game.mode === "party") return;
    enemyTurn(game, rolls, die);
    if (game.combat) game.combat.turn = 1;
  } else if (game.mode === "party" && !currentPlayer(game)?.hero.hp) {
    advancePartyCursor(game);
  }
}

export function resolve(
  input: Game,
  userId: string,
  command: Command,
  die: Die = randomDie,
  options: GameResolutionOptions = {},
): Resolution {
  if (
    input.world &&
    ["action", "confirm", "cancel", "session"].includes(command.kind) &&
    !command.actionId?.startsWith("fight:")
  )
    return resolveWorld(input, userId, command, die, options);
  const game = structuredClone(input),
    player = game.players.find((p) => p.userId === userId);
  if (!player) throw new Error("你不在这个房间中。");
  const hero = player.hero,
    rolls: Roll[] = [];
  if (game.mode === "party" && hero.hp <= 0 && !["start", "cancel"].includes(command.kind) && !(options.teamDecision && command.kind === "retreat"))
    throw new Error("角色已经倒地，不能执行行动。请等待同伴救援。");
  let fact = "";
  if (command.kind === "start") {
    if (game.owner !== userId || game.status !== "waiting")
      throw new Error("只有房主能开始等待中的冒险。");
    game.status = "active";
    fact = "队伍准备完毕，冒险开始。";
  } else {
    if (game.status !== "active")
      throw new Error("这场冒险尚未开始或已经结束。");
    if (command.kind === "retreat") {
      if (game.mode === "party" ? !options.teamDecision : game.owner !== userId)
        throw new Error(game.mode === "party" ? "结束全队冒险需要通过团队投票。" : "结束多人冒险需要房主操作。");
      endGame(game, "retreat");
      fact = "你决定带着所见返回安全的地方。";
    } else if (command.kind === "cancel") {
      if (!game.pending || (game.pending.actorId !== hero.id && !options.system))
        throw new Error("只有检定所属玩家可以放弃；系统超时可以关闭检定。");
      game.pending = null;
      fact = "尚未执行的检定已经放弃，没有掷骰、消耗资源或推动世界时间。";
    } else if (command.kind === "roll") {
      const check = game.pending;
      if (!check || check.actorId !== hero.id)
        throw new Error("当前没有等待你掷出的检定。");
      const action = campaignForGame(game).scenes[game.scene].actions.find(
        (a) => a.id === check.actionId,
      )!;
      const roll = checkRoll(
        check.title,
        check.modifier,
        check.dc,
        check.advantage,
        die,
        { disadvantage: check.disadvantage, lucky: halflingLucky(hero) },
      );
      game.flags.push(attemptFlag(game, action));
      game.pending = null;
      rolls.push(roll);
      finishAction(game, action, roll.success, hero, rolls, die);
      advanceSpellTime(game, 1);
      fact = roll.success
        ? `${hero.name}完成「${action.title}」。${action.clue ? "获得了一条线索。" : ""}`
        : `${hero.name}尝试「${action.title}」失败。${check.consequence}危险刻度 +1。同样的方法不能原地重掷，请换一种办法。`;
    } else if (command.kind === "action") {
      const action = availableActions(game).find(
        (a) => a.id === command.actionId,
      );
      if (!action)
        throw new Error("这个行动目前不可用；请刷新后查看当前选项。");
      if (game.mode === "party" && action.kind !== "combat" && (action.next !== undefined || action.ending) && !options.teamDecision)
        throw new Error("移动全队或决定结局需要通过团队投票。");
      if (action.kind === "combat") {
        let encounter: Enemy | undefined;
        if (game.world) {
          const goal = eligibleGoals(game).find(
            (g) => `fight:${g.id}` === action.id,
          );
          if (!goal?.encounter) throw new Error("这个冲突现在不可用。");
          game.world.battleGoal = goal.id;
          action.next = game.scene;
          encounter = goal.encounter;
          advanceTime(game, 1, 0);
        }
        enterCombat(game, action, rolls, die, encounter);
        fact = "战斗开始，双方先攻已经结算。";
      } else if (action.skill && action.dc !== undefined) {
        const advantage =
          !!action.advantageFlag &&
          (game.flags.includes(action.advantageFlag) ||
            game.clues.includes(action.advantageFlag));
        const disadvantage =
          action.skill === "stealth" && !!hero.build?.armorStealthDisadvantage;
        game.pending = {
          id: crypto.randomUUID(),
          actorId: hero.id,
          actionId: action.id,
          title: action.title,
          skill: action.skill,
          dc: action.dc,
          modifier: skillMod(hero, action.skill),
          advantage,
          disadvantage,
          consequence: action.consequence || "耗费时间，危险刻度 +1。",
        };
        fact = `${hero.name}准备「${action.title}」：${SKILLS[action.skill].name}检定，DC ${action.dc}，加值 ${skillMod(hero, action.skill)}${advantage && disadvantage ? "，优势与护甲劣势抵消" : advantage ? "，获得优势" : disadvantage ? "，护甲造成劣势" : ""}。失败：${game.pending.consequence}危险刻度 +1。请确认后掷骰。`;
      } else {
        finishAction(game, action, true, hero, rolls, die);
        advanceSpellTime(game, 1);
        fact = `${hero.name}完成「${action.title}」。这是确定可行的行动，无需掷骰。${action.timeCost ? `绕行与等待使危险刻度 +${action.timeCost}。` : ""}${action.clue ? "发现了一条线索。" : ""}`;
      }
    } else {
      if (game.pending || game.world?.proposal)
        throw new Error("请先完成或放弃已经确定的检定或行动提案。");
      if (game.combat && currentPlayer(game)?.userId !== userId)
        throw new Error("现在轮到另一位冒险者行动。");
      const combat = game.combat;
      switch (command.kind) {
        case "attack":
        case "missile":
        case "dodge":
        case "spell": {
          if (!combat && command.kind !== "spell")
            throw new Error("只有战斗中可以使用这个行动。");
          let asleep = false;
          if (command.kind === "dodge") {
            combat!.guard.push(hero.id);
            fact = `${hero.name}使用闪避动作；直到下一回合开始，敌人的攻击有劣势。`;
          } else if (
            command.kind === "spell" ||
            command.kind === "missile" ||
            (!hero.build && hero.classId === "wizard")
          ) {
            const rawId =
              command.kind === "spell"
                ? command.actionId
                : command.kind === "missile"
                  ? "magic-missile"
                  : "fire-bolt";
            if (!rawId) throw new Error("请选择一个已支持的法术。");
            const ritual = rawId.startsWith("ritual:"),
              spellId = ritual ? rawId.slice(7) : rawId;
            const result = castSpell(game, hero, spellId, die, { ritual });
            rolls.push(...result.rolls);
            fact = result.fact;
            asleep = !!result.resolvedConflict;
            if (!combat) {
              if (game.world)
                advanceTime(game, 1 + (ritual ? 1 : 0), result.castMinutes);
              else advanceSpellTime(game, result.castMinutes);
            }
          } else {
            const preset = CLASSES[hero.classId];
            const weapon = hero.build?.weapon;
            const modifier = abilityMod(hero.abilities[preset.ability]);
            const disadvantage = !!weapon?.disadvantageReasons.length;
            const label = weapon?.name ?? preset.weapon;
            const roll = attackRoll(
              label,
              weapon?.attackBonus ?? modifier + 2,
              combat!.enemy.ac,
              die,
              disadvantage,
              {
                lucky: halflingLucky(hero),
                disadvantageReason: disadvantage
                  ? "小体型角色使用重型武器"
                  : undefined,
              },
            );
            if (roll.success) {
              const criticalMultiplier = roll.kept === 20 ? 2 : 1;
              const values = Array.from(
                { length: (weapon?.damageDice ?? 1) * criticalMultiplier },
                () => die(weapon?.damageDie ?? preset.die),
              );
              const fixed = weapon?.damageBonus ?? modifier;
              // Text encounters place living allies wielding melee weapons next to the single enemy.
              const eligibleWeapon =
                !weapon ||
                weapon.kind === "ranged" ||
                weapon.properties.includes("finesse");
              const ally = game.players.some(
                (p) =>
                  p.hero.id !== hero.id &&
                  p.hero.hp > 0 &&
                  (p.hero.build
                    ? p.hero.build.weapon.attackMode === "melee"
                    : p.hero.classId === "fighter"),
              );
              const sneak =
                hero.classId === "rogue" &&
                eligibleWeapon &&
                !disadvantage &&
                ally;
              const sneakDice = sneak
                ? Array.from({ length: criticalMultiplier }, () => die(6))
                : [];
              roll.damage = Math.max(
                0,
                [...values, ...sneakDice].reduce((a, b) => a + b, 0) + fixed,
              );
              roll.explanation += ` 伤害骰 ${values.join(" + ")}${sneak ? `，偷袭骰 ${sneakDice.join(" + ")}` : ""}，固定加值 ${fixed}，共 ${roll.damage}。${hero.classId === "rogue" && !sneak ? "本次没有满足灵巧/远程武器、无劣势与贴近敌人的盟友条件，不触发偷袭。" : ""}`;
              combat!.enemy.hp = Math.max(0, combat!.enemy.hp - roll.damage);
            }
            rolls.push(roll);
            fact = `${hero.name}用${label}${roll.success ? `命中，造成 ${roll.damage} 点伤害。` : "攻击，但没能命中。"}`;
          }
          if (combat) {
            if (combat.enemy.hp === 0 || asleep) {
              advanceSpellTime(game, 0.1);
              victory(game, asleep);
            } else advanceCombat(game, rolls, die);
          }
          break;
        }
        case "potion": {
          const target = command.targetHeroId ? game.players.find(candidate => candidate.hero.id === command.targetHeroId)?.hero : hero;
          if (!target) throw new Error("治疗目标不在当前队伍中。");
          if (target.id !== hero.id && (game.mode !== "party" || target.hp > 0))
            throw new Error("只能给同地点的倒地队友使用治疗药水。");
          if (hero.potions < 1) throw new Error("你已经没有治疗药水。");
          if (target.hp === target.maxHp) throw new Error("生命已满，无需喝药。");
          const roll = healingRoll("治疗药水", 4, 2, 2, die),
            restored = Math.min(roll.total, target.maxHp - target.hp);
          hero.potions--;
          target.hp += restored;
          rolls.push(roll);
          fact = target.id === hero.id ? `${hero.name}饮下一瓶治疗药水，恢复 ${restored} 点生命。` : `${hero.name}使用自己的 1 瓶治疗药水救起${target.name}，恢复 ${restored} 点生命，消耗主要动作。${combat ? "目标从下次自己的回合开始行动。" : "目标恢复行动能力。"}`;
          if (combat) advanceCombat(game, rolls, die);
          else if (game.world) advanceTime(game, 1, 1);
          else advanceSpellTime(game, 1);
          break;
        }
        case "wind": {
          if (hero.classId !== "fighter" || hero.secondWind < 1)
            throw new Error("复苏之风尚未恢复。");
          if (hero.hp === hero.maxHp)
            throw new Error("生命已满，无需使用复苏之风。");
          const roll = healingRoll("复苏之风", 10, 1, 1, die),
            restored = Math.min(roll.total, hero.maxHp - hero.hp);
          hero.secondWind--;
          hero.hp += restored;
          rolls.push(roll);
          fact = `${hero.name}使用复苏之风，恢复 ${restored} 点生命。附赠动作不消耗本回合的主要动作。`;
          if (!combat) {
            if (game.world) advanceTime(game, 1, 1);
            else advanceSpellTime(game, 1);
          }
          break;
        }
        case "rest": {
          if (game.mode === "party") throw new Error("多人短休需要团队投票，并分别确认每位角色的恢复选择。");
          if (combat || !campaignForGame(game).scenes[game.scene].safeRest)
            throw new Error("短休需要剧本指定的安全环境。");
          if (
            game.lastRestScene === game.scene &&
            (!game.world || game.lastRestChapter === game.world.session)
          )
            throw new Error("这里本章节已经休息过；不能反复休息刷取资源。");
          if (
            !game.players.some(
              (p) =>
                (p.hero.hitDice > 0 && p.hero.hp < p.hero.maxHp) ||
                (p.hero.classId === "fighter" && p.hero.secondWind === 0) ||
                arcaneRecoveryAvailable(game, p.hero),
            )
          )
            throw new Error("当前队伍不需要休息。");
          for (const { hero: resting } of game.players) {
            if (resting.hitDice > 0 && resting.hp < resting.maxHp) {
              const sides =
                resting.classId === "fighter"
                  ? 10
                  : resting.classId === "rogue"
                    ? 8
                    : 6;
              const roll = healingRoll(
                `${resting.name}的短休生命骰`,
                sides,
                1,
                abilityMod(resting.abilities.CON),
                die,
              );
              const restored = Math.min(roll.total, resting.maxHp - resting.hp);
              resting.hitDice--;
              resting.hp += restored;
              rolls.push(roll);
              fact += `${resting.name}花费 1 枚生命骰，恢复 ${restored} 点生命。`;
            }
            if (resting.classId === "fighter") resting.secondWind = 1;
            const recovered = recoverArcane(game, resting);
            if (recovered)
              fact += `${resting.name}使用本章节一次的奥术回想，恢复 ${recovered} 个一环法术位。`;
          }
          game.lastRestScene = game.scene;
          game.lastRestChapter = game.world?.session;
          if (game.world) {
            advanceTime(game, 6);
            fact +=
              "队伍安全短休一小时，世界时间 +6 格。药水不会补发，奥术回想以外的已消耗法术位不会恢复。";
          } else {
            advanceSpellTime(game, 60);
            game.danger = Math.min(6, game.danger + 2);
            fact +=
              "队伍安全短休一小时，危险刻度 +2。药水不会补发，奥术回想以外的已消耗法术位不会恢复。";
          }
          break;
        }
        default:
          throw new Error("当前冒险模式不支持这个规则行动。");
      }
    }
  }
  if (game.scene !== input.scene)
    fact += ` 队伍来到「${campaignForGame(game).scenes[game.scene].title}」。`;
  if (command.kind !== "cancel") game.turns++;
  // Enemy responses are computed during resolution but displayed after the player's action.
  const responses = game.messages.filter(
    (m) => m.roll?.kind === "attack" && rolls.includes(m.roll),
  );
  game.messages = game.messages.filter((m) => !responses.includes(m));
  addMessage(
    game,
    "system",
    fact,
    hero.name,
    rolls.find(
      (r) =>
        !game.messages.some((m) => m.roll === r) &&
        !responses.some((m) => m.roll === r),
    ),
  );
  // Player rolls must remain independently auditable even when an enemy also rolled.
  for (const roll of rolls)
    if (
      !game.messages.some((m) => m.roll === roll) &&
      !responses.some((m) => m.roll === roll)
    )
      addMessage(game, "system", roll.label, undefined, roll);
  game.messages.push(...responses);
  if (game.ending) {
    const ending = endingFor(game);
    addMessage(game, "dm", `${ending?.title}\n${ending?.text}`);
  }
  return { state: game, fact, rolls };
}
/** Party callers check room pause/AFK state before invoking this separate enemy settlement. */
export function settleEnemyTurn(input: Game, die: Die = randomDie): Resolution {
  if (input.mode !== "party" || input.status !== "active" || !input.combat || input.combat.order[input.combat.turn] !== "enemy")
    throw new Error("当前没有等待结算的多人敌方回合。");
  const game = structuredClone(input), rolls: Roll[] = [];
  enemyTurn(game, rolls, die);
  if (game.combat) advancePartyCursor(game);
  for (const roll of rolls) if (!game.messages.some(message => message.roll === roll)) addMessage(game, "system", roll.label, undefined, roll);
  if (game.ending) { const ending = endingFor(game)!; addMessage(game, "dm", `${ending.title}\n${ending.text}`); }
  const attack = rolls.find(roll => roll.kind === "attack");
  const fact = attack ? `${attack.label}：${attack.success ? `命中，造成 ${attack.damage} 点伤害。` : "未命中。"}${game.ending ? "全队失能，已执行新手救援。" : ""}` : "全队失能，已执行新手救援。";
  return { state: game, fact, rolls };
}

export function resolveDefaultCombatTurn(input: Game, reason: "timeout" | "pass" = "timeout", die: Die = randomDie): Resolution {
  if (input.mode !== "party" || input.status !== "active" || !input.combat)
    throw new Error("当前没有可以结束的多人战斗回合。");
  const game = structuredClone(input), actor = currentPlayer(game);
  if (!actor) throw new Error("敌方回合需要单独结算。");
  game.pending = null;
  if (game.world) game.world.proposal = null;
  const cause = reason === "timeout" ? "整回合操作超时" : "玩家选择结束回合";
  if (actor.hero.hp <= 0) {
    advancePartyCursor(game);
    game.turns++;
    const fact = `${cause}：${actor.hero.name}已经倒地，跳过回合，不消耗药水、法术位或职业资源。`;
    addMessage(game, "system", fact);
    if (game.ending) { const ending = endingFor(game)!; addMessage(game, "dm", `${ending.title}\n${ending.text}`); }
    return { state: game, fact, rolls: [] };
  }
  const result = resolve(game, actor.userId, { kind: "dodge" }, die);
  const originalFact = result.fact;
  result.fact = `${cause}：系统执行合法闪避默认动作，不消耗药水、法术位或职业资源。${originalFact}`;
  const message = result.state.messages.findLast(message => message.text === originalFact);
  if (message) message.text = result.fact;
  return result;
}

/** Choices are collected per authenticated user by the room and settled atomically after its team vote. */
export function resolvePartyShortRest(input: Game, choices: PartyRestChoices, die: Die = randomDie): Resolution {
  if (input.mode !== "party" || input.status !== "active") throw new Error("当前不能进行多人短休。");
  if (input.combat || input.pending || input.world?.proposal || !campaignForGame(input).scenes[input.scene].safeRest)
    throw new Error("短休需要没有待结算行动的安全环境。");
  if (input.lastRestScene === input.scene && (!input.world || input.lastRestChapter === input.world.session))
    throw new Error("这里本章节已经休息过；不能反复休息刷取资源。");
  if (!choices || typeof choices !== "object" || Array.isArray(choices)) throw new Error("短休选择格式不正确。");
  for (const [userId, choice] of Object.entries(choices)) {
    const hero = input.players.find(player => player.userId === userId)?.hero;
    if (!hero || !choice || typeof choice !== "object" || Array.isArray(choice) ||
      Object.keys(choice).some(key => !["hitDie", "arcaneRecovery"].includes(key)) ||
      (choice.hitDie !== undefined && typeof choice.hitDie !== "boolean") ||
      (choice.arcaneRecovery !== undefined && typeof choice.arcaneRecovery !== "boolean")) throw new Error("短休选择必须属于队伍中的玩家，并使用明确的恢复授权。");
    if (choice.hitDie && (hero.hitDice < 1 || hero.hp >= hero.maxHp)) throw new Error(`${hero.name}没有可用于恢复的生命骰，或生命已经全满。`);
    if (choice.arcaneRecovery && !arcaneRecoveryAvailable(input, hero)) throw new Error(`${hero.name}当前不能使用奥术回想。`);
  }
  const game = structuredClone(input), rolls: Roll[] = [];
  let fact = "队伍按通过的团队决定安全短休一小时。";
  for (const { userId, hero } of game.players) {
    const choice = Object.hasOwn(choices, userId) ? choices[userId] : undefined;
    if (choice?.hitDie) {
      const sides = hero.classId === "fighter" ? 10 : hero.classId === "rogue" ? 8 : 6;
      const roll = healingRoll(`${hero.name}的短休生命骰`, sides, 1, abilityMod(hero.abilities.CON), die);
      const restored = Math.min(roll.total, hero.maxHp - hero.hp);
      hero.hitDice--; hero.hp += restored; rolls.push(roll);
      fact += `${hero.name}按自己的选择花费 1 枚生命骰，恢复 ${restored} 点生命。`;
    }
    if (hero.classId === "fighter") hero.secondWind = 1;
    if (choice?.arcaneRecovery) fact += `${hero.name}按自己的选择使用本章节一次奥术回想，恢复 ${recoverArcane(game, hero)} 个一环法术位。`;
  }
  game.lastRestScene = game.scene; game.lastRestChapter = game.world?.session;
  if (game.world) { advanceTime(game, 6, 60); fact += "世界时间 +6 格。"; }
  else { advanceSpellTime(game, 60); game.danger = Math.min(6, game.danger + 2); fact += "危险刻度 +2。"; }
  game.turns++;
  fact += "未提交选择的角色不消耗生命骰或奥术回想；治疗药水不会补发。";
  addMessage(game, "system", fact, undefined, rolls[0]);
  for (const roll of rolls.slice(1)) addMessage(game, "system", roll.label, undefined, roll);
  return { state: game, fact, rolls };
}
export function endingFor(game: Game) {
  if (!game.ending) return null;
  const ending = campaignForGame(game).endings[game.ending];
  if (!Object.hasOwn(campaignForGame(game).endings, game.ending))
    throw new Error("剧本中的结局引用不存在。");
  return {
    ...ending,
    text:
      ending.text +
      (!game.world && game.danger >= 4 && game.ending !== "retreat"
        ? " 你在路上失去了一些时间。天亮后仍有居民需要帮助，平安归来的人开始补上那些未完成的事。"
        : ""),
  };
}
export function gameView(game: Game, version: number): View {
  const campaign = campaignForGame(game),
    scene = campaign.scenes[game.scene];
  const publicGame = Object.fromEntries(
    Object.entries(game).filter(
      ([key]) => key !== "campaignSnapshot" && key !== "requestIds",
    ),
  ) as View["game"];
  publicGame.players = structuredClone(game.players).map((player, index) => ({
    ...player,
    hero: {
      ...player.hero,
      ac: effectiveArmorClass(game.players[index].hero, game),
    },
  }));
  return {
    game: publicGame,
    scene: {
      id: scene.id,
      title: scene.title,
      description: scene.description,
      safeRest: !!scene.safeRest,
    },
    actions: availableActions(game),
    version,
    title: campaign.title,
    sceneCount: campaign.scenes.length,
    ending: endingFor(game),
    clues: game.clues.map((id) => campaign.clues[id]).filter(Boolean),
    world: worldView(game),
  };
}
