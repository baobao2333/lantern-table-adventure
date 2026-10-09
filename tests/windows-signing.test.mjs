import assert from "node:assert/strict";
import test from "node:test";
import signing from "../desktop/windows-signing.cjs";

const thumbprint = "0123456789ABCDEF0123456789ABCDEF01234567";

test("Windows signing is explicit and required signing never silently falls back", () => {
  assert.equal(signing.readSigningConfig({}), null);
  assert.throws(() => signing.readSigningConfig({ LANTERN_SIGN_REQUIRED: "1" }), /no unsigned fallback/);
  assert.throws(() => signing.readSigningConfig({ LANTERN_SIGN_REQUIRED: "yes" }), /0 or 1/);
  assert.throws(() => signing.readSigningConfig({ LANTERN_SIGN_TIMESTAMP_URL: "https://example.test/" }), /incomplete/);
});

test("Windows signing selects one certificate without serialized PFX secrets", () => {
  const config = signing.readSigningConfig({
    LANTERN_SIGN_CERTIFICATE_THUMBPRINT: thumbprint.toLowerCase(),
    LANTERN_SIGN_CERTIFICATE_STORE: "LocalMachine",
    LANTERN_SIGN_TIMESTAMP_URL: "https://timestamp.example.test/",
    LANTERN_WINDOWS_PFX_PASSWORD: "must-not-enter-forge-config",
    LANTERN_WINDOWS_PFX_BASE64: "private-key-material",
  });
  assert.equal(config.thumbprint, thumbprint);
  assert.equal(config.store, "LocalMachine");
  assert.ok(!JSON.stringify(config).includes("must-not-enter"));
  assert.ok(!JSON.stringify(config).includes("private-key"));
  assert.throws(() => signing.readSigningConfig({ LANTERN_SIGN_CERTIFICATE_THUMBPRINT: "not-a-thumbprint" }), /40 hexadecimal/);
  assert.throws(() => signing.readSigningConfig({ LANTERN_SIGN_CERTIFICATE_THUMBPRINT: thumbprint, LANTERN_SIGN_CERTIFICATE_STORE: "Root" }), /CurrentUser or LocalMachine/);
});

test("Timestamp endpoints cannot contain credentials or arbitrary protocols", () => {
  for (const url of ["file:///C:/keys", "https://user:password@example.test/", "https://example.test/?secret=a", "https://example.test/#secret"]) {
    assert.throws(() => signing.readSigningConfig({ LANTERN_SIGN_CERTIFICATE_THUMBPRINT: thumbprint, LANTERN_SIGN_TIMESTAMP_URL: url }), /RFC 3161/);
  }
});

test("Trusted verification rejects unsigned, untrusted, untimestamped, and wrong-publisher files", () => {
  const valid = { status: "Valid", thumbprint, timestamped: true };
  signing.assertTrustedSignature(valid, "LanternTable.exe", thumbprint);
  for (const status of ["NotSigned", "NotTrusted", "HashMismatch", "UnknownError"])
    assert.throws(() => signing.assertTrustedSignature({ ...valid, status }, "LanternTable.exe", thumbprint), /verification failed/);
  assert.throws(() => signing.assertTrustedSignature({ ...valid, timestamped: false }, "LanternTable.exe", thumbprint), /timestamp/);
  assert.throws(() => signing.assertTrustedSignature(valid, "LanternTable.exe", "F".repeat(40)), /Unexpected publisher/);
});

test("Signing preflight detects the absent certificate before packaging", { skip: process.platform !== "win32" }, async () => {
  await assert.rejects(signing.preflightSigning({ thumbprint: "0".repeat(40), store: "CurrentUser" }), /selected code-signing certificate is not installed/);
  const tool = await signing.findSignTool();
  assert.match(tool, /signtool\.exe$/i);
});
