const WS_URL = `ws://${location.hostname}:${location.port || 8080}/ws`;

// ?max=3 (G no anel externo), ?flip=acc,lmu (inverte o lado da lateral
// estimada nesses jogos, se a bolinha for para o lado errado)
const params = new URLSearchParams(location.search);
const MAX_G = Math.max(1, Number(params.get("max")) || 3);
const FLIP = (params.get("flip") || "").split(",").map((s) => s.trim()).filter(Boolean);
const STALE_MS = 2000; // sem dado do carro em foco por mais que isso: apaga
const TRAIL_MS = 1500;
const SIZE = 240; // lado do canvas, em px de CSS
const DEAD_ZONE_G = 0.05; // abaixo disso nao diz o lado
// Eixo longitudinal como nos G-meters de transmissao: a bolinha mostra a forca que o piloto sente,
// entao na freada ela vai para a frente (cima) e na aceleracao para tras (baixo). ?eixo=acel volta
// ao desenho antigo (acelerando para cima).
const ACCEL_UP = params.get("eixo") === "acel";
// ?piloto=1: a versao do piloto, por cima do jogo (janela do app). So a forca G, sem as luzes
// de acelerador e freio; so aparece com o carro na pista; liga e desliga pelo painel do piloto
// (nao pela tecla 8 nem pelo painel da transmissao); e usa a aceleracao do pacote rapido do
// AMS2 (~30 leituras por segundo) quando o carro em foco e o do proprio piloto.
const PILOT = params.get("piloto") === "1";
if (PILOT) {
  document.documentElement.classList.add("piloto");
  // a janela do piloto muda de tamanho (Editar na tela): o desenho de 300 px acompanha a largura
  const fit = () => (document.documentElement.style.zoom = String(Math.max(0.3, window.innerWidth / 300)));
  window.addEventListener("resize", fit);
  fit();
}

const tracker = LLGGForce.createTracker({ flip: FLIP });
let visible = true;
try {
  if (!PILOT) visible = localStorage.getItem("gforceVisible") !== "0";
} catch (_) {}

let latest = null; // ultimo resultado do tracker
let latestAt = 0;
let trail = []; // { t, lat, long }

const el = (id) => document.getElementById(id);
const card = el("card");
const canvas = el("circle");
const ctx = canvas.getContext("2d");
const dpr = window.devicePixelRatio || 1;
canvas.width = SIZE * dpr;
canvas.height = SIZE * dpr;
ctx.scale(dpr, dpr);

function setVisible(v) {
  visible = !!v;
  document.body.classList.toggle("hidden", !visible);
  try {
    localStorage.setItem("gforceVisible", visible ? "1" : "0");
  } catch (_) {}
}
setVisible(visible);

const g2 = (n) => Math.abs(n).toFixed(2);

