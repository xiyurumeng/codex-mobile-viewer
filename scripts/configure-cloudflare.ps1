$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$projectRoot = Split-Path -Parent $PSScriptRoot
$dataDir = Join-Path $projectRoot 'data'
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
$project = Read-Host 'Cloudflare Pages project name (lowercase letters, digits, hyphens)'
if ($project -notmatch '^[a-z0-9][a-z0-9-]{0,57}[a-z0-9]$') { throw 'Invalid project name.' }
$accountId = Read-Host 'Cloudflare Account ID (32 characters)'
if ($accountId -notmatch '^[a-f0-9]{32}$') { throw 'Invalid Account ID.' }
$secure = Read-Host 'Cloudflare API Token (input is hidden)' -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  $plain = [Text.Encoding]::UTF8.GetBytes($token)
  $entropy = [Text.Encoding]::UTF8.GetBytes('codex-mobile-viewer:v1')
  $sealed = [Security.Cryptography.ProtectedData]::Protect($plain, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  [IO.File]::WriteAllBytes((Join-Path $dataDir 'cloudflare-token.dpapi'), $sealed)
  $config = @{ projectName = $project; accountId = $accountId } | ConvertTo-Json
  [IO.File]::WriteAllText((Join-Path $dataDir 'cloudflare.json'), $config, (New-Object Text.UTF8Encoding($false)))
  Write-Host 'Cloudflare configuration saved with Windows DPAPI for the current user.'
} finally {
  if ($plain) { [Array]::Clear($plain, 0, $plain.Length) }
  if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}
