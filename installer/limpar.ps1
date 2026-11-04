# installer/limpar.ps1
# Roda no desinstalador (escondido), antes de apagar a pasta do programa.
# Desfaz o que o LLG Overlay instala fora da propria pasta:
#   - o app do Assetto Corsa (apps\python\LLGOverlay na pasta do jogo, em
#     qualquer biblioteca da Steam) e a secao [LLGOVERLAY] do python.ini
#     (ver server/acInstaller.js)
#   - as pastas temporarias da atualizacao automatica (app/updater.js)
# Nao toca nos carsets instalados no AMS2: sao conteudo do usuario.
# Erros sao ignorados: a desinstalacao nunca para por causa deste script.

$ErrorActionPreference = 'SilentlyContinue'

# --- bibliotecas da Steam
$libs = @()
$steam = (Get-ItemProperty 'HKCU:\Software\Valve\Steam').SteamPath
if ($steam) { $libs += $steam }
$libs += (Join-Path ${env:ProgramFiles(x86)} 'Steam')
foreach ($s in @($libs)) {
  $vdf = Join-Path $s 'steamapps\libraryfolders.vdf'
  if (Test-Path $vdf) {
    foreach ($m in [regex]::Matches((Get-Content $vdf -Raw), '"path"\s+"((?:[^"\\]|\\.)*)"')) {
      $libs += $m.Groups[1].Value.Replace('\\', '\')
    }
  }
}

# --- app do Assetto Corsa
foreach ($lib in ($libs | Select-Object -Unique)) {
  $dir = Join-Path $lib 'steamapps\common\assettocorsa\apps\python\LLGOverlay'
  if (Test-Path $dir) { Remove-Item $dir -Recurse -Force }
}

$docs = [Environment]::GetFolderPath('MyDocuments')
$ini = Join-Path $docs 'Assetto Corsa\cfg\python.ini'
if (Test-Path $ini) {
  $text = [IO.File]::ReadAllText($ini)
  $new = [regex]::Replace($text, '(?im)^[ \t]*\[LLGOVERLAY\][^\[]*', '')
  if ($new -ne $text) { [IO.File]::WriteAllText($ini, $new.TrimEnd() + "`r`n") }
}

# --- sobras da atualizacao automatica
Get-ChildItem $env:TEMP -Directory -Filter 'llg-overlay-update-*' | Remove-Item -Recurse -Force

exit 0
