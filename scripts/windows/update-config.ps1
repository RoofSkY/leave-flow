<#
.SYNOPSIS
  leave-flow 설정(config.json) 바꾸기 + 다시 시작 (관리자 권한 PowerShell 5.1)

.DESCRIPTION
  지정한 값만 바꿉니다. 포트를 바꾸면 방화벽 규칙도 함께 바꿉니다.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\update-config.ps1 -NasBackupDir "\\NAS주소\backup\leave-flow"
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\update-config.ps1 -Port 8090 -AutoUpdate off
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\update-config.ps1 -DisableNas     (NAS 백업 끄기)
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\update-config.ps1 -DisableUpdates     (업데이트 기능 끄기: updateRepo 를 null 로)
.NOTES
  PowerShell 5.1 에서는 -NasBackupDir "" 처럼 빈 값을 넘기면 값이 사라져 오류가 나므로 -DisableNas / -DisableUpdates 를 쓰세요.
  (-NasBackupDir none, -UpdateRepo none 도 같은 뜻)
#>
[CmdletBinding()]
param(
  # 없으면 설치되어 있는 폴더 (예약 작업 기준)
  [string]$InstallDir,
  [int]$Port,
  [string]$NasBackupDir,
  # NAS 백업 끄기 (nasBackupDir = null)
  [switch]$DisableNas,
  [string]$UpdateRepo,
  # 업데이트 기능 끄기 (updateRepo = null)
  [switch]$DisableUpdates,
  [ValidateSet("on", "off")]
  [string]$AutoUpdate,
  [string]$BackupTime,
  [int]$BackupKeepDays
)

$ErrorActionPreference = "Stop"
$TaskName = "leave-flow"
$FirewallRule = "leave-flow"

function Fail($msg) { Write-Host "설정을 바꾸지 못했습니다: $msg" -ForegroundColor Red; exit 1 }
# 서버 상태 확인 주소 (launcher/state.mjs healthUrl 과 같은 규칙: 모든 주소에서 받으면 127.0.0.1, IPv6 는 [ ])
function Health-Url($cfgHost, $port) {
  $h = ""
  if ($cfgHost) { $h = ([string]$cfgHost).Trim() }
  if ($h -eq "" -or $h -eq "0.0.0.0" -or $h -eq "::" -or $h -eq "[::]") { $h = "127.0.0.1" }
  elseif ($h.Contains(":") -and -not $h.StartsWith("[")) { $h = "[$h]" }
  return "http://${h}:$port/api/health"
}
# 트레이(tray.ps1)를 끄면 launcher 가 서버와 함께 정상 종료함. 15초 안에 끝나지 않으면 이 설치 폴더의 node 만 강제 종료
function Stop-LeaveFlow {
  $trayScript = Join-Path $InstallDir "tray.ps1"
  Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($trayScript, [StringComparison]::OrdinalIgnoreCase) -ge 0 } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  $nodeDir = Join-Path $InstallDir "node"
  $deadline = (Get-Date).AddSeconds(15)
  for (;;) {
    $left = @(Get-Process -Name node -ErrorAction SilentlyContinue |
      Where-Object { $_.Path -and $_.Path.StartsWith($nodeDir, [StringComparison]::OrdinalIgnoreCase) })
    if ($left.Count -eq 0) { return }
    if ((Get-Date) -gt $deadline) { $left | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 1; return }
    Start-Sleep -Milliseconds 500
  }
}
# 끄기를 뜻하는 값 (빈 값은 PowerShell 5.1 에서 전달되지 않으므로 none/off 도 받음)
function Is-Off($value) { return (-not $value) -or ([string]$value).Trim() -in @("none", "off", "null") }

if ($DisableNas -and $PSBoundParameters.ContainsKey("NasBackupDir")) { Fail "-DisableNas 와 -NasBackupDir 는 함께 쓸 수 없습니다." }
if ($DisableUpdates -and $PSBoundParameters.ContainsKey("UpdateRepo")) { Fail "-DisableUpdates 와 -UpdateRepo 는 함께 쓸 수 없습니다." }

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Fail "관리자 권한이 필요합니다. PowerShell 을 '관리자 권한으로 실행'한 뒤 다시 실행하세요."
}
if (-not $InstallDir) {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if (-not ($task -and $task.Actions[0].WorkingDirectory)) { Fail "설치된 leave-flow 를 찾을 수 없습니다. -InstallDir 로 설치 폴더를 지정하세요." }
  $InstallDir = $task.Actions[0].WorkingDirectory
}

