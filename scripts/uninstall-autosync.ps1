$ErrorActionPreference = 'Stop'
$taskName = 'Codex Mobile Viewer Sync'
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  Write-Host 'Automatic sync task removed.'
} else {
  Write-Host 'Automatic sync task was not found.'
}
