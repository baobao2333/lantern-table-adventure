# Windows 发布签名

安装包与便携版共用构建链。`desktop-release.json` 明确记录 `signature.status`；SHA-256 清单证明下载内容一致，不能代替发行者签名。没有配置证书时，构建输出 `UNSIGNED` 诊断；设置 `LANTERN_SIGN_REQUIRED=1` 后，缺证书、签名失败、信任链失败或缺时间戳都会终止打包。

公开受信任签名需要已有的 Authenticode 代码签名证书及可用私钥，例如 CA 提供的硬件令牌／HSM。自己生成的证书不会自动获得 Windows 信任，本项目不生成自签代码签名证书、不安装信任根。即使受信任签名成功，新应用仍可能出现 SmartScreen 信誉提示；不能承诺签名后任何电脑都无需确认。

## 本机证书存储

先按证书颁发机构的要求安装证书、令牌驱动和私钥提供程序。证书必须位于 Windows `CurrentUser\My` 或 `LocalMachine\My`，具有代码签名 EKU、可访问私钥、有效期和受信任证书链。默认在线检查吊销状态，需要能访问 CA 的验证地址和时间戳服务。不要把证书、PFX、密码或私钥提交到仓库或聊天。

在专用 PowerShell 会话中配置公开的证书指纹；以下指纹仅为格式示例：

```powershell
$env:LANTERN_SIGN_REQUIRED = '1'
$env:LANTERN_SIGN_CERTIFICATE_THUMBPRINT = '0123456789ABCDEF0123456789ABCDEF01234567'
$env:LANTERN_SIGN_CERTIFICATE_STORE = 'CurrentUser'
$env:LANTERN_SIGN_TIMESTAMP_URL = 'http://timestamp.digicert.com'
# Optional: select a particular installed Windows SDK SignTool.
$env:LANTERN_SIGNTOOL_PATH = 'C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\signtool.exe'
npm run build:desktop
npm run release:desktop
npm run verify:desktop
```

构建按指纹选定证书，不依赖“自动选择任意证书”。应用主程序、原生依赖和 Squirrel 安装程序都经过签名检查：已有有效且带时间戳的第三方二进制保留原发行者签名，其余使用所选证书。使用 SHA-256 文件摘要和 RFC 3161 时间戳，每个签名通过 `Get-AuthenticodeSignature` 和 `signtool verify /pa /all /tw`。主程序与安装程序还核对预期发行者指纹。原生依赖签名后重新记录运行时哈希，再生成 ZIP 和安装包；最后生成发行附件哈希。

签名 hook 只存在于构建目录，被排除在应用 ASAR 外。Forge／Squirrel 的配置仅包含 hook 路径，不序列化证书密码或私钥。证书指纹和发行者名称是公开信息，会进入发布清单。

## GitHub Actions

Windows 发布 workflow 支持 GitHub Secrets `LANTERN_WINDOWS_PFX_BASE64` 和 `LANTERN_WINDOWS_PFX_PASSWORD`。它们仅用于你合法持有且可以导出的证书；现代 CA 的硬件私钥通常不能导出 PFX，这类证书应在装有令牌的本机或受控 runner 上签名。

设置仓库 Variables `LANTERN_SIGN_REQUIRED=1` 可强制后续版本必须签名，避免配置丢失时发布未签名包。可选 Variable `LANTERN_SIGN_TIMESTAMP_URL` 指定 CA 推荐的 RFC 3161 服务。不要把密码放在 Variables。

workflow 将 PFX 临时导入临时 runner 的 `CurrentUser\My`，要求其中只有一个代码签名私钥，提取公开指纹后立即删除 PFX 文件并清除传给打包子进程的 PFX／密码环境变量。无论打包成功或失败，都删除导入的证书与私钥。未配置 Secret 时继续产出明确标记的未签名测试包，除非已启用 `LANTERN_SIGN_REQUIRED=1`。

验证工作不需要私钥：解压 ZIP 后依据发布清单的指纹检查全部 PE 文件和安装包。签名证明发行者和文件完整性；网络中继身份、房间邀请签名和 API 密钥属于不同用途，不能互相替代。

## 当前验证范围

已验证无证书时的显式诊断、强制签名拒绝、配置边界、安装包／主程序当前未签名的系统检测，以及签后验证对未签名／不受信任／错误发行者／缺时间戳的拒绝。随包官方 Node 可执行文件通过了真实 Windows 信任链、时间戳和 SignTool 验证，发行者为 OpenJS Foundation；CI 签名步骤通过 PowerShell 语法解析。当前开发机没有受信任代码签名证书，实际 CA 签名和 CI Secret 导入签名尚不能执行；这部分必须在提供合法证书后完成，不能记为已签名。

参考：[Electron Forge Windows 签名](https://www.electronforge.io/guides/code-signing/code-signing-windows)、[Microsoft SignTool](https://learn.microsoft.com/en-us/windows/win32/seccrypto/signtool)、[Microsoft SmartScreen 信誉说明](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)。
