# 灯火之下 0.2.0 · Windows 本机版

完整解压 ZIP 到任意可写目录，双击 `START.cmd`。发行包已包含经过官方校验的 Node.js，无须安装 Node.js、npm 或运行安装命令。浏览器会打开 `http://127.0.0.1:4173`；若没有自动打开，复制启动窗口里的地址。保留窗口，按 `Ctrl+C` 停止服务。

进入页面后，在 **AI 设置** 选择一种连接方式：

- **兼容 API**：填写支持 Chat Completions 和 JSON 输出的服务地址、模型名称与自己的 API 密钥。地址填写到 API 根路径，例如 `https://api.openai.com/v1`，不要追加 `/chat/completions`。仅本机模型地址允许使用 HTTP。API 调用使用服务商账户及其计费方式。
- **Codex CLI**：先安装 [官方 Codex CLI](https://learn.chatgpt.com/docs/codex-cli)，在终端运行 `codex login` 完成登录，再重启本程序。使用已有登录与账户权限，不需要在本程序填写 API 密钥；模型可以留空，沿用 CLI 默认。此方式需要联网，账户模型权限与使用额度仍然适用。发行包不捆绑 Codex 或任何账户凭据。
- **暂不连接**：可以创建角色、阅读规则和用可见行动进行规则冒险；自由对话和 AI 叙事需要先连接 AI。

保存设置后点击连接测试。API 密钥只在本机服务持有，页面只显示是否已保存；省略密钥时保留原值。密钥使用 Windows 当前账户的 DPAPI 加密存储。浏览器不会收到原始密钥。

本版已用 Codex CLI 0.149.1 验证连接和行动裁定。旧版如果不支持隔离配置的启动参数，请先更新官方 CLI，再测试连接。

角色、冒险与 AI 设置保存在 `%LOCALAPPDATA%\LanternTable`。更换或移动发行目录不会清空存档。备份时先停止服务，再复制整个数据目录；在原 Windows 账户恢复。`settings.json` 的加密密钥不能直接迁移到其他 Windows 账户，新账户需要重新配置 AI。

本版是一位本机玩家的私人冒险桌，只有 `127.0.0.1` 能连接。组队联网将在 0.3 版本实现；本机版不会让另一台电脑通过邀请码加入。浏览器刷新或下次启动后，可从大厅继续已保存冒险。

如果端口被占用，先关闭旧启动窗口。需要换端口时，在终端运行 `set LANTERN_PORT=4174` 后启动 `START.cmd`（PowerShell 使用 `$env:LANTERN_PORT=4174`）。升级时完整解压新版本后启动，保留原数据目录即可。

本项目的规则改编自 Wizards of the Coast LLC 的 [SRD 5.1](https://www.dndbeyond.com/attachments/39j2li89/SRD5.1-CCBY4.0License.pdf)，依 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/legalcode) 使用。中文改编与原创冒险为独立项目；其他依赖许可随代码或发行包保留。Node.js 许可位于 `runtime/LICENSE`，官方来源及校验记录位于 `runtime/SOURCE.txt`。
