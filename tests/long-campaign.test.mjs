import test from "node:test";
import assert from "node:assert/strict";
import Ajv from "ajv";
import world from "../content/worlds/tide-testament.json" with { type: "json" };
import schema from "../content/world.schema.json" with { type: "json" };
import { worldErrors } from "../lib/game/world-validation.mjs";
import { asCampaign } from "../lib/game/campaigns.ts";
import { createHero } from "../lib/game/characters.ts";
import { createGame, resolve, gameView, availableActions } from "../lib/game/engine.ts";
import { initializeWorld, eligibleGoals, stageIdea } from "../lib/game/world-engine.ts";

const OWNER = "long-campaign-owner";
const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);

function game() {
  const state = createGame(
    crypto.randomUUID(), OWNER,
    createHero(crypto.randomUUID(), "fighter", "Tide Tester", "I claim to be the lost god of tides."),
    "moonbridge-conspiracy", "solo", "TID234",
  );
  state.campaignId = world.id;
  state.campaignRevision = world.revision;
  state.campaignSnapshot = asCampaign(structuredClone(world));
  state.messages = [{ id: crypto.randomUUID(), role: "dm", text: world.hook }];
  initializeWorld(state);
  return state;
}
function here(state) {
  return state.campaignSnapshot.world.locations[state.scene].id;
}
function travel(state, target) {
  const locations = state.campaignSnapshot.world.locations;
  const queue = [[here(state)]], seen = new Set();
  while (queue.length) {
    const path = queue.shift(), last = path.at(-1);
    if (last === target) {
      for (const id of path.slice(1)) {
        assert.ok(availableActions(state).some(action => action.id === `travel:${id}`));
        const result = resolve(state, OWNER, { kind: "action", actionId: `travel:${id}` }, () => {
          throw new Error("Travel must not roll.");
        });
        assert.equal(result.rolls.length, 0);
        state = result.state;
      }
      return state;
    }
    if (seen.has(last)) continue;
    seen.add(last);
    for (const id of locations.find(location => location.id === last).exits)
      queue.push([...path, id]);
  }
  throw new Error(`No directed path to ${target}`);
}
function satisfied(state, goal) {
  return goal.success.clues.every(id => state.clues.includes(id)) &&
    goal.success.objectives.every(id => state.world.objectives.includes(id));
}
function perform(state, id, die = 20, alternative = false) {
  const goal = world.opportunities.find(value => value.id === id);
  assert.ok(goal, `Unknown goal ${id}`);
  state = travel(state, goal.location);
  assert.ok(eligibleGoals(state).some(value => value.id === id), `Unavailable goal ${id}`);
  const before = state.turns;
  if (alternative) {
    state = structuredClone(state);
    stageIdea(state, state.players[0].hero, {
      title: goal.title,
      approach: `Use a different corroborating method for ${id}; compare another allowed observation and explain the result.`,
      skill: goal.skills.at(-1), goalId: id, success: "Untrusted reward", failure: "Untrusted destruction",
    });
  } else {
    const staged = resolve(state, OWNER, { kind: "action", actionId: `goal:${id}` });
    assert.equal(staged.rolls.length, 0);
    state = staged.state;
  }
  assert.equal(state.turns, before, "An unconfirmed proposal cannot consume world time.");
  const result = resolve(state, OWNER, { kind: "confirm" }, () => die);
  assert.equal(result.rolls.length, 1);
  assert.equal(result.rolls[0].success, die === 20, id);
  return result.state;
}
function route(state, ids) {
  const performed = [];
  for (const id of ids) {
    const goal = world.opportunities.find(value => value.id === id);
    if (!goal.success.ending && satisfied(state, goal)) continue;
    state = perform(state, id);
    performed.push(id);
    assert.equal(state.status, goal.success.ending ? "complete" : "active", id);
  }
  return { state, performed };
}

