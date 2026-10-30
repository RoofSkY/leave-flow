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

function Show-Error($msg) {
  [void][System.Windows.Forms.MessageBox]::Show($msg, $Title, "OK", "Error")
}

# 접속 주소 (config.json 의 port·host. 모든 주소에서 받으면 localhost)
$port = 8080
$hostName = "localhost"
try {
  $config = Get-Content -Path (Join-Path $InstallDir "config.json") -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($config.port) { $port = [int]$config.port }
  $h = ([string]$config.host).Trim()
  if ($h -and $h -notin @("0.0.0.0", "::", "[::]")) {
    if ($h.Contains(":") -and -not $h.StartsWith("[")) { $h = "[$h]" }
    $hostName = $h
  }
} catch { }
$url = "http://${hostName}:$port"

function Open-Web { Start-Process $url }

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

# 아이콘: 웹 화면의 아이콘(파란 달력)과 같은 모양
$bmp = New-Object System.Drawing.Bitmap 32, 32
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = "AntiAlias"
$g.FillRectangle((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(35, 131, 226))), 3, 5, 26, 24)
$g.FillRectangle((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(26, 111, 196))), 3, 5, 26, 7)
$g.FillEllipse([System.Drawing.Brushes]::White, 8, 17, 6, 6)
$g.Dispose()

$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
$tray.Text = "$Title ($url)"

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
$tray.add_DoubleClick({ Open-Web })
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
