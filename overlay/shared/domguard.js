// overlay/shared/domguard.js
// Escritas repetidas no DOM viram nada.
//
// As overlays redesenham a cada atualizacao do jogo (~10x por segundo) e
// reescrevem textos, classes, atributos e cores mesmo quando o valor nao
// mudou. Numa janela comum o navegador quase nao gasta com isso, mas na fonte
// de navegador do OBS cada escrita invalida a pagina, e ela e desenhada e
// copiada para o OBS de novo: medido num PC no limite, a tabela de tempos com
// os mesmos 5 carros parados custava ~20% de um nucleo so por estar visivel.
//
// Este arquivo vem antes de qualquer outro script da overlay e faz cada
// escrita olhar o valor atual primeiro: igual, nao escreve. O resultado na tela
// e o mesmo; so deixa de existir o trabalho de redesenhar algo identico.
(function () {
  if (typeof window === "undefined" || typeof Element === "undefined") return;

  // propriedade com getter e setter: so escreve se o valor lido for diferente
  function guardProperty(proto, name, same) {
    const d = Object.getOwnPropertyDescriptor(proto, name);
    if (!d || !d.set || !d.get) return;
    Object.defineProperty(proto, name, {
      configurable: true,
      enumerable: d.enumerable,
      get: d.get,
      set(v) {
        if (same(this, d.get.call(this), v)) return;
        d.set.call(this, v);
      },
    });
  }

  const asText = (v) => (v == null ? "" : String(v));
  guardProperty(Node.prototype, "textContent", (el, cur, v) => cur === asText(v));
  guardProperty(Element.prototype, "className", (el, cur, v) => cur === asText(v));
  guardProperty(HTMLElement.prototype, "hidden", (el, cur, v) => cur === !!v);
  guardProperty(HTMLImageElement.prototype, "src", (el, cur, v) => el.getAttribute("src") === asText(v) || cur === asText(v));

  // innerHTML: o valor lido vem normalizado pelo navegador, entao lembra o texto escrito e como
  // ele ficou; pula so se o pedido e o mesmo E ninguem mexeu no conteudo depois
  const lastHtml = new WeakMap(); // el -> { src, out }
  const html = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML");
  if (html && html.set) {
    Object.defineProperty(Element.prototype, "innerHTML", {
      configurable: true,
      enumerable: html.enumerable,
      get: html.get,
      set(v) {
        const s = asText(v);
        const last = lastHtml.get(this);
        if (last && last.src === s && html.get.call(this) === last.out) return;
        html.set.call(this, s);
        lastHtml.set(this, { src: s, out: html.get.call(this) });
      },
    });
  }

  const setAttr = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    if (this.getAttribute(name) === asText(value)) return;
    return setAttr.call(this, name, value);
  };

  // classList.add/remove/toggle: so mexe se a classe realmente entra ou sai
  const tl = DOMTokenList.prototype;
  const add = tl.add;
  const remove = tl.remove;
  const toggle = tl.toggle;
  tl.add = function (...tokens) {
    const missing = tokens.filter((t) => !this.contains(t));
    if (missing.length) add.apply(this, missing);
  };
  tl.remove = function (...tokens) {
    const present = tokens.filter((t) => this.contains(t));
    if (present.length) remove.apply(this, present);
  };
  tl.toggle = function (token, force) {
    const has = this.contains(token);
    if (force === undefined) return toggle.call(this, token);
    if (!!force === has) return has;
    return toggle.call(this, token, force);
  };

  // estilo inline (el.style.color = ..., el.style.setProperty(...)): o valor lido vem normalizado
  // ("#fff" vira "rgb(255, 255, 255)"), entao compara com o ultimo valor escrito
  const lastStyle = new WeakMap();
  function styleSame(decl, prop, v) {
    let m = lastStyle.get(decl);
    if (!m) lastStyle.set(decl, (m = new Map()));
    const s = asText(v);
    if (m.get(prop) === s) return true;
    m.set(prop, s);
    return false;
  }
  const sp = CSSStyleDeclaration.prototype;
  const setProperty = sp.setProperty;
  sp.setProperty = function (prop, value, priority) {
    if (styleSame(this, prop + "|" + (priority || ""), value) && this.getPropertyValue(prop) !== "") return;
    return setProperty.call(this, prop, value, priority);
  };
  const removeProperty = sp.removeProperty;
  sp.removeProperty = function (prop) {
    const m = lastStyle.get(this);
    if (m) for (const k of m.keys()) if (k === prop || k.startsWith(prop + "|")) m.delete(k);
    if (this.getPropertyValue(prop) === "") return "";
    return removeProperty.call(this, prop);
  };
  // cada propriedade de estilo (color, background, width, transform...)
  const probe = document.createElement("div").style;
  const props = new Set();
  for (let p = sp; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
    Object.getOwnPropertyNames(p).forEach((n) => props.add(n));
  }
  for (const k in probe) props.add(k);
  props.forEach((name) => {
    if (name === "cssText" || /^[A-Z]/.test(name)) return;
    let owner = sp;
    let d = null;
    while (owner && !(d = Object.getOwnPropertyDescriptor(owner, name))) owner = Object.getPrototypeOf(owner);
    if (!d || !d.set || !d.get) return;
    Object.defineProperty(owner, name, {
      configurable: true,
      enumerable: d.enumerable,
      get: d.get,
      set(v) {
        // o navegador pode ter limpado o valor (cssText, removeProperty): ai escreve de novo
        if (styleSame(this, name, v) && d.get.call(this) !== "") return;
        d.set.call(this, v);
      },
    });
  });
  // cssText reescreve tudo: esquece o que foi lembrado
  const css = Object.getOwnPropertyDescriptor(sp, "cssText");
  if (css && css.set) {
    Object.defineProperty(sp, "cssText", {
      configurable: true,
      enumerable: css.enumerable,
      get: css.get,
      set(v) {
        lastStyle.delete(this);
        css.set.call(this, v);
      },
    });
  }
})();
