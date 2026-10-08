import test from "node:test";
import assert from "node:assert/strict";
import Ajv from "ajv";
import schema from "../content/world.schema.json" with { type: "json" };
import moonbridge from "../content/worlds/moonbridge-conspiracy.json" with { type: "json" };
import { worldErrors } from "../lib/game/world-validation.mjs";
import { createHero } from "../lib/game/characters.ts";
import { createGame, resolve } from "../lib/game/engine.ts";
import { initializeWorld, eligibleGoals } from "../lib/game/world-engine.ts";

const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
function shape(world) {
  assert.equal(validate(world), true, JSON.stringify(validate.errors));
}
function fixture() {
  const clue = (id) => ({ title: id, text: `Known fact ${id}` });
  const objective = (id) => ({ title: id, description: `World change ${id}` });
  const opportunity = (id, location, requires, clues, objectives, ending) => ({
    id,
    location,
    title: id,
    prompt: `Investigate ${id}`,
    skills: ["investigation"],
    dc: 10,
    requires,
    success: {
      text: `Completed ${id}`,
      clues,
      objectives,
      ...(ending ? { ending } : {}),
    },
    failure: { text: `Not completed ${id}`, clock: 1 },
  });
  return {
    ...structuredClone(moonbridge),
    id: "clock-dependency-fixture",
    locations: [
      {
        id: "camp",
        title: "Camp",
        description: "The caretaker keeps the records.",
        npcIds: ["caretaker"],
        exits: ["crossing"],
        safeRest: true,
      },
      {
        id: "crossing",
        title: "Crossing",
        description: "Marks on the old bridge.",
        npcIds: [],
        exits: ["camp"],
        safeRest: false,
      },
    ],
    npcs: [
      {
        id: "caretaker",
        name: "Caretaker",
        role: "Keeper of the camp",
        want: "Understand the bridge",
        secret: "An undisclosed record",
        location: "camp",
      },
    ],
    clues: Object.fromEntries(
      ["clock-clue", "route-clue", "prize-clue"].map((id) => [id, clue(id)]),
    ),
    objectives: Object.fromEntries(
      ["prelude", "explored", "resolved"].map((id) => [id, objective(id)]),
    ),
    opportunities: [
      opportunity(
        "find-crossing",
        "crossing",
        ["clock-clue"],
        ["route-clue"],
        ["explored"],
      ),
      opportunity(
        "read-original",
        "camp",
        ["route-clue"],
        ["prize-clue"],
        ["resolved"],
      ),
      opportunity("make-choice", "camp", ["prize-clue"], [], [], "peaceful"),
    ],
    clocks: [
      {
        id: "news",
        title: "News arrives",
        max: 8,
        thresholds: [
          {
            at: 2,
            text: "The camp receives an old map.",
            clue: "clock-clue",
            objective: "prelude",
          },
        ],
      },
    ],
    endings: {
      retreat: { title: "Leave", text: "Return home." },
      peaceful: {
        title: "Make peace",
        text: "The dispute is resolved.",
        requires: ["prelude", "resolved"],
        clues: ["prize-clue"],
      },
    },
    backstoryHooks: [
      {
        id: "camp-memory",
        location: "camp",
        question: "What do the records remind you of?",
        tags: ["memory"],
        truthStatus: "unresolved",
      },
      {
        id: "bridge-memory",
        location: "crossing",
        question: "Who once crossed with you?",
        tags: ["memory"],
        truthStatus: "unresolved",
      },
    ],
  };
}
function opportunityOnlyFixture() {
  const world = fixture();
  world.opportunities[0].requires = [];
  world.opportunities[0].success.clues.push("clock-clue");
  return world;
}
function fixtureGame(world) {
  const state = createGame(
    crypto.randomUUID(),
    "owner",
    createHero(crypto.randomUUID(), "fighter", "Tester", ""),
    "moonbridge-conspiracy",
    "solo",
    "ABC234",
  );
  state.campaignSnapshot = {
    ...world,
    world,
    flags: [],
    scenes: world.locations.map((l) => ({
      id: l.id,
      title: l.title,
      description: l.description,
      npc: "",
      safeRest: l.safeRest,
      actions: [],
    })),
  };
  initializeWorld(state);
  return state;
}
function finish(state, id) {
  const staged = resolve(state, "owner", {
    kind: "action",
    actionId: `goal:${id}`,
  });
  const result = resolve(staged.state, "owner", { kind: "confirm" }, () => 20);
  assert.equal(result.rolls[0].success, true);
  return result.state;
}

