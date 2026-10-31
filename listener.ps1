# listener.ps1
#
# Le a Shared Memory do AMS2 ($pcars2$, mesma usada por SimHub/CrewChief)
# usando os metodos prontos do .NET (MemoryMappedFile / MemoryMappedViewAccessor)
# -- sem precisar escrever C# ou usar addons nativos.
#
# Os offsets abaixo vem da struct oficial (SharedMemory_AMS2.h) que a Reiza
# distribui junto do jogo. Le a cada ~130ms e manda o resultado (em JSON) pro
# servidor Node via TCP, com um prefixo de 4 bytes indicando o tamanho.
#
# A cada ciclo a Shared Memory inteira e copiada para um buffer local, e a
# copia so e aceita se o numero de sequencia do jogo nao mudou durante a
# copia (ver Read-Snapshot). Todos os campos sao lidos dessa copia, entao um
# ciclo nunca mistura dados de dois instantes diferentes.

param(
    [string]$MapName = '$pcars2$',
    [string]$BridgeHost = "127.0.0.1",
    [int]$BridgePort = 5607,
    # pausa entre leituras; cada ciclo leva essa pausa + ~30 ms de trabalho
    [int]$IntervalMs = 100,
    # PID do aplicativo que iniciou este script. Se ele fechar (ou travar),
    # o script encerra sozinho em vez de ficar rodando escondido.
    [int]$ParentPid = 0
)

$mapName = $MapName

# Prioridade abaixo do normal: com a CPU disputada, o Windows atende o jogo
# primeiro e este script usa so o que sobra (menos engasgo em PC mais fraco).
try { (Get-Process -Id $PID).PriorityClass = [System.Diagnostics.ProcessPriorityClass]::BelowNormal } catch {}
$bridgeHost = $BridgeHost
$bridgePort = $BridgePort

# Offsets (em bytes) dentro da Shared Memory:
$OFFSET_SEQUENCE_NUMBER          = 7320  # uint, impar enquanto o jogo esta escrevendo
# clima (logo antes do numero de sequencia)
$OFFSET_AMBIENT_TEMP             = 7292  # float, graus Celsius
$OFFSET_TRACK_TEMP               = 7296  # float, graus Celsius
$OFFSET_RAIN_DENSITY             = 7300  # float, 0 a 1
# sessao (AMS2): duracao programada e voltas extras depois do tempo acabar
$OFFSET_SESSION_DURATION         = 20576 # float, minutos (0 = corrida por voltas)
$OFFSET_SESSION_ADDITIONAL_LAPS  = 20580 # int
$OFFSET_SESSION_STATE            = 12
$OFFSET_VIEWED_PARTICIPANT_INDEX = 20
$OFFSET_NUM_PARTICIPANTS         = 24
$OFFSET_EVENT_TIME_REMAINING     = 6740  # float -- o header diz "milli-seconds" mas o valor observado bate mais com SEGUNDOS; ajustando com base no teste
$OFFSET_PARTICIPANT_INFO_START   = 28
$PARTICIPANT_INFO_SIZE           = 100   # sizeof(ParticipantInfo)
$OFFSET_SPLIT_TIME_AHEAD         = 6728  # float, so do carro local/viewed
$OFFSET_FASTEST_LAP_TIMES        = 8944  # float[64]
$OFFSET_LAST_LAP_TIMES           = 9200  # float[64]
$OFFSET_RACE_STATES              = 9520  # uint[64]
$OFFSET_PIT_MODES                = 9776  # uint[64]
$OFFSET_SPEEDS                   = 10800 # float[64]
$OFFSET_CAR_NAMES                = 11056 # char[64][64]
$OFFSET_CAR_CLASS_NAMES          = 15152 # char[64][64]
$OFFSET_TRACK_LENGTH             = 6704  # float, metros (unico, nao por participante)
$OFFSET_LAPS_IN_EVENT            = 6572  # uint, total de voltas (0 = corrida por tempo)
$OFFSET_TRACK_LOCATION           = 6576  # char[64] mTrackLocation
$OFFSET_TRACK_VARIATION          = 6640  # char[64] mTrackVariation
$OFFSET_FUEL_LEVEL               = 6840  # float 0-1, so local
$OFFSET_FUEL_CAPACITY            = 6844  # float litros, so local
$OFFSET_TYRE_COMPOUND            = 19388 # char[4][40], so local
$OFFSET_CUR_SECTOR1              = 7408  # float[64]
$OFFSET_CUR_SECTOR2              = 7664
$OFFSET_CUR_SECTOR3              = 7920
$OFFSET_FAST_SECTOR1             = 8176  # float[64]
$OFFSET_FAST_SECTOR2             = 8432
$OFFSET_FAST_SECTOR3             = 8688
$OFFSET_PIT_SCHEDULES            = 19548 # uint[64]: 5 = drive-through, 6 = stop & go (punicoes de cada carro)
$OFFSET_FLAG_COLOURS             = 19804 # uint[64]
$OFFSET_FLAG_REASONS             = 20060 # uint[64]
$OFFSET_LAPS_INVALIDATED         = 9456  # bool[64]

