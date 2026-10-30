<#
.SYNOPSIS
  leave-flow 제거 (관리자 권한 PowerShell 5.1)

.DESCRIPTION
  트레이·예약 작업, 시작 메뉴·바탕화면 바로가기와 방화벽 규칙을 지우고 프로그램 파일(node, versions …)을 지웁니다.
  데이터(data), 백업(backups), 로그(logs), config.json 은 남깁니다. -RemoveData 를 주면 설치 폴더를 모두 지웁니다.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\uninstall.ps1 -RemoveData
#>
[CmdletBinding()]
param(
  # 없으면 설치되어 있는 폴더 (예약 작업 기준)
  [string]$InstallDir,
  [switch]$RemoveData
)

$ErrorActionPreference = "Stop"
$TaskName = "leave-flow"
$FirewallRule = "leave-flow"

function Step($msg) { Write-Host ""; Write-Host "==> $msg" -ForegroundColor Cyan }
function Ok($msg) { Write-Host "    $msg" -ForegroundColor Green }
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

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host "관리자 권한이 필요합니다. uninstall.cmd 를 더블클릭하거나 PowerShell 을 '관리자 권한으로 실행'하세요." -ForegroundColor Red
  exit 1
}
if (-not $InstallDir) {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($task -and $task.Actions[0].WorkingDirectory) { $InstallDir = $task.Actions[0].WorkingDirectory }
  else { $InstallDir = Join-Path ([Environment]::GetFolderPath("MyDocuments")) "leave-flow" }
}
$InstallDir = [IO.Path]::GetFullPath($InstallDir)

if ($RemoveData) {
  Write-Host ""
  Write-Host "주의: $InstallDir 폴더 전체(휴가 데이터와 로컬 백업 포함)를 지웁니다. 되돌릴 수 없습니다." -ForegroundColor Yellow
  $answer = Read-Host "계속하려면 '삭제' 라고 입력하세요"
  if ($answer -ne "삭제") { Write-Host "취소했습니다."; exit 0 }
}

Step "자동 실행 해제"
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Ok "예약 작업 삭제"
}
Stop-LeaveFlow
$shortcutPath = Join-Path $env:ProgramData "Microsoft\Windows\Start Menu\Programs\leave-flow 휴가원 관리.lnk"
if (Test-Path $shortcutPath) {
  Remove-Item -Path $shortcutPath -Force
  Ok "시작 메뉴 바로가기 삭제"
}
$desktopShortcutPath = Join-Path ([Environment]::GetFolderPath("CommonDesktopDirectory")) "leave-flow 휴가원 관리.lnk"
if (Test-Path $desktopShortcutPath) {
  Remove-Item -Path $desktopShortcutPath -Force
  Ok "바탕화면 바로가기 삭제"
}

Step "방화벽 규칙 삭제"
Get-NetFirewallRule -DisplayName $FirewallRule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
Ok "완료"

Step "파일 정리"
if (-not (Test-Path $InstallDir)) {
  Ok "설치 폴더가 없습니다: $InstallDir"
} elseif ($RemoveData) {
  Remove-Item -Path $InstallDir -Recurse -Force
  Ok "설치 폴더를 모두 지웠습니다."
} else {
  foreach ($name in @("node", "versions", "updates", "launcher.mjs", "state.mjs", "tray.ps1", "state.json", "state.json.tmp")) {
    $p = Join-Path $InstallDir $name
    if (Test-Path $p) { Remove-Item -Path $p -Recurse -Force }
  }
  Ok "프로그램 파일을 지웠습니다. 데이터는 남겨 두었습니다:"
  Write-Host "    $InstallDir\data      (DB)"
  Write-Host "    $InstallDir\backups   (로컬 백업)"
  Write-Host "    $InstallDir\logs, config.json"
}
Write-Host ""
Write-Host "제거를 마쳤습니다." -ForegroundColor Green
