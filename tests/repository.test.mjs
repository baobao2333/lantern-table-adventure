import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile} from 'node:fs/promises';
import {registerHooks} from 'node:module';
import {createGame} from '../lib/game/engine.ts';
import {createHero} from '../lib/game/characters.ts';
import {configureRuntime} from '../lib/server/runtime.ts';

// Exercise the repository's real SQL with a narrow in-memory D1 adapter.
globalThis.__lanternTestEnvironment={};
registerHooks({resolve(specifier,context,nextResolve) {
  if(specifier==='cloudflare:workers') return {url:'data:text/javascript,export const env = globalThis.__lanternTestEnvironment;',shortCircuit:true};
  return nextResolve(specifier,context);
}});
const repository=await import('../lib/server/repository.ts');
const migration=await readFile(new URL('../drizzle/0000_material_zaladane.sql',import.meta.url),'utf8');
function fixture(t) {
  const sql=new DatabaseSync(':memory:'); sql.exec(migration); t.after(()=>sql.close());
  const prepare=text=> {
    const query=sql.prepare(text);
    const bind=(...values)=> ({
      execute:()=>({success:true,meta:{changes:Number(query.run(...values).changes)}}),
      run:async()=>({success:true,meta:{changes:Number(query.run(...values).changes)}}),
      first:async()=>query.get(...values)??null,
      all:async()=>({results:query.all(...values)})
    });
    return {...bind(),bind};
  };
  const database={prepare,async batch(statements) {
    sql.exec('BEGIN');
    try {const result=statements.map(s=>s.execute()); sql.exec('COMMIT'); return result;}
    catch(error) {sql.exec('ROLLBACK'); throw error;}
  }};
  configureRuntime({DB:database,aiReady:false});
  return sql;
}
async function seed() {
  const hero=createHero(crypto.randomUUID(),'fighter','Owner',''), game=createGame(crypto.randomUUID(),'owner',hero,'silent-bell','party','ABC234');
  await repository.saveHero(hero,'owner'); await repository.insertGame(game); return {game,hero};
}
test('repository keeps heroes and adventures isolated by membership',async t=> {
  fixture(t); const {game,hero}=await seed();
  assert.equal((await repository.listGames('owner')).length,1); assert.equal((await repository.listGames('stranger')).length,0);
  await assert.rejects(repository.loadGame(game.id,'stranger'),e=>e.status===404);
  await assert.rejects(repository.ownedHero(hero.id,'stranger'),e=>e.status===404);
});
test('lease excludes concurrent writes; versions and request IDs persist without duplicate effects',async t=> {
  fixture(t); const {game}=await seed(), request=crypto.randomUUID();
  const first=await repository.acquire(game.id,request);
  await assert.rejects(repository.acquire(game.id,crypto.randomUUID()),e=>e.status===409);
  first.game.danger=2;
  assert.equal(await repository.commit(first.game,first.token,first.version,request),1);
  await assert.rejects(repository.commit(first.game,first.token,first.version,request),e=>e.status===409);
  await repository.unlock(game.id,first.token);
  const retry=await repository.acquire(game.id,request); assert.equal(retry.duplicate,true); assert.equal(retry.game.danger,2); assert.equal(retry.version,1);
  await repository.unlock(game.id,'wrong-token'); await assert.rejects(repository.acquire(game.id,crypto.randomUUID()),e=>e.status===409);
  await repository.unlock(game.id,retry.token);
});
test('joining commits membership and state together; stale leases cannot grant access',async t=> {
  const sql=fixture(t); const {game}=await seed(), guest=createHero(crypto.randomUUID(),'rogue','Guest','');
  await repository.saveHero(guest,'guest'); const request=crypto.randomUUID(), lease=await repository.acquire(game.id,request);
  lease.game.players.push({userId:'guest',hero:guest});
  await repository.commit(lease.game,lease.token,lease.version,request,'guest'); await repository.unlock(game.id,lease.token);
  assert.equal((await repository.loadGame(game.id,'guest')).game.players.length,2);
  const expired=await repository.acquire(game.id,crypto.randomUUID()); sql.prepare('UPDATE adventures SET lock_until=0 WHERE id=?').run(game.id);
  await assert.rejects(repository.commit(expired.game,expired.token,expired.version,crypto.randomUUID(),'stranger'),e=>e.status===409);
  await assert.rejects(repository.loadGame(game.id,'stranger'),e=>e.status===404);
});