# Car telemetry (viewed only)
$OFFSET_UNFILTERED_THROTTLE      = 6428
$OFFSET_UNFILTERED_BRAKE         = 6432
$OFFSET_UNFILTERED_STEERING      = 6436
$OFFSET_UNFILTERED_CLUTCH        = 6440
$OFFSET_CAR_NAME                 = 6444
$OFFSET_CAR_CLASS_NAME           = 6508
$OFFSET_CAR_FLAGS                = 6816
$OFFSET_OIL_TEMP                 = 6820
$OFFSET_OIL_PRESSURE             = 6824
$OFFSET_WATER_TEMP               = 6828
$OFFSET_WATER_PRESSURE           = 6832
$OFFSET_FUEL_PRESSURE            = 6836
$OFFSET_SPEED                    = 6848
$OFFSET_RPM                      = 6852
$OFFSET_MAX_RPM                  = 6856
$OFFSET_BRAKE                    = 6860
$OFFSET_THROTTLE                 = 6864
$OFFSET_CLUTCH                   = 6868
$OFFSET_STEERING                 = 6872
$OFFSET_GEAR                     = 6876
$OFFSET_NUM_GEARS                = 6880
$OFFSET_ODOMETER                 = 6884
$OFFSET_ABS_ACTIVE               = 6888
$OFFSET_BOOST_ACTIVE             = 6900
$OFFSET_BOOST_AMOUNT             = 6904
$OFFSET_ORIENTATION              = 6908
$OFFSET_LOCAL_VELOCITY           = 6920
$OFFSET_LOCAL_ACCEL              = 6956
$OFFSET_TYRE_FLAGS               = 6992
$OFFSET_TERRAIN                  = 7008
$OFFSET_TYRE_RPS                 = 7040
$OFFSET_TYRE_TEMP                = 7072
$OFFSET_TYRE_WEAR                = 7136
$OFFSET_BRAKE_DAMAGE             = 7152
$OFFSET_SUSP_DAMAGE              = 7168
$OFFSET_BRAKE_TEMP               = 7184
$OFFSET_TYRE_TREAD_TEMP          = 7200
$OFFSET_TYRE_LAYER_TEMP          = 7216
$OFFSET_TYRE_CARCASS_TEMP        = 7232
$OFFSET_TYRE_RIM_TEMP            = 7248
$OFFSET_TYRE_AIR_TEMP            = 7264
$OFFSET_CRASH_STATE              = 7280
$OFFSET_AERO_DAMAGE              = 7284
$OFFSET_ENGINE_DAMAGE            = 7288
$OFFSET_SUSP_TRAVEL              = 7340
$OFFSET_SUSP_VELOCITY            = 7356
$OFFSET_AIR_PRESSURE             = 7372
$OFFSET_ENGINE_SPEED             = 7388
$OFFSET_ENGINE_TORQUE            = 7392
$OFFSET_WINGS                    = 7396
$OFFSET_HANDBRAKE                = 7404
$OFFSET_BRAKE_BIAS               = 19380
$OFFSET_TURBO_BOOST              = 19384
$OFFSET_TYRE_TEMP_LEFT           = 20584
$OFFSET_TYRE_TEMP_CENTER         = 20600
$OFFSET_TYRE_TEMP_RIGHT          = 20616
$OFFSET_DRS_STATE                = 20632
$OFFSET_RIDE_HEIGHT              = 20636
$OFFSET_ABS_SETTING              = 20660
$OFFSET_TC_SETTING               = 20664
$OFFSET_ERS_MODE                 = 20668
$OFFSET_ERS_AUTO                 = 20672
$OFFSET_CLUTCH_TEMP              = 20676
$OFFSET_CLUTCH_WEAR              = 20680
$OFFSET_CLUTCH_OVERHEATED        = 20684
$OFFSET_CLUTCH_SLIPPING          = 20685
$OFFSET_LAUNCH_STAGE             = 20696

$SESSION_LABELS = @{ 0="INVALIDA"; 1="TREINO LIVRE"; 2="TESTE"; 3="CLASSIFICACAO"; 4="VOLTA DE FORMACAO"; 5="CORRIDA"; 6="TIME ATTACK" }

$maxSpeedKmh = @{}

function Read-CString($src, $offset, $maxLen) {
    $bytes = New-Object byte[] $maxLen
    [Array]::Copy($src, $offset, $bytes, 0, $maxLen)
    $nullIndex = [Array]::IndexOf($bytes, [byte]0)
    if ($nullIndex -lt 0) { $nullIndex = $maxLen }
    if ($nullIndex -le 0) { return "" }
    $slice = New-Object byte[] $nullIndex
    [Array]::Copy($bytes, 0, $slice, 0, $nullIndex)
    try {
        $utf8 = New-Object System.Text.UTF8Encoding $false, $true
        return $utf8.GetString($slice)
    } catch {
        return [System.Text.Encoding]::GetEncoding(1252).GetString($slice)
    }
}

