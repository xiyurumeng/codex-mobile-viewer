param(
  [Parameter(Mandatory = $true)][ValidateSet('protect', 'unprotect')][string]$Mode,
  [Parameter(Mandatory = $true)][string]$Path
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$entropy = [Text.Encoding]::UTF8.GetBytes('codex-mobile-viewer:v1')
if ($Mode -eq 'protect') {
  $base64 = [Console]::In.ReadToEnd().Trim()
  $plain = [Convert]::FromBase64String($base64)
  try {
    $sealed = [Security.Cryptography.ProtectedData]::Protect($plain, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    [IO.File]::WriteAllBytes($Path, $sealed)
  } finally { [Array]::Clear($plain, 0, $plain.Length) }
} else {
  $sealed = [IO.File]::ReadAllBytes($Path)
  $plain = [Security.Cryptography.ProtectedData]::Unprotect($sealed, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  try { [Console]::Out.Write([Convert]::ToBase64String($plain)) }
  finally { [Array]::Clear($plain, 0, $plain.Length) }
}
