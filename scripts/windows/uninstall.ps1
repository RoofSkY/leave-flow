<#
.SYNOPSIS
  leave-flow 제거 (관리자 권한 PowerShell 5.1)

.DESCRIPTION
  서비스·예약 작업과 방화벽 규칙을 지우고 프로그램 파일(node, versions …)을 지웁니다.
  데이터(data), 백업(backups), 로그(logs), config.json 은 남깁니다. -RemoveData 를 주면 설치 폴더를 모두 지웁니다.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\uninstall.ps1 -RemoveData
#>
[CmdletBinding()]
param(
  [string]$InstallDir = "C:\leave-flow",
  [switch]$RemoveData
)

$ErrorActionPreference = "Stop"
$ServiceName = "leave-flow"
$FirewallRule = "leave-flow"

function Step($msg) { Write-Host ""; Write-Host "==> $msg" -ForegroundColor Cyan }
function Ok($msg) { Write-Host "    $msg" -ForegroundColor Green }

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host "관리자 권한이 필요합니다. uninstall.cmd 를 더블클릭하거나 PowerShell 을 '관리자 권한으로 실행'하세요." -ForegroundColor Red
  exit 1
}
$InstallDir = [IO.Path]::GetFullPath($InstallDir)

if ($RemoveData) {
  Write-Host ""
  Write-Host "주의: $InstallDir 폴더 전체(휴가 데이터와 로컬 백업 포함)를 지웁니다. 되돌릴 수 없습니다." -ForegroundColor Yellow
  $answer = Read-Host "계속하려면 '삭제' 라고 입력하세요"
  if ($answer -ne "삭제") { Write-Host "취소했습니다."; exit 0 }
}

Step "자동 실행 해제"
$nssm = Join-Path $InstallDir "tools\nssm.exe"
$service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($service) {
  if ($service.Status -ne "Stopped") {
    Stop-Service -Name $ServiceName -Force
    $service.WaitForStatus("Stopped", (New-TimeSpan -Seconds 30))
  }
  if (Test-Path $nssm) { & $nssm remove $ServiceName confirm | Out-Null } else { sc.exe delete $ServiceName | Out-Null }
  Ok "Windows 서비스 삭제"
}
if (Get-ScheduledTask -TaskName $ServiceName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $ServiceName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $ServiceName -Confirm:$false
  Ok "예약 작업 삭제"
}
$nodeDir = Join-Path $InstallDir "node"
Get-Process -Name node -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -and $_.Path.StartsWith($nodeDir, [StringComparison]::OrdinalIgnoreCase) } |
  Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

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
  foreach ($name in @("node", "versions", "updates", "launcher.mjs", "state.mjs", "state.json", "state.json.tmp")) {
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
