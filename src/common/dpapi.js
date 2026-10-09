const { spawnSync } = require('node:child_process');

const ENTROPY_B64 = Buffer.from('qianjiang-wentian-assistant-v1', 'utf8').toString('base64');

function runDpapi(script, input) {
  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-Command', script
  ], {
    input,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`DPAPI 调用失败：${(result.stderr || '').trim() || `exit=${result.status}`}`);
  }
  return String(result.stdout || '').trim();
}

function protectText(plainText) {
  const script = `
Add-Type -AssemblyName System.Security;
$plain = [Console]::In.ReadToEnd();
$bytes = [Text.Encoding]::UTF8.GetBytes($plain);
$entropy = [Convert]::FromBase64String('${ENTROPY_B64}');
$protected = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser);
[Console]::Out.Write([Convert]::ToBase64String($protected));
`;
  return runDpapi(script, String(plainText));
}

function unprotectText(protectedBase64) {
  const script = `
Add-Type -AssemblyName System.Security;
$protectedText = [Console]::In.ReadToEnd().Trim();
$protected = [Convert]::FromBase64String($protectedText);
$entropy = [Convert]::FromBase64String('${ENTROPY_B64}');
$bytes = [System.Security.Cryptography.ProtectedData]::Unprotect($protected, $entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser);
[Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes));
`;
  return runDpapi(script, String(protectedBase64));
}

function isAvailable() {
  try {
    const value = `dpapi-test-${Date.now()}`;
    return unprotectText(protectText(value)) === value;
  } catch {
    return false;
  }
}

module.exports = { protectText, unprotectText, isAvailable };