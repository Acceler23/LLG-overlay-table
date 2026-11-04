# listener-lmu.ps1
#
# Le a Shared Memory do Le Mans Ultimate (mapeamento "LMU_Data", a interface
# oficial da Studio 397) e manda o resultado em JSON pro servidor Node via
# TCP, com um prefixo de 4 bytes indicando o tamanho -- o mesmo formato do
# listener.ps1 do AMS2. Os campos saem com os mesmos nomes e significados
# (position, pitMode, raceState, ...), entao as overlays nao precisam saber
# de qual jogo os dados vieram. O que so existe no LMU vai em campos extras:
# pneus (tyreFront/tyreRear/tyreWear) e energia virtual (virtualEnergy).
#
# Os offsets abaixo foram medidos compilando os headers oficiais
# (SharedMemoryInterface.hpp / InternalsPlugin.hpp) com offsetof(). Se uma
# atualizacao do jogo mudar as structs, eles precisam ser medidos de novo.
#
# Este script so LE a memoria. Ele nao pega a trava do jogo (para nunca
# segurar o jogo se o script travar): copia tudo e so aceita a copia se o
# indicador de "escrevendo" estava livre antes e depois.

param(
    [string]$MapName = "LMU_Data",
    [string]$BridgeHost = "127.0.0.1",
    [int]$BridgePort = 5607,
    # pausa entre leituras; cada ciclo leva essa pausa + o tempo de trabalho
    [int]$IntervalMs = 100,
    # PID do aplicativo que iniciou este script. Se ele fechar, o script encerra.
    [int]$ParentPid = 0
)

# Prioridade abaixo do normal: com a CPU disputada, o Windows atende o jogo
# primeiro e este script usa so o que sobra (menos engasgo em PC mais fraco).
try { (Get-Process -Id $PID).PriorityClass = [System.Diagnostics.ProcessPriorityClass]::BelowNormal } catch {}

# ---------------------------------------------------------------- offsets
$LAYOUT_SIZE          = 324824
$MAX_VEHICLES         = 104

# SharedMemoryScoringData
$SCORING              = 1632      # ScoringInfoV01
$SC_TRACK_NAME        = 0         # char[64]
$SC_SESSION           = 64        # long: 0=teste 1-4=treino 5-8=classificacao 9=aquecimento 10-13=corrida
$SC_CURRENT_ET        = 68        # double
$SC_END_ET            = 76        # double
$SC_MAX_LAPS          = 84        # long (2147483647 = corrida por tempo)
$SC_LAP_DIST          = 88        # double, comprimento da pista em metros
$SC_NUM_VEHICLES      = 104       # long
$SC_GAME_PHASE        = 108       # uchar: 3=volta de formacao 5=verde 6=bandeira amarela geral/safety car 8=fim
$SC_SECTOR_FLAGS      = 110       # schar[3] lido sem sinal (255 = -1, invalido): bandeira amarela local por setor; a ordem dos setores nao e documentada
$SC_TIME_REMAINING    = 340       # float, segundos
# clima (ScoringInfoV01, depois de mPlrFileName): doubles
$SC_RAINING           = 220       # 0 a 1
$SC_AMBIENT_TEMP      = 228       # graus Celsius
$SC_TRACK_TEMP        = 236       # graus Celsius