function Read-Float4($src, $off) {
    return @(
        [math]::Round([BitConverter]::ToSingle($src, $off), 3),
        [math]::Round([BitConverter]::ToSingle($src, $off + 4), 3),
        [math]::Round([BitConverter]::ToSingle($src, $off + 8), 3),
        [math]::Round([BitConverter]::ToSingle($src, $off + 12), 3)
    )
}
function Read-UInt4($src, $off) {
    return @(
        [int][BitConverter]::ToUInt32($src, $off),
        [int][BitConverter]::ToUInt32($src, $off + 4),
        [int][BitConverter]::ToUInt32($src, $off + 8),
        [int][BitConverter]::ToUInt32($src, $off + 12)
    )
}
function Read-Vec3($src, $off) {
    return @(
        [math]::Round([BitConverter]::ToSingle($src, $off), 4),
        [math]::Round([BitConverter]::ToSingle($src, $off + 4), 4),
        [math]::Round([BitConverter]::ToSingle($src, $off + 8), 4)
    )
}

# Mapeamento aberto uma unica vez e reaproveitado entre os ciclos.
$script:mmf = $null
$script:view = $null
$script:snapshot = $null
$script:lastSeq = $null
$script:lastSeqChange = [DateTime]::UtcNow
$script:sentSeq = -1 # sequencia do ultimo envio (ver o loop principal)
$script:sentAt = [DateTime]::MinValue
$script:tornCycles = 0
$script:tornWarned = $false

function Close-SharedMemory {
    if ($script:view) { $script:view.Dispose() }
    if ($script:mmf) { $script:mmf.Dispose() }
    $script:view = $null
    $script:mmf = $null
    $script:lastSeq = $null
}

# Copia a Shared Memory para $script:snapshot. Devolve $true quando a copia
# pode ser usada. O jogo incrementa o numero de sequencia no inicio e no fim
# de cada escrita: impar = escrevendo agora; diferente antes/depois da copia
# = o jogo escreveu no meio. Nos dois casos a copia e refeita.
function Read-Snapshot {
    if (-not $script:view) {
        $script:mmf = [System.IO.MemoryMappedFiles.MemoryMappedFile]::OpenExisting($mapName)
        $script:view = $script:mmf.CreateViewAccessor(0, 0)
        $script:snapshot = New-Object byte[] ([int]$script:view.Capacity)
        $script:lastSeq = $null
        $script:lastSeqChange = [DateTime]::UtcNow
    }

    $consistent = $false
    $seq = 0
    for ($attempt = 0; $attempt -lt 10; $attempt++) {
        $seq = $script:view.ReadUInt32($OFFSET_SEQUENCE_NUMBER)
        [void]$script:view.ReadArray(0, $script:snapshot, 0, $script:snapshot.Length)
        $seqAfter = $script:view.ReadUInt32($OFFSET_SEQUENCE_NUMBER)
        if ((($seq -band 1) -eq 0) -and ($seq -eq $seqAfter)) { $consistent = $true; break }
        [System.Threading.Thread]::SpinWait(5000)
    }

    # Nosso handle mantem o mapeamento vivo mesmo com o jogo fechado. Se o
    # numero de sequencia parou por 5 s, fecha e reabre: com o jogo fechado a
    # reabertura falha e caimos no aviso de "sem dados", como antes.
    $now = [DateTime]::UtcNow
    if ($script:lastSeq -ne $seq) {
        $script:lastSeq = $seq
        $script:lastSeqChange = $now
    } elseif (($now - $script:lastSeqChange).TotalSeconds -ge 5) {
        Close-SharedMemory
    }

    if ($consistent) {
        $script:tornCycles = 0
        return $true
    }
    # Nao deveria acontecer. Pula alguns ciclos; se persistir, usa a copia
    # mesmo assim (comportamento antigo) em vez de deixar a overlay sem dados.
    $script:tornCycles++
    if ($script:tornCycles -lt 10) { return $false }
    if (-not $script:tornWarned) {
        $script:tornWarned = $true
        Write-Host "Aviso: numero de sequencia da Shared Memory nao estabiliza; usando leitura sem verificacao."
    }
    return $true
}

$lastSessionKey = $null
$lastNoDataMsg = $null

# ---- Assetto Corsa Competizione ----
# Os dados do ACC nao passam por aqui (o servidor fala direto com a API de
# transmissao do jogo). Mas o servidor precisa saber QUANDO ha uma sessao
# aberta, porque o ACC le um pedido de conexao de cada vez, bem devagar, e nao
# pode receber pedidos repetidos. O estado esta na Shared Memory do ACC
# (Local\acpmf_graphics, campo status: 0 = fora de sessao), entao este
# listener, que ja esta sempre rodando, avisa o servidor quando ele muda.
$script:accLive = $null
$script:accCheckedAt = [DateTime]::MinValue
$script:accSentAt = [DateTime]::MinValue

function Test-AccLive {
    try {
        $m = [System.IO.MemoryMappedFiles.MemoryMappedFile]::OpenExisting('Local\acpmf_graphics')
        $v = $m.CreateViewAccessor(0, 16, [System.IO.MemoryMappedFiles.MemoryMappedFileAccess]::Read)
        $status = $v.ReadInt32(4)
        $v.Dispose(); $m.Dispose()
        return ($status -gt 0)
    } catch {
        return $false   # jogo fechado
    }
}

