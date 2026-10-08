import { campaignById, campaignForGame } from "./campaigns.ts";
import { abilityMod, CLASSES, skillMod, SKILLS } from "./characters.ts";
import type { Action, Game, Hero, Player, Resolution, Roll, View } from "./types.ts";

export type Die = (sides: number) => number;
export type Command = { kind: "action" | "roll" | "attack" | "missile" | "dodge" | "potion" | "wind" | "rest" | "retreat" | "start"; actionId?: string };

export function randomDie(sides: number) {
  const limit = Math.floor(0x100000000 / sides) * sides;
  const buffer = new Uint32Array(1);
  do { crypto.getRandomValues(buffer); } while (buffer[0] >= limit);
  return buffer[0] % sides + 1;
}
export function addMessage(game: Game, role: "dm" | "player" | "system", text: string, actor?: string, roll?: Roll, ai = false) {
  game.messages.push({ id: crypto.randomUUID(), role, text, actor, roll, ai });
  if (game.messages.length > 180) game.messages.splice(0, game.messages.length - 180);
}
export function createGame(id: string, owner: string, hero: Hero, campaignId: string, mode: "solo" | "party", roomCode: string): Game {
  const campaign = campaignById(campaignId);
  const state: Game = { id, owner, roomCode, mode, campaignId, campaignRevision: campaign.revision, campaignSnapshot: structuredClone(campaign), players: [{ userId: owner, hero: structuredClone(hero) }],
    status: mode === "solo" ? "active" : "waiting", scene: 0, clues: [], flags: [], danger: 0, turns: 0,
    pending: null, combat: null, messages: [], ending: null, requestIds: [] };
  addMessage(state, "dm", campaign.hook);
  addMessage(state, "system", "这是一级角色教学冒险。你可以点选行动，也可以用自己的话和主持人交流。所有检定会先展示规则；生命降至 0 时使用新手救援房规：冒险结束，角色获救。危险刻度记录失败与延误，达到 4 时会影响结局。" );
  return state;
}
function attemptFlag(game: Game, action: Action) { return `attempt:${game.scene}:${action.id}`; }
export function availableActions(game: Game) {
  if (game.status !== "active" || game.pending || game.combat) return [];
  return campaignForGame(game).scenes[game.scene].actions.filter(action =>
    !(action.requiresClue && !game.clues.includes(action.requiresClue)) &&
    !((action.clue || action.flag) && action.next === undefined && !action.ending &&
      (!action.clue || game.clues.includes(action.clue)) && (!action.flag || game.flags.includes(action.flag))) &&
    !game.flags.includes(attemptFlag(game, action)));
}
function endGame(game: Game, ending: string) {
  game.status = "complete"; game.ending = ending; game.pending = null; game.combat = null;
}
function damage(game: Game, hero: Hero, amount: number) {
  hero.hp = Math.max(0, hero.hp - amount);
  if (hero.hp === 0) {
    // This explicitly advertised house rule replaces death saves in the teaching mode.
    endGame(game, "retreat");
    addMessage(game, "system", `${hero.name}的生命降至 0。同伴或附近居民将你带回安全地带；本次冒险结束。新手救援房规生效，没有进行标准死亡豁免。`);
  }
}
function finishAction(game: Game, action: Action, success: boolean, hero: Hero) {
  if (success) {
    if (action.clue && !game.clues.includes(action.clue)) game.clues.push(action.clue);
    if (action.flag && !game.flags.includes(action.flag)) game.flags.push(action.flag);
    if (action.timeCost) game.danger += action.timeCost;
    if (action.next !== undefined) game.scene = action.next;
    if (action.ending) endGame(game, action.ending);
  } else {
    game.danger++;
    if (action.failureDamage) damage(game, hero, action.failureDamage);
  }
  game.danger = Math.min(6, game.danger);
}
export function checkRoll(label: string, modifier: number, target: number, advantage: boolean, die: Die = randomDie): Roll {
  const rolls = advantage ? [die(20), die(20)] : [die(20)];
  const kept = Math.max(...rolls), total = kept + modifier;
  return { label, rolls, kept, modifier, total, target, success: total >= target, kind: "check",
    explanation: `${advantage ? "优势：两颗 d20 取高值。" : "一颗 d20。"}总值达到难度即成功；技能检定自然 1 和 20 没有额外效果。` };
}
export function attackRoll(label: string, modifier: number, ac: number, die: Die = randomDie, disadvantage = false): Roll {
  const rolls = disadvantage ? [die(20), die(20)] : [die(20)];
  const kept = Math.min(...rolls), total = kept + modifier;
  return { label, rolls, kept, modifier, total, target: ac, success: kept === 20 || (kept !== 1 && total >= ac), kind: "attack",
    explanation: kept === 20 ? "自然 20：必定命中，伤害骰翻倍，固定加值不翻倍。" : kept === 1 ? "自然 1：攻击必定失手。" : `${disadvantage ? "目标正在闪避，攻击有劣势，取低值。" : ""}命中总值达到护甲等级即命中。` };
}
function healingRoll(label: string, sides: number, count: number, modifier: number, die: Die): Roll {
  const rolls = Array.from({ length: count }, () => die(sides));
  const total = Math.max(0, rolls.reduce((a, b) => a + b, 0) + modifier);
  return { label, rolls, kept: rolls.reduce((a, b) => a + b, 0), modifier, total, target: 0, success: true, kind: "healing", explanation: `${count}d${sides} ${modifier < 0 ? "−" : "+"} ${Math.abs(modifier)}；治疗不超过最大生命。` };
}
function currentPlayer(game: Game): Player | undefined {
  const combat = game.combat;
  return combat ? game.players.find(p => p.hero.id === combat.order[combat.turn]) : undefined;
}
function victory(game: Game) {
  const combat = game.combat!;
  game.scene = combat.next; game.combat = null;
  if (combat.clue && !game.clues.includes(combat.clue)) game.clues.push(combat.clue);
  addMessage(game, "system", `对手失去战斗能力，冲突结束。你进入下一处场景。${combat.clue ? "并发现一条线索。" : ""}` );
}
function enemyTurn(game: Game, rolls: Roll[], die: Die) {
  const combat = game.combat;
  if (!combat) return;
  const target = game.players[(combat.round - 1) % game.players.length].hero;
  const roll = attackRoll(`${combat.enemy.name} → ${target.name}`, combat.enemy.attackBonus, target.ac, die, combat.guard.includes(target.id));
  if (roll.success) {
    const count = roll.kept === 20 ? 2 : 1;
    const values = Array.from({ length: count }, () => die(combat.enemy.damageDie));
    roll.damage = values.reduce((a, b) => a + b, 0) + combat.enemy.damageBonus;
    roll.explanation += ` 伤害：${values.join(" + ")} + ${combat.enemy.damageBonus} = ${roll.damage}。`;
    damage(game, target, roll.damage);
  }
  rolls.push(roll);
  addMessage(game, "system", roll.success ? `${target.name}受到 ${roll.damage} 点伤害。` : `${target.name}避开了攻击。`, undefined, roll);
}
function advanceCombat(game: Game, rolls: Roll[], die: Die) {
  const combat = game.combat;
  if (!combat) return;
  combat.turn = (combat.turn + 1) % combat.order.length;
  if (combat.turn === 0) combat.round++;
  if (combat.order[combat.turn] === "enemy") {
    enemyTurn(game, rolls, die);
    if (!game.combat) return;
    combat.turn = (combat.turn + 1) % combat.order.length;
    if (combat.turn === 0) combat.round++;
  }
  const next = combat.order[combat.turn];
  combat.guard = combat.guard.filter(id => id !== next);
}
function enterCombat(game: Game, action: Action, rolls: Roll[], die: Die) {
  const enemy = campaignForGame(game).scenes[game.scene].enemy;
  if (!enemy) throw new Error("这里没有战斗对象。");
  const entries = game.players.map(player => ({ id: player.hero.id, name: player.hero.name, dex: abilityMod(player.hero.abilities.DEX) }));
  entries.push({ id: "enemy", name: enemy.name, dex: enemy.dex });
  const scored = entries.map(entry => {
    const value = die(20);
    const roll: Roll = { label: `${entry.name}的先攻`, rolls: [value], kept: value, modifier: entry.dex, total: value + entry.dex, target: 0, success: true, kind: "initiative", explanation: "d20 + 敏捷调整值；高者先行动，同值时冒险者优先。" };
    rolls.push(roll); addMessage(game, "system", `${entry.name}的先攻为 ${roll.total}。`, undefined, roll);
    return { ...entry, total: roll.total };
  }).sort((a, b) => b.total - a.total || (a.id === "enemy" ? 1 : b.id === "enemy" ? -1 : 0));
  game.combat = { enemy: { ...enemy, hp: enemy.hp + 4 * (game.players.length - 1), maxHp: enemy.hp + 4 * (game.players.length - 1) }, order: scored.map(p => p.id), turn: 0, round: 1, guard: [], next: action.next!, clue: action.clue };
  if (scored[0].id === "enemy") { enemyTurn(game, rolls, die); if (game.combat) game.combat.turn = 1; }
}

