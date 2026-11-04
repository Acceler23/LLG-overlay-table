# listener.ps1
#
# Le a Shared Memory do AMS2 ($pcars2$, mesma usada por SimHub/CrewChief) e
# manda um JSON por ciclo para o servidor Node via TCP, com um prefixo de 4
# bytes (big-endian) indicando o tamanho.
#
# Versao otimizada: todo o trabalho de cada ciclo (copiar a memoria, ler os
# campos, montar o JSON e enviar) roda em C# compilado, e nao em PowerShell.
# O PowerShell so compila (uma vez, com cache) e inicia o laco. A saida e a
# mesma da versao anterior (listener-legacy.ps1), campo a campo: o servidor
# e as overlays nao mudam. Medido num PC no limite (jogo + OBS + overlay,
# CPU total a 93%): a versao anterior usava ~40% de um nucleo.
#
# A cada ciclo a Shared Memory inteira e copiada para um buffer local, e a
# copia so e aceita se o numero de sequencia do jogo nao mudou durante a
# copia. Todos os campos sao lidos dessa copia, entao um ciclo nunca mistura
# dados de dois instantes diferentes.
#
# Os offsets vem da struct oficial (SharedMemory_AMS2.h) que a Reiza
# distribui junto do jogo.

param(
    [string]$MapName = '$pcars2$',
    [string]$BridgeHost = "127.0.0.1",
    [int]$BridgePort = 5607,
    # pausa entre leituras (o trabalho de cada ciclo leva ~1 ms). A cada ~33 ms sai a telemetria
    # do carro do piloto (pacote minimo); o completo continua ~10x por segundo (FULL_EVERY_MS).
    [int]$IntervalMs = 33,
    # PID do aplicativo que iniciou este script. Se ele fechar (ou travar),
    # o script encerra sozinho em vez de ficar rodando escondido.
    [int]$ParentPid = 0
)

# Prioridade abaixo do normal: com a CPU disputada, o Windows atende o jogo
# primeiro e este script usa so o que sobra.
try { (Get-Process -Id $PID).PriorityClass = [System.Diagnostics.ProcessPriorityClass]::BelowNormal } catch {}

$source = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO.MemoryMappedFiles;
using System.Net.Sockets;
using System.Text;
using System.Threading;

// a conexao com o servidor caiu (diferente de "jogo fechado", que tambem e IOException)
public class BridgeClosedException : Exception {
    public BridgeClosedException(Exception inner) : base(inner.Message, inner) { }
}

