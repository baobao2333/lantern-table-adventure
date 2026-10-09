export type PendingRequest = Record<string, unknown> & { requestId: string; id: string };
const key = "lantern.solo.pending.v1";
let local = false;
let cached: PendingRequest | null | undefined;

export async function clientJournal<T>(kind: "solo" | "room", operation?: { op: "save"; payload: T } | { op: "clear"; requestId: string }): Promise<T | null> {
  const response = await fetch(`/api/client-journal?kind=${kind}`, operation ? {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind, ...operation }),
  } : { cache: "no-store" });
  const result = await response.json() as { pending: T | null; error?: string };
  if (!response.ok) throw new Error(result.error || "无法保存待确认行动，请稍后恢复。");
  return result.pending;
}

export function pendingRequest(): PendingRequest | null {
  if (cached !== undefined) return cached;
  try {
    const value = JSON.parse(localStorage.getItem(key) || "null");
    return value && typeof value.requestId === "string" && typeof value.id === "string" ? value : null;
  } catch { return null; }
}

export async function loadPendingRequest(isLocal: boolean) {
  local = isLocal;
  cached = local ? await clientJournal<PendingRequest>("solo") : pendingRequest();
  return cached;
}

export async function savePendingRequest(value: PendingRequest) {
  if (local) await clientJournal("solo", { op: "save", payload: value });
  try { localStorage.setItem(key, JSON.stringify(value)); }
  catch { if (!local) throw new Error("无法保存待确认请求。请启用本机存储后再行动。"); }
  cached = value;
}

export async function clearPendingRequest(requestId: string) {
  if (local) await clientJournal("solo", { op: "clear", requestId });
  if (pendingRequest()?.requestId === requestId) {
    cached = null;
    try { localStorage.removeItem(key); } catch { /* The SQLite journal remains authoritative. */ }
  }
}
