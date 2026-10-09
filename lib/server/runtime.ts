export type Completion = (system: string, prompt: unknown, signal?: AbortSignal) => Promise<unknown>;
export type TableRuntime = {
  DB: D1Database;
  aiReady: boolean;
  local?: boolean;
  completion?: Completion;
};
let current: TableRuntime | undefined;
export function configureRuntime(value: TableRuntime) {
  current = value;
}
export function runtime(): TableRuntime {
  if (!current) throw new Error("Table runtime has not been configured.");
  return current;
}