public static class LlgAms2Listener {
    // ---- offsets (bytes) na Shared Memory do AMS2 ----
    const int SEQUENCE_NUMBER = 7320;          // uint, impar enquanto o jogo escreve
    const int AMBIENT_TEMP = 7292, TRACK_TEMP = 7296, RAIN_DENSITY = 7300;
    const int SESSION_DURATION = 20576;        // float, minutos
    const int SESSION_ADDITIONAL_LAPS = 20580; // int
    const int SESSION_STATE = 12, VIEWED_PARTICIPANT_INDEX = 20, NUM_PARTICIPANTS = 24;
    const int EVENT_TIME_REMAINING = 6740;     // float (segundos, na pratica)
    const int PARTICIPANT_INFO_START = 28, PARTICIPANT_INFO_SIZE = 100;
    const int SPLIT_TIME_AHEAD = 6728;
    const int FASTEST_LAP_TIMES = 8944, LAST_LAP_TIMES = 9200, RACE_STATES = 9520, PIT_MODES = 9776;
    const int SPEEDS = 10800, CAR_NAMES = 11056, CAR_CLASS_NAMES = 15152;
    const int TRACK_LENGTH = 6704, LAPS_IN_EVENT = 6572, TRACK_LOCATION = 6576, TRACK_VARIATION = 6640;
    const int FUEL_LEVEL = 6840, FUEL_CAPACITY = 6844, TYRE_COMPOUND = 19388;
    const int CUR_SECTOR1 = 7408, CUR_SECTOR2 = 7664, CUR_SECTOR3 = 7920;
    const int FAST_SECTOR1 = 8176, FAST_SECTOR2 = 8432, FAST_SECTOR3 = 8688;
    const int PIT_SCHEDULES = 19548, FLAG_COLOURS = 19804, FLAG_REASONS = 20060, LAPS_INVALIDATED = 9456;
    // telemetria do carro em foco
    const int UNFILTERED_THROTTLE = 6428, UNFILTERED_BRAKE = 6432, UNFILTERED_STEERING = 6436, UNFILTERED_CLUTCH = 6440;
    const int CAR_NAME = 6444, CAR_CLASS_NAME = 6508, CAR_FLAGS = 6816;
    const int OIL_TEMP = 6820, OIL_PRESSURE = 6824, WATER_TEMP = 6828, WATER_PRESSURE = 6832, FUEL_PRESSURE = 6836;
    const int SPEED = 6848, RPM = 6852, MAX_RPM = 6856, BRAKE = 6860, THROTTLE = 6864, CLUTCH = 6868, STEERING = 6872;
    const int GEAR = 6876, NUM_GEARS = 6880, ODOMETER = 6884, ABS_ACTIVE = 6888, BOOST_ACTIVE = 6900, BOOST_AMOUNT = 6904;
    const int ORIENTATION = 6908, LOCAL_VELOCITY = 6920, LOCAL_ACCEL = 6956;
    const int TYRE_FLAGS = 6992, TERRAIN = 7008, TYRE_RPS = 7040, TYRE_TEMP = 7072, TYRE_WEAR = 7136;
    const int BRAKE_DAMAGE = 7152, SUSP_DAMAGE = 7168, BRAKE_TEMP = 7184;
    const int TYRE_TREAD_TEMP = 7200, TYRE_LAYER_TEMP = 7216, TYRE_CARCASS_TEMP = 7232, TYRE_RIM_TEMP = 7248, TYRE_AIR_TEMP = 7264;
    const int CRASH_STATE = 7280, AERO_DAMAGE = 7284, ENGINE_DAMAGE = 7288;
    const int SUSP_TRAVEL = 7340, SUSP_VELOCITY = 7356, AIR_PRESSURE = 7372, ENGINE_SPEED = 7388, ENGINE_TORQUE = 7392;
    const int WINGS = 7396, HANDBRAKE = 7404, BRAKE_BIAS = 19380, TURBO_BOOST = 19384;
    const int TYRE_TEMP_LEFT = 20584, TYRE_TEMP_CENTER = 20600, TYRE_TEMP_RIGHT = 20616;
    const int DRS_STATE = 20632, RIDE_HEIGHT = 20636, ABS_SETTING = 20660, TC_SETTING = 20664;
    const int ERS_MODE = 20668, ERS_AUTO = 20672, CLUTCH_TEMP = 20676, CLUTCH_WEAR = 20680;
    const int CLUTCH_OVERHEATED = 20684, CLUTCH_SLIPPING = 20685, LAUNCH_STAGE = 20696;

    static readonly string[] SESSION_LABELS = { "INVALIDA", "TREINO LIVRE", "TESTE", "CLASSIFICACAO", "VOLTA DE FORMACAO", "CORRIDA", "TIME ATTACK" };
    static readonly CultureInfo INV = CultureInfo.InvariantCulture;
    static readonly UTF8Encoding UTF8_STRICT = new UTF8Encoding(false, true);
    static readonly Encoding CP1252 = Encoding.GetEncoding(1252);

    static MemoryMappedFile mmf;
    static MemoryMappedViewAccessor view;
    static byte[] snap;
    static bool hasSeq;
    static uint lastSeq;
    static DateTime lastSeqChange = DateTime.UtcNow;
    static long sentSeq = -1;
    static DateTime sentAt = DateTime.MinValue;
    static int tornCycles;
    static bool tornWarned;
    static string lastSessionKey;
    static readonly Dictionary<string, double> maxSpeedKmh = new Dictionary<string, double>();
    static readonly StringBuilder sb = new StringBuilder(64 * 1024);
    static string lastNoDataMsg;

    // ACC / Assetto Corsa: o servidor precisa saber quando ha uma sessao aberta (ver listener-legacy.ps1)
    static object accLive; // null = ainda nao mandado
    static DateTime accCheckedAt = DateTime.MinValue, accSentAt = DateTime.MinValue;
    static bool ac1Running;
    static DateTime ac1ProcAt = DateTime.MinValue, ac1SentAt = DateTime.MinValue;

    static void Log(string s) { Console.WriteLine(s); Console.Out.Flush(); }

    [System.Runtime.InteropServices.DllImport("winmm.dll")]
    static extern uint timeBeginPeriod(uint ms);

