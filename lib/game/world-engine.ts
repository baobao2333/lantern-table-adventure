import { skillMod, SKILLS } from "./characters.ts";
import { checkRoll, randomDie, type Die } from "./dice.ts";
import {
  advanceSpellTime,
  castSpell,
  halflingLucky,
  isExplorationSpell,
  spellAvailability,
} from "./spells.ts";
import type { Action, Game, GameResolutionOptions, Hero, Resolution, Skill } from "./types.ts";
import type { Opportunity, WorldConfig, WorldProposal } from "./world-types.ts";

function config(game: Game): WorldConfig {
  if (!game.world || !game.campaignSnapshot.world)
    throw new Error("这不是持续战役存档。");
  return game.campaignSnapshot.world;
}
function log(
  game: Game,
  text: string,
  kind: "event" | "decision" | "claim" = "event",
) {
  const world = game.world!;
  world.journal.push({
    id: crypto.randomUUID(),
    turn: game.turns,
    location: config(game).locations[game.scene].id,
    text,
    kind,
  });
  // Long-term state is kept in objectives, clues, clocks and relationships; events retain the last 300 decisions.
  if (world.journal.length > 300)
    world.journal.splice(0, world.journal.length - 300);
  game.messages.push({ id: crypto.randomUUID(), role: "system", text });
  if (game.messages.length > 180)
    game.messages.splice(0, game.messages.length - 180);
}
export function initializeWorld(game: Game) {
  const world = game.campaignSnapshot.world;
  if (!world) return;
  game.world = {
    objectives: [],
    clocks: Object.fromEntries(world.clocks.map((c) => [c.id, 0])),
    trust: Object.fromEntries(world.npcs.map((n) => [n.id, 0])),
    journal: [],
    attempts: [],
    proposal: null,
    session: 1,
    restAt: -12,
    preparations: [],
  };
  log(
    game,
    "持续战役开始。地点可以回访；行动与休息会推动世界事件。章节休整可恢复资源，但也会让局势变化。",
  );
  const hero = game.players[0].hero;
  log(
    game,
    `${hero.name}的背景声明：${hero.background}。这是人物设定，未证实的身份不会授予额外能力。`,
    "claim",
  );
}
export function eligibleGoals(game: Game) {
  const world = config(game),
    location = world.locations[game.scene].id;
  return world.opportunities.filter(
    (g) =>
      g.location === location &&
      g.requires.every((id) => game.clues.includes(id)) &&
      !game.flags.includes(`worldgoal:${g.id}`) &&
      (g.success.ending || !goalResultSatisfied(game, g)) &&
      (!g.success.ending || endingAllowed(game, g.success.ending)),
  );
}
function goalResultSatisfied(game: Game, goal: Opportunity) {
  const result = goal.success;
  return (
    result.clues.length + result.objectives.length > 0 &&
    result.clues.every((id) => game.clues.includes(id)) &&
    result.objectives.every((id) => game.world!.objectives.includes(id))
  );
}
function endingAllowed(game: Game, id: string) {
  const end = config(game).endings[id];
  return (
    !!end &&
    (end.requires || []).every((id) => game.world!.objectives.includes(id)) &&
    (end.clues || []).every((id) => game.clues.includes(id))
  );
}
export function worldActions(game: Game): Action[] {
  if (game.status !== "active" || game.world?.proposal || game.combat)
    return [];
  const world = config(game),
    here = world.locations[game.scene];
  return [
    ...eligibleGoals(game)
      .filter(
        (g) =>
          !game.world!.attempts.includes(
            attemptKey(game, g.prompt, g.skills[0], g.id),
          ),
      )
      .map((g) => ({
        id: `goal:${g.id}`,
        kind: "check" as const,
        title: g.title,
        description: g.prompt,
        skill: g.skills[0],
        dc: g.dc,
        consequence: g.failure.text,
      })),
    ...eligibleGoals(game)
      .filter((g) => g.encounter)
      .map((g) => ({
        id: `fight:${g.id}`,
        kind: "combat" as const,
        title: `迎战：${g.encounter!.name}`,
        description: "战斗是可选方法，也可以描述绕行或安抚的办法。",
      })),
    ...here.exits.map((id) => ({
      id: `travel:${id}`,
      kind: "automatic" as const,
      title: `前往${world.locations.find((l) => l.id === id)!.title}`,
      description: "可回访的相邻地点。路程推动世界时间 1 格。",
    })),
  ];
}
function attemptKey(
  game: Game,
  approach: string,
  skill: Skill,
  goalId?: string,
  npcId?: string,
) {
  const location = config(game).locations[game.scene].id;
  const prepared =
    !!goalId && game.world!.preparations.includes(`${location}:${skill}`);
  const method = approach
    .toLowerCase()
    .replace(/[\s，。！？,.!?]/g, "")
    .slice(0, 180);
  return `idea:${location}:${goalId || npcId || "preparation"}:${skill}:${method}:prepared=${Number(prepared)}`;
}
export type ProposedIdea = {
  title: string;
  approach: string;
  skill: Skill;
  goalId?: string;
  travelTo?: string;
  npcId?: string;
  spellId?: string;
  success: string;
  failure: string;
};
export function stageIdea(
  game: Game,
  hero: Hero,
  idea: ProposedIdea,
): WorldProposal {
  const world = config(game),
    location = world.locations[game.scene];
  if (game.status !== "active" || game.combat || game.pending)
    throw new Error("请先完成当前的规则行动。");
  if (game.mode === "party" && hero.hp <= 0)
    throw new Error("角色已经倒地，不能执行行动。请等待同伴救援。");
  if (game.world!.proposal) throw new Error("请先确认或放弃已经说明的行动。");
  if (!Object.hasOwn(SKILLS, idea.skill)) throw new Error("未支持的技能。");
  const goal = idea.goalId
    ? eligibleGoals(game).find((g) => g.id === idea.goalId)
    : undefined;
  if ([idea.goalId, idea.travelTo, idea.npcId].filter(Boolean).length > 1)
    throw new Error(
      "一次只裁定一个目的：取得目标、移动或交谈。请拆成独立行动。",
    );
  if (idea.goalId && !goal)
    throw new Error("这个目标在当前地点尚不可接触，或已经尝试过。");
  if (goal && !goal.skills.includes(idea.skill))
    throw new Error(
      "这个办法需要另一项适合目标的技能。请说明方法与目标的联系。",
    );
  if (idea.travelTo && !location.exits.includes(idea.travelTo))
    throw new Error("只能前往当前地点相邻的区域。");
  if (idea.npcId && !location.npcIds.includes(idea.npcId))
    throw new Error("这位人物不在当前地点。");
  if (idea.spellId) {
    if (idea.travelTo || !isExplorationSpell(idea.spellId))
      throw new Error("一次只裁定一个目的。该行动只能配合角色卡中的探索法术。");
    const availability = spellAvailability(hero, idea.spellId);
    if (!availability.allowed) throw new Error(availability.reason);
  }
  const key = attemptKey(game, idea.approach, idea.skill, goal?.id, idea.npcId);
  if (!idea.travelTo && game.world!.attempts.includes(key))
    throw new Error("这个方法已经尝试过。请改变条件或提出另一种办法。");
  const proposal: WorldProposal = {
    id: crypto.randomUUID(),
    actorId: hero.id,
    location: location.id,
    title: idea.title,
    approach: idea.approach,
    kind: idea.travelTo ? "automatic" : "check",
    skill: idea.skill,
    dc: goal ? goal.dc : 12,
    modifier: skillMod(hero, idea.skill),
    success: goal
      ? `完成「${goal.title}」，取得这个目标允许的线索或进展。`
      : idea.travelTo
        ? `你来到${world.locations.find((l) => l.id === idea.travelTo)!.title}。`
        : idea.npcId
          ? "交谈取得有限信任，人物态度 +1；不会强迫对方服从。"
          : "完成一次准备：下一次在这里使用同一技能时获得优势。",
    failure: goal
      ? goal.failure.text
      : idea.npcId
        ? "交谈受挫，人物态度 −1，世界时间额外推进 1 格。"
        : "准备没有奏效，世界时间额外推进 1 格。",
    timeCost: 1,
    goalId: goal?.id,
    travelTo: idea.travelTo,
    npcId: idea.npcId,
    spellId: idea.spellId,
    attemptKey: key,
  };
  game.world!.proposal = proposal;
  return proposal;
}
function trust(game: Game, id: string, delta: number) {
  game.world!.trust[id] = Math.max(
    -2,
    Math.min(2, (game.world!.trust[id] || 0) + delta),
  );
}
export function completeWorldGoal(game: Game, goal: Opportunity) {
  const world = game.world!;
  if (!game.flags.includes(`worldgoal:${goal.id}`))
    game.flags.push(`worldgoal:${goal.id}`);
  for (const id of goal.success.clues)
    if (!game.clues.includes(id)) game.clues.push(id);
  for (const id of goal.success.objectives)
    if (!world.objectives.includes(id)) world.objectives.push(id);
  if (goal.success.trustNpc) trust(game, goal.success.trustNpc, 1);
  if (goal.success.ending) {
    if (!endingAllowed(game, goal.success.ending))
      throw new Error("结局条件尚未成立。");
    game.status = "complete";
    game.ending = goal.success.ending;
  }
}
export function advanceTime(
  game: Game,
  amount: number,
  elapsedMinutes = amount * 10,
) {
  const world = game.world!,
    cfg = config(game);
  for (const clock of cfg.clocks) {
    if (clock.stoppedBy?.some((id) => world.objectives.includes(id))) continue;
    const before = world.clocks[clock.id],
      after = Math.min(clock.max, before + amount);
    world.clocks[clock.id] = after;
    for (const threshold of clock.thresholds)
      if (before < threshold.at && after >= threshold.at) {
        if (threshold.clue && !game.clues.includes(threshold.clue))
          game.clues.push(threshold.clue);
        if (
          threshold.objective &&
          !world.objectives.includes(threshold.objective)
        )
          world.objectives.push(threshold.objective);
        log(game, `${clock.title}：${threshold.text}`);
      }
  }
  advanceSpellTime(game, elapsedMinutes);
}
export function resolveWorld(
  input: Game,
  userId: string,
  command: { kind: string; actionId?: string },
  die: Die = randomDie,
  options: GameResolutionOptions = {},
): Resolution {
  const game = structuredClone(input),
    hero = game.players.find((p) => p.userId === userId)?.hero;
  if (!hero || game.status !== "active") throw new Error("当前不能行动。");
  if (game.mode === "party" && hero.hp <= 0 && command.kind !== "cancel" && !(options.teamDecision && command.kind === "session"))
    throw new Error("角色已经倒地，不能执行行动。请等待同伴救援。");
  if (game.combat || game.pending) throw new Error("请先完成当前的规则行动。");
  const cfg = config(game),
    world = game.world!,
    location = cfg.locations[game.scene],
    rolls: Resolution["rolls"] = [];
  let fact = "";
  if (command.kind === "cancel") {
    if (world.proposal && world.proposal.actorId !== hero.id && !options.system)
      throw new Error("只有提案所属玩家可以放弃；系统超时可以关闭提案。");
    world.proposal = null;
    fact = "你放弃了尚未执行的提案，世界时间没有推进。";
  } else if (command.kind === "action") {
    if (world.proposal) throw new Error("请先确认或放弃当前提案。");
    if (command.actionId?.startsWith("travel:")) {
      if (game.mode === "party" && !options.teamDecision)
        throw new Error("移动全队需要通过团队投票。");
      const id = command.actionId.slice(7);
      if (!location.exits.includes(id)) throw new Error("这里没有这条路径。");
      game.scene = cfg.locations.findIndex((l) => l.id === id);
      fact = `你来到${cfg.locations[game.scene].title}。`;
      game.turns++;
      advanceTime(game, 1);
      log(game, fact, "decision");
    } else {
      const goal = eligibleGoals(game).find(
        (g) => `goal:${g.id}` === command.actionId,
      );
      if (!goal) throw new Error("这个目标目前不可用。");
      stageIdea(game, hero, {
        title: goal.title,
        approach: goal.prompt,
        skill: goal.skills[0],
        goalId: goal.id,
        success: goal.success.text,
        failure: goal.failure.text,
      });
      fact = `已说明「${goal.title}」的规则与两种结果。你可以确认掷骰，也可以放弃并描述自己的方法。`;
    }
  } else if (command.kind === "confirm") {
    const proposal = world.proposal;
    if (
      !proposal ||
      proposal.actorId !== hero.id ||
      proposal.location !== location.id
    )
      throw new Error("没有可确认的行动。");
    const goal = proposal.goalId
      ? eligibleGoals(game).find((g) => g.id === proposal.goalId)
      : undefined;
    if (proposal.goalId && !goal)
      throw new Error("行动条件已改变，请重新提出方法。");
    if (game.mode === "party" && (proposal.travelTo || goal?.success.ending) && !options.teamDecision)
      throw new Error("移动全队或决定结局需要通过团队投票。");
    const preparation = `${location.id}:${proposal.skill}`;
    const advantage = !!goal && world.preparations.includes(preparation);
    if (advantage)
      world.preparations = world.preparations.filter(
        (id) => id !== preparation,
      );
    if (proposal.spellId) {
      if (!isExplorationSpell(proposal.spellId))
        throw new Error("这个法术不能用于当前行动。");
      const spell = castSpell(game, hero, proposal.spellId, die);
      advanceSpellTime(game, spell.castMinutes);
      rolls.push(...spell.rolls);
      log(game, spell.fact);
    }
    const roll =
      proposal.kind === "check"
        ? checkRoll(
            proposal.title,
            proposal.modifier,
            proposal.dc,
            advantage,
            die,
            {
              lucky: halflingLucky(hero),
              disadvantage:
                proposal.skill === "stealth" &&
                !!hero.build?.armorStealthDisadvantage,
            },
          )
        : null;
    const success = !roll || roll.success;
    if (roll) rolls.push(roll);
    world.proposal = null;
    if (proposal.kind === "check") {
      const settledKey = attemptKey(
        game,
        proposal.approach,
        proposal.skill,
        proposal.goalId,
        proposal.npcId,
      );
      // Consuming preparation does not reopen the same method under weaker conditions.
      for (const key of [proposal.attemptKey, settledKey])
        if (!world.attempts.includes(key)) world.attempts.push(key);
    }
    game.turns++;
    if (success) {
      if (goal) completeWorldGoal(game, goal);
      if (proposal.travelTo)
        game.scene = cfg.locations.findIndex((l) => l.id === proposal.travelTo);
      if (proposal.npcId) trust(game, proposal.npcId, 1);
      if (
        !goal &&
        !proposal.npcId &&
        !proposal.travelTo &&
        !world.preparations.includes(preparation)
      )
        world.preparations.push(preparation);
    } else {
      if (proposal.npcId) trust(game, proposal.npcId, -1);
      game.danger = Math.min(6, game.danger + 1);
    }
    const elapsed =
      proposal.timeCost + (success ? 0 : (goal?.failure.clock ?? 1));
    const outcome = success
      ? goal?.success.text ||
        (proposal.travelTo
          ? `你来到${cfg.locations[game.scene].title}。`
          : proposal.success)
      : proposal.failure;
    fact = `${proposal.title}：${outcome} ${roll ? `检定 ${roll.total} / DC ${roll.target}。` : "无需掷骰。"}世界时间 +${elapsed}。`;
    log(
      game,
      `${hero.name}采用的方法：${proposal.approach}。${fact}`,
      "decision",
    );
    if (roll) game.messages[game.messages.length - 1].roll = roll;
    advanceTime(game, elapsed);
  } else if (command.kind === "session") {
    if (game.mode === "party" && !options.teamDecision)
      throw new Error("章节休整需要通过团队投票。");
    if (world.proposal || game.combat || !location.safeRest)
      throw new Error("章节休整需要没有待结算行动的安全地点。");
    if (game.turns - world.restAt < 12)
      throw new Error("距离上次章节休整太近。请先继续探索至少 12 次行动。");
    world.restAt = game.turns;
    world.session++;
    for (const p of game.players) {
      p.hero.hp = p.hero.maxHp;
      p.hero.hitDice = 1;
      p.hero.secondWind = p.hero.classId === "fighter" ? 1 : 0;
      p.hero.spellSlots = p.hero.classId === "wizard" ? 2 : 0;
      p.hero.activeSpellEffects = [];
      delete p.hero.arcaneRecoveryUsedChapter;
    }
    game.turns++;
    advanceTime(game, 8, 480);
    fact =
      "你在安全地点休整八小时，生命与职业资源恢复，药水不会补发。世界时间 +8，新的一次游玩开始。";
    log(game, fact);
  } else throw new Error("未支持的持续战役行动。");
  if (game.ending) {
    const end = cfg.endings[game.ending];
    game.messages.push({
      id: crypto.randomUUID(),
      role: "dm",
      text: `${end.title}\n${end.text}`,
    });
  }
  return { state: game, fact, rolls };
}
export function worldView(game: Game) {
  if (!game.world) return undefined;
  const cfg = config(game),
    location = cfg.locations[game.scene];
  return {
    location: location.id,
    session: game.world.session,
    npcs: cfg.npcs
      .filter((n) => location.npcIds.includes(n.id))
      .map((n) => ({
        id: n.id,
        name: n.name,
        role: n.role,
        want: n.want,
        trust: game.world!.trust[n.id],
      })),
    objectives: Object.entries(cfg.objectives)
      .filter(([id]) => game.world!.objectives.includes(id))
      .map(([id, o]) => ({
        id,
        title: o.title,
        description: o.description,
        done: game.world!.objectives.includes(id),
      })),
    clocks: cfg.clocks.map((c) => ({
      id: c.id,
      title: c.title,
      current: game.world!.clocks[c.id],
      max: c.max,
      stopped: !!c.stoppedBy?.some((id) => game.world!.objectives.includes(id)),
    })),
    locations: cfg.locations.map((l) => ({
      id: l.id,
      title: l.title,
      current: l.id === location.id,
      adjacent: location.exits.includes(l.id),
    })),
    hooks: cfg.backstoryHooks
      .filter((h) => h.location === location.id)
      .map((h) => ({
        id: h.id,
        question: h.question,
        truthStatus: h.truthStatus,
      })),
  };
}
