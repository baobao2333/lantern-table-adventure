const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { readdir } = require("node:fs/promises");
const { basename, join, relative } = require("node:path");

const execute = promisify(execFile);
const productBinary = /^(?:LanternTable(?:-.+-Setup)?|Setup|Update)\.exe$/i;
const portableExecutable = /\.(?:exe|dll|node)$/i;

function readSigningConfig(environment = process.env) {
  const required = environment.LANTERN_SIGN_REQUIRED || "0";
  if (!["0", "1"].includes(required))
    throw new Error("LANTERN_SIGN_REQUIRED must be 0 or 1.");
  const thumbprint = (environment.LANTERN_SIGN_CERTIFICATE_THUMBPRINT || "")
    .replace(/\s/g, "")
    .toUpperCase();
  if (!thumbprint) {
    if (required === "1")
      throw new Error(
        "Trusted Windows signing is required. Configure LANTERN_SIGN_CERTIFICATE_THUMBPRINT for an existing code-signing certificate; no unsigned fallback is allowed.",
      );
    if (
      environment.LANTERN_SIGN_CERTIFICATE_STORE ||
      environment.LANTERN_SIGN_TIMESTAMP_URL ||
      environment.LANTERN_SIGNTOOL_PATH
    )
      throw new Error("Windows signing configuration is incomplete: certificate thumbprint is missing.");
    return null;
  }
  if (!/^[A-F0-9]{40}$/.test(thumbprint))
    throw new Error("The code-signing certificate thumbprint must contain 40 hexadecimal characters.");
  const store = environment.LANTERN_SIGN_CERTIFICATE_STORE || "CurrentUser";
  if (!["CurrentUser", "LocalMachine"].includes(store))
    throw new Error("The certificate store must be CurrentUser or LocalMachine.");
  const timestampUrl = environment.LANTERN_SIGN_TIMESTAMP_URL || "http://timestamp.digicert.com";
  const timestamp = new URL(timestampUrl);
  if (
    !["http:", "https:"].includes(timestamp.protocol) ||
    timestamp.username ||
    timestamp.password ||
    timestamp.search ||
    timestamp.hash
  )
    throw new Error("Use an HTTP(S) RFC 3161 timestamp URL without credentials, query, or fragment.");
  return {
    thumbprint,
    store,
    timestampUrl,
    signToolPath: environment.LANTERN_SIGNTOOL_PATH || null,
  };
}

async function powershell(script, environment = {}) {
  // Node can inherit PowerShell 7's modules; Windows PowerShell needs its own certificate provider.
  const result = await execute(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference='Stop'; [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); $env:PSModulePath = Join-Path $PSHOME 'Modules'; Import-Module Microsoft.PowerShell.Security -ErrorAction Stop; ${script}`],
    {
      env: { ...process.env, ...environment },
      windowsHide: true,
      timeout: 90_000,
      maxBuffer: 1024 * 1024,
    },
  );
  return JSON.parse(result.stdout.replace(/^\uFEFF/, "").trim());
}

async function findSignTool(config) {
  if (config?.signToolPath) return config.signToolPath;
  return powershell(`
$tool = Get-Command signtool.exe -ErrorAction SilentlyContinue
if ($tool) { $tool.Source | ConvertTo-Json -Compress; exit }
$kits = Join-Path ([Environment]::GetFolderPath('ProgramFilesX86')) 'Windows Kits\\10\\bin'
$tool = Get-ChildItem -LiteralPath $kits -Directory -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match '^\\d+\\.\\d+\\.\\d+\\.\\d+$' } |
  Sort-Object { [Version]$_.Name } -Descending |
  ForEach-Object { Join-Path $_.FullName 'x64\\signtool.exe' } |
  Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $tool) { throw 'Windows SDK SignTool is required for trusted-signature verification.' }
$tool | ConvertTo-Json -Compress`);
}

async function preflightSigning(config = readSigningConfig()) {
  if (!config) return null;
  if (process.platform !== "win32")
    throw new Error("Windows certificate signing must run on Windows.");
  const certificate = await powershell(`