test("a clock-produced clue seeds a legal opportunity chain and its ending", () => {
  const world = fixture();
  shape(world);
  assert.deepEqual(worldErrors(world), []);
  let state = fixtureGame(world);
  state = resolve(state, "owner", {
    kind: "action",
    actionId: "travel:crossing",
  }).state;
  assert.equal(
    eligibleGoals(state).some((g) => g.id === "find-crossing"),
    false,
  );
  state = resolve(state, "owner", {
    kind: "action",
    actionId: "travel:camp",
  }).state;
  assert.ok(state.clues.includes("clock-clue"));
  assert.ok(state.world.objectives.includes("prelude"));
  assert.equal(
    state.status,
    "active",
    "The threshold must not select the ending.",
  );
  state = resolve(state, "owner", {
    kind: "action",
    actionId: "travel:crossing",
  }).state;
  state = finish(state, "find-crossing");
  state = resolve(state, "owner", {
    kind: "action",
    actionId: "travel:camp",
  }).state;
  state = finish(state, "read-original");
  assert.equal(state.status, "active");
  state = finish(state, "make-choice");
  assert.equal(state.ending, "peaceful");
  assert.equal(state.status, "complete");
});

test("a clock can break an otherwise circular clue dependency", () => {
  const world = fixture();
  world.opportunities[0].requires = ["prize-clue"];
  world.opportunities[1].requires = ["route-clue"];
  world.clocks[0].thresholds[0].clue = "prize-clue";
  shape(world);
  assert.deepEqual(worldErrors(world), []);
  delete world.clocks[0].thresholds[0].clue;
  shape(world);
  assert.ok(
    worldErrors(world).some((e) =>
      e.includes("unreachable clue prerequisites"),
    ),
  );
});

test("each NPC must be listed only at its declared location", () => {
  const world = opportunityOnlyFixture();
  shape(world);
  assert.deepEqual(worldErrors(world), []);
  world.locations[1].npcIds.push("caretaker");
  shape(world);
  assert.ok(
    worldErrors(world).includes("crossing: NPC caretaker belongs to camp"),
  );
});

test("an NPC missing from its own location is still rejected", () => {
  const world = opportunityOnlyFixture();
  world.locations[0].npcIds = [];
  shape(world);
  assert.ok(worldErrors(world).includes("caretaker: NPC location mismatch"));
});

test("different background hooks cannot reuse one ID", () => {
  const world = opportunityOnlyFixture();
  world.backstoryHooks[1].id = world.backstoryHooks[0].id;
  shape(world);
  assert.ok(worldErrors(world).includes("backstoryHooks: duplicate ID"));
});

test("an ending cannot require an objective with no producer", () => {
  const world = opportunityOnlyFixture();
  world.objectives.unproduced = {
    title: "Unproduced",
    description: "No configured action grants it.",
  };
  world.endings.peaceful.requires.push("unproduced");
  shape(world);
  assert.ok(
    worldErrors(world).includes("peaceful: unreachable ending prerequisites"),
  );
});

test("a final choice cannot supply the prerequisite that would unlock itself", () => {
  const world = opportunityOnlyFixture();
  world.opportunities[1].success.objectives = [];
  world.opportunities[2].success.objectives = ["resolved"];
  shape(world);
  assert.ok(
    worldErrors(world).includes("peaceful: unreachable ending prerequisites"),
  );
});