const commonRoute = [
  "prepare-relief", "bargain-boats", "relay-relief", "hear-child-song", "trace-messenger",
  "inspect-counterflow", "speak-pilot", "read-tideposts", "triangulate-beacon",
  "chart-beacon-fault", "repair-beacon", "find-maintenance-hatch", "draw-blueprints",
  "raise-lower-gates", "drain-archive", "read-terrace-mechanism", "inspect-memory-silt",
  "study-chapel-map", "read-contract-by-index", "replay-core-terms", "supply-marsh",
  "fund-record-copies", "preserve-public-record", "verify-three-controls",
  "calibrate-observatory", "map-dry-path", "secure-lighthouse-exit",
  "agree-return-pact", "finish-memory-copies",
];
const branches = {
  "voluntary-renewal": [
    "hear-courier", "recover-dispatch", "rescue-courier", "interview-commander",
    "secure-original-order", "authorize-inspection", "enter-lighthouse-with-pass",
    "isolate-archive", "stabilize-tide-heart", "read-memorial-names", "answer-lost-names",
    "ask-preserved-witnesses", "trace-consent-gap", "renew-voluntary-witnesses",
    "negotiate-growers", "draft-civic-charter", "prepare-public-hearing",
    "confirm-council-mandate", "prepare-voluntary-renewal", "choose-voluntary-renewal",
  ],
  "open-tide": [
    "examine-cargo", "compare-duplicate-order", "rescue-mail-cart", "secure-duplicate-order",
    "read-bypass-sequence", "enter-lighthouse-by-bypass", "isolate-archive", "stabilize-tide-heart",
    "answer-lost-names", "ask-preserved-witnesses", "calculate-drainage-window",
    "open-sea-channel", "prepare-release", "prepare-public-hearing", "choose-open-tide",
  ],
  "public-custody": [
    "examine-cargo", "compare-duplicate-order", "rescue-mail-cart", "secure-duplicate-order",
    "hear-harbor-case", "read-bypass-sequence", "enter-lighthouse-by-bypass",
    "triangulate-beacon", "reserve-stone-loads", "assemble-repair-team",
    "isolate-with-repair-team", "stabilize-tide-heart", "negotiate-harbor-support",
    "negotiate-growers", "draft-civic-charter", "prepare-public-hearing",
    "confirm-council-mandate", "secure-ward-care", "choose-public-custody",
  ],
};

test("the long campaign uses the canonical contract, with substantive content in five connected areas", () => {
  assert.equal(validate(world), true, JSON.stringify(validate.errors));
  assert.deepEqual(worldErrors(world), []);
  assert.equal(world.locations.length, 25);
  assert.equal(world.npcs.length, 25);
  assert.equal(world.opportunities.length, 78);
  assert.equal(Object.keys(world.clues).length, 70);
  assert.equal(Object.keys(world.objectives).length, 53);
  assert.equal(Object.keys(world.endings).length, 4);
  assert.equal(world.backstoryHooks.length, 10);
  assert.equal(world.opportunities.filter(goal => goal.encounter).length, 1);
  for (const goal of world.opportunities) {
    assert.ok(goal.skills.length >= 3, `${goal.id} must support distinct methods.`);
    assert.ok(goal.success.ending || goal.success.clues.length + goal.success.objectives.length > 0);
    assert.ok(goal.dc <= 12, `${goal.id} should remain achievable with current level-one characters.`);
  }
  for (const location of world.locations) {
    const visited = travel(game(), location.id);
    const returned = travel(visited, world.locations[0].id);
    assert.equal(here(returned), world.locations[0].id, `${location.id} cannot trap a player.`);
  }
});

for (const [ending, branch] of Object.entries(branches)) {
  test(`${ending} can be completed using real travel and distinct noncombat checks`, () => {
    let { state, performed } = route(game(), commonRoute);
    const baseCount = performed.length;
    ({ state, performed } = route(state, branch));
    assert.ok(baseCount + performed.length >= 30, "A primary route should require sustained play.");
    assert.equal(state.status, "complete");
    assert.equal(state.ending, ending);
    assert.equal(here(state), "oath-bridge");
    assert.equal(state.combat, null);
    for (const id of world.endings[ending].requires)
      assert.ok(state.world.objectives.includes(id), `${ending}: missing ${id}`);
    for (const id of world.endings[ending].clues)
      assert.ok(state.clues.includes(id), `${ending}: missing ${id}`);
    assert.ok(state.messages.at(-1).text.includes(world.endings[ending].title));
    assert.throws(() => resolve(state, OWNER, { kind: "action", actionId: "travel:tide-heart" }));
  });
}

test("all nonterminal opportunities can be explored, revisited and persisted before choosing an ending", () => {
  const ids = world.opportunities.filter(goal => !goal.success.ending).map(goal => goal.id);
  let { state, performed } = route(game(), ids);
  assert.ok(performed.length >= 60, `Only ${performed.length} meaningful opportunities executed.`);
  assert.equal(state.status, "active");
  assert.equal(state.ending, null);
  assert.equal(state.combat, null);
  assert.equal(state.clues.length, Object.keys(world.clues).length);
  assert.equal(state.world.objectives.length, Object.keys(world.objectives).length);
  assert.equal(state.players[0].hero.hp, state.players[0].hero.maxHp);
  const before = JSON.parse(JSON.stringify(state));
  state = travel(state, "lantern-inn");
  assert.deepEqual(state.world.objectives, before.world.objectives);
  assert.deepEqual(state.clues, before.clues);
  state = travel(state, "oath-bridge");
  for (const ending of Object.keys(branches))
    assert.ok(eligibleGoals(state).some(goal => goal.success.ending === ending));
  const stored = JSON.parse(JSON.stringify(state));
  for (const ending of Object.keys(branches)) {
    const choice = world.opportunities.find(goal => goal.success.ending === ending);
    const completed = perform(structuredClone(stored), choice.id);
    assert.equal(completed.ending, ending);
  }
});

