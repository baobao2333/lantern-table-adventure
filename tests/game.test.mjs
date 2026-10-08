import test from 'node:test';
import assert from 'node:assert/strict';
import {createHero, skillMod} from '../lib/game/characters.ts';
import {CAMPAIGNS} from '../lib/game/campaigns.ts';
import {createGame, resolve, availableActions, checkRoll, attackRoll, gameView} from '../lib/game/engine.ts';
import {semanticErrors} from '../lib/game/content-validation.mjs';
import Ajv from 'ajv';
import schema from '../content/campaign.schema.json' with {type:'json'};

const valid = new Ajv({allErrors:true,strict:false}).compile(schema);
function game(classId='fighter', campaignId='silent-bell') {return createGame(crypto.randomUUID(),'owner',createHero(crypto.randomUUID(),classId,'Tester',''),'silent-bell' === campaignId ? 'silent-bell' : campaignId,'solo','ABC234');}
function act(state,id,die=()=>1) {return resolve(state,'owner',{kind:'action',actionId:id},die).state;}
function command(state,kind,die=()=>1) {return resolve(state,'owner',{kind},die).state;}
function dice(...values) {return sides => {const value=values.shift(); assert.ok(value >= 1 && value <= sides,`Missing/out-of-range d${sides}: ${value}`); return value;};}