test("rewards of one ending cannot unlock another ending after play has stopped", () => {
  const world = opportunityOnlyFixture();
  world.objectives["post-ending"] = {
    title: "Post ending",
    description: "Only granted after the first ending.",
  };
  world.opportunities[2].success.objectives = ["post-ending"];
  shape(world);
  assert.deepEqual(
    worldErrors(world),
    [],
    "Unused terminal rewards are allowed.",
  );
  world.endings.second = {
    title: "Second ending",
    text: "A different ending.",
    requires: ["post-ending"],
    clues: ["prize-clue"],
  };
  const choice = structuredClone(world.opportunities[2]);
  choice.id = "second-choice";
  choice.success.objectives = [];
  choice.success.ending = "second";
  world.opportunities.push(choice);
  shape(world);
  assert.ok(
    worldErrors(world).includes("second: unreachable ending prerequisites"),
  );
});

test("clock-provided objectives are valid ending prerequisites without opportunity producers", () => {
  const world = opportunityOnlyFixture();
  shape(world);
  assert.equal(
    world.opportunities.some((g) => g.success.objectives.includes("prelude")),
    false,
  );
  assert.deepEqual(worldErrors(world), []);
});

test("directed exits, unsorted thresholds and namespace-local IDs remain legal", () => {
  const world = opportunityOnlyFixture();
  world.locations[1].exits = [];
  world.opportunities[1].location = "crossing";
  world.opportunities[2].location = "crossing";
  world.npcs[0].id = "camp";
  world.locations[0].npcIds = ["camp"];
  world.backstoryHooks[0].id = world.opportunities[0].id;
  world.clocks[0].thresholds.unshift({ at: 4, text: "A later public report." });
  shape(world);
  assert.deepEqual(worldErrors(world), []);
});

test("unknown and inherited references are rejected at every configurable reference boundary", () => {
  const cases = [
    [
      (w) => w.locations[0].exits.push("missing"),
      /camp: unknown reference missing/,
    ],
    [
      (w) => w.locations[0].npcIds.push("missing"),
      /camp: unknown reference missing/,
    ],
    [
      (w) => (w.npcs[0].location = "missing"),
      /caretaker: NPC location mismatch/,
    ],
    [
      (w) => (w.opportunities[0].location = "missing"),
      /find-crossing: unknown reference missing/,
    ],
    [
      (w) => w.opportunities[0].requires.push("missing"),
      /find-crossing: unknown reference missing/,
    ],
    [
      (w) => w.opportunities[0].success.clues.push("missing"),
      /find-crossing: unknown reference missing/,
    ],
    [
      (w) => w.opportunities[0].success.objectives.push("missing"),
      /find-crossing: unknown reference missing/,
    ],
    [
      (w) => (w.opportunities[0].success.trustNpc = "missing"),
      /find-crossing: unknown reference missing/,
    ],
    [
      (w) => (w.opportunities[2].success.ending = "constructor"),
      /make-choice: unknown ending/,
    ],
    [
      (w) => (w.clocks[0].stoppedBy = ["constructor"]),
      /news: unknown reference constructor/,
    ],
    [
      (w) => (w.clocks[0].thresholds[0].clue = "missing"),
      /news: unknown reference missing/,
    ],
    [
      (w) => (w.clocks[0].thresholds[0].objective = "missing"),
      /news: unknown reference missing/,
    ],
    [
      (w) => w.endings.peaceful.requires.push("constructor"),
      /peaceful: unknown reference constructor/,
    ],
    [
      (w) => w.endings.peaceful.clues.push("constructor"),
      /peaceful: unknown reference constructor/,
    ],
    [
      (w) => (w.backstoryHooks[0].location = "missing"),
      /camp-memory: unknown hook location/,
    ],
  ];
  for (const [mutate, error] of cases) {
    const world = opportunityOnlyFixture();
    mutate(world);
    shape(world);
    assert.ok(
      worldErrors(world).some((message) => error.test(message)),
      String(error),
    );
  }
});

test("existing Moonbridge configuration still passes both contracts", () => {
  shape(moonbridge);
  assert.deepEqual(worldErrors(moonbridge), []);
});