$configPath = Join-Path $InstallDir "config.json"
if (-not (Test-Path $configPath)) { Fail "config.json 이 없습니다: $configPath (먼저 install.ps1 로 설치하세요)" }
try { $config = Get-Content -Path $configPath -Raw -Encoding UTF8 | ConvertFrom-Json }
catch { Fail "config.json 형식이 올바르지 않습니다: $configPath" }

function Set-Value($name, $value) {
  $config | Add-Member -NotePropertyName $name -NotePropertyValue $value -Force
  if ($null -eq $value) { Write-Host "    $name = (없음)" } else { Write-Host "    $name = $value" }
}

Write-Host "바꾼 값:"
$oldPort = 8080
if ($config.port) { $oldPort = [int]$config.port }
if ($PSBoundParameters.ContainsKey("Port")) {
  if ($Port -eq 5000) { Fail "5000번 포트는 같은 PC의 auto-ansimtalk 가 사용하므로 쓸 수 없습니다." }
  if ($Port -lt 1 -or $Port -gt 65535) { Fail "포트 번호가 올바르지 않습니다: $Port" }
  Set-Value "port" $Port
}
if ($DisableNas) {
  Set-Value "nasBackupDir" $null
} elseif ($PSBoundParameters.ContainsKey("NasBackupDir")) {
  if (Is-Off $NasBackupDir) { Set-Value "nasBackupDir" $null } else { Set-Value "nasBackupDir" $NasBackupDir.Trim() }
}
if ($DisableUpdates) {
  Set-Value "updateRepo" $null
} elseif ($PSBoundParameters.ContainsKey("UpdateRepo")) {
  if (Is-Off $UpdateRepo) {
    Set-Value "updateRepo" $null
  } else {
    if ($UpdateRepo.Trim() -notmatch '^[\w.-]+/[\w.-]+$') { Fail "업데이트 저장소는 'owner/repo' 형식으로 입력하세요." }
    Set-Value "updateRepo" $UpdateRepo.Trim()
  }
}
if ($PSBoundParameters.ContainsKey("AutoUpdate")) { Set-Value "autoUpdate" ($AutoUpdate -eq "on") }
if ($PSBoundParameters.ContainsKey("BackupTime")) {
  if ($BackupTime -notmatch '^([01]\d|2[0-3]):[0-5]\d$') { Fail "백업 시각은 HH:MM 형식으로 입력하세요. (예: 12:30)" }
  Set-Value "backupTime" $BackupTime
}
if ($PSBoundParameters.ContainsKey("BackupKeepDays")) {
  if ($BackupKeepDays -lt 1) { Fail "보관 일수는 1 이상이어야 합니다." }
  Set-Value "backupKeepDays" $BackupKeepDays
}

[IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding $false))

$newPort = $oldPort
if ($config.port) { $newPort = [int]$config.port }
if ($newPort -ne $oldPort) {
  Get-NetFirewallRule -DisplayName $FirewallRule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  New-NetFirewallRule -DisplayName $FirewallRule -Description "leave-flow 휴가원 관리 (사무실 LAN)" `
    -Direction Inbound -Protocol TCP -LocalPort $newPort -Action Allow -Profile Private | Out-Null
  Write-Host "방화벽 규칙을 $newPort 번 포트로 바꿨습니다."
}

# 다시 시작
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Stop-LeaveFlow
  Start-ScheduledTask -TaskName $TaskName
} else {
  Fail "등록된 예약 작업이 없습니다. install.ps1 로 다시 설치하세요."
}

$healthUrl = Health-Url $config.host $newPort
$deadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $deadline) {
  try {
    $h = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 3
    if ($h.ok) { Write-Host "다시 시작했습니다. (버전 $($h.version), 포트 $newPort)" -ForegroundColor Green; exit 0 }
  } catch { }
  Start-Sleep -Seconds 2
}
Fail "서버가 응답하지 않습니다 ($healthUrl). 로그를 확인하세요: $InstallDir\logs"
