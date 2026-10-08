export function worldErrors(world) {
  const errors = [],
    loc = new Set(world.locations.map((x) => x.id)),
    npc = new Set(world.npcs.map((x) => x.id)),
    goals = new Set(world.opportunities.map((x) => x.id));
  const refs = (values, valid, label) => {
    for (const id of values)
      if (!valid(id)) errors.push(`${label}: unknown reference ${id}`);
  };
  for (const [list, label] of [
    [world.locations, "locations"],
    [world.npcs, "npcs"],
    [world.opportunities, "opportunities"],
    [world.clocks, "clocks"],
    [world.backstoryHooks, "backstoryHooks"],
  ])
    if (new Set(list.map((x) => x.id)).size !== list.length)
      errors.push(`${label}: duplicate ID`);
  for (const l of world.locations) {
    refs(l.exits, (id) => loc.has(id), l.id);
    refs(l.npcIds, (id) => npc.has(id), l.id);
    for (const id of l.npcIds) {
      const person = world.npcs.find((n) => n.id === id);
      if (person && person.location !== l.id)
        errors.push(`${l.id}: NPC ${id} belongs to ${person.location}`);
    }
  }
  for (const n of world.npcs)
    if (
      !loc.has(n.location) ||
      !world.locations.find((l) => l.id === n.location)?.npcIds.includes(n.id)
    )
      errors.push(`${n.id}: NPC location mismatch`);
  const reached = new Set([world.locations[0].id]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const l of world.locations)
      if (reached.has(l.id))
        for (const id of l.exits)
          if (!reached.has(id)) {
            reached.add(id);
            changed = true;
          }
  }
  if (reached.size !== loc.size)
    errors.push("Locations must be reachable from the first location.");
  const hasClue = (id) => Object.hasOwn(world.clues, id),
    hasObjective = (id) => Object.hasOwn(world.objectives, id);
  // Clock interventions are potential producers; dynamic timing and stopped clocks still need playtesting.
  const thresholds = world.clocks.flatMap((c) =>
    c.thresholds.filter((t) => t.at >= 1 && t.at <= c.max),
  );
  const available = new Set(
    thresholds.map((t) => t.clue).filter((id) => id && hasClue(id)),
  );
  const availableObjectives = new Set(
    thresholds.map((t) => t.objective).filter((id) => id && hasObjective(id)),
  );
  for (let changed = true; changed; ) {
    changed = false;
    for (const g of world.opportunities) {
      if (
        !reached.has(g.location) ||
        !g.requires.every((id) => available.has(id))
      )
        continue;
      // Ending rewards arrive after play stops, so they cannot unlock another action or ending.
      if (g.success.ending) continue;
      for (const id of g.success.clues)
        if (hasClue(id) && !available.has(id)) {
          available.add(id);
          changed = true;
        }
      for (const id of g.success.objectives)
        if (hasObjective(id) && !availableObjectives.has(id)) {
          availableObjectives.add(id);
          changed = true;
        }
    }
  }
  for (const g of world.opportunities) {
    refs([g.location], (id) => loc.has(id), g.id);
    refs(g.requires, hasClue, g.id);
    refs(g.success.clues, hasClue, g.id);
    refs(g.success.objectives, hasObjective, g.id);
    if (g.success.trustNpc)
      refs([g.success.trustNpc], (id) => npc.has(id), g.id);
    if (g.requires.some((id) => !available.has(id)))
      errors.push(`${g.id}: unreachable clue prerequisites`);
    if (
      g.success.trustNpc &&
      !world.locations
        .find((l) => l.id === g.location)
        ?.npcIds.includes(g.success.trustNpc)
    )
      errors.push(`${g.id}: trust NPC must be at this location`);
    if (g.success.ending && !Object.hasOwn(world.endings, g.success.ending))
      errors.push(`${g.id}: unknown ending`);
  }
  for (const c of world.clocks) {
    refs(c.stoppedBy || [], hasObjective, c.id);
    const ats = new Set();
    for (const t of c.thresholds) {
      if (t.at > c.max || ats.has(t.at))
        errors.push(`${c.id}: invalid threshold`);
      ats.add(t.at);
      if (t.clue) refs([t.clue], hasClue, c.id);
      if (t.objective) refs([t.objective], hasObjective, c.id);
    }
  }
  if (!Object.hasOwn(world.endings, "retreat"))
    errors.push("A retreat ending is required.");
  for (const [id, e] of Object.entries(world.endings)) {
    refs(e.requires || [], hasObjective, id);
    refs(e.clues || [], hasClue, id);
    if (id !== "retreat") {
      if (!world.opportunities.some((g) => g.success.ending === id))
        errors.push(`${id}: ending has no explicit choice`);
      if (
        (e.requires || []).some((id) => !availableObjectives.has(id)) ||
        (e.clues || []).some((id) => !available.has(id))
      )
        errors.push(`${id}: unreachable ending prerequisites`);
    }
  }
  for (const h of world.backstoryHooks)
    if (!loc.has(h.location)) errors.push(`${h.id}: unknown hook location`);
  if (!goals.size) errors.push("No opportunities.");
  return errors;
}
