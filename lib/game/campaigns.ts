import { campaignContent } from "./campaign-content.generated.mjs";
import type { Campaign, Game } from "./types.ts";

// Config files pass the canonical schema and semantic checks before registry generation.
export const CAMPAIGNS = (campaignContent as unknown as Campaign[]).toSorted((a,b) => a.order - b.order || a.id.localeCompare(b.id));
export function campaignById(id: string): Campaign {
  const campaign = CAMPAIGNS.find(value => value.id === id);
  if (!campaign) throw new Error("未知的冒险模组。");
  return campaign;
}
export function campaignForGame(game: Game): Campaign {
  if (game.campaignSnapshot.rulesVersion !== "srd-5.1-teaching-1") throw new Error("这个存档需要尚未支持的规则版本。");
  return game.campaignSnapshot;
}
