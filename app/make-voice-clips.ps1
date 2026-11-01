# app/make-voice-clips.ps1
# Gera os audios prontos de server/voice-clips (so roda quando for refazer os
# arquivos; o app apenas toca os .wav), com as vozes neurais do edge-tts:
#   py -3.13 -m pip install --user edge-tts
# Precisa de internet e do ffmpeg, que corta o silencio das pontas e deixa o mesmo
# pico em todos. Tom mais grave, um pouco mais lento e o ponto final deixam a voz
# seria. Trocar um audio por uma gravacao: salve um .wav com o mesmo nome.
param(
    [string]$Out = (Join-Path $PSScriptRoot "..\server\voice-clips"),
    [string]$Voice = "pt-BR-AntonioNeural",
    [string]$Rate = "-6%",
    [string]$Pitch = "-10Hz"
)

$tres = "tr" + [char]0xEA + "s"
$clips = [ordered]@{
    "sc"          = "Safety Car."
    "fcy-in"      = "Full Course Yellow in"
    "fcy-in-20"   = "Full Course Yellow in 20."
    "fcy"         = "Full Course Yellow."
    "green"       = "Bandeira Verde."
    "sc-in"       = "Safety Car, nessa volta."
    "green-in-15" = "15 segundos para verde."
    "10" = "dez."; "9" = "nove."; "8" = "oito."; "7" = "sete."; "6" = "seis."
    "5" = "cinco."; "4" = "quatro."; "3" = "$tres."; "2" = "dois."; "1" = "um."
}

New-Item -ItemType Directory -Force $Out | Out-Null
$temp = Join-Path $env:TEMP "llg-clip.mp3"
$culture = [Globalization.CultureInfo]::InvariantCulture
foreach ($name in $clips.Keys) {
    & py -3.13 -m edge_tts --voice $Voice "--rate=$Rate" "--pitch=$Pitch" --text $clips[$name] --write-media $temp 2>$null
    if ($LASTEXITCODE -ne 0) { throw "edge-tts falhou em: $name" }
    # -60 dB e margem no fim: palavras curtas ("um") nao perdem o final
    $trim = "silenceremove=start_periods=1:start_threshold=-60dB,areverse,silenceremove=start_periods=1:start_threshold=-60dB:start_silence=0.05,areverse"
    $peak = (& ffmpeg -hide_banner -nostats -i $temp -af "$trim,volumedetect" -f null - 2>&1 | Select-String "max_volume: (-?[\d.]+)").Matches[0].Groups[1].Value
    $gain = -2 - [double]::Parse($peak, $culture)
    & ffmpeg -hide_banner -loglevel error -y -i $temp -af ("$trim,volume=" + $gain.ToString("0.00", $culture) + "dB") -ar 44100 -ac 1 -c:a pcm_s16le (Join-Path $Out "$name.wav")
}
Remove-Item $temp -ErrorAction SilentlyContinue
"gerados com ${Voice} (velocidade $Rate, tom $Pitch): " + $clips.Count