$VEH                  = 2192      # VehicleScoringInfoV01[104]
$VEH_SIZE             = 584
$V_ID                 = 0         # long, slot
$V_DRIVER_NAME        = 4         # char[32]
$V_VEHICLE_NAME       = 36        # char[64], ex: "BMW M Team WRT 2026 #15:LM"
$V_TOTAL_LAPS         = 100       # short
$V_SECTOR             = 102       # sbyte: 0=setor 3, 1=setor 1, 2=setor 2
$V_FINISH_STATUS      = 103       # sbyte: 0=nada 1=terminou 2=dnf 3=dq
$V_LAP_DIST           = 104       # double
$V_POS                = 264       # double[3] mPos: X, Y (altura), Z do mundo (mapa da pista)
$V_BEST_SECTOR1       = 128       # double
$V_BEST_SECTOR2       = 136       # double (setor 1 + setor 2)
$V_BEST_LAP           = 144       # double
$V_LAST_SECTOR2       = 160       # double (setor 1 + setor 2)
$V_LAST_LAP           = 168       # double
$V_CUR_SECTOR1        = 176       # double
$V_CUR_SECTOR2        = 184       # double (setor 1 + setor 2)
$V_NUM_PITSTOPS       = 192       # short
$V_NUM_PENALTIES      = 194       # short, punicoes pendentes
$V_IS_PLAYER          = 196       # bool
$V_IN_PITS            = 198       # bool
$V_PLACE              = 199       # uchar, posicao (1 = primeiro)
$V_VEHICLE_CLASS      = 200       # char[32], ex: "Hyper", "LMP2", "GT3"
$V_LOCAL_VEL          = 288       # double[3], m/s
$V_PIT_STATE          = 457       # uchar: 0=nada 1=pediu 2=entrando 3=parado 4=saindo
$V_COUNT_LAP_FLAG     = 506       # uchar: 2 = volta e tempo valem
$V_IN_GARAGE          = 507       # bool

# SharedMemoryTelemetryData
$TEL_ACTIVE           = 128464    # uchar, quantos TelemInfoV01 sao validos
$TEL                  = 128468    # TelemInfoV01[104]
$TEL_SIZE             = 1888
$T_ID                 = 0         # long, slot (casa com V_ID)
$T_LOCAL_VEL          = 184       # double[3] mLocalVel, m/s
$T_LOCAL_ACCEL        = 208       # double[3] mLocalAccel, m/s2 (x sai pela esquerda do carro, z para tras); logo depois de mLocalVel
$T_GEAR               = 352       # long: -1 re, 0 neutro, 1+ marchas
$T_THROTTLE           = 388       # double, 0.0 a 1.0 (pedal do piloto, sem filtro)
$T_BRAKE              = 396       # double, 0.0 a 1.0
# O acelerador da Shared Memory do LMU nao chega a 1.0 com o pedal no fundo
# (para em 0.87 a 0.98, conforme o carro). Para a barra do driver card encher,
# o valor e esticado: a partir deste ponto ja conta como pe no fundo.
$THROTTLE_FULL_AT     = 0.85
$T_FUEL               = 524       # double, litros
$T_LAST_IMPACT_ET     = 552       # double, tempo da sessao do ultimo impacto
$T_LAST_IMPACT_MAG    = 560       # double, forca do ultimo impacto (escala do jogo)
$T_FRONT_COMPOUND     = 620       # char[18], ex: "Medium"
$T_REAR_COMPOUND      = 638       # char[18]
$T_LAP_INVALIDATED    = 745       # bool
$T_VIRTUAL_ENERGY     = 776       # float, 0.0 a 1.0
$T_VEHICLE_MODEL      = 796       # char[30], ex: "BMW M Hybrid V8"
$T_WHEEL              = 848       # TelemWheelV01[4]: diant. esq, diant. dir, tras. esq, tras. dir
$WHEEL_SIZE           = 260
$W_WEAR               = 152       # double, 1.0 = novo
$W_COMPOUND_TYPE      = 241       # uchar, composto DESTA roda (os nomes acima so dizem um por eixo)
# tipo de composto por roda -> nome. O 1 (Medium) foi conferido com o jogo; os demais seguem a ordem do jogo.
$COMPOUND_TYPES = @{ 0 = "Soft"; 1 = "Medium"; 2 = "Hard"; 3 = "Wet" }

# trava do jogo (LMU_SharedMemoryLockData): { LONG waiters; LONG busy; }
$LOCK_MAP_NAME        = "LMU_SharedMemoryLockData"
$LOCK_BUSY            = 4

$SESSION_LABELS = @{ 1="TREINO LIVRE"; 2="TESTE"; 3="CLASSIFICACAO"; 4="VOLTA DE FORMACAO"; 5="CORRIDA" }

$maxSpeedKmh = @{}

function Read-CString($src, $offset, $maxLen) {
    $nullIndex = [Array]::IndexOf($src, [byte]0, $offset, $maxLen)
    $len = if ($nullIndex -lt 0) { $maxLen } else { $nullIndex - $offset }
    if ($len -le 0) { return "" }
    try {
        $utf8 = New-Object System.Text.UTF8Encoding $false, $true
        return $utf8.GetString($src, $offset, $len)
    } catch {
        return [System.Text.Encoding]::GetEncoding(1252).GetString($src, $offset, $len)
    }
}

