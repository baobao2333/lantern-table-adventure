import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export function acquireServiceOwnership(directory, instanceId) {
  const lockDirectory = join(directory, "service.lock");
  const ownerPath = join(lockDirectory, "owner.json");
  mkdirSync(directory, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(lockDirectory);
      writeFileSync(
        ownerPath,
        JSON.stringify({ pid: process.pid, instanceId }),
        { flag: "wx", mode: 0o600 },
      );
      return () => {
        try {
          const owner = JSON.parse(readFileSync(ownerPath, "utf8"));
          if (owner.pid === process.pid && owner.instanceId === instanceId)
            rmSync(lockDirectory, { recursive: true, force: true });
        } catch {}
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let owner;
      try {
        owner = JSON.parse(readFileSync(ownerPath, "utf8"));
      } catch {
        throw new Error(
          "Service ownership is incomplete; close other instances before recovery.",
        );
      }
      if (!Number.isSafeInteger(owner.pid) || owner.pid < 1)
        throw new Error(
          "Service ownership is invalid; preserve the lock for recovery.",
        );
      try {
        process.kill(owner.pid, 0);
        throw new Error("Another desktop service owns this data directory.");
      } catch (probeError) {
        if (probeError.code !== "ESRCH") throw probeError;
      }
      const stale = `${lockDirectory}.stale-${randomUUID()}`;
      renameSync(lockDirectory, stale);
      rmSync(stale, { recursive: true, force: true });
    }
  }
  throw new Error("Could not acquire desktop service ownership.");
}