test("a failed document check grants no proof, blocks an identical retry, and supports an independent source", () => {
  let state = perform(game(), "hear-courier");
  state = perform(state, "recover-dispatch", 1);
  assert.equal(state.clues.includes("first-order"), false);
  assert.equal(state.world.objectives.includes("orders-secured"), false);
  assert.equal(availableActions(state).some(action => action.id === "goal:recover-dispatch"), false);
  assert.throws(() => resolve(state, OWNER, { kind: "action", actionId: "goal:recover-dispatch" }), /这个方法已经尝试过/);
  state = perform(state, "examine-cargo");
  state = perform(state, "compare-duplicate-order");
  assert.ok(state.clues.includes("first-order"));
  assert.ok(state.world.objectives.includes("orders-secured"));
  state = travel(state, "courier-house");
  assert.equal(eligibleGoals(state).some(goal => goal.id === "recover-dispatch"), false);
  assert.equal(state.status, "active");
});

test("repeated failure and exhausted clocks still allow a changed method and a real ending", () => {
  let state = game();
  for (const id of ["prepare-relief", "read-city-routes", "rescue-courier", "examine-cargo", "inspect-counterflow"])
    state = perform(state, id, 1);
  assert.equal(state.world.objectives.includes("supplies-prepared"), false);
  assert.equal(state.clues.includes("cargo-switch"), false);
  for (let index = 0; index < 105; index++)
    state = travel(state, index % 2 ? "lantern-inn" : "salt-market");
  assert.equal(state.status, "active");
  assert.equal(state.ending, null);
  assert.ok(state.clues.includes("core-terms"));
  assert.ok(state.world.objectives.includes("residents-protected"));
  assert.ok(state.world.objectives.includes("oldlock-stable"));
  state = perform(state, "prepare-relief", 20, true);
  state = perform(state, "inspect-counterflow", 20, true);
  state = perform(state, "examine-cargo", 20, true);
  ({ state } = route(state, commonRoute));
  ({ state } = route(state, branches["public-custody"]));
  assert.equal(state.ending, "public-custody");
});

test("stabilization pauses clocks without choosing a future; each ending requires every promised prerequisite", () => {
  let { state } = route(game(), world.opportunities.filter(goal => !goal.success.ending).map(goal => goal.id));
  const clocks = structuredClone(state.world.clocks);
  state = travel(state, "lantern-inn");
  state = resolve(state, OWNER, { kind: "session" }).state;
  state = travel(state, "oath-bridge");
  assert.equal(state.status, "active");
  assert.equal(state.ending, null);
  assert.deepEqual(state.world.clocks, clocks);
  for (const [id, ending] of Object.entries(world.endings)) {
    if (id === "retreat") continue;
    const choice = world.opportunities.find(goal => goal.success.ending === id);
    for (const objective of ending.requires) {
      const missing = structuredClone(state);
      missing.world.objectives = missing.world.objectives.filter(value => value !== objective);
      assert.equal(eligibleGoals(missing).some(goal => goal.id === choice.id), false, `${id}: ${objective}`);
    }
    for (const clue of ending.clues) {
      const missing = structuredClone(state);
      missing.clues = missing.clues.filter(value => value !== clue);
      assert.equal(eligibleGoals(missing).some(goal => goal.id === choice.id), false, `${id}: ${clue}`);
    }
  }
});

test("failing the last authorization does not execute it or prevent a different prepared future", () => {
  let { state } = route(game(), world.opportunities.filter(goal => !goal.success.ending).map(goal => goal.id));
  const before = structuredClone(state.world.objectives);
  state = perform(state, "choose-voluntary-renewal", 1);
  assert.equal(state.status, "active");
  assert.equal(state.ending, null);
  assert.deepEqual(state.world.objectives, before);
  assert.equal(state.flags.includes("worldgoal:choose-voluntary-renewal"), false);
  assert.equal(availableActions(state).some(action => action.id === "goal:choose-voluntary-renewal"), false);
  assert.ok(availableActions(state).some(action => action.id === "goal:choose-open-tide"));
  state = perform(state, "choose-open-tide");
  assert.equal(state.status, "complete");
  assert.equal(state.ending, "open-tide");
});

test("unearned secrets and a divine claim never become public mechanical facts", () => {
  let state = game();
  const hero = structuredClone(state.players[0].hero);
  const view = JSON.stringify(gameView(state, 0));
  for (const npc of world.npcs) assert.equal(view.includes(npc.secret), false, npc.id);
  for (const clue of Object.values(world.clues)) assert.equal(view.includes(clue.text), false, clue.title);
  state = route(state, ["read-memorial-names", "record-unbound-name"]).state;
  assert.deepEqual(state.players[0].hero, hero);
  assert.ok(state.world.objectives.includes("identity-recorded"));
  assert.ok(state.clues.includes("unbound-name"));
  assert.equal(state.status, "active");
  const retired = resolve(state, OWNER, { kind: "retreat" }).state;
  assert.equal(retired.ending, "retreat");
  assert.equal(retired.status, "complete");
});
