import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { assertReleaseVersion } from "./check-release-version.mjs";
import { RuntimeController } from "../desktop/runtime-controller.mjs";
import { run, sha256, runtimeInventory } from "../desktop/distribution.mjs";
import WebSocket from "ws";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = await assertReleaseVersion(root);
const buildOnly = process.argv.includes("--build-only");
const temporary = await mkdtemp(join(tmpdir(), "lantern-desktop-verify-"));
let runtime, desktopProcess;
const pendingRequests = {
  solo: {
    op: "game.command",
    id: randomUUID(),
    requestId: randomUUID(),
    expectedVersion: 4,
    command: { kind: "action", actionId: "ask-witness" },
  },
  room: {
    id: randomUUID(),
    role: "guest",
    payload: {
      commandId: randomUUID(),
      serverEpoch: 2,
      operationId: randomUUID(),
      phaseId: randomUUID(),
      type: "talk",
      text: "检查桥边的灯。",
    },
  },
};
async function nativeWindow(pid, action = "Visible") {
  const script = `Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class LanternWindowProbe {
  private delegate bool Visitor(IntPtr window, IntPtr parameter);
  [DllImport("user32.dll")] private static extern bool EnumWindows(Visitor visitor, IntPtr parameter);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr window, uint message, IntPtr wparam, IntPtr lparam);
  public static bool Visible(uint expected) {
    bool visible = false;
    EnumWindows((window, parameter) => {
      uint process; GetWindowThreadProcessId(window, out process);
      if (process == expected && IsWindowVisible(window)) visible = true;
      return true;
    }, IntPtr.Zero);
    return visible;
  }
  public static bool Close(uint expected) {
    bool sent = false;
    EnumWindows((window, parameter) => {
      uint process; GetWindowThreadProcessId(window, out process);
      if (process == expected && IsWindowVisible(window)) {
        sent = PostMessage(window, 0x0010, IntPtr.Zero, IntPtr.Zero);
        return false;
      }
      return true;
    }, IntPtr.Zero);
    return sent;
  }
}
'@
[LanternWindowProbe]::${action}([uint32]$env:LANTERN_VERIFY_PID)`;
  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      env: { ...process.env, LANTERN_VERIFY_PID: String(pid) },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "",
    errors = "";
  child.stdout.on("data", (bytes) => {
    output += bytes;
  });
  child.stderr.on("data", (bytes) => {
    errors += bytes;
  });
  child.on("error", () => {});
  const timeout = setTimeout(() => child.kill(), 10_000);
  const [code] = await once(child, "exit");
  clearTimeout(timeout);
  assert.equal(
    code,
    0,
    `Cannot inspect the verification process window: ${errors}`,
  );
  assert.match(output.trim(), /^(True|False)$/);
  return output.trim() === "True";
}
async function verifyWindow(executable, restored = false) {
  const local = join(temporary, "electron-profile");
  const roaming = join(temporary, "electron-roaming");
  await mkdir(local, { recursive: true });
  await mkdir(roaming, { recursive: true });
  const environment = { ...process.env, LOCALAPPDATA: local, APPDATA: roaming };
  for (const name of ["NODE_OPTIONS", "NODE_PATH", "ELECTRON_RUN_AS_NODE"])
    delete environment[name];
  const portFile = join(
    local,
    "LanternTable",
    "desktop",
    "electron",
    "DevToolsActivePort",
  );
  await rm(portFile, { force: true });
  desktopProcess = spawn(
    executable,
    ["--remote-debugging-port=0", "--enable-logging=stderr"],
    {
      env: environment,
      windowsHide: false,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let diagnostics = "";
  for (const stream of [desktopProcess.stdout, desktopProcess.stderr])
    stream.on("data", (bytes) => {
      diagnostics = (diagnostics + bytes.toString()).slice(-16_384);
    });
  let processError;
  desktopProcess.on("error", (error) => {
    processError = error;
  });
  const deadline = Date.now() + 45_000;
  let port;
  while (!port && Date.now() < deadline) {
    if (processError) throw processError;
    assert.equal(
      desktopProcess.exitCode,
      null,
      "Electron exited before its actual page was ready.",
    );
    assert.equal(
      desktopProcess.signalCode,
      null,
      "Electron was terminated before its actual page was ready.",
    );
    try {
      port = Number((await readFile(portFile, "utf8")).split(/\r?\n/)[0]);
    } catch {}
    if (!port) await new Promise((done) => setTimeout(done, 100));
  }
  assert.ok(
    Number.isInteger(port) && port > 0,
    `Electron debugging transport did not become ready. ${diagnostics}`,
  );
  let target;
  while (!target && Date.now() < deadline) {
    const targets = await (
      await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(5000),
      })
    ).json();
    target = targets.find(
      (item) =>
        item.type === "page" && /^http:\/\/127\.0\.0\.1:\d+\/?$/.test(item.url),
    );
    if (!target) await new Promise((done) => setTimeout(done, 100));
  }
  assert.ok(target, "Electron did not load the local packaged UI.");
  const socket = new WebSocket(target.webSocketDebuggerUrl, {
    handshakeTimeout: 5000,
  });
  await once(socket, "open");
  let sequence = 0;
  const pending = new Map();
  socket.on("error", (error) => {
    for (const waiting of pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(error);
    }
    pending.clear();
  });
  socket.on("message", (bytes) => {
    const message = JSON.parse(bytes.toString());
    const waiting = pending.get(message.id);
    if (waiting) {
      pending.delete(message.id);
      clearTimeout(waiting.timer);
      if (message.error) waiting.reject(new Error(message.error.message));
      else waiting.resolve(message.result);
    }
  });
  function command(method, params) {
    return new Promise((resolveEvaluation, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(
          new Error(
            `Electron page verification timed out: ${method} ${String(params?.expression || "").slice(0, 100)}`,
          ),
        );
      }, 10_000);
      pending.set(id, { resolve: resolveEvaluation, reject, timer });
      socket.send(
        JSON.stringify({
          id,
          method,
          params,
        }),
      );
    });
  }
  function evaluate(expression) {
    return command("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    }).then((result) => {
      assert.ok(!result.exceptionDetails, "Packaged UI evaluation failed.");
      return result.result.value;
    });
  }
  try {
    let loaded = false;
    while (!loaded && Date.now() < deadline) {
      loaded = await evaluate(
        "document.readyState === 'complete' && typeof window.lanternDesktop?.info === 'function' && document.body.innerText.includes('灯火')",
      );
      if (!loaded) await new Promise((done) => setTimeout(done, 100));
    }
    assert.ok(
      loaded,
      "Packaged UI did not finish loading its local desktop bridge.",
    );
    const page = await evaluate(
      `(async()=>({ info: await window.lanternDesktop.info(), bootstrap: await (await fetch('/api/table')).json(), settings: await (await fetch('/api/settings')).json(), cookie: document.cookie, node: typeof process, text: document.body.innerText }))()`,
    );
    assert.equal(page.info.version, version);
    assert.equal(page.info.closeBehavior, "tray");
    assert.equal(page.bootstrap.version, version);
    assert.equal(page.bootstrap.local, true);
    assert.equal(page.settings.config.provider, "none");
    assert.ok(!page.cookie.includes("lantern_admin"));
    assert.equal(page.node, "undefined");
    assert.match(page.text, /灯火/);
    for (const [kind, payload] of Object.entries(pendingRequests)) {
      const saved = await evaluate(
        `(async()=>{ const response = await fetch('/api/client-journal?kind=${kind}', ${restored ? "{cache:'no-store'}" : JSON.stringify({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind, op: "save", payload }) })}); return {status:response.status,body:await response.json()}; })()`,
      );
      assert.equal(saved.status, 200);
      assert.deepEqual(saved.body.pending, payload);
    }
    if (restored) {
      let banner = false;
      for (let attempt = 0; attempt < 30 && !banner; attempt++) {
        banner = await evaluate(
          "document.body.innerText.includes('上次行动尚未收到确认')",
        );
        if (!banner) await new Promise((done) => setTimeout(done, 100));
      }
      assert.ok(
        banner,
        "The restarted Electron UI did not expose its durable pending action.",
      );
      for (const [kind, payload] of Object.entries(pendingRequests)) {
        const requestId = payload.requestId || payload.payload.commandId;
        const cleared = await evaluate(
          `(async()=>{ const response = await fetch('/api/client-journal?kind=${kind}', ${JSON.stringify({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind, op: "clear", requestId }) })}); return {status:response.status,body:await response.json()}; })()`,
        );
        assert.equal(cleared.status, 200);
        assert.equal(cleared.body.pending, null);
      }
    } else {
      const screenshot = await command("Page.captureScreenshot", {
        format: "png",
      });
      const evidence = join(root, "dist", "release");
      await mkdir(evidence, { recursive: true });
      await writeFile(
        join(evidence, `desktop-ui-${version}.png`),
        Buffer.from(screenshot.data, "base64"),
      );
    }
    assert.equal(await nativeWindow(desktopProcess.pid), true);
    assert.equal(await nativeWindow(desktopProcess.pid, "Close"), true);
    let hidden = false;
    for (let attempt = 0; attempt < 20 && !hidden; attempt++) {
      hidden = !(await nativeWindow(desktopProcess.pid));
      if (!hidden) await new Promise((done) => setTimeout(done, 100));
    }
    assert.ok(hidden, "Closing the window did not hide it to the tray.");
    assert.equal(desktopProcess.exitCode, null);
    // A real second launch restores the first window; hidden Chromium pages can suspend CDP evaluation.
    const second = spawn(executable, [], {
      env: environment,
      windowsHide: false,
      stdio: "ignore",
    });
    const secondTimeout = setTimeout(() => second.kill(), 10_000);
    const [secondCode] = await once(second, "exit");
    clearTimeout(secondTimeout);
    assert.equal(
      secondCode,
      0,
      "A second launch did not hand control to the first instance.",
    );
    assert.equal(await nativeWindow(desktopProcess.pid), true);
    assert.equal(await evaluate("document.visibilityState"), "visible");
    assert.deepEqual(await evaluate("window.lanternDesktop.pause()"), {
      ok: true,
    });
    const exited = once(desktopProcess, "exit");
    await evaluate("void window.lanternDesktop.quit(); true");
    const timeout = setTimeout(() => {
      desktopProcess.kill();
    }, 12_000);
    const [code] = await exited;
    clearTimeout(timeout);
    assert.equal(code, 0);
  } finally {
    socket.close();
    for (const waiting of pending.values()) clearTimeout(waiting.timer);
  }
  if (!restored) await verifyWindow(executable, true);
}
try {
  let runtimeDirectory = join(root, "dist", "desktop", "runtime");
  let desktopExecutable;
  if (!buildOnly) {
    const releaseDirectory = join(root, "dist", "desktop", "release");
    const release = JSON.parse(
      await readFile(join(releaseDirectory, "desktop-release.json"), "utf8"),
    );
    assert.equal(release.application, version);
    assert.ok(release.artifacts.length >= 2);
    for (const artifact of release.artifacts) {
      assert.match(artifact.name, /^[A-Za-z0-9_.-]+$/);
      const bytes = await readFile(join(releaseDirectory, artifact.name));
      assert.equal(bytes.length, artifact.size);
      assert.equal(sha256(bytes), artifact.sha256);
    }
    const zip = release.artifacts.find((file) => file.name.endsWith(".zip"));
    const setup = release.artifacts.find((file) =>
      file.name.endsWith("-Setup.exe"),
    );
    assert.ok(zip && setup);
    assert.equal(
      (await readFile(join(releaseDirectory, setup.name)))
        .subarray(0, 2)
        .toString(),
      "MZ",
    );
    const extracted = join(temporary, "portable");
    await run(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath $env:LANTERN_VERIFY_ZIP -DestinationPath $env:LANTERN_VERIFY_DIRECTORY -Force",
      ],
      {
        env: {
          ...process.env,
          LANTERN_VERIFY_ZIP: join(releaseDirectory, zip.name),
          LANTERN_VERIFY_DIRECTORY: extracted,
        },
      },
    );
    assert.ok((await stat(join(extracted, "LanternTable.exe"))).isFile());
    desktopExecutable = join(extracted, "LanternTable.exe");
    assert.ok((await stat(join(extracted, "resources", "app.asar"))).isFile());
    for (const name of ["LICENSE", "LICENSES.chromium.html"])
      assert.ok((await stat(join(extracted, name))).isFile());
    runtimeDirectory = join(extracted, "resources", "runtime");
    const { listPackage } = await import("@electron/asar");
    const names = listPackage(join(extracted, "resources", "app.asar"));
    assert.ok(names.some((name) => /[\\/]main\.mjs$/.test(name)));
    assert.ok(!names.some((name) => /[\\/]runtime[\\/]/.test(name)));
    assert.ok(
      !names.some((name) =>
        /[\\/](?:auth\.json|settings\.json|\.env[^/\\]*|\.dev\.vars[^/\\]*|[^/\\]*\.sqlite(?:-wal|-shm)?)(?:$|[\\/])/i.test(
          name,
        ),
      ),
    );
  }
  const metadata = JSON.parse(
    await readFile(join(runtimeDirectory, "release.json"), "utf8"),
  );
  const desktop = JSON.parse(
    await readFile(join(runtimeDirectory, "desktop-release.json"), "utf8"),
  );
  assert.equal(metadata.version, version);
  assert.equal(desktop.application, version);
  assert.equal(desktop.frontend, version);
  assert.equal(desktop.node, metadata.nodeVersion);
  assert.deepEqual(desktop.inventory, await runtimeInventory(runtimeDirectory));
  assert.ok(!runtimeDirectory.includes("app.asar"));
  async function checkPrivateFiles(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      assert.ok(
        !entry.isSymbolicLink(),
        `Unexpected runtime symlink: ${entry.name}`,
      );
      assert.ok(
        !/^(?:\.env.*|\.dev\.vars.*|auth\.json|settings\.json|[^/\\]*\.sqlite(?:-wal|-shm)?|[^/\\]*\.(?:pem|pfx|key))$/i.test(
          entry.name,
        ),
        `Private file in runtime: ${entry.name}`,
      );
      if (entry.isDirectory())
        await checkPrivateFiles(join(directory, entry.name));
    }
  }
  await checkPrivateFiles(runtimeDirectory);
  for (const name of [
    "node.exe",
    "NODE_LICENSE.txt",
    "NODE_SOURCE.txt",
    "CODEX_LICENSE.txt",
    "LICENSE",
    "THIRD_PARTY_NOTICES.txt",
    "README_CN.md",
  ])
    assert.ok((await stat(join(runtimeDirectory, name))).isFile());
  const dataDirectory = join(temporary, "data", "desktop");
  runtime = new RuntimeController({
    nodeExecutable: join(runtimeDirectory, "node.exe"),
    serverFile: join(runtimeDirectory, "server.mjs"),
    runtimeDirectory,
    dataDirectory,
    legacyDirectory: join(temporary, "data"),
    version,
  });
  const { origin } = await runtime.start();
  assert.equal((await fetch(`${origin}/api/table`)).status, 401);
  const headers = { Cookie: `lantern_admin=${runtime.adminToken}` };
  const response = await fetch(`${origin}/api/table`, { headers });
  assert.equal(response.status, 200);
  const bootstrap = await response.json();
  assert.equal(bootstrap.version, version);
  assert.equal(bootstrap.local, true);
  const settings = await fetch(`${origin}/api/settings`, { headers });
  assert.equal(settings.status, 200);
  const config = await settings.json();
  assert.equal(config.config.provider, "none");
  assert.ok(!("apiKey" in config.config));
  assert.equal(
    (
      await fetch(`${origin}/api/settings`, {
        headers: { ...headers, Origin: "https://untrusted.example" },
      })
    ).status,
    403,
  );
  const page = await fetch(origin);
  assert.equal(page.status, 200);
  assert.ok(
    (page.headers.get("content-security-policy") || "").includes(
      "frame-ancestors 'none'",
    ),
  );
  assert.ok(!(await page.text()).includes(runtime.adminToken));
  assert.ok(
    (await stat(join(dataDirectory, "adventures-desktop.sqlite"))).isFile(),
  );
  await assert.rejects(stat(join(temporary, "data", "adventures.sqlite")), {
    code: "ENOENT",
  });
  await runtime.pause();
  await runtime.stop();
  assert.equal(runtime.child.exitCode, 0);
  // Restart from the same desktop library, then simulate a vanished Electron management channel.
  runtime = new RuntimeController({
    nodeExecutable: join(runtimeDirectory, "node.exe"),
    serverFile: join(runtimeDirectory, "server.mjs"),
    runtimeDirectory,
    dataDirectory,
    legacyDirectory: join(temporary, "data"),
    version,
  });
  await runtime.start();
  runtime.stopping = true;
  const exited = once(runtime.child, "exit");
  runtime.child.disconnect();
  const watchdog = setTimeout(() => {
    void runtime.forceStop();
  }, 10_000);
  const [code] = await exited;
  clearTimeout(watchdog);
  assert.equal(code, 0);
  if (desktopExecutable) await verifyWindow(desktopExecutable);
  console.log(
    `PASS desktop ${version}: ${buildOnly ? "built runtime" : "Setup/portable artifact hashes, ASAR separation, extracted runtime, actual Electron window/tray/quit and durable solo/room journals across application restart"}, frontend/schema/native inventory, private-file exclusion, admin cookie boundary, startup identity, pause/shutdown receipts, restart and parent-channel loss.`,
  );
} finally {
  await runtime?.forceStop();
  if (desktopProcess?.pid && desktopProcess.exitCode === null) {
    await run(
      join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"),
      ["/PID", String(desktopProcess.pid), "/T", "/F"],
    ).catch(() => {});
  }
  await rm(temporary, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}
