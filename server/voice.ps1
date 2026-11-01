# server/voice.ps1
# Toca os audios prontos de server/voice-clips para server/raceVoice.js. Fica
# aberto, com os arquivos ja carregados, e le ordens pela entrada:
#   PLAY nome  corta o que estiver tocando e toca nome.wav
#   VOL n      volume de 0 a 100 (deste processo, nao o do Windows)
# Fechar a entrada (o app fechou) encerra o script. Parado, ele nao gasta CPU.
param([string]$Clips = (Join-Path $PSScriptRoot "voice-clips"))

Add-Type -Namespace LLG -Name WaveOut -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("winmm.dll")]
public static extern int waveOutSetVolume(System.IntPtr device, uint volume);
'@

$players = @{}
Get-ChildItem $Clips -Filter *.wav | ForEach-Object {
    $player = New-Object System.Media.SoundPlayer $_.FullName
    $player.Load()
    $players[$_.BaseName] = $player
}
[Console]::Out.WriteLine("READY " + $players.Count)

while ($null -ne ($line = [Console]::In.ReadLine())) {
    if ($line.StartsWith("VOL ")) {
        $level = [uint32]([math]::Max(0, [math]::Min(100, [int]$line.Substring(4))) * 65535 / 100)
        [void][LLG.WaveOut]::waveOutSetVolume([IntPtr]::Zero, ($level -bor ($level * 65536)))
    } elseif ($line.StartsWith("PLAY ")) {
        $player = $players[$line.Substring(5)]
        # tocar um audio corta o anterior: sao todos do mesmo processo
        if ($player) { $player.Play() }
    }
}
