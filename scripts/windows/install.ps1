<#
.SYNOPSIS
  leave-flow 설치 / 다시 설치 (Windows 10·11, PowerShell 5.1, 관리자 권한)

.DESCRIPTION
  1. 설치 폴더(data, backups, logs …) 만들기
  2. 전용 Node 24 설치 (InstallDir\node — PC의 다른 Node·Python과 무관)
  3. 배포 파일을 versions\<버전>\ 에 복사, launcher.mjs·state.mjs 복사, state.json 기록
  4. config.json 이 없으면 만들기 (있으면 그대로 둠, 데이터도 건드리지 않음)
  5. Windows 방화벽: 이 포트를 '개인(사설)' 네트워크에서만 허용
  6. 자동 실행 등록: 지금 로그인한 계정이 Windows 에 로그인하면 트레이(tray.ps1)로 실행 (작업 스케줄러, -NoAutoStart 면 등록만)
     + 시작 메뉴 바로가기 'leave-flow 휴가원 관리' (-DesktopShortcut 이면 바탕화면에도)
  7. 시작 후 /api/health 확인, 접속 주소 안내

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -NasBackupDir "\\NAS주소\backup\leave-flow"
#>
[CmdletBinding()]
param(
  # 없으면 설치되어 있는 폴더(예약 작업 기준), 처음이면 문서\leave-flow
  [string]$InstallDir,
  [int]$Port = 8080,
  # leave-flow-<버전>.zip 경로. 없으면 이 스크립트가 있는 압축 해제 폴더 또는 옆의 zip 사용
  [string]$ReleaseZip,
  # 미리 받아 둔 node-v24.x.x-win-x64.zip (없으면 nodejs.org 에서 받음)
  [string]$NodeZip,
  [string]$NasBackupDir,
  # 자동 업데이트용 GitHub 저장소 "owner/repo" (없으면 배포 파일의 release.json 값)
  [string]$UpdateRepo,
  # Windows 로그인 시 자동 실행하지 않음 (시작 메뉴·바탕화면 바로가기로만 켬)
  [switch]$NoAutoStart,
  # 바탕화면 바로가기 만들기 (주지 않으면 있던 바로가기를 지움)
  [switch]$DesktopShortcut
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
# 설치 프로그램(exe)이 출력을 받아 진행 상황을 보여 줌 → 한글이 깨지지 않게 UTF-8 로
if ([Console]::IsOutputRedirected) { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false }
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$TaskName = "leave-flow"
$FirewallRule = "leave-flow"
$Utf8NoBom = New-Object System.Text.UTF8Encoding $false

function Step($msg) { Write-Host ""; Write-Host "==> $msg" -ForegroundColor Cyan }
function Ok($msg) { Write-Host "    $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "    $msg" -ForegroundColor Yellow }
function Fail($msg) {
  Write-Host ""
  Write-Host "설치하지 못했습니다: $msg" -ForegroundColor Red
  exit 1
}
function Write-Json($path, $value) {
  [IO.File]::WriteAllText($path, ($value | ConvertTo-Json -Depth 5), $Utf8NoBom)
}
function Read-Json($path) {
  if (-not (Test-Path $path)) { return $null }
  try { return (Get-Content -Path $path -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { return $null }
}
function Version-Key($v) {
  try { return [version](($v -replace '^v', '') -replace '-.*$', '') } catch { return [version]"0.0.0" }
}
# 서버 상태 확인 주소 (launcher/state.mjs healthUrl 과 같은 규칙: 모든 주소에서 받으면 127.0.0.1, IPv6 는 [ ])
function Health-Url($cfgHost, $port) {
  $h = ""
  if ($cfgHost) { $h = ([string]$cfgHost).Trim() }
  if ($h -eq "" -or $h -eq "0.0.0.0" -or $h -eq "::" -or $h -eq "[::]") { $h = "127.0.0.1" }
  elseif ($h.Contains(":") -and -not $h.StartsWith("[")) { $h = "[$h]" }
  return "http://${h}:$port/api/health"
}
# 설치 폴더 기준 경로 (절대 경로면 그대로 — 서버 config.ts 와 같은 규칙)
function Home-Path($value, $default) {
  $p = $default
  if ($value) { $p = [string]$value }
  return [IO.Path]::GetFullPath([IO.Path]::Combine($InstallDir, $p))
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

# ---------- 확인 ----------

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Fail "관리자 권한이 필요합니다. install.cmd 를 더블클릭하거나, PowerShell 을 '관리자 권한으로 실행'한 뒤 다시 실행하세요."
}
if ($Port -eq 5000) { Fail "5000번 포트는 같은 PC의 auto-ansimtalk 가 사용하므로 쓸 수 없습니다." }
if ($Port -lt 1 -or $Port -gt 65535) { Fail "포트 번호가 올바르지 않습니다: $Port" }
if (-not $InstallDir) {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($task -and $task.Actions[0].WorkingDirectory) { $InstallDir = $task.Actions[0].WorkingDirectory }
  else { $InstallDir = Join-Path ([Environment]::GetFolderPath("MyDocuments")) "leave-flow" }
}
$InstallDir = [IO.Path]::GetFullPath($InstallDir)

# ---------- 배포 파일 찾기 ----------

Step "배포 파일 확인"
$tempDirs = @()
$source = $null
if ($ReleaseZip) {
  if (-not (Test-Path $ReleaseZip)) { Fail "배포 파일을 찾을 수 없습니다: $ReleaseZip" }
  $zip = (Resolve-Path $ReleaseZip).Path
} else {
  $zip = $null
  foreach ($dir in @($PSScriptRoot, (Split-Path $PSScriptRoot -Parent))) {
    if (Test-Path (Join-Path $dir "server.mjs")) { $source = $dir; break }
  }
  if (-not $source) {
    $zip = Get-ChildItem -Path @($PSScriptRoot, (Split-Path $PSScriptRoot -Parent)) -Filter "leave-flow-*.zip" -File -ErrorAction SilentlyContinue |
      Sort-Object { Version-Key ($_.BaseName -replace '^leave-flow-', '') } -Descending |
      Select-Object -First 1 -ExpandProperty FullName
    if (-not $zip) { Fail "배포 파일(leave-flow-<버전>.zip)을 찾을 수 없습니다. -ReleaseZip 으로 지정하세요." }
  }
}
if ($zip) {
  $source = Join-Path $env:TEMP ("leave-flow-release-" + [guid]::NewGuid())
  $tempDirs += $source
  Expand-Archive -Path $zip -DestinationPath $source -Force
  Ok "압축 해제: $zip"
}
if (-not (Test-Path (Join-Path $source "server.mjs"))) { Fail "배포 파일에 server.mjs 가 없습니다: $source" }

$release = Read-Json (Join-Path $source "release.json")
$Version = if ($release) { [string]$release.version } else { $null }
if (-not $Version -and $zip) { $Version = [IO.Path]::GetFileNameWithoutExtension($zip) -replace '^leave-flow-', '' }
if ($Version -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$') { Fail "배포 파일의 버전을 알 수 없습니다." }
Ok "버전 $Version"

# ---------- 기존 실행 중지 ----------

Step "기존 실행 중지 (다시 설치하는 경우)"
$nodeDir = Join-Path $InstallDir "node"
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Ok "예약 작업 중지"
}
# 트레이와 이 설치 폴더의 전용 node.exe 만 정리 (다른 프로그램은 건드리지 않음)
Stop-LeaveFlow

# ---------- 폴더 ----------

Step "설치 폴더 준비: $InstallDir"
foreach ($d in @("", "data", "backups", "logs", "updates", "versions", "tools")) {
  New-Item -ItemType Directory -Path (Join-Path $InstallDir $d) -Force | Out-Null
}
Ok "완료"

# ---------- config.json (있으면 그대로) ----------

Step "설정 파일 (config.json)"
$configPath = Join-Path $InstallDir "config.json"
$config = Read-Json $configPath
if (Test-Path $configPath) {
  if (-not $config) { Fail "config.json 형식이 올바르지 않습니다. 파일을 고친 뒤 다시 실행하세요: $configPath" }
  if ($config.port) {
    if ($PSBoundParameters.ContainsKey("Port") -and [int]$config.port -ne $Port) {
      Warn "기존 config.json 의 포트($($config.port))를 그대로 사용합니다. 바꾸려면 update-config.ps1 -Port 를 사용하세요."
    }
    $Port = [int]$config.port
  }
  if ($PSBoundParameters.ContainsKey("NasBackupDir") -or $PSBoundParameters.ContainsKey("UpdateRepo")) {
    Warn "기존 config.json 은 바꾸지 않습니다. NAS 폴더·업데이트 저장소를 바꾸려면 update-config.ps1 을 사용하세요."
  }
  Ok "기존 config.json 을 그대로 사용합니다."
} else {
  $repo = $null
  if ($UpdateRepo) { $repo = $UpdateRepo } elseif ($release -and $release.repo) { $repo = [string]$release.repo }
  $nas = $null
  if ($NasBackupDir) { $nas = $NasBackupDir }
  $config = [ordered]@{
    port             = $Port
    nasBackupDir     = $nas
    backupTime       = "12:30"
    backupKeepDays   = 30
    updateRepo       = $repo
    autoUpdate       = $true
    updateCheckHours = 6
  }
  Write-Json $configPath $config
  Ok "config.json 을 만들었습니다. (포트 $Port)"
}
if ($Port -eq 5000) { Fail "config.json 의 포트가 5000번입니다. auto-ansimtalk 와 겹치므로 다른 포트로 바꾸세요." }

$listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listening) {
  $owner = (Get-Process -Id $listening.OwningProcess -ErrorAction SilentlyContinue).ProcessName
  Fail "$Port 번 포트를 이미 다른 프로그램($owner)이 사용 중입니다. -Port 로 다른 포트를 지정하세요."
}

$nasDir = $null
if ($config.nasBackupDir) { $nasDir = [string]$config.nasBackupDir }
if ($nasDir) {
  if (Test-Path $nasDir) { Ok "NAS 백업 폴더 접근 확인: $nasDir" }
  else { Warn "지금 계정으로 NAS 백업 폴더에 접근할 수 없습니다: $nasDir (주소·공유 권한을 확인하세요)" }
}

# ---------- Node ----------

Step "전용 Node 24 설치"
$nodeExe = Join-Path $nodeDir "node.exe"
$haveNode = $false
if (-not $NodeZip -and (Test-Path $nodeExe)) {
  $current = & $nodeExe --version
  if ($current -match '^v(\d+)\.' -and [int]$Matches[1] -ge 24) { $haveNode = $true; Ok "이미 설치됨: $current" }
}
if (-not $haveNode) {
  $nodeTemp = Join-Path $env:TEMP ("leave-flow-node-" + [guid]::NewGuid())
  $tempDirs += $nodeTemp
  New-Item -ItemType Directory -Path $nodeTemp | Out-Null
  if ($NodeZip) {
    if (-not (Test-Path $NodeZip)) { Fail "Node 파일을 찾을 수 없습니다: $NodeZip" }
    $nodeZipPath = (Resolve-Path $NodeZip).Path
  } else {
    $base = "https://nodejs.org/dist/latest-v24.x"
    $sumsPath = Join-Path $nodeTemp "SHASUMS256.txt"
    try { Invoke-WebRequest -Uri "$base/SHASUMS256.txt" -OutFile $sumsPath -UseBasicParsing }
    catch { Fail "Node 목록을 받지 못했습니다. 인터넷 연결을 확인하거나 -NodeZip 으로 받아 둔 파일을 지정하세요. ($($_.Exception.Message))" }
    $line = Get-Content $sumsPath | Where-Object { $_ -match '^[0-9a-f]{64}\s+node-v24\.[0-9.]+-win-x64\.zip$' } | Select-Object -First 1
    if (-not $line) { Fail "nodejs.org 에서 Node 24 Windows(x64) 파일을 찾지 못했습니다." }
    $parts = $line.Trim() -split '\s+'
    $expected = $parts[0]
    $nodeZipPath = Join-Path $nodeTemp $parts[1]
    Ok "내려받는 중: $($parts[1])"
    try { Invoke-WebRequest -Uri "$base/$($parts[1])" -OutFile $nodeZipPath -UseBasicParsing }
    catch { Fail "Node 를 받지 못했습니다. ($($_.Exception.Message))" }
    $actual = (Get-FileHash -Path $nodeZipPath -Algorithm SHA256).Hash
    if ($actual -ne $expected) { Fail "내려받은 Node 파일의 무결성(SHA-256) 확인에 실패했습니다. 다시 실행하세요." }
    Ok "무결성(SHA-256) 확인"
  }
  $extract = Join-Path $nodeTemp "x"
  Expand-Archive -Path $nodeZipPath -DestinationPath $extract -Force
  $inner = Get-ChildItem -Path $extract -Directory | Where-Object { Test-Path (Join-Path $_.FullName "node.exe") } | Select-Object -First 1
  if (-not $inner) { Fail "Node 압축 파일 안에 node.exe 가 없습니다." }
  if (Test-Path $nodeDir) { Remove-Item -Path $nodeDir -Recurse -Force }
  Copy-Item -Path $inner.FullName -Destination $nodeDir -Recurse
  $current = & $nodeExe --version
  if (-not ($current -match '^v(\d+)\.' -and [int]$Matches[1] -ge 24)) { Fail "Node 24 이상이 필요합니다. (설치된 버전: $current)" }
  Ok "설치됨: $current"
}

# ---------- 프로그램 ----------

Step "프로그램 설치 (versions\$Version)"
$versionDir = Join-Path $InstallDir "versions\$Version"
$sameFolder = [IO.Path]::GetFullPath($source).TrimEnd('\') -ieq $versionDir.TrimEnd('\')
if (-not $sameFolder) {
  if (Test-Path $versionDir) { Remove-Item -Path $versionDir -Recurse -Force }
  New-Item -ItemType Directory -Path $versionDir -Force | Out-Null
  Copy-Item -Path (Join-Path $source "*") -Destination $versionDir -Recurse -Force
}
Copy-Item -Path (Join-Path $source "launcher.mjs") -Destination (Join-Path $InstallDir "launcher.mjs") -Force
Copy-Item -Path (Join-Path $source "state.mjs") -Destination (Join-Path $InstallDir "state.mjs") -Force
Copy-Item -Path (Join-Path $source "tray.ps1") -Destination (Join-Path $InstallDir "tray.ps1") -Force
Ok "완료"

$statePath = Join-Path $InstallDir "state.json"
$state = Read-Json $statePath
if (-not $state -or [string]$state.current -ne $Version) {
  $previous = $null
  if ($state -and $state.current -and (Test-Path (Join-Path $InstallDir "versions\$($state.current)\server.mjs"))) {
    $previous = [string]$state.current
  }

  # 버전을 바꾸면 업데이트 전 DB 백업을 만들어 둠 → 새 버전이 정상 기동하지 않으면 launcher 가 되돌리면서 이 백업도 복구
  # (새 버전이 시작하면서 DB 구조를 바꿨을 수 있으므로). 이름은 서버 백업 규칙(leave-flow-날짜-시각-pre-update.db)과 같게.
  $preUpdateBackup = $null
  $dbFile = Join-Path (Home-Path $config.dataDir "data") "leave-flow.db"
  if ($previous -and (Test-Path $dbFile)) {
    $backupDir = Home-Path $config.backupDir "backups"
    New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
    $base = "leave-flow-" + (Get-Date -Format "yyyyMMdd-HHmmss") + "-pre-update"
    $target = Join-Path $backupDir "$base.db"
    for ($n = 2; Test-Path $target; $n++) { $target = Join-Path $backupDir "$base-$n.db" }
    # 전용 node 로 일관된 한 파일 복사본을 만듦 (VACUUM INTO — 강제 종료로 남은 -wal 내용도 포함)
    $snapshotJs = Join-Path $env:TEMP ("leave-flow-snapshot-" + [guid]::NewGuid() + ".mjs")
    [IO.File]::WriteAllText($snapshotJs, @'
import { DatabaseSync } from "node:sqlite";
const [, , source, target] = process.argv;
const db = new DatabaseSync(source);
try {
  db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
} finally {
  db.close();
}
'@, $Utf8NoBom)
    $snapshotCode = 1
    try {
      & $nodeExe --disable-warning=ExperimentalWarning $snapshotJs $dbFile $target
      $snapshotCode = $LASTEXITCODE
    } catch {
      Warn $_.Exception.Message
    }
    Remove-Item -Path $snapshotJs -Force -ErrorAction SilentlyContinue
    if ($snapshotCode -ne 0 -or -not (Test-Path $target)) {
      Remove-Item -Path $target -Force -ErrorAction SilentlyContinue
      Fail "업데이트 전 DB 백업을 만들지 못해 버전을 바꾸지 않았습니다. ($dbFile) 디스크 공간·권한을 확인한 뒤 다시 실행하세요."
    }
    $preUpdateBackup = $target
    Ok "업데이트 전 DB 백업: $target"
  }

  # 이전 버전으로 낮추면 자동 업데이트가 곧바로 높은 버전을 다시 설치하지 않도록 그 버전을 건너뜀
  # (그보다 높은 새 버전이 나오면 자동으로 설치됨. launcher 는 current 가 failedVersion 보다 낮으면 이 기록을 지우지 않음)
  $failedVersion = $null
  $lastUpdateError = $null
  if ($previous -and ((Version-Key $Version) -lt (Version-Key $previous))) {
    $failedVersion = $previous
    if ($state.failedVersion -and ((Version-Key $state.failedVersion) -gt (Version-Key $previous))) {
      $failedVersion = [string]$state.failedVersion
      $lastUpdateError = $state.lastUpdateError
    }
    Warn "이전 버전($previous)으로 낮췄습니다. 자동 업데이트가 $failedVersion 을(를) 다시 설치하지 않도록 건너뜁니다. 더 높은 새 버전이 나오면 자동으로 설치됩니다."
    Warn "이 버전에 계속 머물려면 update-config.ps1 -AutoUpdate off 로 자동 업데이트를 끄세요."
  }

  # 기존 버전이 있으면 새 버전을 시험 기동 → 정상이 아니면 launcher 가 기존 버전으로 되돌림
  $newState = [ordered]@{
    current         = $Version
    previous        = $previous
    pending         = $null
    trial           = [bool]$previous
    failedVersion   = $failedVersion
    lastUpdateError = $lastUpdateError
    updatedAt       = $null
    preUpdateBackup = $preUpdateBackup
  }
  Write-Json $statePath $newState
  if ($previous) { Ok "state.json: $previous → $Version" } else { Ok "state.json: $Version" }
}

# ---------- 방화벽 ----------

Step "Windows 방화벽 ($Port 번 포트, 개인 네트워크만)"
Get-NetFirewallRule -DisplayName $FirewallRule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName $FirewallRule -Description "leave-flow 휴가원 관리 (사무실 LAN)" `
  -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Private | Out-Null
Ok "인바운드 규칙 '$FirewallRule' 추가"
foreach ($p in @(Get-NetConnectionProfile -ErrorAction SilentlyContinue)) {
  if ([string]$p.NetworkCategory -eq "Public") {
    Warn "네트워크 '$($p.Name)' 이(가) '공용'으로 되어 있어 다른 PC에서 접속할 수 없습니다."
    Warn "설정 > 네트워크 및 인터넷 > 이더넷(또는 Wi-Fi) > 네트워크 프로필 유형을 '개인'으로 바꾸세요."
  }
}

# ---------- 자동 실행 ----------

Step "트레이 실행 등록"
# 트레이는 로그인한 사람의 화면에 떠야 하므로 지금 이 PC에 로그인한 계정으로 등록
# (다른 관리자 계정으로 install.cmd 를 실행해도 화면 앞의 계정). NAS 에도 이 계정으로 접근함
$trayUser = (Get-CimInstance Win32_ComputerSystem -ErrorAction SilentlyContinue).UserName
if (-not $trayUser) { $trayUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name }
# 그 계정(관리자 권한 없이 실행)으로 데이터·백업·로그·업데이트 파일을 쓸 수 있게
& icacls $InstallDir /grant "${trayUser}:(OI)(CI)M" /Q | Out-Null
if ($LASTEXITCODE -ne 0) { Fail "설치 폴더에 '$trayUser' 계정의 쓰기 권한을 주지 못했습니다." }

$psExe = Join-Path $PSHOME "powershell.exe"
$trayArgs = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$(Join-Path $InstallDir 'tray.ps1')`""
$action = New-ScheduledTaskAction -Execute $psExe -Argument $trayArgs -WorkingDirectory $InstallDir
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$taskPrincipal = New-ScheduledTaskPrincipal -UserId $trayUser -LogonType Interactive -RunLevel Limited
# 자동 실행을 끄면 트리거 없이 등록 (설치 직후 시작과 update-config.ps1 의 다시 시작에 씀)
$taskArgs = @{ Action = $action; Settings = $settings; Principal = $taskPrincipal }
if (-not $NoAutoStart) { $taskArgs.Trigger = New-ScheduledTaskTrigger -AtLogOn -User $trayUser }
Register-ScheduledTask -TaskName $TaskName -Description "희망세움터 휴가원 관리 프로그램 (트레이로 실행). 설치 폴더: $InstallDir" `
  @taskArgs -Force | Out-Null
if ($NoAutoStart) { Ok "작업 스케줄러 '$TaskName' 등록 (Windows 로그인 시 자동 실행 안 함)" }
else { Ok "작업 스케줄러 '$TaskName' 등록 ($trayUser 로그인 시 실행)" }

# 트레이에서 종료한 뒤 다시 켤 때 쓰는 바로가기 (이미 켜져 있으면 웹페이지를 엶)
function New-TrayShortcut($path) {
  $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($path)
  $shortcut.TargetPath = $psExe
  $shortcut.Arguments = $trayArgs
  $shortcut.WorkingDirectory = $InstallDir
  $shortcut.WindowStyle = 7
  $shortcut.Description = "휴가원 관리 서버 켜기 (켜져 있으면 웹페이지 열기)"
  $shortcut.Save()
}
New-TrayShortcut (Join-Path $env:ProgramData "Microsoft\Windows\Start Menu\Programs\leave-flow 휴가원 관리.lnk")
Ok "시작 메뉴 바로가기: leave-flow 휴가원 관리"
$desktopShortcutPath = Join-Path ([Environment]::GetFolderPath("CommonDesktopDirectory")) "leave-flow 휴가원 관리.lnk"
if ($DesktopShortcut) {
  New-TrayShortcut $desktopShortcutPath
  Ok "바탕화면 바로가기: leave-flow 휴가원 관리"
} elseif (Test-Path $desktopShortcutPath) {
  Remove-Item -Path $desktopShortcutPath -Force
}

Start-ScheduledTask -TaskName $TaskName

# ---------- 확인 ----------

Step "서버 시작 확인"
# 설치한 버전이 응답해야 성공. 새 버전이 시험 기동(60초)에 실패하면 launcher 가 이전 버전으로 되돌리므로
# 그 시간과 다시 시작하는 시간까지 기다리고, 다른 버전이 응답하면 되돌린 것으로 알림.
$healthUrl = Health-Url $config.host $Port
$healthy = $null
$other = $null
$rolledBack = $false
$deadline = (Get-Date).AddSeconds(120)
while ((Get-Date) -lt $deadline) {
  $h = $null
  try { $h = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 3 } catch { }
  if ($h -and $h.ok) {
    if ([string]$h.version -eq $Version) { $healthy = $h; break }
    $other = $h
  }
  $st = Read-Json $statePath
  if ($st -and ([string]$st.failedVersion -eq $Version -or ([string]$st.current -ne $Version -and -not $st.trial))) {
    $rolledBack = $true
  }
  if ($rolledBack -and $other) { break }
  Start-Sleep -Seconds 2
}
foreach ($t in $tempDirs) { Remove-Item -Path $t -Recurse -Force -ErrorAction SilentlyContinue }
if (-not $healthy) {
  if ($rolledBack -or $other) {
    $st = Read-Json $statePath
    $reason = "이유를 알 수 없습니다"
    if ($st -and $st.lastUpdateError -and $st.lastUpdateError.message) { $reason = [string]$st.lastUpdateError.message }
    $running = "이전 버전"
    if ($other) { $running = [string]$other.version } elseif ($st -and $st.current) { $running = [string]$st.current }
    Fail "새 버전 $Version 이(가) 정상적으로 시작되지 않아 $running(으)로 되돌렸습니다: $reason. 로그를 확인하세요: $InstallDir\logs"
  }
  Fail "서버가 응답하지 않습니다 ($healthUrl). 로그를 확인하세요: $InstallDir\logs"
}
Ok "leave-flow $($healthy.version) 실행 중"

Write-Host ""
Write-Host "설치를 마쳤습니다. 사무실 PC의 브라우저에서 아래 주소로 접속하세요." -ForegroundColor Green
$ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } |
  Select-Object -ExpandProperty IPAddress
foreach ($ip in $ips) { Write-Host "    http://${ip}:$Port" -ForegroundColor White }
Write-Host "    (이 PC에서는 http://localhost:$Port)"
Write-Host ""
Write-Host "작업 표시줄 오른쪽 알림 영역(트레이)의 파란 달력 아이콘에서 웹페이지 열기·종료를 할 수 있습니다."
if ($NoAutoStart) { Write-Host "Windows 에 로그인해도 자동으로 켜지지 않습니다. 'leave-flow 휴가원 관리' 바로가기(시작 메뉴)로 켭니다." }
else { Write-Host "Windows 에 로그인하면 자동으로 켜지고, 종료한 뒤에는 'leave-flow 휴가원 관리' 바로가기(시작 메뉴)로 다시 켭니다." }
Write-Host "처음 설정 순서: 관리 > 휴가 종류 → 설정 → 직원 → 기존 잔여량 → 부여 내역"
Write-Host "자세한 내용: $versionDir\docs\운영가이드.md"
