export function semanticErrors(campaign) {
  const errors = [], scenes = campaign.scenes, seenScenes = new Set(), seenActions = new Set();
  const clues = new Set(Object.keys(campaign.clues)), flags = new Set(campaign.flags), endingRefs = new Set(), clueRefs = new Set(), flagRefs = new Set();
  for (const flag of flags) if (clues.has(flag)) errors.push(`flags/${flag}: flag and clue IDs must differ`);
  const reachable = new Set([0]);
  scenes.forEach((scene,index) => {
    const path = `scenes/${index}`;
    if (seenScenes.has(scene.id)) errors.push(`${path}/id: duplicate scene ID`);
    seenScenes.add(scene.id);
    if (!reachable.has(index)) errors.push(`${path}: unreachable scene`);
    if (!scene.actions.some(a => a.kind === 'automatic' && !a.requiresClue && (a.next !== undefined || a.ending))) errors.push(`${path}: requires an unconditional automatic forward action or ending so failed checks cannot lock the story`);
    const combat = scene.actions.filter(a => a.kind === 'combat');
    if ((!!scene.enemy) !== (combat.length > 0)) errors.push(`${path}: enemy and combat action must appear together`);
    if (combat.length > 1) errors.push(`${path}: at most one combat action is supported`);
    if (scene.enemy && scene.enemy.hp !== scene.enemy.maxHp) errors.push(`${path}/enemy: initial hp must equal maxHp`);
    for (const action of scene.actions) {
      const at = `${path}/actions/${action.id}`;
      if (seenActions.has(action.id)) errors.push(`${at}: duplicate action ID`);
      seenActions.add(action.id);
      if (action.next !== undefined) {
        if (action.next <= index || action.next >= scenes.length) errors.push(`${at}/next: must reference a later existing scene index`);
        else if (reachable.has(index)) reachable.add(action.next);
      }
      if (action.ending) {
        if (!Object.hasOwn(campaign.endings,action.ending)) errors.push(`${at}/ending: unknown ending`);
        if (action.ending === 'retreat') errors.push(`${at}/ending: retreat is reserved for the engine's rescue/retreat flow`);
        endingRefs.add(action.ending);
      }
      if (!action.next && !action.ending && !action.clue && !action.flag) errors.push(`${at}: action has no supported effect`);
      for (const key of ['clue','requiresClue']) if (action[key] && !clues.has(action[key])) errors.push(`${at}/${key}: unknown clue`);
      if (action.clue) clueRefs.add(action.clue);
      if (action.flag) {flagRefs.add(action.flag); if (!flags.has(action.flag)) errors.push(`${at}/flag: undeclared flag`);}
      if (action.advantageFlag && !clues.has(action.advantageFlag) && !flags.has(action.advantageFlag)) errors.push(`${at}/advantageFlag: undeclared clue/flag`);
      if (action.requiresClue) {
        const obtainable = scenes.slice(0,index+1).some((s,i) => s.actions.some(a => a.clue === action.requiresClue && a.requiresClue !== action.requiresClue && (i < index || a.next === undefined)));
        if (!obtainable) errors.push(`${at}/requiresClue: no prior or local producer can make this clue available`);
      }
    }
  });
  for (const ending of Object.keys(campaign.endings)) if (ending !== 'retreat' && !endingRefs.has(ending)) errors.push(`endings/${ending}: unused ending`);
  for (const clue of clues) if (!clueRefs.has(clue)) errors.push(`clues/${clue}: never granted`);
  for (const flag of flags) if (!flagRefs.has(flag)) errors.push(`flags/${flag}: never granted`);
  if (!errors.length) errors.push(...reachabilityErrors(campaign));
  return errors;
}

function reachabilityErrors(campaign) {
  const visited = new Set(), reachedScenes = new Set(), reachedClues = new Set(), reachedEndings = new Set();
  const queue = [{scene:0,clues:[],flags:[],attempts:[]}];
  for (let cursor=0; cursor<queue.length; cursor++) {
    const state=queue[cursor], key=JSON.stringify([state.scene,state.clues.toSorted(),state.flags.toSorted(),state.attempts.toSorted()]);
    if (visited.has(key)) continue;
    visited.add(key);
    if (visited.size>20000) return ['scenes: dependency graph exceeds the supported 20000-state validation limit; simplify branching'];
    reachedScenes.add(state.scene);
    const scene=campaign.scenes[state.scene];
    for (const action of scene.actions) {
      if (action.requiresClue && !state.clues.includes(action.requiresClue)) continue;
      if (state.attempts.includes(action.id)) continue;
      if ((action.clue || action.flag) && action.next===undefined && !action.ending && (!action.clue || state.clues.includes(action.clue)) && (!action.flag || state.flags.includes(action.flag))) continue;
      const next={scene:action.next??state.scene,clues:[...state.clues],flags:[...state.flags],attempts:action.next!==undefined?[]:[...state.attempts]};
      if (action.kind==='check') {
        next.attempts.push(action.id);
        queue.push({...state,attempts:[...state.attempts,action.id]});
      }
      if (action.clue && !next.clues.includes(action.clue)) next.clues.push(action.clue);
      if (action.flag && !next.flags.includes(action.flag)) next.flags.push(action.flag);
      if (action.ending) reachedEndings.add(action.ending);
      else {for(const clue of next.clues) reachedClues.add(clue); queue.push(next);}
    }
  }
  const errors=[];
  campaign.scenes.forEach((_,index)=> {if (!reachedScenes.has(index)) errors.push(`scenes/${index}: blocked by unavailable clue dependencies`);});
  for (const clue of Object.keys(campaign.clues)) if (!reachedClues.has(clue)) errors.push(`clues/${clue}: unreachable producer or circular clue dependency`);
  for (const ending of Object.keys(campaign.endings)) if (ending!=='retreat' && !reachedEndings.has(ending)) errors.push(`endings/${ending}: unreachable with supported action preconditions`);
  return errors;
}