    public static void Run(string mapName, string host, int port, int intervalMs, int parentPid) {
        Log("Bridge (Shared Memory) iniciando...");
        // pausas de 1 ms de precisao (o padrao do Windows arredonda para 15,6 ms: os ~33 ms entre
        // leituras viravam ~47 ms e a telemetria saia a ~20 Hz em vez de ~30)
        try { timeBeginPeriod(1); } catch { }
        Process parent = null;
        if (parentPid > 0) { try { parent = Process.GetProcessById(parentPid); } catch { parent = null; } }
        while (true) {
            if (parentPid > 0 && (parent == null || parent.HasExited)) {
                Log("Aplicativo fechado, encerrando o listener.");
                return;
            }
            TcpClient tcp = null;
            try {
                tcp = new TcpClient(host, port);
                tcp.NoDelay = true;
                NetworkStream stream = tcp.GetStream();
                Log("Conectado ao servidor Node.");
                DateTime parentCheckAt = DateTime.UtcNow;
                while (tcp.Connected) {
                    // a cada ~2 s confere se o aplicativo que nos iniciou continua aberto
                    if (parent != null && (DateTime.UtcNow - parentCheckAt).TotalSeconds >= 2) {
                        parentCheckAt = DateTime.UtcNow;
                        if (parent.HasExited) { Log("Aplicativo fechado, encerrando o listener."); return; }
                    }
                    try {
                        SendAccStatus(stream);
                        if (!ReadSnapshot(mapName)) { Thread.Sleep(20); continue; }
                        DateTime now = DateTime.UtcNow;
                        // o jogo nao escreveu nada novo (menu, pausa): o completo sai de novo so 1x por segundo
                        bool fresh = (long)lastSeq != sentSeq || (now - sentAt).TotalMilliseconds >= 1000;
                        if (fresh && (now - sentAt).TotalMilliseconds >= FULL_EVERY_MS) {
                            // tudo (carros, sessao, carro do piloto): ~10x por segundo
                            BuildPayload();
                            Send(stream, sb.ToString());
                            sentSeq = lastSeq;
                            sentAt = now;
                        } else if ((long)lastSeq != telSeq) {
                            // entre um completo e outro: so os pedais do carro do piloto (overlay de telemetria)
                            SendTel(stream);
                            telSeq = lastSeq;
                        }
                        if (lastNoDataMsg != null) { lastNoDataMsg = null; Log("Recebendo dados do jogo."); }
                    } catch (Exception ex) {
                        if (ex is BridgeClosedException) throw;
                        CloseSharedMemory();
                        // avisa uma vez so (nao a cada ciclo) e espera mais antes de tentar de novo
                        if (ex.Message != lastNoDataMsg) {
                            lastNoDataMsg = ex.Message;
                            Log("Sem dados agora (jogo fechado ou no menu?): " + ex.Message);
                        }
                        Thread.Sleep(400);
                    }
                    Thread.Sleep(intervalMs);
                }
            } catch (Exception ex) {
                Log("Bridge: sem conexao com o Node, tentando de novo em 1s... " + ex.Message);
                Thread.Sleep(1000);
            } finally {
                if (tcp != null) { try { tcp.Close(); } catch { } }
            }
        }
    }

    // ---------- Shared Memory ----------
    static void CloseSharedMemory() {
        if (view != null) view.Dispose();
        if (mmf != null) mmf.Dispose();
        view = null; mmf = null; hasSeq = false;
    }

    // Copia a Shared Memory para snap. Devolve true quando a copia pode ser usada. O jogo
    // incrementa o numero de sequencia no inicio e no fim de cada escrita: impar = escrevendo
    // agora; diferente antes/depois da copia = escreveu no meio. Nos dois casos, refaz.
    static bool ReadSnapshot(string mapName) {
        if (view == null) {
            mmf = MemoryMappedFile.OpenExisting(mapName, MemoryMappedFileRights.Read);
            view = mmf.CreateViewAccessor(0, 0, MemoryMappedFileAccess.Read);
            snap = new byte[(int)view.Capacity];
            hasSeq = false;
            lastSeqChange = DateTime.UtcNow;
        }
        bool consistent = false;
        uint seq = 0;
        for (int attempt = 0; attempt < 10; attempt++) {
            seq = view.ReadUInt32(SEQUENCE_NUMBER);
            view.ReadArray(0, snap, 0, snap.Length);
            uint after = view.ReadUInt32(SEQUENCE_NUMBER);
            if ((seq & 1) == 0 && seq == after) { consistent = true; break; }
            Thread.SpinWait(5000);
        }
        // nosso handle mantem o mapeamento vivo com o jogo fechado: sequencia parada por 5 s,
        // fecha e reabre (com o jogo fechado a reabertura falha e cai no aviso de "sem dados")
        DateTime now = DateTime.UtcNow;
        if (!hasSeq || lastSeq != seq) { hasSeq = true; lastSeq = seq; lastSeqChange = now; }
        else if ((now - lastSeqChange).TotalSeconds >= 5) CloseSharedMemory();

        if (consistent) { tornCycles = 0; return true; }
        tornCycles++;
        if (tornCycles < 10) return false;
        if (!tornWarned) {
            tornWarned = true;
            Log("Aviso: numero de sequencia da Shared Memory nao estabiliza; usando leitura sem verificacao.");
        }
        return true;
    }

