; installer/llg-overlay.iss
; Instalador do LLG Overlay (Inno Setup 6). Nao rode direto: use
;   npm run installer
; que monta o aplicativo (npm run build) e chama o ISCC com a versao do package.json.
;
; O que o instalador faz:
;   - instala para o usuario, sem pedir administrador, em
;     %LOCALAPPDATA%\Programs\LLG Overlay (a pasta aceita escrita, entao a
;     atualizacao automatica do app continua funcionando)
;   - cria o atalho na area de trabalho e no menu Iniciar
;   - aparece em Configuracoes > Aplicativos instalados, com o desinstalador
;   - se o app estiver aberto, avisa e fecha antes de copiar
;
; O que o desinstalador faz:
;   - fecha o app (e os scripts que ele abre)
;   - apaga a pasta do programa inteira (inclusive o que as atualizacoes trouxeram)
;   - tira o app do Assetto Corsa que o painel instala na pasta do jogo (installer/limpar.ps1)
;   - pergunta se apaga tambem as configuracoes (%APPDATA%\LLG Overlay)

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef SourceDir
  #define SourceDir "..\dist\LLG Overlay-win32-x64"
#endif

#define AppName "LLG Overlay"
#define AppExe "LLG Overlay.exe"

[Setup]
; Nao mude o AppId: e por ele que o Windows sabe que uma versao nova substitui a antiga.
AppId={{6F3B2A51-8C4D-4E7A-9B1F-2D5E8A4C7B39}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=LLG
VersionInfoVersion={#AppVersion}
PrivilegesRequired=lowest
DefaultDirName={autopf}\{#AppName}
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=yes
DisableWelcomePage=no
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
WizardStyle=modern
SetupIconFile=..\app\icon.ico
UninstallDisplayIcon={app}\{#AppExe}
UninstallDisplayName={#AppName}
OutputDir=..\dist
OutputBaseFilename=LLG-Overlay-Setup-v{#AppVersion}
Compression=lzma2/max
SolidCompression=yes
; o app e fechado pelo proprio instalador (PrepareToInstall), sem a tela do Restart Manager
CloseApplications=no

[Languages]
Name: "ptbr"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"

[Messages]
ptbr.WelcomeLabel2=Este assistente vai instalar o [name/ver] no seu computador.%n%nNo fim, um atalho do LLG Overlay fica na área de trabalho.%n%nClique em Avançar para continuar.
ptbr.FinishedLabel=O [name] foi instalado.%n%nPara abrir, use o atalho "LLG Overlay" na área de trabalho.%n%nNa primeira vez o Windows pode pedir para liberar o programa no firewall: clique em Permitir.

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "limpar.ps1"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{userdesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; WorkingDir: "{app}"
Name: "{userprograms}\{#AppName}"; Filename: "{app}\{#AppExe}"; WorkingDir: "{app}"
Name: "{userprograms}\Desinstalar o {#AppName}"; Filename: "{uninstallexe}"

[Run]
Filename: "{app}\{#AppExe}"; Description: "Abrir o LLG Overlay agora"; WorkingDir: "{app}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; As atualizacoes automaticas copiam arquivos que o instalador nao conhece:
; a pasta do programa sai inteira. Ela e so do LLG Overlay (o usuario nao escolhe a pasta).
Type: filesandordirs; Name: "{app}"

[Code]
const
  PROC_NAME = '{#AppExe}';

function AppIsRunning(): Boolean;
var
  Locator, Service, Procs: Variant;
begin
  Result := False;
  try
    Locator := CreateOleObject('WbemScripting.SWbemLocator');
    Service := Locator.ConnectServer('.', 'root\CIMV2');
    Procs := Service.ExecQuery('SELECT ProcessId FROM Win32_Process WHERE Name = ''' + PROC_NAME + '''');
    Result := Procs.Count > 0;
  except
    Result := False;
  end;
end;

procedure CloseApp();
var
  Code, I: Integer;
begin
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /T /IM "' + PROC_NAME + '"', '', SW_HIDE, ewWaitUntilTerminated, Code);
  // os scripts do PowerShell que o app abre fecham sozinhos quando ele sai; da um tempo
  for I := 1 to 20 do
  begin
    if not AppIsRunning() then Break;
    Sleep(250);
  end;
  Sleep(1500);
end;

// Antes de copiar: se o app estiver aberto, avisa e fecha.
function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  if AppIsRunning() then
  begin
    if WizardSilent() or
       (MsgBox('O LLG Overlay está aberto. Ele será fechado para continuar a instalação.' + #13#10#13#10 +
               'Se estiver no meio de uma transmissão, clique em Cancelar e rode o instalador depois.',
               mbConfirmation, MB_OKCANCEL) = IDOK) then
      CloseApp()
    else
      Result := 'Feche o LLG Overlay e rode o instalador de novo.';
  end;
end;

function InitializeUninstall(): Boolean;
begin
  Result := True;
  if AppIsRunning() then
  begin
    if UninstallSilent() or
       (MsgBox('O LLG Overlay está aberto. Ele será fechado para continuar a desinstalação.',
               mbConfirmation, MB_OKCANCEL) = IDOK) then
      CloseApp()
    else
      Result := False;
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Code: Integer;
  DataDir: String;
begin
  if CurUninstallStep = usUninstall then
  begin
    // antes de apagar os arquivos: tira o app do Assetto Corsa e as sobras das atualizacoes
    Exec('powershell.exe',
         '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + ExpandConstant('{app}\limpar.ps1') + '"',
         '', SW_HIDE, ewWaitUntilTerminated, Code);
  end;

  if CurUninstallStep = usPostUninstall then
  begin
    DataDir := ExpandConstant('{userappdata}\{#AppName}');
    if DirExists(DataDir) and not UninstallSilent() then
      if MsgBox('Apagar também as suas configurações do LLG Overlay?' + #13#10#13#10 +
                '(chave de acesso, temporada, posição das overlays, ajustes do painel)' + #13#10#13#10 +
                'Clique em Não se pretende instalar de novo e quer manter tudo como está.',
                mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
        DelTree(DataDir, True, True, True);
  end;
end;