# ---- Assetto Corsa (o primeiro) ----
# Usa os MESMOS nomes de Shared Memory do ACC, entao o que diz qual dos dois
# esta aberto e o processo (acs.exe). Os carros chegam ao servidor pelo app
# Python do jogo (ac-app/LLGOverlay); daqui vao a sessao atual, o tempo
# restante e o numero de voltas, que o app nao tem como ler.
$script:ac1Running = $false
$script:ac1ProcAt = [DateTime]::MinValue
$script:ac1SentAt = [DateTime]::MinValue

function Test-Ac1Running {
    $now = [DateTime]::UtcNow
    if (($now - $script:ac1ProcAt).TotalSeconds -ge 3) {
        $script:ac1ProcAt = $now
        $script:ac1Running = [bool](Get-Process -Name acs -ErrorAction SilentlyContinue)
    }
    return $script:ac1Running
}

function Send-Json($stream, $json) {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $len = [BitConverter]::GetBytes([int32]$bytes.Length)
    if ([BitConverter]::IsLittleEndian) { [Array]::Reverse($len) }
    $stream.Write($len, 0, 4)
    $stream.Write($bytes, 0, $bytes.Length)
}

function Send-Ac1Status($stream) {
    $now = [DateTime]::UtcNow
    if (($now - $script:ac1SentAt).TotalMilliseconds -lt 200) { return }
    $script:ac1SentAt = $now
    try {
        $m = [System.IO.MemoryMappedFiles.MemoryMappedFile]::OpenExisting('Local\acpmf_graphics')
        $v = $m.CreateViewAccessor(0, 176, [System.IO.MemoryMappedFiles.MemoryMappedFileAccess]::Read)
        $status = $v.ReadInt32(4)
        $session = $v.ReadInt32(8)
        $left = [double]$v.ReadSingle(152)
        $laps = $v.ReadInt32(172)
        $v.Dispose(); $m.Dispose()
        $timed = 0
        try {
            $m = [System.IO.MemoryMappedFiles.MemoryMappedFile]::OpenExisting('Local\acpmf_static')
            $v = $m.CreateViewAccessor(0, 604, [System.IO.MemoryMappedFiles.MemoryMappedFileAccess]::Read)
            $timed = $v.ReadInt32(596)
            $v.Dispose(); $m.Dispose()
        } catch { }
        if ([double]::IsNaN($left) -or [double]::IsInfinity($left) -or $left -lt 0 -or $left -gt 4e9) { $left = 0.0 }
        $json = '{"acStatus":{"status":' + $status + ',"session":' + $session + ',"timeLeftMs":' + [long][math]::Round($left) + ',"laps":' + $laps + ',"timed":' + $(if ($timed -ne 0) { 'true' } else { 'false' }) + '}}'
    } catch {
        return   # jogo fechando
    }
    Send-Json $stream $json
}

function Send-AccStatus($stream) {
    # o Assetto Corsa 1 esta aberto, nao o ACC
    if (Test-Ac1Running) { Send-Ac1Status $stream }
    $now = [DateTime]::UtcNow
    if (($now - $script:accCheckedAt).TotalMilliseconds -lt 400) { return }
    $script:accCheckedAt = $now
    $live = $(if ($script:ac1Running) { $false } else { Test-AccLive })
    # manda quando muda, e repete a cada 3 s para o servidor nao perder o estado
    if ($live -eq $script:accLive -and ($now - $script:accSentAt).TotalSeconds -lt 3) { return }
    $script:accLive = $live
    $script:accSentAt = $now
    $json = '{"accStatus":{"live":' + $(if ($live) { 'true' } else { 'false' }) + '}}'
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $len = [BitConverter]::GetBytes([int32]$bytes.Length)
    if ([BitConverter]::IsLittleEndian) { [Array]::Reverse($len) }
    $stream.Write($len, 0, 4)
    $stream.Write($bytes, 0, $bytes.Length)
}

Write-Host "Bridge (Shared Memory) iniciando..."