    static int I32(int o) { return BitConverter.ToInt32(snap, o); }
    static uint U32(int o) { return BitConverter.ToUInt32(snap, o); }
    static float F32(int o) { return BitConverter.ToSingle(snap, o); }

    static string CStr(int offset, int maxLen) {
        int n = 0;
        while (n < maxLen && snap[offset + n] != 0) n++;
        if (n == 0) return "";
        try { return UTF8_STRICT.GetString(snap, offset, n); }
        catch { return CP1252.GetString(snap, offset, n); }
    }

    // ---------- JSON ----------
    static void Num(double v) {
        if (double.IsNaN(v) || double.IsInfinity(v)) { sb.Append("null"); return; }
        sb.Append(v.ToString("R", INV));
    }
    static void Rnd(double v, int digits) { Num(Math.Round(v, digits)); }
    static void Str(string s) {
        sb.Append('"');
        foreach (char c in s) {
            switch (c) {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
                    else sb.Append(c);
                    break;
            }
        }
        sb.Append('"');
    }
    static void Key(string k) { sb.Append('"').Append(k).Append("\":"); }
    static void KNum(string k, double v, int digits) { Key(k); Rnd(v, digits); sb.Append(','); }
    static void KInt(string k, long v) { Key(k); sb.Append(v.ToString(INV)); sb.Append(','); }
    static void KBool(string k, bool v) { Key(k); sb.Append(v ? "true" : "false"); sb.Append(','); }
    static void KStr(string k, string v) { Key(k); Str(v); sb.Append(','); }
    static void KNull(string k) { Key(k); sb.Append("null,"); }
    // tempo em ms a partir de segundos (null se nao ha tempo)
    static void KMs(string k, float s) {
        if (s > 0) KInt(k, (long)Math.Round((double)s * 1000)); else KNull(k);
    }
    static void Float4(string k, int o, int digits) {
        Key(k); sb.Append('[');
        for (int i = 0; i < 4; i++) { if (i > 0) sb.Append(','); Rnd(F32(o + i * 4), digits); }
        sb.Append("],");
    }
    static void UInt4(string k, int o) {
        Key(k); sb.Append('[');
        for (int i = 0; i < 4; i++) { if (i > 0) sb.Append(','); sb.Append(((int)U32(o + i * 4)).ToString(INV)); }
        sb.Append("],");
    }
    static void Vec3(string k, int o) {
        Key(k); sb.Append('[');
        for (int i = 0; i < 3; i++) { if (i > 0) sb.Append(','); Rnd(F32(o + i * 4), 4); }
        sb.Append("],");
    }
    static void EndObject() {
        if (sb[sb.Length - 1] == ',') sb.Length--;
        sb.Append('}');
    }

    struct Entry { public int position; public int start; public int length; }

