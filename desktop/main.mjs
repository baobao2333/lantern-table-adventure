import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  dialog,
  ipcMain,
  session,
  powerMonitor,
} from "electron";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RuntimeController } from "./runtime-controller.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const squirrelEvent = process.argv.find((value) =>
  /^--squirrel-(install|updated|uninstall|obsolete)$/.test(value),
);
if (squirrelEvent) {
  if (squirrelEvent !== "--squirrel-obsolete") {
    const update = resolve(dirname(process.execPath), "..", "Update.exe");
    const operation =
      squirrelEvent === "--squirrel-uninstall"
        ? "--removeShortcut"
        : "--createShortcut";
    await new Promise((finish) => {
      const child = spawn(update, [operation, "LanternTable.exe"], {
        windowsHide: true,
        stdio: "ignore",
      });
      child.once("error", finish);
      child.once("exit", finish);
      setTimeout(finish, 5000).unref();
    });
  }
  app.quit();
} else {
  app.enableSandbox();
  app.setAppUserModelId("com.squirrel.lantern_table_adventure.LanternTable");
  const legacyDirectory = join(
    process.env.LOCALAPPDATA || app.getPath("appData"),
    "LanternTable",
  );
  const dataDirectory = join(legacyDirectory, "desktop");
  mkdirSync(dataDirectory, { recursive: true });
  // Both the portable and installed app use this same Chromium single-instance identity.
  app.setPath("userData", join(dataDirectory, "electron"));
  if (!app.requestSingleInstanceLock()) app.quit();
  else {
    let window,
      tray,
      runtime,
      origin,
      quitting = false,
      quitPromise;
    const showWindow = () => {
      if (!window) return;
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    };
    app.on("second-instance", showWindow);
    app.on("activate", showWindow);
    async function quit() {
      if (quitPromise) return quitPromise;
      quitting = true;
      quitPromise = (async () => {
        try {
          await runtime?.stop();
        } catch {
          dialog.showErrorBox(
            "已停止服务",
            "服务没有在 10 秒内完成保存，已强制结束。下次启动将按异常退出恢复；已保存的存档会保留。",
          );
        }
        tray?.destroy();
        app.exit(0);
      })();
      return quitPromise;
    }
    app.on("before-quit", (event) => {
      if (!quitting) {
        event.preventDefault();
        void quit();
      }
    });
    app.on("window-all-closed", () => {});
    app.on("will-quit", () => runtime?.forceStop());
    // Electron completes ESM loading before emitting ready; awaiting it at module scope deadlocks startup.
    void app.whenReady().then(async () => {
      try {
        if (
          existsSync(join(legacyDirectory, "adventures.sqlite")) &&
          !existsSync(join(dataDirectory, "desktop-import.json"))
        ) {
          const choice = dialog.showMessageBoxSync({
            type: "info",
            title: "导入旧版单人存档",
            message: "请先关闭旧版灯火之下，再导入存档。",
            detail:
              "新版会一致性备份旧版存档并导入独立目录。原文件保留；以后新版以导入后的存档为准，不合并旧版后来产生的变化。",
            buttons: ["已关闭旧版，继续", "退出"],
            defaultId: 0,
            cancelId: 1,
          });
          if (choice !== 0) {
            await quit();
            throw new Error("Startup cancelled.");
          }
        }
        const runtimeDirectory = app.isPackaged
          ? join(process.resourcesPath, "runtime")
          : resolve(directory, "..", "dist", "desktop", "runtime");
        const metadata = JSON.parse(
          readFileSync(join(runtimeDirectory, "release.json"), "utf8"),
        );
        if (metadata.version !== app.getVersion())
          throw new Error("桌面程序与服务版本不一致，请重新安装完整发行包。");
        runtime = new RuntimeController({
          nodeExecutable: join(runtimeDirectory, "node.exe"),
          serverFile: join(runtimeDirectory, "server.mjs"),
          runtimeDirectory,
          dataDirectory,
          legacyDirectory,
          version: metadata.version,
        });
        runtime.on("unexpectedExit", () => {
          window?.hide();
          dialog.showErrorBox(
            "本机服务已停止",
            "服务意外退出，当前窗口已停止操作。请重新启动；存档将按异常退出恢复。",
          );
          void quit();
        });
        ({ origin } = await runtime.start());
        // Suspend acknowledgement is best effort; the service also detects clock gaps.
        const pauseForPower = () => {
          void runtime.pause().catch(() => {});
        };
        powerMonitor.on("suspend", pauseForPower);
        powerMonitor.on("resume", pauseForPower);
        const localSession = session.fromPartition(
          `lantern-${runtime.instanceId}`,
        );
        localSession.setPermissionRequestHandler(
          (_contents, _permission, callback) => callback(false),
        );
        localSession.setPermissionCheckHandler(() => false);
        localSession.webRequest.onBeforeRequest((details, callback) => {
          let allowed = false;
          try {
            allowed = [origin, origin.replace("http:", "ws:")].includes(
              new URL(details.url).origin,
            );
          } catch {}
          callback({ cancel: !allowed });
        });
        await localSession.cookies.set({
          url: origin,
          name: "lantern_admin",
          value: runtime.adminToken,
          httpOnly: true,
          sameSite: "strict",
          path: "/",
        });
        window = new BrowserWindow({
          title: "灯火之下",
          width: 1280,
          height: 860,
          minWidth: 860,
          minHeight: 640,
          show: false,
          autoHideMenuBar: true,
          webPreferences: {
            session: localSession,
            preload: join(directory, "preload.cjs"),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webSecurity: true,
            devTools: !app.isPackaged,
            spellcheck: false,
          },
        });
        window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        window.webContents.on("will-navigate", (event, url) => {
          if (new URL(url).origin !== origin) event.preventDefault();
        });
        window.webContents.on("will-attach-webview", (event) =>
          event.preventDefault(),
        );
        window.on("close", (event) => {
          if (!quitting) {
            event.preventDefault();
            window.hide();
          }
        });
        window.once("ready-to-show", showWindow);
        const assertSender = (event) => {
          if (
            event.sender !== window.webContents ||
            event.senderFrame !== window.webContents.mainFrame ||
            new URL(event.senderFrame.url).origin !== origin
          )
            throw new Error("Desktop IPC origin denied.");
        };
        ipcMain.handle("desktop:info", (event) => {
          assertSender(event);
          return {
            version: app.getVersion(),
            platform: "windows",
            closeBehavior: "tray",
          };
        });
        ipcMain.handle("desktop:hide", (event) => {
          assertSender(event);
          window.hide();
          return { ok: true };
        });
        ipcMain.handle("desktop:pause", async (event) => {
          assertSender(event);
          await runtime.pause();
          return { ok: true };
        });
        ipcMain.handle("desktop:quit", async (event) => {
          assertSender(event);
          void quit();
          return { ok: true };
        });
        // The installed executable supplies a local tray icon, without remote image requests.
        const icon = await app.getFileIcon(process.execPath, { size: "small" });
        tray = new Tray(icon);
        tray.setToolTip("灯火之下 · 关闭窗口后继续在托盘运行");
        tray.on("double-click", showWindow);
        tray.setContextMenu(
          Menu.buildFromTemplate([
            { label: "打开灯火之下", click: showWindow },
            {
              label: "暂停当前房间",
              click: () => {
                void runtime
                  .pause()
                  .catch(() =>
                    dialog.showErrorBox(
                      "暂停失败",
                      "服务未能确认暂停，请打开窗口检查连接。",
                    ),
                  );
              },
            },
            { type: "separator" },
            {
              label: "保存并完整退出",
              click: () => {
                void quit();
              },
            },
          ]),
        );
        await window.loadURL(origin);
      } catch (error) {
        if (!quitting)
          dialog.showErrorBox(
            "启动失败",
            error instanceof Error ? error.message : "无法启动本机服务。",
          );
        await quit();
      }
    });
  }
}