export function resolve(input: Game, userId: string, command: Command, die: Die = randomDie): Resolution {
  const game = structuredClone(input), player = game.players.find(p => p.userId === userId);
  if (!player) throw new Error("你不在这个房间中。");
  const hero = player.hero, rolls: Roll[] = [];
  let fact = "";
  if (command.kind === "start") {
    if (game.owner !== userId || game.status !== "waiting") throw new Error("只有房主能开始等待中的冒险。");
    game.status = "active"; fact = "队伍准备完毕，冒险开始。";
  } else {
    if (game.status !== "active") throw new Error("这场冒险尚未开始或已经结束。");
    if (command.kind === "retreat") {
      if (game.owner !== userId) throw new Error("结束多人冒险需要房主操作。");
      endGame(game, "retreat"); fact = "你决定带着所见返回安全的地方。";
    } else if (command.kind === "roll") {
      const check = game.pending;
      if (!check || check.actorId !== hero.id) throw new Error("当前没有等待你掷出的检定。");
      const action = campaignForGame(game).scenes[game.scene].actions.find(a => a.id === check.actionId)!;
      const roll = checkRoll(check.title, check.modifier, check.dc, check.advantage, die);
      game.flags.push(attemptFlag(game, action)); game.pending = null;
      finishAction(game, action, roll.success, hero); rolls.push(roll);
      fact = roll.success ? `${hero.name}完成「${action.title}」。${action.clue ? "获得了一条线索。" : ""}` : `${hero.name}尝试「${action.title}」失败。${check.consequence}危险刻度 +1。同样的方法不能原地重掷，请换一种办法。`;
    } else if (command.kind === "action") {
      const action = availableActions(game).find(a => a.id === command.actionId);
      if (!action) throw new Error("这个行动目前不可用；请刷新后查看当前选项。");
      if (action.kind === "combat") { enterCombat(game, action, rolls, die); fact = "战斗开始，双方先攻已经结算。"; }
      else if (action.skill && action.dc !== undefined) {
        const advantage = !!action.advantageFlag && (game.flags.includes(action.advantageFlag) || game.clues.includes(action.advantageFlag));
        game.pending = { id: crypto.randomUUID(), actorId: hero.id, actionId: action.id, title: action.title, skill: action.skill,
          dc: action.dc, modifier: skillMod(hero, action.skill), advantage, consequence: action.consequence || "耗费时间，危险刻度 +1。" };
        fact = `${hero.name}准备「${action.title}」：${SKILLS[action.skill].name}检定，DC ${action.dc}，加值 ${skillMod(hero, action.skill)}${advantage ? "，获得优势" : ""}。失败：${game.pending.consequence}危险刻度 +1。请确认后掷骰。`;
      } else {
        finishAction(game, action, true, hero);
        fact = `${hero.name}完成「${action.title}」。这是确定可行的行动，无需掷骰。${action.timeCost ? `绕行与等待使危险刻度 +${action.timeCost}。` : ""}${action.clue ? "发现了一条线索。" : ""}`;
      }
    } else {
      if (game.pending) throw new Error("请先完成已经确定的检定。");
      if (game.combat && currentPlayer(game)?.userId !== userId) throw new Error("现在轮到另一位冒险者行动。");
      const combat = game.combat;
      switch (command.kind) {
        case "attack": case "missile": case "dodge": {
          if (!combat) throw new Error("只有战斗中可以使用这个行动。");
          if (command.kind === "dodge") {
            combat.guard.push(hero.id); fact = `${hero.name}使用闪避动作；直到下一回合开始，敌人的攻击有劣势。`;
          } else {
            const preset = CLASSES[hero.classId];
            if (command.kind === "missile") {
              if (hero.classId !== "wizard" || hero.spellSlots < 1) throw new Error("需要法师和至少一个法术位。");
              hero.spellSlots--;
              const values = [die(4), die(4), die(4)], amount = values.reduce((a, b) => a + b, 0) + 3;
              combat.enemy.hp = Math.max(0, combat.enemy.hp - amount);
              rolls.push({ label: "魔法飞弹", rolls: values, kept: amount - 3, modifier: 3, total: amount, target: 0, success: true, kind: "damage", damage: amount, explanation: "消耗 1 个一环法术位，三枚飞弹自动命中；3d4 + 3 伤害。" });
              fact = `${hero.name}施放魔法飞弹，造成 ${amount} 点伤害，消耗 1 个法术位。`;
            } else {
              const modifier = abilityMod(hero.abilities[preset.ability]);
              const roll = attackRoll(preset.weapon, modifier + 2, combat.enemy.ac, die);
              if (roll.success) {
                const count = roll.kept === 20 ? 2 : 1, values = Array.from({ length: count }, () => die(preset.die));
                const fixed = hero.classId === "wizard" ? 0 : modifier;
                // Abstract encounter positions: living melee allies are adjacent; a solo archer has no sneak attack.
                const sneak = hero.classId === "rogue" && game.players.some(p => p.hero.id !== hero.id && p.hero.classId === "fighter" && p.hero.hp > 0);
                const sneakDice = sneak ? Array.from({ length: count }, () => die(6)) : [];
                roll.damage = Math.max(0, [...values, ...sneakDice].reduce((a, b) => a + b, 0) + fixed);
                roll.explanation += ` 伤害骰 ${values.join(" + ")}${sneak ? `，偷袭骰 ${sneakDice.join(" + ")}` : ""}，固定加值 ${fixed}，共 ${roll.damage}。${hero.classId === "rogue" && !sneak ? "没有贴近敌人的战士盟友，本次不满足偷袭条件。" : ""}`;
                combat.enemy.hp = Math.max(0, combat.enemy.hp - roll.damage);
              }
              rolls.push(roll); fact = `${hero.name}用${preset.weapon}${roll.success ? `命中，造成 ${roll.damage} 点伤害。` : "攻击，但没能命中。"}`;
            }
          }
          if (combat.enemy.hp === 0) victory(game);
          else advanceCombat(game, rolls, die);
          break;
        }
        case "potion": {
          if (hero.potions < 1) throw new Error("你已经没有治疗药水。");
          if (hero.hp === hero.maxHp) throw new Error("生命已满，无需喝药。");
          const roll = healingRoll("治疗药水", 4, 2, 2, die), restored = Math.min(roll.total, hero.maxHp - hero.hp);
          hero.potions--; hero.hp += restored; rolls.push(roll); fact = `${hero.name}饮下一瓶治疗药水，恢复 ${restored} 点生命。`;
          if (combat) advanceCombat(game, rolls, die);
          break;
        }
        case "wind": {
          if (hero.classId !== "fighter" || hero.secondWind < 1) throw new Error("复苏之风尚未恢复。");
          if (hero.hp === hero.maxHp) throw new Error("生命已满，无需使用复苏之风。");
          const roll = healingRoll("复苏之风", 10, 1, 1, die), restored = Math.min(roll.total, hero.maxHp - hero.hp);
          hero.secondWind--; hero.hp += restored; rolls.push(roll); fact = `${hero.name}使用复苏之风，恢复 ${restored} 点生命。附赠动作不消耗本回合的主要动作。`; break;
        }
        case "rest": {
          if (combat || !campaignForGame(game).scenes[game.scene].safeRest) throw new Error("短休需要剧本指定的安全环境。");
          if (game.lastRestScene === game.scene) throw new Error("这里已经休息过；不能反复休息刷取资源。");
          if (!game.players.some(p => (p.hero.hitDice > 0 && p.hero.hp < p.hero.maxHp) || (p.hero.classId === "fighter" && p.hero.secondWind === 0))) throw new Error("当前队伍不需要休息。");
          for (const {hero: resting} of game.players) {
            if (resting.hitDice > 0 && resting.hp < resting.maxHp) {
              const sides = resting.classId === "fighter" ? 10 : resting.classId === "rogue" ? 8 : 6;
              const roll = healingRoll(`${resting.name}的短休生命骰`, sides, 1, abilityMod(resting.abilities.CON), die);
              const restored = Math.min(roll.total, resting.maxHp - resting.hp);
              resting.hitDice--; resting.hp += restored; rolls.push(roll); fact += `${resting.name}花费 1 枚生命骰，恢复 ${restored} 点生命。`;
            }
            if (resting.classId === "fighter") resting.secondWind = 1;
          }
          game.lastRestScene = game.scene; game.danger = Math.min(6, game.danger + 2); fact += "队伍安全短休一小时，危险刻度 +2。已消耗的法术位与药水不会恢复。"; break;
        }
      }
    }
  }
  if (game.scene !== input.scene) fact += ` 队伍来到「${campaignForGame(game).scenes[game.scene].title}」。`;
  game.turns++;
  // Enemy responses are computed during resolution but displayed after the player's action.
  const responses = game.messages.filter(m => m.roll?.kind === "attack" && rolls.includes(m.roll));
  game.messages = game.messages.filter(m => !responses.includes(m));
  addMessage(game, "system", fact, hero.name, rolls.find(r => !game.messages.some(m => m.roll === r) && !responses.some(m => m.roll === r)));
  // Player rolls must remain independently auditable even when an enemy also rolled.
  for (const roll of rolls) if (!game.messages.some(m => m.roll === roll) && !responses.some(m => m.roll === roll)) addMessage(game, "system", roll.label, undefined, roll);
  game.messages.push(...responses);
  if (game.ending) {
    const ending = endingFor(game);
    addMessage(game, "dm", `${ending?.title}\n${ending?.text}`);
  }
  return { state: game, fact, rolls };
}
export function endingFor(game: Game) {
  if (!game.ending) return null;
  const ending = campaignForGame(game).endings[game.ending];
  if (!Object.hasOwn(campaignForGame(game).endings,game.ending)) throw new Error("剧本中的结局引用不存在。");
  return { ...ending, text: ending.text + (game.danger >= 4 && game.ending !== "retreat" ? " 你在路上失去了一些时间。天亮后仍有居民需要帮助，平安归来的人开始补上那些未完成的事。" : "") };
}
export function gameView(game: Game, version: number): View {
  const campaign = campaignForGame(game), scene = campaign.scenes[game.scene];
  const publicGame = Object.fromEntries(Object.entries(game).filter(([key]) => key !== "campaignSnapshot" && key !== "requestIds")) as View["game"];
  return { game: publicGame, scene: { id: scene.id, title: scene.title, description: scene.description, safeRest: !!scene.safeRest }, actions: availableActions(game), version,
    title: campaign.title, sceneCount: campaign.scenes.length, ending: endingFor(game), clues: game.clues.map(id => campaign.clues[id]).filter(Boolean) };
}