while ($true) {
    if ($ParentPid -gt 0 -and -not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) {
        Write-Host "Aplicativo fechado, encerrando o listener."
        exit
    }
    try {
        $tcp = New-Object System.Net.Sockets.TcpClient($bridgeHost, $bridgePort)
        $stream = $tcp.GetStream()
        Write-Host "Conectado ao servidor Node."

        while ($tcp.Connected) {
            try {
                Send-AccStatus $stream
                if (-not (Read-Snapshot)) {
                    Start-Sleep -Milliseconds 20
                    continue
                }
                # o jogo nao escreveu nada novo (menu, pausa): nao refaz o trabalho;
                # manda de novo so 1x por segundo, para o servidor saber que o jogo esta aberto
                if ($script:lastSeq -eq $script:sentSeq -and ([DateTime]::UtcNow - $script:sentAt).TotalMilliseconds -lt 1000) {
                    Start-Sleep -Milliseconds $IntervalMs
                    continue
                }
                $buf = $script:snapshot

                $numParticipants = [BitConverter]::ToInt32($buf, $OFFSET_NUM_PARTICIPANTS)
                $viewedIndex = [BitConverter]::ToInt32($buf, $OFFSET_VIEWED_PARTICIPANT_INDEX)
                $sessionState = [BitConverter]::ToUInt32($buf, $OFFSET_SESSION_STATE)
                $timeRemainingSec = [int][BitConverter]::ToSingle($buf, $OFFSET_EVENT_TIME_REMAINING)
                $trackLength = [BitConverter]::ToSingle($buf, $OFFSET_TRACK_LENGTH)
                $lapsInEvent = [BitConverter]::ToUInt32($buf, $OFFSET_LAPS_IN_EVENT)
                $trackLocation = Read-CString $buf $OFFSET_TRACK_LOCATION 64
                $trackVariation = Read-CString $buf $OFFSET_TRACK_VARIATION 64
                $splitAhead = [BitConverter]::ToSingle($buf, $OFFSET_SPLIT_TIME_AHEAD)
                $inRace = ($sessionState -eq 5)
                if ($numParticipants -gt 64) { $numParticipants = 64 }

                # velocidade maxima vale por sessao: zera ao trocar de sessao ou de pista
                $sessionKey = "$sessionState|$trackLocation|$trackVariation"
                if ($sessionKey -ne $lastSessionKey) {
                    $lastSessionKey = $sessionKey
                    $maxSpeedKmh.Clear()
                }

                $standings = @()
                $scOut = $false
                for ($i = 0; $i -lt $numParticipants; $i++) {
                    $base = $OFFSET_PARTICIPANT_INFO_START + ($i * $PARTICIPANT_INFO_SIZE)
                    $isActive = $buf[$base] -ne 0
                    $racePosition = [BitConverter]::ToUInt32($buf, $base + 84)

                    $carName = Read-CString $buf ($OFFSET_CAR_NAMES + ($i * 64)) 64
                    $carClass = Read-CString $buf ($OFFSET_CAR_CLASS_NAMES + ($i * 64)) 64
                    $pitMode = [BitConverter]::ToUInt32($buf, $OFFSET_PIT_MODES + ($i * 4))

                    $clsLow = if ($carClass) { $carClass.ToLower() } else { "" }
                    $cnLow = if ($carName) { $carName.ToLower() } else { "" }
                    if ($clsLow -eq "safetycar" -or $cnLow -like "*safety*") {
                        if ($isActive -and $pitMode -eq 0) { $scOut = $true }
                    }

                    if (-not $isActive -or $racePosition -eq 0) { continue }

                    $name = Read-CString $buf ($base + 1) 64
                    $currentLapDistance = [BitConverter]::ToSingle($buf, $base + 80)
                    # posicao no mundo (X e Z; o Y e a altura), para o mapa da pista
                    $worldX = [BitConverter]::ToSingle($buf, $base + 68)
                    $worldZ = [BitConverter]::ToSingle($buf, $base + 76)
                    $lapsCompleted = [BitConverter]::ToUInt32($buf, $base + 88)
                    $currentLap = [BitConverter]::ToUInt32($buf, $base + 92)
                    $currentSector = [BitConverter]::ToInt32($buf, $base + 96)

                    $fastestLap = [BitConverter]::ToSingle($buf, $OFFSET_FASTEST_LAP_TIMES + ($i * 4))
                    $lastLap = [BitConverter]::ToSingle($buf, $OFFSET_LAST_LAP_TIMES + ($i * 4))
                    $speed = [BitConverter]::ToSingle($buf, $OFFSET_SPEEDS + ($i * 4))
                    $raceState = [BitConverter]::ToUInt32($buf, $OFFSET_RACE_STATES + ($i * 4))
                    $s1 = [BitConverter]::ToSingle($buf, $OFFSET_CUR_SECTOR1 + ($i * 4))
                    $s2 = [BitConverter]::ToSingle($buf, $OFFSET_CUR_SECTOR2 + ($i * 4))
                    $s3 = [BitConverter]::ToSingle($buf, $OFFSET_CUR_SECTOR3 + ($i * 4))
                    $fs1 = [BitConverter]::ToSingle($buf, $OFFSET_FAST_SECTOR1 + ($i * 4))
                    $fs2 = [BitConverter]::ToSingle($buf, $OFFSET_FAST_SECTOR2 + ($i * 4))
                    $fs3 = [BitConverter]::ToSingle($buf, $OFFSET_FAST_SECTOR3 + ($i * 4))
                    $flagColour = [BitConverter]::ToUInt32($buf, $OFFSET_FLAG_COLOURS + ($i * 4))
                    $flagReason = [BitConverter]::ToUInt32($buf, $OFFSET_FLAG_REASONS + ($i * 4))
                    $pitSchedule = [BitConverter]::ToUInt32($buf, $OFFSET_PIT_SCHEDULES + ($i * 4))
                    $lapInvalid = $buf[$OFFSET_LAPS_INVALIDATED + $i] -ne 0

                    if ($inRace -and $raceState -eq 0) { continue }
                    if ($inRace -and [int]$lapsCompleted -eq 0 -and ($pitMode -eq 4 -or $pitMode -eq 2)) { continue }
                    if ($clsLow -eq "safetycar" -or $cnLow -like "*safety*") { continue }

                    $speedKmh = [math]::Round($speed * 3.6, 1)
                    if (-not $maxSpeedKmh.ContainsKey($name) -or $speedKmh -gt $maxSpeedKmh[$name]) {
                        $maxSpeedKmh[$name] = $speedKmh
                    }

                    $entry = [PSCustomObject]@{
                        slot          = $i   # indice do participante na Shared Memory
                        position      = [int]$racePosition
                        name          = $name
                        carName       = $carName
                        carClass      = $carClass
                        lapsCompleted = [int]$lapsCompleted
                        currentLap    = [int]$currentLap
                        lapDistance   = [math]::Round([double]$currentLapDistance, 1)
                        worldX        = [math]::Round([double]$worldX, 1)
                        worldZ        = [math]::Round([double]$worldZ, 1)
                        totalDistance = ([double]$lapsCompleted * $trackLength) + $currentLapDistance
                        lastLapMs     = if ($lastLap -gt 0) { [int]($lastLap * 1000) } else { $null }
                        fastestLapMs  = if ($fastestLap -gt 0) { [int]($fastestLap * 1000) } else { $null }
                        speedKmh      = $speedKmh
                        speedMs       = [math]::Round($speed, 2)
                        maxSpeedKmh   = $maxSpeedKmh[$name]
                        isPlayer      = ($i -eq $viewedIndex)
                        pitMode       = [int]$pitMode
                        raceState     = [int]$raceState
                        inRace        = $inRace
                        sector1Ms     = if ($s1 -gt 0) { [int]($s1 * 1000) } else { $null }
                        sector2Ms     = if ($s2 -gt 0) { [int]($s2 * 1000) } else { $null }
                        sector3Ms     = if ($s3 -gt 0) { [int]($s3 * 1000) } else { $null }
                        currentSector = [int]$currentSector
                        bestSector1Ms = if ($fs1 -gt 0) { [int]($fs1 * 1000) } else { $null }
                        bestSector2Ms = if ($fs2 -gt 0) { [int]($fs2 * 1000) } else { $null }
                        bestSector3Ms = if ($fs3 -gt 0) { [int]($fs3 * 1000) } else { $null }
                        flagColour    = [int]$flagColour
                        flagReason    = [int]$flagReason
                        # Flag 6=YELLOW 7=DOUBLE_YELLOW. SM marca todos no mini-setor;
                        # so carros lentos/parados (<40 km/h) como proxy do causador.
                        causedYellow  = (($flagColour -eq 6 -or $flagColour -eq 7) -and $speedKmh -lt 40)
                        lapInvalidated = [bool]$lapInvalid
                        # punicao pendente do carro (o 7, vaga do box ocupada, nao e punicao)
                        penaltyType   = if ($pitSchedule -eq 5) { "driveThrough" } elseif ($pitSchedule -eq 6) { "stopGo" } else { $null }
                    }
                    if ($i -eq $viewedIndex) {
                        if ($splitAhead -ge 0) {
                            $entry | Add-Member -NotePropertyName splitAhead -NotePropertyValue ([math]::Round($splitAhead, 2))
                        }
                        $fuelLevel = [BitConverter]::ToSingle($buf, $OFFSET_FUEL_LEVEL)
                        $fuelCap = [BitConverter]::ToSingle($buf, $OFFSET_FUEL_CAPACITY)
                        $tyre = Read-CString $buf $OFFSET_TYRE_COMPOUND 40
                        $entry | Add-Member -NotePropertyName fuelPct -NotePropertyValue ([math]::Round($fuelLevel * 100, 1))
                        if ($fuelCap -gt 0) {
                            $entry | Add-Member -NotePropertyName fuelL -NotePropertyValue ([math]::Round($fuelLevel * $fuelCap, 1))
                        }
                        if ($tyre) {
                            $entry | Add-Member -NotePropertyName tyreCompound -NotePropertyValue $tyre
                        }
                    }
                    $standings += $entry
                }

                $car = [PSCustomObject]@{
                    carName        = Read-CString $buf $OFFSET_CAR_NAME 64
                    carClass       = Read-CString $buf $OFFSET_CAR_CLASS_NAME 64
                    throttle       = [math]::Round([BitConverter]::ToSingle($buf, $OFFSET_THROTTLE), 3)
                    brake          = [math]::Round([BitConverter]::ToSingle($buf, $OFFSET_BRAKE), 3)
                    clutch         = [math]::Round([BitConverter]::ToSingle($buf, $OFFSET_CLUTCH), 3)
                    steering       = [math]::Round([BitConverter]::ToSingle($buf, $OFFSET_STEERING), 3)
                    handbrake      = [math]::Round([BitConverter]::ToSingle($buf, $OFFSET_HANDBRAKE), 3)
                    unfThrottle    = [math]::Round([BitConverter]::ToSingle($buf, $OFFSET_UNFILTERED_THROTTLE), 3)
                    unfBrake       = [math]::Round([BitConverter]::ToSingle($buf, $OFFSET_UNFILTERED_BRAKE), 3)
                    unfClutch      = [math]::Round([BitConverter]::ToSingle($buf, $OFFSET_UNFILTERED_CLUTCH), 3)
                    unfSteering    = [math]::Round([BitConverter]::ToSingle($buf, $OFFSET_UNFILTERED_STEERING), 3)
                    rpm            = [math]::Round([BitConverter]::ToSingle($buf, $OFFSET_RPM), 0)
                    maxRpm         = [math]::Round([BitConverter]::ToSingle($buf, $OFFSET_MAX_RPM), 0)
                    engineSpeed    = [math]::Round([BitConverter]::ToSingle($buf, $OFFSET_ENGINE_SPEED), 2)
                    engineTorque   = [math]::Round([BitConverter]::ToSingle($buf, $OFFSET_ENGINE_TORQUE), 1)
                    speedMs        = [math]::Round([BitConverter]::ToSingle($buf, $OFFSET_SPEED), 2)
                    speedKmh       = [math]::Round([BitConverter]::ToSingle($buf, $OFFSET_SPEED) * 3.6, 1)
                    gear           = [int][BitConverter]::ToInt32($buf, $OFFSET_GEAR)
                    numGears       = [int][BitConverter]::ToInt32($buf, $OFFSET_NUM_GEARS)
                    odometerKm     = [math]::Round([BitConverter]::ToSingle($buf, $OFFSET_ODOMETER), 2)
                    oilTempC       = [math]::Round([BitConverter]::ToSingle($buf, $OFFSET_OIL_TEMP), 1)
                    oilPressureKPa = [math]::Round([BitConverter]::ToSingle($buf, $OFFSET_OIL_PRESSURE), 1)
                    waterTempC     = [math]::Round([BitConverter]::ToSingle($buf, $OFFSET_WATER_TEMP), 1)
                    waterPressureKPa = [math]::Round([BitConverter]::ToSingle($buf, $OFFSET_WATER_PRESSURE), 1)
                    fuelPressureKPa  = [math]::Round([BitConverter]::ToSingle($buf, $OFFSET_FUEL_PRESSURE), 1)
                    fuelLevel      = [math]::Round([BitConverter]::ToSingle($buf, $OFFSET_FUEL_LEVEL), 4)
                    fuelCapacityL  = [math]::Round([BitConverter]::ToSingle($buf, $OFFSET_FUEL_CAPACITY), 1)
                    fuelPct        = [math]::Round([BitConverter]::ToSingle($buf, $OFFSET_FUEL_LEVEL) * 100, 1)
                    carFlags       = [int][BitConverter]::ToUInt32($buf, $OFFSET_CAR_FLAGS)
                    absActive      = ($buf[$OFFSET_ABS_ACTIVE] -ne 0)
                    boostActive    = ($buf[$OFFSET_BOOST_ACTIVE] -ne 0)
                    boostAmount    = [math]::Round([BitConverter]::ToSingle($buf, $OFFSET_BOOST_AMOUNT), 1)
                    turboBoost     = [math]::Round([BitConverter]::ToSingle($buf, $OFFSET_TURBO_BOOST), 3)
                    brakeBias      = [math]::Round([BitConverter]::ToSingle($buf, $OFFSET_BRAKE_BIAS), 3)
                    wings          = @(
                        [math]::Round([BitConverter]::ToSingle($buf, $OFFSET_WINGS), 3),
                        [math]::Round([BitConverter]::ToSingle($buf, $OFFSET_WINGS + 4), 3)
                    )
                    crashState     = [int][BitConverter]::ToUInt32($buf, $OFFSET_CRASH_STATE)
                    aeroDamage     = [math]::Round([BitConverter]::ToSingle($buf, $OFFSET_AERO_DAMAGE), 3)
                    engineDamage   = [math]::Round([BitConverter]::ToSingle($buf, $OFFSET_ENGINE_DAMAGE), 3)
                    orientation    = Read-Vec3 $buf $OFFSET_ORIENTATION
                    localVelocity  = Read-Vec3 $buf $OFFSET_LOCAL_VELOCITY
                    localAccel     = Read-Vec3 $buf $OFFSET_LOCAL_ACCEL
                    tyreFlags      = Read-UInt4 $buf $OFFSET_TYRE_FLAGS
                    terrain        = Read-UInt4 $buf $OFFSET_TERRAIN
                    tyreRps        = Read-Float4 $buf $OFFSET_TYRE_RPS
                    tyreTemp       = Read-Float4 $buf $OFFSET_TYRE_TEMP
                    tyreTempLeft   = Read-Float4 $buf $OFFSET_TYRE_TEMP_LEFT
                    tyreTempCenter = Read-Float4 $buf $OFFSET_TYRE_TEMP_CENTER
                    tyreTempRight  = Read-Float4 $buf $OFFSET_TYRE_TEMP_RIGHT
                    tyreWear       = Read-Float4 $buf $OFFSET_TYRE_WEAR
                    tyreTreadTemp  = Read-Float4 $buf $OFFSET_TYRE_TREAD_TEMP
                    tyreLayerTemp  = Read-Float4 $buf $OFFSET_TYRE_LAYER_TEMP
                    tyreCarcassTemp = Read-Float4 $buf $OFFSET_TYRE_CARCASS_TEMP
                    tyreRimTemp    = Read-Float4 $buf $OFFSET_TYRE_RIM_TEMP
                    tyreAirTemp    = Read-Float4 $buf $OFFSET_TYRE_AIR_TEMP
                    airPressurePsi = Read-Float4 $buf $OFFSET_AIR_PRESSURE
                    brakeTempC     = Read-Float4 $buf $OFFSET_BRAKE_TEMP
                    brakeDamage    = Read-Float4 $buf $OFFSET_BRAKE_DAMAGE
                    suspDamage     = Read-Float4 $buf $OFFSET_SUSP_DAMAGE
                    suspTravel     = Read-Float4 $buf $OFFSET_SUSP_TRAVEL
                    suspVelocity   = Read-Float4 $buf $OFFSET_SUSP_VELOCITY
                    rideHeightCm   = Read-Float4 $buf $OFFSET_RIDE_HEIGHT
                    tyreCompound   = @(
                        (Read-CString $buf $OFFSET_TYRE_COMPOUND 40),
                        (Read-CString $buf ($OFFSET_TYRE_COMPOUND + 40) 40),
                        (Read-CString $buf ($OFFSET_TYRE_COMPOUND + 80) 40),
                        (Read-CString $buf ($OFFSET_TYRE_COMPOUND + 120) 40)
                    )
                    drsState       = [int][BitConverter]::ToUInt32($buf, $OFFSET_DRS_STATE)
                    absSetting     = [int][BitConverter]::ToInt32($buf, $OFFSET_ABS_SETTING)
                    tcSetting      = [int][BitConverter]::ToInt32($buf, $OFFSET_TC_SETTING)
                    ersMode        = [int][BitConverter]::ToInt32($buf, $OFFSET_ERS_MODE)
                    ersAuto        = ($buf[$OFFSET_ERS_AUTO] -ne 0)
                    clutchTempK    = [math]::Round([BitConverter]::ToSingle($buf, $OFFSET_CLUTCH_TEMP), 1)
                    clutchWear     = [math]::Round([BitConverter]::ToSingle($buf, $OFFSET_CLUTCH_WEAR), 3)
                    clutchOverheated = ($buf[$OFFSET_CLUTCH_OVERHEATED] -ne 0)
                    clutchSlipping = ($buf[$OFFSET_CLUTCH_SLIPPING] -ne 0)
                    launchStage    = [int][BitConverter]::ToInt32($buf, $OFFSET_LAUNCH_STAGE)
                }

                $standingsSorted = @($standings | Sort-Object position)

                $payload = [PSCustomObject]@{
                    game    = "ams2"
                    session = [PSCustomObject]@{
                        state            = [int]$sessionState
                        label            = $SESSION_LABELS[[int]$sessionState]
                        timeRemainingSec = $timeRemainingSec
                        lapsInEvent      = [int]$lapsInEvent
                        scOut            = $scOut
                        trackLocation    = $trackLocation
                        trackVariation   = $trackVariation
                        trackLength      = [math]::Round([double]$trackLength, 1)
                        ambientTempC     = [math]::Round([double][BitConverter]::ToSingle($buf, $OFFSET_AMBIENT_TEMP), 1)
                        trackTempC       = [math]::Round([double][BitConverter]::ToSingle($buf, $OFFSET_TRACK_TEMP), 1)
                        rain             = [math]::Round([double][BitConverter]::ToSingle($buf, $OFFSET_RAIN_DENSITY), 2)
                        sessionDurationMin = [math]::Round([double][BitConverter]::ToSingle($buf, $OFFSET_SESSION_DURATION), 1)
                        additionalLaps   = [int][BitConverter]::ToInt32($buf, $OFFSET_SESSION_ADDITIONAL_LAPS)
                    }
                    standings = $standingsSorted
                    car       = $car
                }
                $json = ConvertTo-Json -InputObject $payload -Compress -Depth 4

                $payloadBytes = [System.Text.Encoding]::UTF8.GetBytes($json)
                $lengthBytes = [BitConverter]::GetBytes([int32]$payloadBytes.Length)
                if ([BitConverter]::IsLittleEndian) { [Array]::Reverse($lengthBytes) }

                $stream.Write($lengthBytes, 0, 4)
                $stream.Write($payloadBytes, 0, $payloadBytes.Length)
                $script:sentSeq = $script:lastSeq
                $script:sentAt = [DateTime]::UtcNow
                if ($lastNoDataMsg) {
                    $lastNoDataMsg = $null
                    Write-Host "Recebendo dados do jogo."
                }
            }
            catch {
                Close-SharedMemory
                # avisa uma vez so (nao a cada ciclo) e espera mais antes de tentar de novo
                $msg = $_.Exception.Message
                if ($msg -ne $lastNoDataMsg) {
                    $lastNoDataMsg = $msg
                    Write-Host "Sem dados agora (jogo fechado ou no menu?):" $msg
                }
                Start-Sleep -Milliseconds 400
            }

            Start-Sleep -Milliseconds $IntervalMs
        }
    }
    catch {
        Write-Host "Bridge: sem conexao com o Node, tentando de novo em 1s..." $_.Exception.Message
        Start-Sleep -Seconds 1
    }
}
