<#
  install.ps1 · uninstall.ps1 · update-config.ps1 이 함께 쓰는 함수 (직접 실행하지 않음)
  각 스크립트가 . (Join-Path $PSScriptRoot "common.ps1") 로 불러옴 → 같은 폴더에 있어야 함
  (설치 프로그램은 uninstall.ps1 과 함께 설치 폴더에도 복사: scripts/installer/leave-flow.iss)
#>

# 서버 상태 확인 주소 (launcher/state.mjs healthUrl 과 같은 규칙: 모든 주소에서 받으면 127.0.0.1, IPv6 는 [ ])
function Get-HealthUrl($cfgHost, $port) {
  $h = ""
  if ($cfgHost) { $h = ([string]$cfgHost).Trim() }
  if ($h -eq "" -or $h -eq "0.0.0.0" -or $h -eq "::" -or $h -eq "[::]") { $h = "127.0.0.1" }
  elseif ($h.Contains(":") -and -not $h.StartsWith("[")) { $h = "[$h]" }
  return "http://${h}:$port/api/health"
}

# 트레이(tray.ps1)를 끄면 launcher 가 서버와 함께 정상 종료함. 15초 안에 끝나지 않으면 이 설치 폴더의 node 만 강제 종료
function Stop-LeaveFlow($dir) {
  $trayScript = Join-Path $dir "tray.ps1"
  Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($trayScript, [StringComparison]::OrdinalIgnoreCase) -ge 0 } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  $nodeDir = Join-Path $dir "node"
  $deadline = (Get-Date).AddSeconds(15)
  for (;;) {
    $left = @(Get-Process -Name node -ErrorAction SilentlyContinue |
      Where-Object { $_.Path -and $_.Path.StartsWith($nodeDir, [StringComparison]::OrdinalIgnoreCase) })
    if ($left.Count -eq 0) { return }
    if ((Get-Date) -gt $deadline) { $left | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 1; return }
    Start-Sleep -Milliseconds 500
  }
}
