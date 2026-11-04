# server/speech.ps1
# Voz do engenheiro de pista (server/engineer.js), com as vozes do Windows: as novas
# (Daniel, voz masculina, e Maria, feminina) e, como reserva, as classicas (SAPI). A mesma
# forma do Cubic Racing Analyser (app/src/voz.rs). Fica aberto, com as vozes carregadas,
# e le ordens pela entrada (a fila fica no server/speech.js):
#   PLAY vol|rate|voz|b64    sintetiza o texto (UTF-8 em base64) e toca ja, cortando o que estiver tocando;
#                            responde "DUR ms" (quanto dura) ou "ERRO ..."
#   STOP                     para de tocar
#   VOICES                   lista as vozes: "VOICES id|nome;id|nome" (id = win:Nome ou sapi:Nome)
# Fechar a entrada (o app fechou) encerra o script. Parado, ele nao gasta CPU.
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
# prioridade acima do normal: num PC no limite o jogo nao rouba o tempo do audio (a voz nao picota)
try { (Get-Process -Id $PID).PriorityClass = [System.Diagnostics.ProcessPriorityClass]::AboveNormal } catch {}
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Speech
$sapi = New-Object System.Speech.Synthesis.SpeechSynthesizer
$winrt = $null
$asTask = $null
try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    [void][Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime]
    $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
    $winrt = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::new()
} catch { $winrt = $null }
$player = $null

function Esperar($op, $tipo) { $t = $asTask.MakeGenericMethod($tipo).Invoke($null, @($op)); [void]$t.Wait(-1); $t.Result }
function Escrever($s) { [Console]::Out.WriteLine($s); [Console]::Out.Flush() }

# WAV do texto, na voz pedida (id "win:Microsoft Daniel" ou "sapi:Microsoft Maria Desktop")
function Sintetizar([int]$vol, [int]$rate, [string]$id, [string]$texto) {
    $tipo, $nome = $id -split ':', 2
    if ($winrt -and ($tipo -eq 'win' -or -not $id)) {
        try {
            $v = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices | Where-Object { ($nome -and $_.DisplayName -eq $nome) -or (-not $nome -and $_.Language -eq 'pt-BR') } | Select-Object -First 1
            if ($v) { $winrt.Voice = $v }
            $winrt.Options.AudioVolume = [Math]::Max(0.01, $vol / 100.0)
            # -5..5 vira 0,7..1,5 (1 = normal)
            $winrt.Options.SpeakingRate = [Math]::Max(0.5, [Math]::Min(2.0, 1.0 + $rate * ($(if ($rate -lt 0) { 0.06 } else { 0.1 }))))
            $stream = Esperar ($winrt.SynthesizeTextToStreamAsync($texto)) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])
            $ms = New-Object System.IO.MemoryStream
            [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($stream).CopyTo($ms)
            return $ms
        } catch { }
    }
    $v = $sapi.GetInstalledVoices() | Where-Object { $_.Enabled -and ($_.VoiceInfo.Name -eq $nome) } | Select-Object -First 1
    if (-not $v) { $v = $sapi.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -eq 'pt-BR' } | Select-Object -First 1 }
    if ($v) { $sapi.SelectVoice($v.VoiceInfo.Name) }
    $sapi.Volume = [Math]::Max(0, [Math]::Min(100, $vol))
    $sapi.Rate = [Math]::Max(-10, [Math]::Min(10, $rate))
    $ms = New-Object System.IO.MemoryStream
    $sapi.SetOutputToWaveStream($ms)
    $sapi.Speak($texto)
    $sapi.SetOutputToNull()
    return $ms
}

# duracao do WAV (ms) pelo cabecalho: bytes de audio / bytes por segundo
function Duracao($ms) {
    $b = $ms.ToArray()
    $byteRate = [BitConverter]::ToInt32($b, 28)
    $i = 12
    while ($i + 8 -le $b.Length) {
        $id = [System.Text.Encoding]::ASCII.GetString($b, $i, 4)
        $size = [BitConverter]::ToInt32($b, $i + 4)
        if ($id -eq 'data') { if ($byteRate -gt 0) { return [int](1000.0 * $size / $byteRate) } else { return 0 } }
        $i += 8 + $size
    }
    return [int](1000.0 * ($b.Length - 44) / [Math]::Max(1, $byteRate))
}

while ($null -ne ($linha = [Console]::In.ReadLine())) {
    try {
        if ($linha -eq 'VOICES') {
            $list = @()
            if ($winrt) { [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices | Where-Object { $_.Language -like 'pt*' } | ForEach-Object { $list += ('win:' + $_.DisplayName + '|' + ($_.DisplayName -replace '^Microsoft ', '') + '|' + $_.Gender) } }
            $sapi.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -like 'pt*' } | ForEach-Object { $list += ('sapi:' + $_.VoiceInfo.Name + '|' + ($_.VoiceInfo.Name -replace '^Microsoft ', '' -replace ' Desktop$', '') + '|' + $_.VoiceInfo.Gender) }
            Escrever ('VOICES ' + ($list -join ';'))
        } elseif ($linha -eq 'STOP') {
            if ($player) { $player.Stop() }
        } elseif ($linha.StartsWith('PLAY ')) {
            $p = $linha.Substring(5).Split('|', 4)
            # o texto vem em UTF-8 codificado em base64: acentos chegam intactos, seja qual for a
            # codificacao do console do Windows
            $texto = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p[3]))
            $ms = Sintetizar ([int]$p[0]) ([int]$p[1]) $p[2] $texto
            $ms.Position = 0
            $dur = Duracao $ms
            $ms.Position = 0
            if ($player) { $player.Stop() }
            $player = New-Object System.Media.SoundPlayer $ms
            $player.Play() # assincrono: uma fala nova (spotter) corta esta
            Escrever ('DUR ' + $dur)
        }
    } catch {
        Escrever ('ERRO ' + $_.Exception.Message)
    }
}
