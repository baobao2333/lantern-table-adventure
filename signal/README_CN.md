# 自部署联机辅助服务

这套服务仅帮助已安装的客户端找到房主、交换连接协商信息和查询 NAT 映射。游戏事件、角色、席位凭证、AI 请求和 API Key 均走玩家与房主之间的加密连接，不经过该服务。没有默认公共服务，也没有 TURN 中继；免费服务器申请、费用和实际公网连通性需要单独确认。

```text
玩家安装包 ── WSS 信令 ── 辅助服务（TCP 8443）
    │              房主安装包 ──┘
    ├── UDP STUN ── coturn（UDP 3478，仅 STUN）
    └════════ DTLS / DataChannel ════════ 房主
```

服务能看到房间 ID、公钥、IP 和短期 SDP 信息。它不持久化房间数据，日志不打印协商正文或凭证。房主会签名完整 SDP；参与者依据邀请中可信的房主公钥验签，协商还绑定参与者随机挑战、offer 摘要和本次连接 ID。服务本身通过 TLS 证书公钥指纹固定。首次取得 `signal-client.json` 和游戏邀请必须走可信渠道。

## 准备与启动

建议使用大陆网络能够访问、具有固定公网 IP 的 Linux 主机，安装 Node.js 24 与 coturn。域名不是必需条件；自签名证书含 IP SAN，客户端只信任配置中的证书和公钥指纹，同时仍检查证书期限和地址。下列 `203.0.113.10` 是文档示例地址，必须替换成自己的服务器地址。

从仓库根目录执行：

```sh
npm ci --prefix signal
node signal/generate-certificate.mjs 203.0.113.10 ./signal/signal-private 8443
SIGNAL_HOST=0.0.0.0 SIGNAL_PORT=8443 SIGNAL_TLS_CERT=./signal/signal-private/server-cert.pem SIGNAL_TLS_KEY=./signal/signal-private/server-key.pem node signal/start.mjs
```

使用 GitHub Release 中的 `lantern-table-signal-<版本>.zip` 时，先解压到新目录，再从包含 `signal/` 和 `local/` 的解压根目录执行相同命令。它是部署源码包，不内置 Node、coturn、证书私钥或账号。`signal-client.example.json` 只展示格式，示例 IP 和占位符不能直接使用；请分享证书工具实际生成的公开配置。

将生成的 `signal-client.json` 配给房主端。它包含公开证书、指纹、WSS 地址和 STUN 地址，可以分享；`server-key.pem` 只留在服务器。证书有效期 90 天，工具不会覆盖已有私钥。轮换证书应创建新目录、替换服务器文件并重新分发可信配置；现有直连不因辅助服务重启而中断，新加入和重连会等待服务恢复。

如用 systemd，将仓库放在 `/opt/lantern-table`，创建无登录权限的 `lantern` 用户，让它只读源码和 TLS 文件；按实际 Node 路径修改 `lantern-signal.service` 后安装该单元。不要以 root 启动信令进程。

也可以从仓库根目录构建容器：

```sh
docker compose -f signal/compose.yml up -d --build
```

先让容器的 UID 1000 能读取 `signal/signal-private` 中的证书和私钥，保持私钥权限 `0600`，例如为该目录设置对应属主。容器只包含信令所需文件和两个依赖，不含游戏存档或 AI 配置。镜像构建和 Linux 运行仍需在目标服务器验证。

## 启动 STUN，明确禁止 TURN

使用发行版 coturn 服务，先备份原配置，再把 `signal/stun-only.conf` 安装为它的配置，确认服务实际使用该文件后启动。也可在前台验证：

```sh
turnserver -c /opt/lantern-table/signal/stun-only.conf
```

`stun-only` 让 coturn 只处理 STUN、忽略 TURN；额外禁用 UDP/TCP relay、TCP/TLS/DTLS 监听、CLI 和 Web 管理端。没有 TURN 账号和 relay 端口段。对应选项依据 [coturn 官方配置](https://github.com/coturn/coturn/blob/master/examples/etc/turnserver.conf)；客户端还会拒绝 TURN URI、远端 relay candidate，并检查已选 ICE candidate pair。部署后应实际验证 TURN Allocate 无法取得 relay 地址。

服务器只需允许 TCP 8443 和 UDP 3478。不要把房主的本机管理端口 4173 暴露出去；自动 P2P 不需要辅助服务开放房主备份端口 4174。可用云防火墙限制 STUN 请求频率和来源范围，防止匿名 UDP 查询被滥用；这不是游戏数据中继。

## 验证与限制

源码中的 `tests/network*.test.mjs` 覆盖本机多进程、多参与者、信令停机后已建立连接继续收发、服务恢复后重新注册、断线新建连接、分片上限、身份及 relay 拒绝。Windows Node.js 24 的本机测试通过只能证明该环境下的实现，不代表任何大陆运营商组合均能互通。

部署验收必须从至少两条真实外部网络检查：信令证书验证、STUN 返回映射、选中 pair 为 host/srflx/prflx、双向游戏消息、停网恢复、辅助服务重启和 UDP 被封锁的失败提示。CGNAT、对称 NAT、企业防火墙或 UDP 封锁可能阻止直连；当前没有 TURN 回退。房主已有可达公网 IP 或手工映射时，可使用单独的 WSS 备份地址，其 TLS 证书也绑定同一房主身份。安装包客户端会连接该地址，不依赖浏览器安装自签根证书。

## 源码与边界

- `server.mjs`：有界信令协议和房主签名注册；最多 128 个连接、1024 个短期房间、256 个协商，SDP 单条不超过 96 KB，协商寿命最多 60 秒，每连接每秒最多 30 条消息。
- `start.mjs`：TLS、监听参数和进程退出；公网监听强制 TLS，明文 WS 仅限 loopback 开发。
- `generate-certificate.mjs`：部署证书和公开客户端配置；不写入游戏凭证。
- `package.mjs`：按明确文件清单生成独立源码 ZIP、逐文件清单和 SHA-256，不收集运行目录、私钥、游戏邀请、API Key 或存档。
- `../local/network/identity.mjs`：公钥验签。服务器只调用验签和摘要函数，不调用 Windows DPAPI。
- `../local/network/index.mjs`：客户端的 P2P / WSS 连接和单一重试管理器；应用席位、回合和权威状态由房主层负责。

不要增加 HTTP 转发、游戏文件读取、AI 代理或通用远程控制接口。当前入口拒绝浏览器 Origin，仅支持安装包内的 Node 网络组件。

## 构建发布包

维护者从仓库根目录执行：

```sh
node signal/package.mjs
```

输出位于 `dist/release/lantern-table-signal-0.3.0-beta.1.zip` 和同名 `.zip.sha256`，也可传入输出目录。版本取自 `signal/package.json`，发布客户端新版本时应同步维护该版本并将 ZIP 与校验文件一起上传 Release。相同源码生成相同 ZIP；`MANIFEST.json` 包含打包源码的逐文件 SHA-256。校验码用于检查完整性，首次下载仍须来自可信 Release。

部署包保留 `signal/` 与 `local/network/identity.mjs` 的目录关系，使普通 Node 启动和 Docker 构建使用同一份入口。不要把实际 `signal-private/` 或生成的私钥手工加入发布压缩包。
