<#
  leave-flow 트레이 — Windows 에 로그인하면 작업 스케줄러가 실행 (시작 메뉴 바로가기로도 실행).
  launcher.mjs 를 띄우고 작업 표시줄 알림 영역(트레이)에 아이콘을 둠. 메뉴: 웹페이지 열기 / 종료.
  종료하면 launcher 의 입력을 닫음 → launcher 가 서버와 함께 정상 종료 (트레이가 강제로 꺼져도 같음).
  이미 실행 중이면 웹페이지만 열고 끝남.
#>
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

$InstallDir = $PSScriptRoot
$Title = "leave-flow 휴가원 관리"

# 콘솔 창이 붙어 있으면 (v0.2.0 이 등록한 예약 작업·바로가기처럼 powershell 을 바로 실행한 경우) conhost --headless 로
# 다시 실행하고 끝냄 → 창이 바로 닫히고, 창을 닫아도 서버가 꺼지지 않음. 자동 업데이트로는 tray.ps1 만 바뀌므로
# 예약 작업의 실행 명령도 여기서 고침 (권한이 없으면 실패해도 그대로 둠 — 다음 로그인에도 이 경로로 다시 실행됨)
Add-Type -Namespace LeaveFlow -Name Native -MemberDefinition '[DllImport("kernel32.dll")] public static extern System.IntPtr GetConsoleWindow();'
if ([LeaveFlow.Native]::GetConsoleWindow() -ne [IntPtr]::Zero -and -not $env:LEAVE_FLOW_HEADLESS) {
  $env:LEAVE_FLOW_HEADLESS = "1"
  $conhostExe = Join-Path $env:WINDIR "System32\conhost.exe"
  $trayArgs = "--headless `"$(Join-Path $PSHOME 'powershell.exe')`" -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
  Start-Process -FilePath $conhostExe -ArgumentList $trayArgs -WorkingDirectory $InstallDir -WindowStyle Hidden
  try {
    $task = Get-ScheduledTask -TaskName "leave-flow" -ErrorAction Stop
    if ($task.Actions[0].Arguments -match 'tray\.ps1' -and $task.Actions[0].Execute -notmatch 'conhost\.exe$') {
      Set-ScheduledTask -TaskName "leave-flow" -ErrorAction Stop `
        -Action (New-ScheduledTaskAction -Execute $conhostExe -Argument $trayArgs -WorkingDirectory $InstallDir) | Out-Null
    }
  } catch { }
  exit 0
}

function Show-Error($msg) {
  [void][System.Windows.Forms.MessageBox]::Show($msg, $Title, "OK", "Error")
}

# 접속 주소 (config.json 의 port·host. 모든 주소에서 받으면 이 PC의 사무실 IP — 직원들이 쓰는 주소와 같게)
$port = 80
$hostName = $null
try {
  $config = Get-Content -Path (Join-Path $InstallDir "config.json") -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($config.port) { $port = [int]$config.port }
  $h = ([string]$config.host).Trim()
  if ($h -and $h -notin @("0.0.0.0", "::", "[::]")) {
    if ($h.Contains(":") -and -not $h.StartsWith("[")) { $h = "[$h]" }
    $hostName = $h
  }
} catch { }

# 기본 게이트웨이가 있는 어댑터의 IPv4 (가상 어댑터 제외). 로그인 직후엔 네트워크가 늦게 잡힐 수 있어 열 때마다 찾음. 없으면 localhost
function Get-Url {
  if ($hostName) { return "http://${hostName}:$port" }
  $ip = Get-NetIPConfiguration -ErrorAction SilentlyContinue |
    Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq "Up" } |
    ForEach-Object { $_.IPv4Address.IPAddress } |
    Where-Object { $_ -and $_ -notlike "169.254.*" } | Select-Object -First 1
  if (-not $ip) { $ip = "localhost" }
  return "http://${ip}:$port"
}

function Open-Web { Start-Process (Get-Url) }

