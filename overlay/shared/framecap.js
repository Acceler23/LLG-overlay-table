// overlay/shared/framecap.js
// Limite de FPS das overlays (opcao do painel, aba Transmissao > Aparencia).
// Uma pagina so e redesenhada quando algo muda: dados do jogo (10x por
// segundo) e animacoes de CSS (que rodam na taxa do monitor, 144 Hz por
// exemplo). Com o limite ligado:
//   - cada render roda no maximo maxFps vezes por segundo (as chamadas no meio
//     viram uma so, com os dados mais novos);
//   - as animacoes e transicoes de CSS ficam desligadas.
// A escolha fica guardada em cada pagina (localStorage) e chega pelo comando
// overlay.setMaxFps { value: 30 | 0 }.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.LLGFrameCap = api;
})(typeof self !== "undefined" ? self : this, function () {
  const KEY = "maxFps";
  let maxFps = 0;
  try {
    maxFps = Number(localStorage.getItem(KEY)) || 0;
  } catch (_) {}

  const hasDom = typeof document !== "undefined";
  if (hasDom) {
    const style = document.createElement("style");
    // escondida no OBS: animacoes paradas tambem (nada e desenhado enquanto ninguem ve)
    style.textContent =
      ".fps-capped *, .fps-capped *::before, .fps-capped *::after { transition: none !important; animation: none !important; }" +
      ".obs-hidden *, .obs-hidden *::before, .obs-hidden *::after { animation-play-state: paused !important; }";
    (document.head || document.documentElement).appendChild(style);
  }
  const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

  function applyClass() {
    if (hasDom) document.documentElement.classList.toggle("fps-capped", maxFps > 0);
  }
  applyClass();

  function set(value) {
    maxFps = Number(value) > 0 ? Number(value) : 0;
    try {
      localStorage.setItem(KEY, String(maxFps));
    } catch (_) {}
    applyClass();
  }

  // Fonte escondida no OBS: a pagina continua recebendo e calculando (historico dos intervalos,
  // setores, mapa), mas nao desenha nada. Cada fonte de navegador do OBS e um navegador inteiro, e
  // desenhar uma overlay que ninguem ve custava de 9% a 21% de um nucleo por fonte num PC no limite.
  // Quando a fonte aparece de novo, o ultimo desenho pendente roda na hora, com os dados atuais.
  // O OBS avisa pelo evento obsSourceVisibleChanged (so existe dentro do OBS; fora dele, nunca pausa).
  let hidden = false;
  const pending = new Map(); // fn -> args do ultimo desenho pedido enquanto escondida
  if (typeof window !== "undefined" && window.addEventListener) {
    window.addEventListener("obsSourceVisibleChanged", (e) => {
      hidden = !(e && e.detail && e.detail.visible);
      if (hasDom) document.documentElement.classList.toggle("obs-hidden", hidden);
      if (hidden) return;
      const todo = [...pending.entries()];
      pending.clear();
      todo.forEach(([fn, args]) => run(fn, args));
    });
  }

  // Roda fn(...args) respeitando o limite. O estado fica na propria funcao.
  function run(fn, args) {
    if (hidden) {
      pending.set(fn, args);
      return undefined;
    }
    if (!(maxFps > 0)) return fn.apply(null, args);
    const st = fn.__frameCap || (fn.__frameCap = { last: -Infinity, timer: null, args: null });
    st.args = args;
    const gap = 1000 / maxFps;
    const t = now();
    if (t - st.last >= gap) {
      st.last = t;
      return fn.apply(null, args);
    }
    if (!st.timer) {
      st.timer = setTimeout(() => {
        st.timer = null;
        st.last = now();
        fn.apply(null, st.args);
      }, gap - (t - st.last));
    }
    return undefined;
  }

  // Mensagem do servidor: aplica o comando do painel, se for ele
  function handle(msg) {
    if (msg && msg.type === "overlayCommand" && msg.name === "overlay.setMaxFps") set(msg.payload && msg.payload.value);
  }

  return { run, set, handle, get: () => maxFps, isHidden: () => hidden };
});
