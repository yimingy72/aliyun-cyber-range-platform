#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fixture_dir="$(mktemp -d)"
trap 'rm -rf "$fixture_dir"' EXIT
# The API dependency image and PowerShell both execute in isolated containers, with no cloud credentials.
docker run --rm --network none --entrypoint node \
  -v "$repo_root/apps/api/src/provisioning/renderers/guest-dns-scripts.ts:/app/apps/api/src/provisioning/renderers/guest-dns-scripts.ts:ro" \
  -v "$fixture_dir:/fixtures" "${DNS_API_TEST_IMAGE:-host-dns-scripts:validation}" -e '
const fs=require("fs"), ts=require("/app/apps/api/node_modules/typescript");
const js=ts.transpileModule(fs.readFileSync("/app/apps/api/src/provisioning/renderers/guest-dns-scripts.ts","utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const m={exports:{}};const scriptRequire=require("node:module").createRequire("/app/apps/api/src/provisioning/renderers/guest-dns-scripts.ts");new Function("require","module","exports",js)(scriptRequire,m,m.exports);
const input={dns:{servers:["10.0.1.10"],nicIds:["nic-secondary"]},interfaces:[{nicId:"nic-secondary",privateIp:"10.0.2.20"}],verificationNonce:"nonce-docker"};
fs.writeFileSync("/fixtures/verify.ps1",m.exports.buildWindowsDnsVerificationScript(input));
fs.writeFileSync("/fixtures/verify-ad.ps1",m.exports.buildWindowsDnsVerificationScript({...input,dns:{...input.dns,servers:["127.0.0.1"],domain:"lab.example"}}));
fs.writeFileSync("/fixtures/start.ps1",m.exports.buildWindowsDnsUserData({...input,provider:"alicloud",scripts:[{type:"powershell",content:"Write-Output USER_INITIALIZATION"}]}).replace(/^\[powershell\]\n/,""));
'
docker run --rm --network none --entrypoint pwsh \
  -v "$fixture_dir:/fixtures" -v "$repo_root/scripts/ci/test-windows-host-dns.ps1:/test.ps1:ro" \
  "${DNS_POWERSHELL_TEST_IMAGE:-mcr.microsoft.com/powershell:7.4-ubuntu-22.04}" -NoProfile -File /test.ps1