function Seconds-ToMs($seconds) {
    if ($seconds -gt 0) { return [int][math]::Round($seconds * 1000) }
    return $null
}

# Sessao do LMU -> mesmos codigos do AMS2 (1 treino, 2 teste, 3 classificacao,
# 4 volta de formacao, 5 corrida)
function Get-SessionState($session, $gamePhase) {
    if ($session -ge 10) { if ($gamePhase -eq 3) { return 4 } else { return 5 } }
    if ($session -ge 5 -and $session -le 8) { return 3 }
    if ($session -eq 0) { return 2 }
    return 1
}

# Mapeamento aberto uma vez e reaproveitado entre os ciclos.
$script:mmf = $null
$script:view = $null
$script:lockMmf = $null
$script:lockView = $null
$script:snapshot = New-Object byte[] $LAYOUT_SIZE
$script:tornCycles = 0

function Close-SharedMemory {
    foreach ($o in @($script:view, $script:mmf, $script:lockView, $script:lockMmf)) { if ($o) { $o.Dispose() } }
    $script:view = $null; $script:mmf = $null; $script:lockView = $null; $script:lockMmf = $null
}

function Test-GameBusy {
    if (-not $script:lockView) { return $false }
    return ($script:lockView.ReadInt32($LOCK_BUSY) -ne 0)
}

# Copia a Shared Memory para $script:snapshot. Devolve $true quando a copia
# pode ser usada: ninguem estava escrevendo antes nem depois da copia.
function Read-Snapshot {
    if (-not $script:view) {
        $script:mmf = [System.IO.MemoryMappedFiles.MemoryMappedFile]::OpenExisting($MapName, [System.IO.MemoryMappedFiles.MemoryMappedFileRights]::Read)
        $script:view = $script:mmf.CreateViewAccessor(0, $LAYOUT_SIZE, [System.IO.MemoryMappedFiles.MemoryMappedFileAccess]::Read)
        try {
            $script:lockMmf = [System.IO.MemoryMappedFiles.MemoryMappedFile]::OpenExisting($LOCK_MAP_NAME, [System.IO.MemoryMappedFiles.MemoryMappedFileRights]::Read)
            $script:lockView = $script:lockMmf.CreateViewAccessor(0, 8, [System.IO.MemoryMappedFiles.MemoryMappedFileAccess]::Read)
        } catch {
            $script:lockMmf = $null; $script:lockView = $null   # sem a trava: segue sem a verificacao
        }
    }
    for ($attempt = 0; $attempt -lt 10; $attempt++) {
        $busyBefore = Test-GameBusy
        [void]$script:view.ReadArray(0, $script:snapshot, 0, $LAYOUT_SIZE)
        if (-not $busyBefore -and -not (Test-GameBusy)) { $script:tornCycles = 0; return $true }
        [System.Threading.Thread]::SpinWait(5000)
    }
    # trava presa por muito tempo: usa a copia mesmo assim em vez de ficar sem dados
    $script:tornCycles++
    return ($script:tornCycles -ge 10)
}

function Test-GameRunning {
    return [bool](Get-Process -Name "Le Mans Ultimate" -ErrorAction SilentlyContinue)
}

$lastSessionKey = $null
$lastNoDataMsg = $null
$cycle = 0

Write-Host "Bridge LMU (Shared Memory) iniciando..."