    static void BuildPayload() {
        int numParticipants = I32(NUM_PARTICIPANTS);
        int viewedIndex = I32(VIEWED_PARTICIPANT_INDEX);
        uint sessionState = U32(SESSION_STATE);
        int timeRemainingSec = (int)Math.Round((double)F32(EVENT_TIME_REMAINING));
        float trackLength = F32(TRACK_LENGTH);
        uint lapsInEvent = U32(LAPS_IN_EVENT);
        string trackLocation = CStr(TRACK_LOCATION, 64);
        string trackVariation = CStr(TRACK_VARIATION, 64);
        float splitAhead = F32(SPLIT_TIME_AHEAD);
        bool inRace = sessionState == 5;
        if (numParticipants > 64) numParticipants = 64;
        if (numParticipants < 0) numParticipants = 0;

        // velocidade maxima vale por sessao: zera ao trocar de sessao ou de pista
        string sessionKey = sessionState + "|" + trackLocation + "|" + trackVariation;
        if (sessionKey != lastSessionKey) { lastSessionKey = sessionKey; maxSpeedKmh.Clear(); }

        // cada carro vira um pedaco de JSON; depois os pedacos vao em ordem de posicao
        sb.Length = 0;
        var entries = new List<Entry>(numParticipants);
        bool scOut = false;
        for (int i = 0; i < numParticipants; i++) {
            int b = PARTICIPANT_INFO_START + i * PARTICIPANT_INFO_SIZE;
            bool isActive = snap[b] != 0;
            uint racePosition = U32(b + 84);
            string carName = CStr(CAR_NAMES + i * 64, 64);
            string carClass = CStr(CAR_CLASS_NAMES + i * 64, 64);
            uint pitMode = U32(PIT_MODES + i * 4);
            string clsLow = carClass.ToLowerInvariant();
            string cnLow = carName.ToLowerInvariant();
            bool isSafety = clsLow == "safetycar" || cnLow.Contains("safety");
            if (isSafety && isActive && pitMode == 0) scOut = true;
            if (!isActive || racePosition == 0) continue;

            uint lapsCompleted = U32(b + 88);
            uint raceState = U32(RACE_STATES + i * 4);
            if (inRace && raceState == 0) continue;
            if (inRace && lapsCompleted == 0 && (pitMode == 4 || pitMode == 2)) continue;
            if (isSafety) continue;

            string name = CStr(b + 1, 64);
            float lapDist = F32(b + 80);
            float worldX = F32(b + 68), worldZ = F32(b + 76);
            uint currentLap = U32(b + 92);
            int currentSector = I32(b + 96);
            float speed = F32(SPEEDS + i * 4);
            uint flagColour = U32(FLAG_COLOURS + i * 4);
            uint pitSchedule = U32(PIT_SCHEDULES + i * 4);

            double speedKmh = Math.Round((double)speed * 3.6, 1);
            double maxV;
            if (!maxSpeedKmh.TryGetValue(name, out maxV) || speedKmh > maxV) { maxV = speedKmh; maxSpeedKmh[name] = maxV; }

            int start = sb.Length;
            sb.Append('{');
            KInt("slot", i);
            KInt("position", racePosition);
            KStr("name", name);
            KStr("carName", carName);
            KStr("carClass", carClass);
            KInt("lapsCompleted", lapsCompleted);
            KInt("currentLap", currentLap);
            KNum("lapDistance", lapDist, 1);
            KNum("worldX", worldX, 1);
            KNum("worldZ", worldZ, 1);
            Key("totalDistance"); Num((double)lapsCompleted * trackLength + lapDist); sb.Append(',');
            KMs("lastLapMs", F32(LAST_LAP_TIMES + i * 4));
            KMs("fastestLapMs", F32(FASTEST_LAP_TIMES + i * 4));
            KNum("speedKmh", speedKmh, 1);
            KNum("speedMs", speed, 2);
            KNum("maxSpeedKmh", maxV, 1);
            KBool("isPlayer", i == viewedIndex);
            KInt("pitMode", pitMode);
            KInt("raceState", raceState);
            KBool("inRace", inRace);
            KMs("sector1Ms", F32(CUR_SECTOR1 + i * 4));
            KMs("sector2Ms", F32(CUR_SECTOR2 + i * 4));
            KMs("sector3Ms", F32(CUR_SECTOR3 + i * 4));
            KInt("currentSector", currentSector);
            KMs("bestSector1Ms", F32(FAST_SECTOR1 + i * 4));
            KMs("bestSector2Ms", F32(FAST_SECTOR2 + i * 4));
            KMs("bestSector3Ms", F32(FAST_SECTOR3 + i * 4));
            KInt("flagColour", flagColour);
            KInt("flagReason", U32(FLAG_REASONS + i * 4));
            // Flag 6=YELLOW 7=DOUBLE_YELLOW. SM marca todos no mini-setor; so carros lentos/parados
            // (<40 km/h) como proxy do causador.
            KBool("causedYellow", (flagColour == 6 || flagColour == 7) && speedKmh < 40);
            KBool("lapInvalidated", snap[LAPS_INVALIDATED + i] != 0);
            // punicao pendente do carro (o 7, vaga do box ocupada, nao e punicao)
            if (pitSchedule == 5) KStr("penaltyType", "driveThrough");
            else if (pitSchedule == 6) KStr("penaltyType", "stopGo");
            else KNull("penaltyType");
            if (i == viewedIndex) {
                if (splitAhead >= 0) KNum("splitAhead", splitAhead, 2);
                float fuelLevel = F32(FUEL_LEVEL), fuelCap = F32(FUEL_CAPACITY);
                KNum("fuelPct", (double)fuelLevel * 100, 1);
                if (fuelCap > 0) KNum("fuelL", (double)fuelLevel * fuelCap, 1);
                string tyre = CStr(TYRE_COMPOUND, 40);
                if (tyre.Length > 0) KStr("tyreCompound", tyre);
            }
            EndObject();
            Entry e; e.position = (int)racePosition; e.start = start; e.length = sb.Length - start;
            entries.Add(e);
        }
        string cars = sb.ToString();
        // estavel (como o Sort-Object do PowerShell): empate fica na ordem dos slots
        var order = new List<int>(entries.Count);
        for (int k = 0; k < entries.Count; k++) order.Add(k);
        order.Sort(delegate (int a, int c) {
            int d = entries[a].position.CompareTo(entries[c].position);
            return d != 0 ? d : a.CompareTo(c);
        });

        sb.Length = 0;
        sb.Append("{\"game\":\"ams2\",\"session\":{");
        KInt("state", sessionState);
        if (sessionState < SESSION_LABELS.Length) KStr("label", SESSION_LABELS[sessionState]); else KNull("label");
        KInt("timeRemainingSec", timeRemainingSec);
        KInt("lapsInEvent", lapsInEvent);
        KBool("scOut", scOut);
        KStr("trackLocation", trackLocation);
        KStr("trackVariation", trackVariation);
        KNum("trackLength", trackLength, 1);
        KNum("ambientTempC", F32(AMBIENT_TEMP), 1);
        KNum("trackTempC", F32(TRACK_TEMP), 1);
        KNum("rain", F32(RAIN_DENSITY), 2);
        KNum("sessionDurationMin", F32(SESSION_DURATION), 1);
        KInt("additionalLaps", I32(SESSION_ADDITIONAL_LAPS));
        EndObject();
        sb.Append(",\"standings\":[");
        for (int k = 0; k < order.Count; k++) {
            if (k > 0) sb.Append(',');
            Entry e = entries[order[k]];
            sb.Append(cars, e.start, e.length);
        }
        sb.Append("],\"car\":{");
        KStr("carName", CStr(CAR_NAME, 64));
        KStr("carClass", CStr(CAR_CLASS_NAME, 64));
        KNum("throttle", F32(THROTTLE), 3);
        KNum("brake", F32(BRAKE), 3);
        KNum("clutch", F32(CLUTCH), 3);
        KNum("steering", F32(STEERING), 3);
        KNum("handbrake", F32(HANDBRAKE), 3);
        KNum("unfThrottle", F32(UNFILTERED_THROTTLE), 3);
        KNum("unfBrake", F32(UNFILTERED_BRAKE), 3);
        KNum("unfClutch", F32(UNFILTERED_CLUTCH), 3);
        KNum("unfSteering", F32(UNFILTERED_STEERING), 3);
        KNum("rpm", F32(RPM), 0);
        KNum("maxRpm", F32(MAX_RPM), 0);
        KNum("engineSpeed", F32(ENGINE_SPEED), 2);
        KNum("engineTorque", F32(ENGINE_TORQUE), 1);
        KNum("speedMs", F32(SPEED), 2);
        KNum("speedKmh", (double)F32(SPEED) * 3.6, 1);
        KInt("gear", I32(GEAR));
        KInt("numGears", I32(NUM_GEARS));
        KNum("odometerKm", F32(ODOMETER), 2);
        KNum("oilTempC", F32(OIL_TEMP), 1);
        KNum("oilPressureKPa", F32(OIL_PRESSURE), 1);
        KNum("waterTempC", F32(WATER_TEMP), 1);
        KNum("waterPressureKPa", F32(WATER_PRESSURE), 1);
        KNum("fuelPressureKPa", F32(FUEL_PRESSURE), 1);
        KNum("fuelLevel", F32(FUEL_LEVEL), 4);
        KNum("fuelCapacityL", F32(FUEL_CAPACITY), 1);
        KNum("fuelPct", (double)F32(FUEL_LEVEL) * 100, 1);
        KInt("carFlags", (int)U32(CAR_FLAGS));
        KBool("absActive", snap[ABS_ACTIVE] != 0);
        KBool("boostActive", snap[BOOST_ACTIVE] != 0);
        KNum("boostAmount", F32(BOOST_AMOUNT), 1);
        KNum("turboBoost", F32(TURBO_BOOST), 3);
        KNum("brakeBias", F32(BRAKE_BIAS), 3);
        Key("wings"); sb.Append('['); Rnd(F32(WINGS), 3); sb.Append(','); Rnd(F32(WINGS + 4), 3); sb.Append("],");
        KInt("crashState", (int)U32(CRASH_STATE));
        KNum("aeroDamage", F32(AERO_DAMAGE), 3);
        KNum("engineDamage", F32(ENGINE_DAMAGE), 3);
        Vec3("orientation", ORIENTATION);
        Vec3("localVelocity", LOCAL_VELOCITY);
        Vec3("localAccel", LOCAL_ACCEL);
        UInt4("tyreFlags", TYRE_FLAGS);
        UInt4("terrain", TERRAIN);
        Float4("tyreRps", TYRE_RPS, 3);
        Float4("tyreTemp", TYRE_TEMP, 3);
        Float4("tyreTempLeft", TYRE_TEMP_LEFT, 3);
        Float4("tyreTempCenter", TYRE_TEMP_CENTER, 3);
        Float4("tyreTempRight", TYRE_TEMP_RIGHT, 3);
        Float4("tyreWear", TYRE_WEAR, 3);
        Float4("tyreTreadTemp", TYRE_TREAD_TEMP, 3);
        Float4("tyreLayerTemp", TYRE_LAYER_TEMP, 3);
        Float4("tyreCarcassTemp", TYRE_CARCASS_TEMP, 3);
        Float4("tyreRimTemp", TYRE_RIM_TEMP, 3);
        Float4("tyreAirTemp", TYRE_AIR_TEMP, 3);
        Float4("airPressurePsi", AIR_PRESSURE, 3);
        Float4("brakeTempC", BRAKE_TEMP, 3);
        Float4("brakeDamage", BRAKE_DAMAGE, 3);
        Float4("suspDamage", SUSP_DAMAGE, 3);
        Float4("suspTravel", SUSP_TRAVEL, 3);
        Float4("suspVelocity", SUSP_VELOCITY, 3);
        Float4("rideHeightCm", RIDE_HEIGHT, 3);
        Key("tyreCompound"); sb.Append('[');
        for (int t = 0; t < 4; t++) { if (t > 0) sb.Append(','); Str(CStr(TYRE_COMPOUND + t * 40, 40)); }
        sb.Append("],");
        KInt("drsState", (int)U32(DRS_STATE));
        KInt("absSetting", I32(ABS_SETTING));
        KInt("tcSetting", I32(TC_SETTING));
        KInt("ersMode", I32(ERS_MODE));
        KBool("ersAuto", snap[ERS_AUTO] != 0);
        KNum("clutchTempK", F32(CLUTCH_TEMP), 1);
        KNum("clutchWear", F32(CLUTCH_WEAR), 3);
        KBool("clutchOverheated", snap[CLUTCH_OVERHEATED] != 0);
        KBool("clutchSlipping", snap[CLUTCH_SLIPPING] != 0);
        KInt("launchStage", I32(LAUNCH_STAGE));
        EndObject();
        sb.Append('}');
    }