function drawCircle(now) {
  const c = SIZE / 2;
  const R = c - 8;
  ctx.clearRect(0, 0, SIZE, SIZE);
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.fillStyle = "rgba(255,255,255,0.45)";
  ctx.font = "10px 'Segoe UI', Arial, sans-serif";
  ctx.textAlign = "left";
  for (let g = 1; g <= MAX_G; g++) {
    ctx.beginPath();
    ctx.arc(c, c, (R * g) / MAX_G, 0, Math.PI * 2);
    ctx.stroke();
    // na diagonal de baixo a direita, longe dos rotulos ACEL/FREIO/ESQ/DIR
    const rg = (R * g) / MAX_G;
    ctx.fillText(`${g}g`, c + rg * Math.SQRT1_2 + 2, c + rg * Math.SQRT1_2 - 2);
  }
  ctx.beginPath();
  ctx.moveTo(c - R, c);
  ctx.lineTo(c + R, c);
  ctx.moveTo(c, c - R);
  ctx.lineTo(c, c + R);
  ctx.stroke();
  ctx.textAlign = "center";
  ctx.fillText(ACCEL_UP ? "ACEL" : "FREIO", c, 10);
  ctx.fillText(ACCEL_UP ? "FREIO" : "ACEL", c, SIZE - 2);
  ctx.textAlign = "left";
  ctx.fillText("ESQ", 2, c - 4);
  ctx.textAlign = "right";
  ctx.fillText("DIR", SIZE - 2, c - 4);

  const point = (p) => {
    // dentro do anel externo: um valor acima do maximo fica na borda
    let x = (p.lat / MAX_G) * R;
    let y = ((ACCEL_UP ? -p.long : p.long) / MAX_G) * R;
    const len = Math.hypot(x, y);
    if (len > R) {
      x = (x / len) * R;
      y = (y / len) * R;
    }
    return [c + x, c + y];
  };

  trail = trail.filter((p) => now - p.t <= TRAIL_MS);
  for (let i = 1; i < trail.length; i++) {
    const a = point(trail[i - 1]);
    const b = point(trail[i]);
    ctx.strokeStyle = `rgba(255,255,255,${(0.55 * (1 - (now - trail[i].t) / TRAIL_MS)).toFixed(3)})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.stroke();
  }
  const last = trail[trail.length - 1];
  if (last && now - latestAt <= STALE_MS) {
    const [x, y] = point(last);
    // verde acelerando, vermelho freando, branco quando so esta em curva
    ctx.fillStyle = Math.abs(last.long) < DEAD_ZONE_G ? "#f2f4f8" : last.long > 0 ? "#3ddc84" : "#ff5a5a";
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
}

// Luzes de acelerador e freio: acesas pela intensidade do pedal (real) ou pela aceleracao (estimada)
function renderPedals(p) {
  const pedals = p || { throttle: null, brake: null, source: "estimated" };
  const set = (id, v) => {
    const light = el(id);
    const on = v !== null && v >= LLGGForce.PEDAL_ON;
    light.classList.toggle("on", on);
    light.querySelector(".fill").style.width = `${on ? Math.round(v * 100) : 0}%`;
  };
  set("thrLight", pedals.throttle);
  set("brkLight", pedals.brake);
  el("pedals").title = pedals.source === "telemetry" ? "Pedais do jogo" : "Deduzidos pela aceleracao do carro (o jogo nao informa os pedais deste carro)";
  el("pedals").classList.toggle("estimated", pedals.source !== "telemetry");
}

function render() {
  const now = Date.now();
  const stale = !latest || now - latestAt > STALE_MS;
  card.classList.toggle("idle", stale);
  if (PILOT) {
    // so com o carro na pista (fora do menu, garagem e box); no modo de edicao aparece para posicionar
    const entry = (latest && latest.entry) || null;
    const onTrack = !stale && entry && (entry.pitMode || 0) === 0;
    card.hidden = !(onTrack || document.getElementById("llgEditBar"));
  }
  drawCircle(now);
  if (stale) {
    renderPedals(null);
    return;
  }

  const r = latest;
  const entry = r.entry || {};
  el("pos").textContent = entry.position > 0 ? `P${entry.position}` : "—";
  el("name").textContent = String(r.name || "").replace(/​+$/, "");
  const badge = el("badge");
  badge.textContent = r.source === "telemetry" ? "TELEMETRIA" : "ESTIMADO";
  badge.className = `badge ${r.source}`;
  badge.title = r.source === "telemetry" ? "Aceleracao medida pelo jogo" : "Calculada pela velocidade e pela posicao do carro";

  const latVal = el("latVal");
  const latSide = el("latSide");
  if (r.latG === null) {
    latVal.textContent = "—";
    latSide.textContent = "sem posicao";
  } else {
    latVal.textContent = g2(r.latG);
    latSide.textContent = Math.abs(r.latG) < DEAD_ZONE_G ? "" : r.latG > 0 ? "direita" : "esquerda";
  }
  const longVal = el("longVal");
  const longSide = el("longSide");
  if (r.longG === null) {
    longVal.textContent = "—";
    longVal.className = "num";
    longSide.textContent = "";
  } else {
    longVal.textContent = g2(r.longG);
    const braking = r.longG < 0;
    longVal.className = Math.abs(r.longG) < DEAD_ZONE_G ? "num" : braking ? "num brake" : "num accel";
    longSide.textContent = Math.abs(r.longG) < DEAD_ZONE_G ? "" : braking ? "freando" : "acelerando";
  }
  if (!PILOT) renderPedals(r.pedals);
}

let lastTelAt = 0; // pacote rapido chegando: a lista nao precisa somar ao rastro
let demoAt = 0; // dados de exemplo do "Editar na tela" (server/demo.js) tocando
function onStandings(data, demo) {
  const now = Date.now();
  if (demo) demoAt = now;
  // tocando o exemplo: a lista vazia do jogo no menu (1x por segundo) nao apaga os valores
  else if (now - demoAt < 500 && !(data && Array.isArray(data.standings) && data.standings.length)) return;
  const fast = PILOT && now - lastTelAt < 500;
  const prev = latest;
  latest = tracker.update(data, now);
  if (latest) {
    latestAt = now;
    if (fast && prev) {
      // os valores da forca G vem do pacote rapido; a lista so atualiza o piloto em foco
      latest.latG = prev.latG;
      latest.longG = prev.longG;
      latest.source = "telemetry";
    } else if (latest.latG !== null && latest.longG !== null) trail.push({ t: now, lat: latest.latG, long: latest.longG });
  }
  LLGFrameCap.run(render, []);
}

// Pacote rapido do AMS2 (so do carro do jogador, ~30x por segundo): forca G medida pelo jogo,
// suavizada um pouco, quando o carro em foco e o do proprio piloto (confere pela velocidade).
const FAST_SMOOTH = 0.35;
function onTel(t) {
  if (!PILOT || !t || typeof t.ax !== "number" || typeof t.az !== "number" || !latest || !latest.entry) return;
  const me = latest.entry;
  if (typeof me.speedMs === "number" && typeof t.spd === "number" && Math.abs(t.spd - me.speedMs) >= Math.max(2, me.speedMs * 0.12)) return;
  const g = LLGGForce.fromLocalAccel([t.ax, 0, t.az]);
  if (!g) return;
  const now = Date.now();
  const k = now - lastTelAt < 200 && latest.latG != null ? FAST_SMOOTH : 1;
  latest.latG = latest.latG == null ? g.latG : latest.latG + (g.latG - latest.latG) * k;
  latest.longG = latest.longG == null ? g.longG : latest.longG + (g.longG - latest.longG) * k;
  latest.source = "telemetry";
  lastTelAt = now;
  latestAt = now;
  trail.push({ t: now, lat: latest.latG, long: latest.longG });
  LLGFrameCap.run(render, []);
}

// O servidor manda a "versao" dos arquivos da overlay ao conectar e de tempos em tempos. Se ela mudar
// (programa atualizado, arquivo editado), a pagina se recarrega sozinha, para o OBS nunca ficar com codigo antigo.
let overlayBuildId = null;
function checkBuildId(id) {
  if (!id) return;
  if (overlayBuildId === null) overlayBuildId = id;
  else if (id !== overlayBuildId) location.reload();
}

function connect() {
  const socket = new WebSocket(WS_URL);
  socket.addEventListener("message", (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      LLGFrameCap.handle(msg); // limite de FPS do painel
      const editingNow = PILOT && !!document.getElementById("llgEditBar");
      if (msg.type === "tel") {
        onTel(msg.data);
      } else if (msg.type === "standings") {
        onStandings(msg.data);
      } else if (msg.type === "demo" && editingNow) {
        onStandings(msg.data, true); // dados de exemplo: so na janela do piloto em edicao
      } else if (msg.type === "demoTel" && editingNow) {
        onTel(msg.data);
      } else if (msg.type === "hello") {
        checkBuildId(msg.buildId);
      } else if (msg.type === "overlayCommand" && !PILOT) {
        if (msg.name === "overlay.toggleGForce") setVisible(!visible);
        else if (msg.name === "overlay.setGForce") setVisible(!!(msg.payload && msg.payload.value));
      }
    } catch (_) {}
  });
  // servidor reiniciando: tenta de novo logo, para a overlay voltar rapido
  socket.addEventListener("close", () => setTimeout(connect, 500));
}

document.addEventListener("keydown", (e) => {
  if (e.key === "8" && !PILOT) setVisible(!visible);
});

// sem mensagens novas, o card ainda precisa apagar sozinho
setInterval(() => LLGFrameCap.run(render, []), 500);

connect();