$path = 'Cert:\\' + $env:LANTERN_SIGN_PROBE_STORE + '\\My\\' + $env:LANTERN_SIGN_PROBE_THUMBPRINT
if (-not (Test-Path -LiteralPath $path)) { throw 'The selected code-signing certificate is not installed.' }
$certificate = Get-Item -LiteralPath $path -ErrorAction Stop
if (-not $certificate.HasPrivateKey) { throw 'The code-signing certificate has no accessible private key.' }
if ($certificate.NotBefore -gt (Get-Date) -or $certificate.NotAfter -lt (Get-Date)) { throw 'The code-signing certificate is not currently valid.' }
if ('1.3.6.1.5.5.7.3.3' -notin $certificate.EnhancedKeyUsageList.ObjectId) { throw 'The certificate does not explicitly permit code signing.' }
$chain = New-Object System.Security.Cryptography.X509Certificates.X509Chain
$chain.ChainPolicy.RevocationMode = 'Online'
$chain.ChainPolicy.UrlRetrievalTimeout = [TimeSpan]::FromSeconds(20)
try {
  if (-not $chain.Build($certificate)) { throw 'The code-signing certificate chain is not trusted or revocation could not be verified.' }
  @{ thumbprint=$certificate.Thumbprint; subject=$certificate.Subject; issuer=$certificate.Issuer; notAfter=$certificate.NotAfter.ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress
} finally { $chain.Dispose() }`, {
    LANTERN_SIGN_PROBE_STORE: config.store,
    LANTERN_SIGN_PROBE_THUMBPRINT: config.thumbprint,
  });
  const signToolPath = await findSignTool(config);
  return { ...config, signToolPath, certificate };
}

async function inspectSignature(filename) {
  return powershell(`
$signature = Get-AuthenticodeSignature -LiteralPath $env:LANTERN_SIGN_PROBE_FILE
@{ status=$signature.Status.ToString(); thumbprint=$signature.SignerCertificate.Thumbprint; subject=$signature.SignerCertificate.Subject; timestamped=($null -ne $signature.TimeStamperCertificate) } | ConvertTo-Json -Compress`, {
    LANTERN_SIGN_PROBE_FILE: filename,
  });
}

function assertTrustedSignature(signature, filename, expectedThumbprint) {
  if (signature.status !== "Valid")
    throw new Error(`Windows signature verification failed for ${basename(filename)}: ${signature.status}.`);
  if (!signature.timestamped)
    throw new Error(`A trusted timestamp is missing from ${basename(filename)}.`);
  if (expectedThumbprint && signature.thumbprint !== expectedThumbprint)
    throw new Error(`Unexpected publisher certificate on ${basename(filename)}.`);
}

async function verifySignedFile(filename, config, expectedThumbprint) {
  const signature = await inspectSignature(filename);
  assertTrustedSignature(signature, filename, expectedThumbprint);
  await execute(config.signToolPath, ["verify", "/pa", "/all", "/tw", "/q", filename], {
    windowsHide: true,
    timeout: 90_000,
    maxBuffer: 1024 * 1024,
  });
  return signature;
}

let signingContext;
async function signFile(filename) {
  signingContext ||= preflightSigning();
  const config = await signingContext;
  if (!config) throw new Error("The signing hook was called without a configured publisher certificate.");
  const signature = await inspectSignature(filename);
  if (!productBinary.test(basename(filename)) && signature.status === "Valid" && signature.timestamped) {
    await verifySignedFile(filename, config);
    return;
  }
  const args = ["sign", "/sha1", config.thumbprint, "/s", "My"];
  if (config.store === "LocalMachine") args.push("/sm");
  args.push(
    "/fd", "SHA256", "/tr", config.timestampUrl, "/td", "SHA256",
    "/d", "Lantern Table Adventure", "/du", "https://github.com/baobao2333/lantern-table-adventure",
    filename,
  );
  await execute(config.signToolPath, args, { windowsHide: true, timeout: 180_000, maxBuffer: 1024 * 1024 });
  await verifySignedFile(filename, config, config.thumbprint);
}

async function verifySignedDirectory(directory, config) {
  const files = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error("Signed packages cannot contain symlinks.");
      const filename = join(current, entry.name);
      if (entry.isDirectory()) await visit(filename);
      else if (portableExecutable.test(entry.name)) {
        const signature = await verifySignedFile(
          filename, config, productBinary.test(entry.name) ? config.thumbprint : undefined,
        );
        files.push({ name: relative(directory, filename).replaceAll("\\", "/"), ...signature });
      }
    }
  }
  await visit(directory);
  if (!files.some((file) => file.name === "LanternTable.exe"))
    throw new Error("The signed application entry point is missing.");
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = signFile;
Object.assign(module.exports, {
  readSigningConfig, preflightSigning, findSignTool, inspectSignature,
  assertTrustedSignature, verifySignedFile, verifySignedDirectory,
});