    // Pacote minimo da telemetria do carro do piloto, entre dois completos: acelerador, freio,
    // volante, velocidade (a overlay confere por ela se e o carro em foco) e aceleracao. ~90 bytes.
    const int FULL_EVERY_MS = 95; // o completo continua ~10x por segundo; o resto do tempo, so isto
    static long telSeq = -1;
    static readonly StringBuilder tsb = new StringBuilder(128);
    static void SendTel(NetworkStream stream) {
        tsb.Length = 0;
        tsb.Append("{\"tel\":{\"thr\":").Append(Math.Round((double)F32(THROTTLE), 3).ToString("R", INV))
           .Append(",\"brk\":").Append(Math.Round((double)F32(BRAKE), 3).ToString("R", INV))
           .Append(",\"str\":").Append(Math.Round((double)F32(STEERING), 3).ToString("R", INV))
           .Append(",\"spd\":").Append(Math.Round((double)F32(SPEED), 2).ToString("R", INV))
           // aceleracao no carro (m/s2): x lateral, z longitudinal (overlay de forca G do piloto)
           .Append(",\"ax\":").Append(Math.Round((double)F32(LOCAL_ACCEL), 3).ToString("R", INV))
           .Append(",\"az\":").Append(Math.Round((double)F32(LOCAL_ACCEL + 8), 3).ToString("R", INV))
           .Append("}}");
        Send(stream, tsb.ToString());
    }

