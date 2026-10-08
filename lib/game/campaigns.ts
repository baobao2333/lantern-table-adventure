import { campaignContent } from "./campaign-content.generated.mjs";
import { worldContent } from "./world-content.generated.mjs";
import type { Campaign, Game } from "./types.ts";
import type { WorldConfig } from "./world-types.ts";

// Config files pass the canonical schema and semantic checks before registry generation.
function asCampaign(world: WorldConfig): Campaign {
  return {...world,world,flags:[],scenes:world.locations.map(location=>({id:location.id,title:location.title,description:location.description,npc:world.npcs.filter(n=>location.npcIds.includes(n.id)).map(n=>`${n.name}：${n.role}`).join("；"),safeRest:location.safeRest,enemy:world.opportunities.find(g=>g.location===location.id&&g.encounter)?.encounter,actions:[]}))};
}
export const CAMPAIGNS = [...campaignContent as unknown as Campaign[],...worldContent.map(world=>asCampaign(world as unknown as WorldConfig))].toSorted((a,b) => a.order - b.order || a.id.localeCompare(b.id));
export function campaignById(id: string): Campaign {
  const campaign = CAMPAIGNS.find(value => value.id === id);
  if (!campaign) throw new Error("未知的冒险模组。");
  return campaign;
}
export function campaignForGame(game: Game): Campaign {
  if (!["srd-5.1-teaching-1","srd-5.1-table-2"].includes(game.campaignSnapshot.rulesVersion)) throw new Error("这个存档需要尚未支持的规则版本。");
  return game.campaignSnapshot;
}