while ($true) {
    if ($ParentPid -gt 0 -and -not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) {
        Write-Host "Aplicativo fechado, encerrando o listener do LMU."
        exit
    }
    try {
        $tcp = New-Object System.Net.Sockets.TcpClient($BridgeHost, $BridgePort)
        $stream = $tcp.GetStream()
        Write-Host "Conectado ao servidor Node."

        while ($tcp.Connected) {
            try {
                # Nosso handle mantem o mapeamento vivo mesmo com o jogo fechado:
                # a cada ~3 s confere se o LMU continua aberto.
                $cycle++
                if ($MapName -eq "LMU_Data" -and ($cycle % 25) -eq 1 -and -not (Test-GameRunning)) {
                    Close-SharedMemory
                    throw "Le Mans Ultimate nao esta aberto."
                }

                if (-not (Read-Snapshot)) {
                    Start-Sleep -Milliseconds 20
                    continue
                }
                $buf = $script:snapshot

                $numVehicles = [BitConverter]::ToInt32($buf, $SCORING + $SC_NUM_VEHICLES)
                if ($numVehicles -lt 0) { $numVehicles = 0 }
                if ($numVehicles -gt $MAX_VEHICLES) { $numVehicles = $MAX_VEHICLES }
                $session = [BitConverter]::ToInt32($buf, $SCORING + $SC_SESSION)
                $gamePhase = [int]$buf[$SCORING + $SC_GAME_PHASE]
                $trackName = Read-CString $buf ($SCORING + $SC_TRACK_NAME) 64
                $trackLength = [BitConverter]::ToDouble($buf, $SCORING + $SC_LAP_DIST)
                $maxLaps = [BitConverter]::ToInt32($buf, $SCORING + $SC_MAX_LAPS)
                $timeRemaining = [BitConverter]::ToSingle($buf, $SCORING + $SC_TIME_REMAINING)
                if ($timeRemaining -le 0) {
                    $timeRemaining = [BitConverter]::ToDouble($buf, $SCORING + $SC_END_ET) - [BitConverter]::ToDouble($buf, $SCORING + $SC_CURRENT_ET)
                }
                if ($timeRemaining -lt 0 -or $timeRemaining -gt 360000) { $timeRemaining = 0 }

                $sessionState = if ($numVehicles -gt 0) { Get-SessionState $session $gamePhase } else { 0 }
                $inRace = ($sessionState -eq 5)

                # velocidade maxima vale por sessao: zera ao trocar de sessao ou de pista
                $sessionKey = "$session|$trackName"
                if ($sessionKey -ne $lastSessionKey) {
                    $lastSessionKey = $sessionKey
                    $maxSpeedKmh.Clear()
                }

                # telemetria: indice por slot, para casar com a pontuacao
                $telemBySlot = @{}
                $active = [int]$buf[$TEL_ACTIVE]
                if ($active -gt $MAX_VEHICLES) { $active = $MAX_VEHICLES }
                for ($j = 0; $j -lt $active; $j++) {
                    $t = $TEL + ($j * $TEL_SIZE)
                    $telemBySlot[[BitConverter]::ToInt32($buf, $t + $T_ID)] = $t
                }

                $standings = New-Object System.Collections.Generic.List[object]
                for ($i = 0; $i -lt $numVehicles; $i++) {
                    $v = $VEH + ($i * $VEH_SIZE)
                    $place = [int]$buf[$v + $V_PLACE]
                    if ($place -le 0) { continue }

                    $slot = [BitConverter]::ToInt32($buf, $v + $V_ID)
                    # sem o codigo da conta do online ("Felipe Antunes#1005" -> "Felipe Antunes")
                    $name = (Read-CString $buf ($v + $V_DRIVER_NAME) 32) -replace '\s*#\d+\s*$', ''
                    $vehicleName = Read-CString $buf ($v + $V_VEHICLE_NAME) 64
                    $carClass = Read-CString $buf ($v + $V_VEHICLE_CLASS) 32
                    $laps = [int][BitConverter]::ToInt16($buf, $v + $V_TOTAL_LAPS)
                    if ($laps -lt 0) { $laps = 0 }
                    $lapDist = [BitConverter]::ToDouble($buf, $v + $V_LAP_DIST)
                    $rawSector = [int]$buf[$v + $V_SECTOR]
                    $finish = [int]$buf[$v + $V_FINISH_STATUS]
                    if ($finish -gt 127) { $finish = 0 }   # sbyte negativo: sem status

                    # velocidade: da telemetria do mesmo slot quando houver (atualiza
                    # mais rapido que a pontuacao, que so muda a cada ~200 ms)
                    $velAt = $v + $V_LOCAL_VEL
                    if ($telemBySlot.ContainsKey($slot)) { $velAt = $telemBySlot[$slot] + $T_LOCAL_VEL }
                    $vx = [BitConverter]::ToDouble($buf, $velAt)
                    $vy = [BitConverter]::ToDouble($buf, $velAt + 8)
                    $vz = [BitConverter]::ToDouble($buf, $velAt + 16)
                    $speed = [math]::Sqrt($vx * $vx + $vy * $vy + $vz * $vz)
                    $speedKmh = [math]::Round($speed * 3.6, 1)
                    if (-not $maxSpeedKmh.ContainsKey($name) -or $speedKmh -gt $maxSpeedKmh[$name]) {
                        $maxSpeedKmh[$name] = $speedKmh
                    }

                    # box: mesmos codigos do AMS2 (1 entrando, 2 no pit lane, 3 saindo, 4 garagem)
                    $pitState = [int]$buf[$v + $V_PIT_STATE]
                    $pitMode = 0
                    if ($buf[$v + $V_IN_GARAGE] -ne 0) { $pitMode = 4 }
                    elseif ($pitState -eq 2) { $pitMode = 1 }
                    elseif ($pitState -eq 4) { $pitMode = 3 }
                    elseif ($pitState -eq 3 -or $buf[$v + $V_IN_PITS] -ne 0) { $pitMode = 2 }

                    # estado na corrida: mesmos codigos do AMS2 (2 correndo, 3 terminou, 4 dq, 6 dnf)
                    $raceState = 2
                    if ($finish -eq 1) { $raceState = 3 } elseif ($finish -eq 2) { $raceState = 6 } elseif ($finish -eq 3) { $raceState = 4 }

                    # setores: o jogo da S1 e S1+S2 da volta atual; o S3 so existe depois
                    # que a volta fecha (ultima volta - S1+S2 da ultima volta). Enquanto o
                    # carro esta no S3, o S3 antigo nao e enviado para nao ser confundido.
                    $currentSector = if ($rawSector -eq 1) { 0 } elseif ($rawSector -eq 2) { 1 } else { 2 }
                    $curS1 = [BitConverter]::ToDouble($buf, $v + $V_CUR_SECTOR1)
                    $curS2 = [BitConverter]::ToDouble($buf, $v + $V_CUR_SECTOR2)
                    $lastLap = [BitConverter]::ToDouble($buf, $v + $V_LAST_LAP)
                    $lastS2 = [BitConverter]::ToDouble($buf, $v + $V_LAST_SECTOR2)
                    $bestLap = [BitConverter]::ToDouble($buf, $v + $V_BEST_LAP)
                    $bestS1 = [BitConverter]::ToDouble($buf, $v + $V_BEST_SECTOR1)
                    $bestS2 = [BitConverter]::ToDouble($buf, $v + $V_BEST_SECTOR2)
                    $sector2 = if ($curS1 -gt 0 -and $curS2 -gt $curS1) { $curS2 - $curS1 } else { 0 }
                    $sector3 = if ($currentSector -ne 2 -and $lastLap -gt 0 -and $lastS2 -gt 0 -and $lastLap -gt $lastS2) { $lastLap - $lastS2 } else { 0 }
                    $bestSector2 = if ($bestS1 -gt 0 -and $bestS2 -gt $bestS1) { $bestS2 - $bestS1 } else { 0 }
                    $bestSector3 = if ($bestLap -gt 0 -and $bestS2 -gt 0 -and $bestLap -gt $bestS2) { $bestLap - $bestS2 } else { 0 }

                    # equipe e numero vem no nome do veiculo: "BMW M Team WRT 2026 #15:LM"
                    $teamName = $vehicleName
                    $carNumber = $null
                    if ($vehicleName -match '^(.*?)\s*(?:\d{4}\s*)?#(\w+)') {
                        $teamName = $Matches[1].Trim()
                        $carNumber = $Matches[2]
                    }

                    # so LMU: pneus e energia virtual (vem da telemetria do mesmo slot)
                    $carName = $vehicleName
                    $tyreFront = $null; $tyreRear = $null; $tyreWear = $null; $tyres = $null
                    $throttle = $null; $brake = $null; $gear = $null; $localAccel = $null
                    $virtualEnergy = $null; $fuelL = $null; $lapInvalid = ($buf[$v + $V_COUNT_LAP_FLAG] -ne 2)
                    $lastImpactEt = $null; $lastImpactMag = $null
                    if ($telemBySlot.ContainsKey($slot)) {
                        $t = $telemBySlot[$slot]
                        $lastImpactEt = [math]::Round([BitConverter]::ToDouble($buf, $t + $T_LAST_IMPACT_ET), 2)
                        $lastImpactMag = [math]::Round([BitConverter]::ToDouble($buf, $t + $T_LAST_IMPACT_MAG), 1)
                        $model = Read-CString $buf ($t + $T_VEHICLE_MODEL) 30
                        if ($model) { $carName = $model }
                        $tyreFront = Read-CString $buf ($t + $T_FRONT_COMPOUND) 18
                        $tyreRear = Read-CString $buf ($t + $T_REAR_COMPOUND) 18
                        $tyreWear = @(0, 1, 2, 3 | ForEach-Object {
                            [math]::Round([BitConverter]::ToDouble($buf, $t + $T_WHEEL + ($_ * $WHEEL_SIZE) + $W_WEAR), 3)
                        })
                        # composto de cada roda (diant. esq, diant. dir, tras. esq, tras. dir):
                        # no LMU da para montar um composto diferente em cada uma
                        $tyres = @(0, 1, 2, 3 | ForEach-Object {
                            $type = [int]$buf[$t + $T_WHEEL + ($_ * $WHEEL_SIZE) + $W_COMPOUND_TYPE]
                            if ($COMPOUND_TYPES.ContainsKey($type)) { $COMPOUND_TYPES[$type] } else { "" }
                        })
                        # pedais e marcha: o LMU informa os de todos os carros
                        $throttle = [math]::Round([math]::Max(0.0, [math]::Min(1.0, [BitConverter]::ToDouble($buf, $t + $T_THROTTLE) / $THROTTLE_FULL_AT)), 2)
                        $brake = [math]::Round([math]::Max(0.0, [math]::Min(1.0, [BitConverter]::ToDouble($buf, $t + $T_BRAKE))), 2)
                        $gear = [BitConverter]::ToInt32($buf, $t + $T_GEAR)
                        # aceleracao real do carro (forca G da overlay/g-force.html), de qualquer carro
                        $localAccel = @(0, 1, 2 | ForEach-Object { [math]::Round([BitConverter]::ToDouble($buf, $t + $T_LOCAL_ACCEL + ($_ * 8)), 3) })
                        $lapInvalid = ($buf[$t + $T_LAP_INVALIDATED] -ne 0)
                        # carros sem energia virtual (ex: LMP2) vem com 0 e tem combustivel
                        $ve = [BitConverter]::ToSingle($buf, $t + $T_VIRTUAL_ENERGY)
                        $fuel = [BitConverter]::ToDouble($buf, $t + $T_FUEL)
                        $fuelL = [math]::Round($fuel, 1)
                        if ($ve -gt 0 -or $fuel -le 0.5) { $virtualEnergy = [math]::Round([math]::Max(0.0, [math]::Min(1.0, [double]$ve)), 3) }
                    }

                    $standings.Add([PSCustomObject]@{
                        slot          = $slot
                        position      = $place
                        name          = $name
                        carName       = $carName
                        carClass      = $carClass
                        teamName      = $teamName
                        carNumber     = $carNumber
                        lapsCompleted = $laps
                        currentLap    = $laps + 1
                        totalDistance = ([double]$laps * $trackLength) + $lapDist
                        lapDistance   = [math]::Round([double]$lapDist, 1)
                        worldX        = [math]::Round([BitConverter]::ToDouble($buf, $v + $V_POS), 1)
                        worldZ        = [math]::Round([BitConverter]::ToDouble($buf, $v + $V_POS + 16), 1)
                        lastLapMs     = Seconds-ToMs $lastLap
                        fastestLapMs  = Seconds-ToMs $bestLap
                        speedKmh      = $speedKmh
                        speedMs       = [math]::Round($speed, 2)
                        maxSpeedKmh   = $maxSpeedKmh[$name]
                        isPlayer      = ($buf[$v + $V_IS_PLAYER] -ne 0)
                        pitMode       = $pitMode
                        raceState     = $raceState
                        inRace        = $inRace
                        sector1Ms     = Seconds-ToMs $curS1
                        sector2Ms     = Seconds-ToMs $sector2
                        sector3Ms     = Seconds-ToMs $sector3
                        currentSector = $currentSector
                        bestSector1Ms = Seconds-ToMs $bestS1
                        bestSector2Ms = Seconds-ToMs $bestSector2
                        bestSector3Ms = Seconds-ToMs $bestSector3
                        causedYellow  = $false
                        lapInvalidated = $lapInvalid
                        lastImpactEt  = $lastImpactEt
                        lastImpactMag = $lastImpactMag
                        pitStops      = [int][BitConverter]::ToInt16($buf, $v + $V_NUM_PITSTOPS)
                        penalties     = [int][BitConverter]::ToInt16($buf, $v + $V_NUM_PENALTIES)
                        fuelL         = $fuelL
                        tyreFront     = $tyreFront
                        tyreRear      = $tyreRear
                        tyres         = $tyres
                        tyreWear      = $tyreWear
                        virtualEnergy = $virtualEnergy
                        throttle      = $throttle
                        brake         = $brake
                        gear          = $gear
                        localAccel    = $localAccel
                    })
                }

                $payload = [PSCustomObject]@{
                    game    = "lmu"
                    session = [PSCustomObject]@{
                        state            = [int]$sessionState
                        label            = $SESSION_LABELS[[int]$sessionState]
                        timeRemainingSec = [int]$timeRemaining
                        eventTime        = [math]::Round([BitConverter]::ToDouble($buf, $SCORING + $SC_CURRENT_ET), 2)
                        lapsInEvent      = if ($maxLaps -gt 0 -and $maxLaps -lt 100000) { $maxLaps } else { 0 }
                        scOut            = ($gamePhase -eq 6)
                        sectorFlags      = @([int]$buf[$SCORING + $SC_SECTOR_FLAGS], [int]$buf[$SCORING + $SC_SECTOR_FLAGS + 1], [int]$buf[$SCORING + $SC_SECTOR_FLAGS + 2])
                        trackLocation    = $trackName
                        trackVariation   = ""
                        trackLength      = [math]::Round($trackLength, 1)
                        ambientTempC     = [math]::Round([BitConverter]::ToDouble($buf, $SCORING + $SC_AMBIENT_TEMP), 1)
                        trackTempC       = [math]::Round([BitConverter]::ToDouble($buf, $SCORING + $SC_TRACK_TEMP), 1)
                        rain             = [math]::Round([BitConverter]::ToDouble($buf, $SCORING + $SC_RAINING), 2)
                    }
                    standings = @($standings | Sort-Object position)
                }
                $json = ConvertTo-Json -InputObject $payload -Compress -Depth 4

                $payloadBytes = [System.Text.Encoding]::UTF8.GetBytes($json)
                $lengthBytes = [BitConverter]::GetBytes([int32]$payloadBytes.Length)
                if ([BitConverter]::IsLittleEndian) { [Array]::Reverse($lengthBytes) }

                $stream.Write($lengthBytes, 0, 4)
                $stream.Write($payloadBytes, 0, $payloadBytes.Length)
                if ($lastNoDataMsg) {
                    $lastNoDataMsg = $null
                    Write-Host "Recebendo dados do LMU."
                }
            }
            catch {
                Close-SharedMemory
                # avisa uma vez so (nao a cada ciclo) e espera mais antes de tentar de novo
                $msg = $_.Exception.Message
                if ($msg -ne $lastNoDataMsg) {
                    $lastNoDataMsg = $msg
                    Write-Host "Sem dados do LMU agora (jogo fechado?):" $msg
                }
                $cycle = 0
                # jogo fechado: procurar o processo a cada 0,4 s custava ~4% de um nucleo a toa
                if ($msg -like "*nao esta aberto*") { Start-Sleep -Milliseconds 3000 } else { Start-Sleep -Milliseconds 400 }
            }

            Start-Sleep -Milliseconds $IntervalMs
        }
    }
    catch {
        Write-Host "Bridge LMU: sem conexao com o Node, tentando de novo em 1s..." $_.Exception.Message
        Start-Sleep -Seconds 1
    }
}