    static void Send(NetworkStream stream, string json) {
        byte[] body = Encoding.UTF8.GetBytes(json);
        byte[] msg = new byte[4 + body.Length];
        int n = body.Length;
        msg[0] = (byte)(n >> 24); msg[1] = (byte)(n >> 16); msg[2] = (byte)(n >> 8); msg[3] = (byte)n;
        Buffer.BlockCopy(body, 0, msg, 4, n);
        try { stream.Write(msg, 0, msg.Length); }
        catch (Exception ex) { throw new BridgeClosedException(ex); }
    }

    // ---------- Assetto Corsa Competizione e Assetto Corsa ----------
    // O ACC le um pedido de conexao de cada vez e o servidor precisa saber QUANDO ha sessao
    // (Local\acpmf_graphics, status 0 = fora de sessao). O AC 1 usa os mesmos nomes; o que
    // diz qual dos dois esta aberto e o processo (acs.exe).
    static bool TestAccLive() {
        try {
            using (var m = MemoryMappedFile.OpenExisting("Local\\acpmf_graphics", MemoryMappedFileRights.Read))
            using (var v = m.CreateViewAccessor(0, 16, MemoryMappedFileAccess.Read)) {
                return v.ReadInt32(4) > 0;
            }
        } catch { return false; }
    }

