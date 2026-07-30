param([Parameter(Mandatory = $true)][string]$Project)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$project = $Project.Trim()
if ($project -notmatch '^[a-z0-9](?:[a-z0-9-]{0,57}[a-z0-9])?$') {
  throw 'Invalid Pages project name.'
}
Push-Location $projectRoot
try {
  & node 'src\cli.mjs' 'rename-cloudflare-project' $project
  if ($LASTEXITCODE -ne 0) {
    throw "Deployment failed with exit code $LASTEXITCODE. Existing local configuration was kept."
  }
} finally {
  Pop-Location
}