test('every shipped campaign passes strict schema and semantic checks',()=> {
  for (const campaign of CAMPAIGNS) {assert.equal(valid(campaign),true,JSON.stringify(valid.errors)); assert.deepEqual(semanticErrors(campaign),[]);}
});
test('schema rejects scripts, unsupported rule versions and mixed action types',()=> {
  const source=CAMPAIGNS.find(c=>c.id==='silent-bell');
  for (const mutate of [c=>{c.scenes[0].actions[0].script='changeHP(100)';},c=>{c.rulesVersion='anything';},c=>{c.scenes[0].actions[0].kind='automatic';}]) {const c=structuredClone(source); mutate(c); assert.equal(valid(c),false);}
});
test('semantic checks reject circular clue dependencies and inherited object keys',()=> {
  const c=structuredClone(CAMPAIGNS.find(c=>c.id==='silent-bell'));
  c.scenes[0].actions[0].requiresClue='rhythm'; c.scenes[0].actions[1].requiresClue='promise';
  assert.ok(semanticErrors(c).some(e=>e.includes('unreachable')));
  const missing=structuredClone(CAMPAIGNS[0]); missing.scenes[3].actions[0].ending='constructor';
  assert.ok(semanticErrors(missing).some(e=>e.includes('unknown ending')));
});
test('time cost is explicit and collecting a clue does not suppress an unearned flag',()=> {
  let state=game(); state.clues.push('rhythm');
  assert.ok(availableActions(state).some(a=>a.id==='ask-eve')); state=act(state,'ask-eve');
  assert.ok(state.flags.includes('prepared')); assert.ok(!availableActions(state).some(a=>a.id==='ask-eve'));
  state.scene=1; const wait=state.campaignSnapshot.scenes[1].actions.find(a=>a.id==='wait-help'); wait.flag='delayed';
  state=act(state,'wait-help'); assert.equal(state.danger,1);
});
test('semantic checks reject backward links, missing clues and missing failure-safe paths',()=> {
  const source=CAMPAIGNS.find(c=>c.id==='silent-bell');
  for (const mutate of [c=>{c.scenes[1].actions[0].next=1;},c=>{c.scenes[0].actions[0].clue='missing';},c=>{c.scenes[1].actions=c.scenes[1].actions.filter(a=>a.kind!=='automatic');},c=>{c.scenes[0].actions[0].requiresClue='truth';}]) {const c=structuredClone(source); mutate(c); assert.ok(semanticErrors(c).length);}
});
test('all checks can fail and every class still has a noncombat completion route',()=> {
  for (const campaign of CAMPAIGNS) for (const cls of ['fighter','rogue','wizard']) {
    let state=game(cls,campaign.id), guard=0;
    while (state.status==='active' && guard++<80) {
      const checks=availableActions(state).filter(a=>a.kind==='check');
      if (checks.length) {state=act(state,checks[0].id); state=command(state,'roll',()=>1);}
      else {const fallback=availableActions(state).find(a=>a.kind==='automatic' && !a.requiresClue && (a.next!==undefined || a.ending)); assert.ok(fallback); state=act(state,fallback.id);}
    }
    assert.equal(state.status,'complete'); assert.notEqual(state.ending,'retreat'); assert.ok(state.danger>=4);
  }
});
test('all authored story endings can be reached with valid engine actions',()=> {
  for (const campaign of CAMPAIGNS) {
    const queue=[game('fighter',campaign.id)], visited=new Set(), endings=new Set();
    while (queue.length) {
      const state=queue.shift(), key=JSON.stringify([state.scene,state.clues.toSorted(),state.flags.toSorted(),state.ending]);
      if (visited.has(key)) continue; visited.add(key);
      if (state.ending) {endings.add(state.ending); continue;}
      for (const action of availableActions(state).filter(a=>a.kind!=='combat')) {
        let next=act(state,action.id); if(next.pending) next=command(next,'roll',()=>20); queue.push(next);
      }
      assert.ok(visited.size<10000,'Unexpected state explosion');
    }
    assert.deepEqual([...endings].sort(),Object.keys(campaign.endings).filter(e=>e!=='retreat').sort());
  }
});
test('check 1/20 have no automatic outcome; attacks do, and advantage takes high',()=> {
  assert.equal(checkRoll('Check',15,10,false,()=>1).success,true);
  assert.equal(checkRoll('Check',-5,20,false,()=>20).success,false);
  assert.equal(attackRoll('Attack',20,10,()=>1).success,false);
  assert.equal(attackRoll('Attack',-10,30,()=>20).success,true);
  assert.equal(checkRoll('Check',2,12,true,dice(2,15)).kept,15);
  assert.equal(attackRoll('Dodge',3,12,dice(20,2),true).kept,2);
});
test('pending check fixes stakes, requires the actor, and cannot be rerolled',()=> {
  const initial=game(), pending=act(initial,'read-letter');
  assert.equal(initial.pending,null); assert.equal(pending.pending.dc,10);
  pending.players.push({userId:'guest',hero:createHero(crypto.randomUUID(),'rogue','Guest','')});
  assert.throws(()=>resolve(pending,'guest',{kind:'roll'},()=>20),/检定/);
  assert.throws(()=>command(pending,'potion'),/检定/);
  const failed=command(pending,'roll',()=>1);
  assert.equal(failed.danger,1); assert.equal(availableActions(failed).some(a=>a.id==='read-letter'),false);
  assert.throws(()=>command(failed,'roll'),/检定/);
});
test('saving snapshots preserves old stories; public view excludes future scenes and request IDs',()=> {
  const state=game(), original=state.campaignSnapshot.title;
  const source=CAMPAIGNS.find(c=>c.id===state.campaignId), before=source.title;
  try {source.title='New revision'; assert.equal(gameView(state,0).title,original);} finally {source.title=before;}
  const view=gameView(state,0); assert.equal('campaignSnapshot' in view.game,false); assert.equal('requestIds' in view.game,false);
  assert.equal(view.sceneCount,state.campaignSnapshot.scenes.length);
  assert.equal(JSON.stringify(view).includes('最后一声钟'),false);
});
test('combat initiative uses d20 plus DEX and crit doubles dice, not fixed modifier',()=> {
  let state=game(); state.scene=2; state=act(state,'fight-shadow',dice(20,1));
  assert.equal(state.combat.order[0],state.players[0].hero.id);
  const result=resolve(state,'owner',{kind:'attack'},dice(20,2,3,1));
  assert.equal(result.rolls[0].damage,8); assert.equal(result.state.combat.enemy.hp,4);
});
test('combat outcome follows config rather than campaign IDs or scene+1',()=> {
  let state=game(); state.scene=2; state.campaignSnapshot.scenes[2].actions.find(a=>a.kind==='combat').clue='promise';
  state=act(state,'fight-shadow',dice(20,1)); state.combat.enemy.hp=1;
  state=command(state,'attack',dice(20,8,8));
  assert.equal(state.scene,3); assert.ok(state.clues.includes('promise')); assert.equal(state.combat,null);
});
test('enemy responses follow the player action and each die result appears once',()=> {
  let state=game(); state.scene=2; state=act(state,'fight-shadow',dice(20,1));
  const previous=state.messages.length, result=resolve(state,'owner',{kind:'dodge'},dice(12,2));
  const messages=result.state.messages.slice(previous);
  assert.ok(messages[0].text.includes('闪避'));
  assert.equal(messages[0].roll,undefined);
  assert.equal(messages.filter(m=>m.roll).length,result.rolls.length);
  assert.ok(messages.at(-1).roll?.kind==='attack');
});
test('combat without a clue does not announce an unearned reward',()=> {
  let state=game(); state.scene=2; delete state.campaignSnapshot.scenes[2].actions.find(a=>a.kind==='combat').clue;
  state=act(state,'fight-shadow',dice(20,1)); state.combat.enemy.hp=1; state=command(state,'attack',dice(20,8,8));
  assert.deepEqual(state.clues,[]); assert.ok(state.messages.every(m=>!m.text.includes('并发现一条线索')));
});
test('magic missile uses three d4 plus 3 and consumes one slot without an attack roll',()=> {
  let state=game('wizard'); state.scene=2; state=act(state,'fight-shadow',dice(20,1));
  const result=resolve(state,'owner',{kind:'missile'},dice(4,4,4));
  assert.equal(result.rolls[0].damage,15); assert.equal(result.state.players[0].hero.spellSlots,1); assert.equal(result.state.combat,null);
});
test('healing caps at max HP, bonus action retains turn, rescue stops the encounter',()=> {
  let state=game(); state.scene=2; state=act(state,'fight-shadow',dice(20,1)); state.players[0].hero.hp=11;
  state=command(state,'wind',dice(10)); assert.equal(state.players[0].hero.hp,12); assert.equal(state.combat.turn,0);
  state.players[0].hero.hp=1; state=command(state,'dodge',dice(20,20,4,4));
  assert.equal(state.players[0].hero.hp,0); assert.equal(state.status,'complete'); assert.equal(state.ending,'retreat'); assert.equal(state.combat,null);
});
test('short rest benefits the whole party once at a configured safe location',()=> {
  let state=game(); const guest=createHero(crypto.randomUUID(),'rogue','Guest',''); guest.hp=3;
  state.players[0].hero.hp=4; state.players[0].hero.secondWind=0; state.players.push({userId:'guest',hero:guest});
  state=command(state,'rest',dice(10,8));
  assert.equal(state.players[0].hero.hp,12); assert.equal(state.players[1].hero.hp,9); assert.equal(state.players[1].hero.hitDice,0); assert.equal(state.danger,2);
  assert.throws(()=>command(state,'rest'),/休息过/);
  state.scene=1; assert.throws(()=>command(state,'rest'),/安全环境/);
});
test('rogue expertise doubles proficiency and only the owner can finish a party adventure',()=> {
  assert.equal(skillMod(createHero('hero','rogue','Rogue',''),'stealth'),7);
  const state=game(); state.players.push({userId:'guest',hero:createHero('guest','wizard','Guest','')});
  assert.throws(()=>resolve(state,'guest',{kind:'retreat'}),/房主/);
});