$mutex = New-Object System.Threading.Mutex($false, "Local\leave-flow-tray")
if (-not $mutex.WaitOne(0)) {
  Open-Web
  exit 0
}

$nodeExe = Join-Path $InstallDir "node\node.exe"
if (-not (Test-Path $nodeExe)) {
  Show-Error "Node 를 찾을 수 없습니다: $nodeExe`ninstall.ps1 로 다시 설치하세요."
  exit 1
}

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $nodeExe
$psi.Arguments = "launcher.mjs --stop-on-stdin-end"
$psi.WorkingDirectory = $InstallDir
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$psi.RedirectStandardInput = $true
# launcher 는 logs\ 에 직접 기록하므로 화면 출력은 읽고 버림
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$launcher = [System.Diagnostics.Process]::Start($psi)
$launcher.BeginOutputReadLine()
$launcher.BeginErrorReadLine()

$tray = New-Object System.Windows.Forms.NotifyIcon
# 아이콘: 바로가기와 같은 leave-flow.ico (웹 화면의 아이콘과 같은 파란 달력). 파일이 없으면 같은 모양을 그림
$iconPath = Join-Path $InstallDir "leave-flow.ico"
if (Test-Path $iconPath) {
  $tray.Icon = New-Object System.Drawing.Icon($iconPath, [System.Windows.Forms.SystemInformation]::SmallIconSize)
} else {
  $bmp = New-Object System.Drawing.Bitmap 32, 32
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = "AntiAlias"
  $g.FillRectangle((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(35, 131, 226))), 3, 5, 26, 24)
  $g.FillRectangle((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(26, 111, 196))), 3, 5, 26, 7)
  $g.FillEllipse([System.Drawing.Brushes]::White, 8, 17, 6, 6)
  $g.Dispose()
  $tray.Icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
}
$tray.Text = "$Title ($(Get-Url))"

$script:quitting = $false
function Quit-Tray {
  $script:quitting = $true
  $tray.Visible = $false
  $tray.Dispose()
  [System.Windows.Forms.Application]::Exit()
}

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$openItem = $menu.Items.Add("웹페이지 열기")
$openItem.Font = New-Object System.Drawing.Font($openItem.Font, [System.Drawing.FontStyle]::Bold)
$openItem.add_Click({ Open-Web })
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$exitItem = $menu.Items.Add("종료")
$exitItem.add_Click({
  $answer = [System.Windows.Forms.MessageBox]::Show(
    "휴가원 관리 서버를 끕니다. 다른 PC에서도 접속할 수 없게 됩니다.`n`n다시 켜려면 시작 메뉴의 '$Title'을 실행하거나 Windows 에 다시 로그인하세요.",
    $Title, "OKCancel", "Warning")
  if ($answer -ne "OK") { return }
  $tray.Text = "$Title (종료 중…)"
  $script:quitting = $true
  try { $launcher.StandardInput.Close() } catch { }
  # launcher 는 서버를 10초 안에 끄지 못하면 강제로 끔
  if (-not $launcher.WaitForExit(15000)) { try { $launcher.Kill() } catch { } }
  Quit-Tray
})
$tray.ContextMenuStrip = $menu
# 왼쪽 클릭으로 웹페이지 열기 (더블클릭해도 MouseClick 은 한 번만 발생. 오른쪽 클릭은 메뉴)
$tray.add_MouseClick({ param($s, $e) if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Open-Web } })
$tray.Visible = $true

# launcher 가 스스로 끝나면 (설치 파일 문제 등) 알리고 트레이도 끝냄
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2000
$timer.add_Tick({
  if ($script:quitting -or -not $launcher.HasExited) { return }
  $timer.Stop()
  $code = $launcher.ExitCode
  Quit-Tray
  if ($code -ne 0) { Show-Error "휴가원 관리 서버가 종료되었습니다 (종료 코드 $code).`n로그를 확인하세요: $InstallDir\logs" }
})
$timer.Start()

[System.Windows.Forms.Application]::Run()
$mutex.ReleaseMutex()
