$ErrorActionPreference = 'Stop'
$taskName = 'Codex Mobile Viewer Sync'
$projectRoot = Split-Path -Parent $PSScriptRoot
$entry = Join-Path $projectRoot 'sync-auto.cmd'
$config = Get-Content -LiteralPath (Join-Path $projectRoot 'data\config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ('/d /c "' + $entry + '"')
$offsets = @(0) + @($config.sync.retryMinutes | ForEach-Object { [int]$_ })
$triggerTimes = foreach ($time in @($config.sync.dailyTimes)) {
  $parsed = [DateTime]::ParseExact([string]$time, 'HH:mm', [Globalization.CultureInfo]::InvariantCulture)
  foreach ($offset in $offsets) {
    (Get-Date).Date.Add($parsed.TimeOfDay).AddMinutes($offset).ToString('HH:mm')
  }
}
$triggerTimes = @($triggerTimes | Sort-Object -Unique)
$triggers = @($triggerTimes | ForEach-Object { New-ScheduledTaskTrigger -Daily -At $_ })
if ([bool]$config.sync.runOnNetworkReconnect) {
  $eventClass = Get-CimClass -Namespace 'Root/Microsoft/Windows/TaskScheduler' -ClassName 'MSFT_TaskEventTrigger'
  $networkTrigger = New-CimInstance -CimClass $eventClass -ClientOnly
  $networkTrigger.Enabled = $true
  $networkTrigger.Subscription = '<QueryList><Query Id="0" Path="Microsoft-Windows-NetworkProfile/Operational"><Select Path="Microsoft-Windows-NetworkProfile/Operational">*[System[(EventID=10000)]]</Select></Query></QueryList>'
  $triggers += $networkTrigger
}
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable:$([bool]$config.sync.startWhenAvailable) `
  -WakeToRun:$([bool]$config.sync.wakeToRun) `
  -RunOnlyIfNetworkAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew `
  -Priority 7 `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 20)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $triggers -Settings $settings -Description 'Deploy changed encrypted Codex snapshots at configured daily times or after network reconnects.' -Force | Out-Null
Write-Host ('Automatic sync task installed. Daily times: ' + ($triggerTimes -join ', ') + '; network reconnect: ' + [bool]$config.sync.runOnNetworkReconnect)
