; leave-flow 설치 프로그램 (Inno Setup 6) → release/leave-flow-setup-<버전>.exe
; 직접 빌드하지 말고 npm run package 로 만듦 (package-release.mjs 가 AppVersion·SourceDir 를 넘김)
; 설치 작업은 배포 파일의 scripts\install.ps1 이 함 — 이 프로그램은 창 없이 실행하고 진행 상황·결과만 보여 줌

#ifndef AppVersion
  #error AppVersion 이 없습니다. npm run package 로 빌드하세요.
#endif
#ifndef SourceDir
  #error SourceDir 이 없습니다. npm run package 로 빌드하세요.
#endif

#define AppTitle "leave-flow 휴가원 관리"
#define PowerShellExe "{sys}\WindowsPowerShell\v1.0\powershell.exe"

[Setup]
AppId={{FCE78272-3C2A-438F-9682-3492F27B84A3}
AppName={#AppTitle}
AppVersion={#AppVersion}
AppVerName={#AppTitle} {#AppVersion}
AppPublisher=희망세움터
; 설치하는 계정의 문서 폴더 (바꿀 수 있음. 다시 설치하면 처음 고른 폴더를 씀)
DefaultDirName={userdocs}\leave-flow
DisableDirPage=no
UsedUserAreasWarning=no
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
CloseApplications=no
WizardStyle=modern
Compression=lzma2
SolidCompression=yes
SetupLogging=yes
OutputBaseFilename=leave-flow-setup-{#AppVersion}
UninstallDisplayName={#AppTitle}

[Languages]
Name: "korean"; MessagesFile: "compiler:Languages\Korean.isl"

[Tasks]
Name: "autostart"; Description: "Windows에 로그인하면 자동으로 실행"
Name: "desktopicon"; Description: "바탕화면 바로가기 만들기"

[Files]
; 배포 파일은 임시 폴더에 풀고 install.ps1 이 설치 폴더로 옮김 (설치가 끝나면 임시 폴더는 지워짐)
Source: "{#SourceDir}\*"; DestDir: "{tmp}\release"; Flags: recursesubdirs ignoreversion
; 제거할 때 실행 (앱 및 기능 → 제거)
Source: "{#SourceDir}\scripts\uninstall.ps1"; DestDir: "{app}"; Flags: ignoreversion

[Run]
; 트레이가 이미 켜져 있으므로 웹페이지만 열림
Filename: "{#PowerShellExe}"; Parameters: "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""{app}\tray.ps1"""; \
  Description: "휴가원 관리 화면 열기"; Flags: postinstall nowait runasoriginaluser runhidden skipifsilent; Check: InstallSucceeded

[UninstallRun]
Filename: "{#PowerShellExe}"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\uninstall.ps1"" -InstallDir ""{app}"""; \
  Flags: runhidden waituntilterminated; RunOnceId: "uninstall"

[Code]
var
  Failed: Boolean;
  FailMessage: String;

function InstallSucceeded: Boolean;
begin
  Result := not Failed;
end;

{ install.ps1 출력 한 줄마다: "==> 단계" 는 진행 상황으로, "설치하지 못했습니다: …" 는 실패 이유로 }
procedure OnInstallOutput(const S: String; const Error, FirstLine: Boolean);
begin
  Log(S);
  if Copy(S, 1, 4) = '==> ' then
    WizardForm.StatusLabel.Caption := Copy(S, 5, Length(S))
  else if Pos('설치하지 못했습니다: ', S) = 1 then
    FailMessage := Copy(S, Length('설치하지 못했습니다: ') + 1, Length(S));
end;

procedure RunInstallScript;
var
  Params: String;
  ResultCode: Integer;
begin
  Params := '-NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{tmp}\release\scripts\install.ps1') + '"' +
    ' -InstallDir "' + ExpandConstant('{app}') + '"';
  if not WizardIsTaskSelected('autostart') then
    Params := Params + ' -NoAutoStart';
  if WizardIsTaskSelected('desktopicon') then
    Params := Params + ' -DesktopShortcut';

  WizardForm.ProgressGauge.Style := npbstMarquee;
  try
    Failed := not ExecAndLogOutput(ExpandConstant('{#PowerShellExe}'), Params, ExpandConstant('{tmp}'),
      SW_HIDE, ewWaitUntilTerminated, ResultCode, @OnInstallOutput) or (ResultCode <> 0);
  except
    Failed := True;
    FailMessage := GetExceptionMessage;
  end;
  WizardForm.ProgressGauge.Style := npbstNormal;

  if Failed then
  begin
    if FailMessage = '' then
      FailMessage := '알 수 없는 오류입니다.';
    if not WizardSilent then
      MsgBox('설치하지 못했습니다.' + #13#10#13#10 + FailMessage, mbCriticalError, MB_OK);
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
    RunInstallScript;
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if (CurPageID = wpFinished) and Failed then
  begin
    WizardForm.FinishedHeadingLabel.Caption := '설치하지 못했습니다';
    WizardForm.FinishedLabel.Caption := FailMessage + #13#10#13#10 +
      '원인을 해결한 뒤 이 설치 프로그램을 다시 실행하세요.' + #13#10 +
      '자세한 기록: ' + ExpandConstant('{log}');
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if (CurUninstallStep = usPostUninstall) and not UninstallSilent then
    MsgBox('프로그램을 제거했습니다.' + #13#10 +
      '휴가 데이터(data)와 백업(backups)은 ' + ExpandConstant('{app}') + ' 에 남겨 두었습니다.', mbInformation, MB_OK);
end;
