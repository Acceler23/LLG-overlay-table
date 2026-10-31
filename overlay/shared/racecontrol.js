// overlay/shared/racecontrol.js
// Safety car / FCY, no estilo das transmissoes da SRO: ao comecar, um painel
// grande cobre a tabela por PANEL_MS; depois a tabela volta normal e fica so a
// etiqueta, enquanto durar. Na contagem da bandeira verde o painel volta com
// "preparar para verde" e fica ate a bandeira; ai o painel inteiro fica verde
// por PANEL_MS e sai. Usado pela tabela de transmissao e pela do piloto: cada
// pagina tem #rcPanel, #rcPanelText, #rcTag e #rcTagText e diz onde eles ficam
// (opts.place). A animacao esta em shared/racecontrol.css.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.LLGRaceControl = api;
})(typeof self !== "undefined" ? self : this, function () {
  const PANEL_MS = 4900; // ate a saida comecar; com a saida, uns 6 s na tela (como na transmissao)
  const OUT_MS = 1200; // duracao da saida (rc-panel-shrink no CSS)
  const LATE_GREEN_MS = 3000; // contagem acabou e a bandeira nao veio (outro PC, pelo chat): espera isso
  const GREEN = { key: "green", tag: "BANDEIRA VERDE", big: "Bandeira<br />Verde" };
  const ACTIVE = new Set(["sc", "fcy", "prep"]);

  function info(session) {
    if (!session) return null;
    if (session.fcy) {
      if (session.fcyGreenIn > 0) return { key: "prep", tag: `VERDE EM ${session.fcyGreenIn}`, big: "Preparar<br />para<br />Verde" };
      const tag = session.fcyCountdown > 0 ? `FCY EM ${session.fcyCountdown}` : "FCY";
      return { key: "fcy", tag, big: "Full<br />Course<br />Yellow" };
    }
    if (session.scCall || session.scOut) return { key: "sc", tag: "SAFETY CAR", big: "Safety<br />Car" };
    return null;
  }

  // O que mostrar agora. Acabou o FCY/SC na mesma sessao: bandeira verde (sessao
  // nova nao e bandeira verde, o FCY so foi desligado).
  function resolve(session, prevKey, sameSession) {
    const now = info(session);
    if (now) return now;
    if (prevKey === "green") return GREEN; // quem tira o verde e o tempo
    return ACTIVE.has(prevKey) && sameSession ? GREEN : null;
  }

  function create(opts) {
    const place = (opts && opts.place) || (() => {});
    const onUpdate = (opts && opts.onUpdate) || (() => {});
    let key = null;
    let lastSession = null;
    let timer = null;
    const el = (id) => document.getElementById(id);

    function hide() {
      clearTimeout(timer);
      const panel = el("rcPanel");
      if (panel.hidden) return;
      panel.classList.remove("rc-in");
      panel.classList.add("rc-out");
      timer = setTimeout(() => {
        panel.hidden = true;
        panel.classList.remove("rc-out");
      }, OUT_MS);
    }

    // Painel ja na tela: so troca o conteudo (e a cor); senao, faz a entrada
    function show(now) {
      clearTimeout(timer);
      const panel = el("rcPanel");
      const onScreen = !panel.hidden && panel.classList.contains("rc-in");
      el("rcPanelText").innerHTML = `<span>${now.big}</span>`;
      panel.classList.toggle("rc-fcy", now.key === "fcy");
      panel.classList.toggle("rc-long", now.key === "prep" || now.key === "green");
      panel.classList.toggle("rc-green", now.key === "green");
      if (onScreen) return;
      panel.classList.remove("rc-out", "rc-in");
      panel.hidden = false;
      place();
      void panel.offsetWidth; // recomeca a animacao
      panel.classList.add("rc-in");
    }

    function endGreen() {
      key = null;
      el("rcTag").hidden = true;
      onUpdate(false);
      hide();
    }

    function change(prev, now) {
      if (!now) return hide();
      if (prev === "prep" && now.key === "fcy") {
        // contagem da verde acabou aqui e a mensagem ainda nao chegou: nao volta o painel de FCY
        clearTimeout(timer);
        timer = setTimeout(hide, LATE_GREEN_MS);
        return undefined;
      }
      show(now);
      if (now.key === "green") timer = setTimeout(endGreen, PANEL_MS);
      else if (now.key !== "prep") timer = setTimeout(hide, PANEL_MS); // "preparar" fica ate a bandeira
      return undefined;
    }

    function update(session) {
      const sessionKey = session ? `${session.state}|${session.trackLocation || ""}` : null;
      const same = sessionKey === lastSession;
      lastSession = sessionKey;
      const now = resolve(session, key, same);
      const nowKey = now ? now.key : null;
      if (nowKey !== key) {
        const prev = key;
        key = nowKey;
        change(prev, now);
      }
      const tag = el("rcTag");
      tag.hidden = !now;
      tag.classList.toggle("rc-green", nowKey === "green");
      if (now) el("rcTagText").textContent = now.tag;
      onUpdate(!!now);
      place();
    }

    return { update, hide };
  }

  return { info, resolve, create, PANEL_MS, OUT_MS };
});
