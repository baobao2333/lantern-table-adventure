import test from "node:test";
import assert from "node:assert/strict";
import { createHero } from "../lib/game/characters.ts";
import {
  createGame,
  resolve,
  gameView,
  availableActions,
} from "../lib/game/engine.ts";
import { stageIdea, eligibleGoals } from "../lib/game/world-engine.ts";
import { worldErrors } from "../lib/game/world-validation.mjs";

const OWNER = "owner";
function game() {
  return createGame(
    crypto.randomUUID(),
    OWNER,
    createHero(
      crypto.randomUUID(),
      "fighter",
      "Tester",
      "I claim to be a forgotten god.",
    ),
    "moonbridge-conspiracy",
    "solo",
    "ABC234",
  );
}
function idea(fields = {}) {
  return {
    title: "Review action",
    approach: "Review method",
    skill: "investigation",
    success: "Invented godhood and rewards",
    failure: "Invented destruction",
    ...fields,
  };
}
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
function here(state) {
  return state.campaignSnapshot.world.locations[state.scene].id;
}
function travel(state, target) {
  const locations = state.campaignSnapshot.world.locations,
    queue = [[here(state)]],
    seen = new Set();
  while (queue.length) {
    const path = queue.shift(),
      last = path.at(-1);
    if (last === target) {
      for (const id of path.slice(1))
        state = resolve(
          state,
          OWNER,
          { kind: "action", actionId: `travel:${id}` },
          () => {
            throw new Error("Travel must not roll.");
          },
        ).state;
      return state;
    }
    if (seen.has(last)) continue;
    seen.add(last);
    for (const id of locations.find((l) => l.id === last).exits)
      queue.push([...path, id]);
  }
  throw new Error(`No route to ${target}`);
}
function perform(state, id, ...values) {
  const goal = state.campaignSnapshot.world.opportunities.find(
    (g) => g.id === id,
  );
  assert.ok(goal, `Unknown goal ${id}`);
  state = travel(state, goal.location);
  assert.ok(
    eligibleGoals(state).some((g) => g.id === id),
    `Goal ${id} should be eligible`,
  );
  const before = state.turns,
    staged = resolve(state, OWNER, { kind: "action", actionId: `goal:${id}` });
  assert.equal(staged.rolls.length, 0);
  assert.equal(staged.state.turns, before, "Proposing must not advance time.");
  const result = resolve(
    staged.state,
    OWNER,
    { kind: "confirm" },
    dice(...(values.length ? values : [20])),
  );
  assert.equal(result.rolls.length, 1);
  return result;
}
function prepare(
  state,
  approach = "Record the old words before comparing them.",
) {
  stageIdea(state, state.players[0].hero, idea({ approach }));
  return resolve(state, OWNER, { kind: "confirm" }, dice(20)).state;
}

test("mixed purposes are rejected before dice, movement or rewards", () => {
  for (const fields of [
    { goalId: "hear-mela", travelTo: "ferry", skill: "insight" },
    { goalId: "hear-mela", npcId: "mela", skill: "persuasion" },
    { travelTo: "ferry", npcId: "mela" },
  ]) {
    const state = game(),
      before = structuredClone(state);
    assert.throws(
      () => stageIdea(state, state.players[0].hero, idea(fields)),
      /一次只裁定一个目的/,
    );
    assert.deepEqual(state, before);
  }
});

test("clock rescue closes equivalent opportunities and stops its clock without ending the campaign", () => {
  let state = game();
  for (let i = 0; i < 44; i++)
    state = travel(state, i % 2 === 0 ? "market" : "inn");
  assert.ok(state.world.objectives.includes("residents-safe"));
  assert.ok(state.clues.includes("ferry-evacuated"));
  state = travel(state, "ferry");
  for (const id of ["execute-ferry-rescue", "improvise-ferry-crossing"]) {
    assert.equal(
      eligibleGoals(state).some((g) => g.id === id),
      false,
    );
    assert.throws(() =>
      stageIdea(
        state,
        state.players[0].hero,
        idea({ goalId: id, skill: "athletics" }),
      ),
    );
  }
  const stoppedAt = state.world.clocks["ferry-rescue"];
  for (const target of ["market", "inn", "market", "inn", "market", "inn"])
    state = travel(state, target);
  assert.equal(state.world.clocks["ferry-rescue"], stoppedAt);
  assert.equal(state.status, "active");
  assert.equal(state.ending, null);
});