    static bool TestAc1Running() {
        DateTime now = DateTime.UtcNow;
        if ((now - ac1ProcAt).TotalSeconds >= 3) {
            ac1ProcAt = now;
            Process[] ps = Process.GetProcessesByName("acs");
            ac1Running = ps.Length > 0;
            foreach (Process p in ps) p.Dispose();
        }
        return ac1Running;
    }

    static void SendAc1Status(NetworkStream stream) {
        DateTime now = DateTime.UtcNow;
        if ((now - ac1SentAt).TotalMilliseconds < 200) return;
        ac1SentAt = now;
        string json;
        try {
            int status, session, laps; double left; int timed = 0;
            using (var m = MemoryMappedFile.OpenExisting("Local\\acpmf_graphics", MemoryMappedFileRights.Read))
            using (var v = m.CreateViewAccessor(0, 176, MemoryMappedFileAccess.Read)) {
                status = v.ReadInt32(4); session = v.ReadInt32(8); left = v.ReadSingle(152); laps = v.ReadInt32(172);
            }
            try {
                using (var m = MemoryMappedFile.OpenExisting("Local\\acpmf_static", MemoryMappedFileRights.Read))
                using (var v = m.CreateViewAccessor(0, 604, MemoryMappedFileAccess.Read)) { timed = v.ReadInt32(596); }
            } catch { }
            if (double.IsNaN(left) || double.IsInfinity(left) || left < 0 || left > 4e9) left = 0;
            json = "{\"acStatus\":{\"status\":" + status + ",\"session\":" + session + ",\"timeLeftMs\":" + ((long)Math.Round(left)).ToString(INV) + ",\"laps\":" + laps + ",\"timed\":" + (timed != 0 ? "true" : "false") + "}}";
        } catch { return; } // jogo fechando
        Send(stream, json);
    }

    static void SendAccStatus(NetworkStream stream) {
        if (TestAc1Running()) SendAc1Status(stream);
        DateTime now = DateTime.UtcNow;
        if ((now - accCheckedAt).TotalMilliseconds < 400) return;
        accCheckedAt = now;
        bool live = ac1Running ? false : TestAccLive();
        // manda quando muda, e repete a cada 3 s para o servidor nao perder o estado
        if (accLive != null && (bool)accLive == live && (now - accSentAt).TotalSeconds < 3) return;
        accLive = live;
        accSentAt = now;
        Send(stream, "{\"accStatus\":{\"live\":" + (live ? "true" : "false") + "}}");
    }
}
'@

# O C# e compilado uma vez e guardado (o csc leva ~1-2 s de CPU): nas proximas vezes so carrega.
$hash = [BitConverter]::ToString(([System.Security.Cryptography.SHA1]::Create()).ComputeHash([System.Text.Encoding]::UTF8.GetBytes($source))).Replace("-", "").Substring(0, 16)
$cacheDir = Join-Path $env:LOCALAPPDATA "LLG Overlay\cache"
$dll = Join-Path $cacheDir "llg-ams2-listener-$hash.dll"
$loaded = $false
if (Test-Path $dll) {
    try { Add-Type -Path $dll; $loaded = $true } catch { $loaded = $false }
}
if (-not $loaded) {
    try {
        New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null
        Get-ChildItem $cacheDir -Filter "llg-ams2-listener-*.dll" -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
        Add-Type -TypeDefinition $source -OutputAssembly $dll -ReferencedAssemblies System.Core
        Add-Type -Path $dll
    } catch {
        # sem permissao para gravar o cache: compila so na memoria
        Add-Type -TypeDefinition $source -ReferencedAssemblies System.Core
    }
}

[LlgAms2Listener]::Run($MapName, $BridgeHost, $BridgePort, $IntervalMs, $ParentPid)