test("alternative rescue closes the other route when all its outcomes are already true", () => {
  let state = perform(game(), "organize-shore-team").state;
  state = perform(state, "improvise-ferry-crossing").state;
  assert.ok(
    state.clues.includes("evacuation-plan"),
    "The other route has its prerequisites.",
  );
  assert.equal(
    eligibleGoals(state).some((g) => g.id === "execute-ferry-rescue"),
    false,
  );
  assert.equal(
    availableActions(state).some((a) => a.id === "goal:execute-ferry-rescue"),
    false,
  );
  assert.throws(() =>
    stageIdea(
      state,
      state.players[0].hero,
      idea({ goalId: "execute-ferry-rescue", skill: "athletics" }),
    ),
  );
});

test("unchanged retries stay blocked; relevant preparation enables one retry and is consumed", () => {
  let state = game();
  const goal = state.campaignSnapshot.world.opportunities.find(
    (g) => g.id === "hear-old-song",
  );
  state = perform(state, goal.id, 1).state;
  state = travel(travel(state, "market"), "inn");
  assert.throws(
    () =>
      stageIdea(
        state,
        state.players[0].hero,
        idea({ goalId: goal.id, approach: goal.prompt }),
      ),
    /这个方法已经尝试过/,
  );
  assert.equal(
    availableActions(state).some((a) => a.id === `goal:${goal.id}`),
    false,
  );
  state = prepare(state);
  assert.ok(state.world.preparations.includes("inn:investigation"));
  assert.equal(
    availableActions(state).some((a) => a.id === `goal:${goal.id}`),
    true,
  );
  const retry = perform(state, goal.id, 1, 1);
  assert.deepEqual(retry.rolls[0].rolls, [1, 1]);
  assert.equal(retry.rolls[0].success, false);
  state = retry.state;
  assert.equal(state.world.preparations.includes("inn:investigation"), false);
  assert.throws(
    () =>
      stageIdea(
        state,
        state.players[0].hero,
        idea({ goalId: goal.id, approach: goal.prompt }),
      ),
    /这个方法已经尝试过/,
  );
  stageIdea(
    state,
    state.players[0].hero,
    idea({
      goalId: goal.id,
      approach: "Compare the tune with the marks on the old beam.",
    }),
  );
  const changed = resolve(state, OWNER, { kind: "confirm" }, dice(20));
  assert.deepEqual(
    changed.rolls[0].rolls,
    [20],
    "Consumed preparation must not grant another advantage.",
  );
});

test("a first attempt with preparation cannot reopen unprepared after consumption", () => {
  let state = prepare(game());
  const goal = state.campaignSnapshot.world.opportunities.find(
    (g) => g.id === "hear-old-song",
  );
  state = perform(state, goal.id, 1, 1).state;
  assert.equal(state.world.preparations.length, 0);
  assert.throws(
    () =>
      stageIdea(
        state,
        state.players[0].hero,
        idea({ goalId: goal.id, approach: goal.prompt }),
      ),
    /这个方法已经尝试过/,
  );
});

test("free-text travel records arrival, costs one step and remains repeatable when revisiting", () => {
  let state = game();
  const walk = (target) => {
    const before = state.turns;
    const proposal = stageIdea(
      state,
      state.players[0].hero,
      idea({
        travelTo: target,
        skill: "perception",
        approach: `Walk to ${target}.`,
      }),
    );
    assert.equal(proposal.kind, "automatic");
    assert.match(proposal.success, /你来到/);
    assert.doesNotMatch(proposal.success, /准备|优势/);
    const result = resolve(state, OWNER, { kind: "confirm" }, () => {
      throw new Error("Automatic travel must not roll.");
    });
    state = result.state;
    assert.equal(here(state), target);
    assert.equal(state.turns, before + 1);
    assert.equal(result.rolls.length, 0);
    assert.match(result.fact, /你来到/);
    assert.doesNotMatch(result.fact, /准备|优势/);
    assert.equal(state.world.preparations.length, 0);
    assert.equal(state.world.attempts.length, 0);
  };
  walk("market");
  walk("inn");
  walk("market");
  assert.equal(state.world.clocks["town-inquiry"], 3);
});

for (const extra of [0, 1, 2])
  test(`failure with extra clock cost ${extra} advances exactly ${1 + extra} steps`, () => {
    const state = game();
    state.campaignSnapshot.world.opportunities.find(
      (g) => g.id === "hear-old-song",
    ).failure.clock = extra;
    const result = perform(state, "hear-old-song", 1);
    assert.equal(result.rolls[0].success, false);
    assert.equal(result.state.world.clocks["town-inquiry"], 1 + extra);
    assert.match(result.fact, new RegExp(`世界时间 \\+${1 + extra}。`));
  });

test("final choices cannot be proposed at the council before their world goals exist", () => {
  const state = travel(game(), "council");
  for (const id of [
    "final-shared-repair",
    "final-public-accountability",
    "final-open-vow",
  ]) {
    assert.equal(
      eligibleGoals(state).some((g) => g.id === id),
      false,
    );
    assert.throws(() =>
      stageIdea(
        state,
        state.players[0].hero,
        idea({ goalId: id, skill: "persuasion" }),
      ),
    );
  }
  assert.equal(state.status, "active");
  assert.equal(state.ending, null);
});

const routes = {
  "shared-repair": [
    "hear-old-song",
    "trace-market-cargo",
    "isolate-siphon-valve",
    "improvise-ferry-crossing",
    "decode-old-calibration",
    "repair-at-observatory",
  ],
  "public-accountability": [
    "trace-market-cargo",
    "organize-shore-team",
    "execute-ferry-rescue",
    "read-ferry-markers",
    "inspect-siphon",
    "close-siphon-with-workers",
    "triangulate-river-lights",
    "repair-at-observatory",
    "recover-original-ledger",
  ],
  "open-vow": [
    "trace-market-cargo",
    "inspect-siphon",
    "close-siphon-with-workers",
    "improvise-ferry-crossing",
    "read-ferry-markers",
    "study-missing-name",
    "synchronize-at-shrine",
  ],
};
for (const [ending, route] of Object.entries(routes))
  test(`${ending} is reachable through real travel and checks, then an explicit final choice`, () => {
    let state = game();
    for (const id of route) {
      const result = perform(state, id);
      assert.equal(result.rolls[0].success, true, id);
      state = result.state;
      assert.equal(
        state.status,
        "active",
        `${id} must not automatically end the campaign.`,
      );
      assert.equal(state.ending, null);
    }
    state = travel(state, "council");
    const cfg = state.campaignSnapshot.world,
      end = cfg.endings[ending];
    const choice = cfg.opportunities.find((g) => g.success.ending === ending);
    assert.ok(end.requires.every((id) => state.world.objectives.includes(id)));
    assert.ok(end.clues.every((id) => state.clues.includes(id)));
    assert.ok(
      eligibleGoals(state).some((g) => g.id === choice.id),
      "The explicit ending must survive satisfied-outcome filtering.",
    );
    for (const objective of end.requires) {
      const missing = structuredClone(state);
      missing.world.objectives = missing.world.objectives.filter(
        (id) => id !== objective,
      );
      assert.equal(
        eligibleGoals(missing).some((g) => g.id === choice.id),
        false,
        objective,
      );
    }
    for (const clue of end.clues) {
      const missing = structuredClone(state);
      missing.clues = missing.clues.filter((id) => id !== clue);
      assert.equal(
        eligibleGoals(missing).some((g) => g.id === choice.id),
        false,
        clue,
      );
    }
    const result = perform(state, choice.id);
    assert.equal(result.state.status, "complete");
    assert.equal(result.state.ending, ending);
    assert.equal(here(result.state), "council");
  });

test("public views never expose NPC secrets, the campaign snapshot or unearned discoveries", () => {
  let state = game();
  const cfg = state.campaignSnapshot.world;
  for (const npc of cfg.npcs) npc.secret = `HIDDEN_NPC_SECRET_${npc.id}`;
  cfg.clues["true-name-fragment"].text = "HIDDEN_UNEARNED_CLUE";
  cfg.objectives["history-recovered"].description = "HIDDEN_FUTURE_OBJECTIVE";
  for (const target of cfg.locations.map((l) => l.id)) {
    state = travel(state, target);
    const view = gameView(state, 0),
      text = JSON.stringify(view);
    assert.equal(Object.hasOwn(view.game, "campaignSnapshot"), false);
    assert.equal(Object.hasOwn(view.game, "requestIds"), false);
    assert.equal(text.includes("HIDDEN_NPC_SECRET_"), false);
    assert.equal(text.includes("HIDDEN_UNEARNED_CLUE"), false);
    assert.equal(text.includes("HIDDEN_FUTURE_OBJECTIVE"), false);
    assert.ok(
      view.world.objectives.every((o) =>
        view.game.world.objectives.includes(o.id),
      ),
    );
    assert.ok(view.world.npcs.every((n) => !Object.hasOwn(n, "secret")));
  }
});

test("completed world changes remain public after leaving their location", () => {
  const state = game();
  state.world.objectives.push("history-recovered");
  const result = travel(state, "market");
  assert.ok(
    gameView(result, 0).world.objectives.some(
      (o) => o.id === "history-recovered",
    ),
  );
});

test("model prose and a divine backstory cannot create mechanical rewards", () => {
  const state = game(),
    hero = structuredClone(state.players[0].hero);
  stageIdea(state, state.players[0].hero, idea());
  const result = resolve(state, OWNER, { kind: "confirm" }, dice(20));
  assert.deepEqual(result.state.players[0].hero, hero);
  assert.deepEqual(result.state.clues, []);
  assert.deepEqual(result.state.world.objectives, []);
  assert.deepEqual(result.state.world.preparations, ["inn:investigation"]);
  assert.doesNotMatch(result.fact, /godhood|destruction/);
});

test("natural 20 still fails a skill check when the total is below the DC", () => {
  const state = game();
  state.players[0].hero.abilities.CHA = 2;
  state.campaignSnapshot.world.opportunities.find(
    (g) => g.id === "hear-mela",
  ).dc = 18;
  stageIdea(
    state,
    state.players[0].hero,
    idea({ goalId: "hear-mela", skill: "persuasion" }),
  );
  const result = resolve(state, OWNER, { kind: "confirm" }, dice(20));
  assert.equal(result.rolls[0].kept, 20);
  assert.equal(result.rolls[0].total, 16);
  assert.equal(result.rolls[0].success, false);
  assert.equal(result.state.clues.includes("cargo-route"), false);
  assert.equal(result.state.world.objectives.includes("witness-safe"), false);
});

test("clock stoppedBy references must name own objective IDs", () => {
  const cfg = game().campaignSnapshot.world;
  assert.deepEqual(worldErrors(cfg), []);
  for (const invalid of ["not-an-objective", "constructor"]) {
    const broken = structuredClone(cfg);
    broken.clocks[0].stoppedBy = [invalid];
    assert.ok(
      worldErrors(broken).some(
        (message) =>
          message.includes("town-inquiry") &&
          message.includes(`unknown reference ${invalid}`),
      ),
    );
  }
});
