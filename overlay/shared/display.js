// overlay/shared/display.js
// Regras de exibicao usadas pela tabela E pelo driver card, para os dois
// mostrarem sempre o mesmo nome de classe, a mesma cor e o mesmo logo.
// As listas vem de drivers-config.js (CLASS_NAME_OVERRIDES, CLASS_COLORS,
// DEFAULT_COLOR, CAR_LOGOS, TEAM_LOGO_OVERRIDES).
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.LLGDisplay = api;
})(typeof self !== "undefined" ? self : this, function () {
  let testConfig = null;

  // No navegador le as constantes globais de drivers-config.js. Nos testes
  // (Node) a configuracao e injetada com setConfig().
  function config() {
    if (testConfig) return testConfig;
    return {
      classNameOverrides: typeof CLASS_NAME_OVERRIDES !== "undefined" ? CLASS_NAME_OVERRIDES : {},
      classColors: typeof CLASS_COLORS !== "undefined" ? CLASS_COLORS : null,
      defaultColor: typeof DEFAULT_COLOR !== "undefined" ? DEFAULT_COLOR : "rgb(0, 98, 255)",
      carLogos: typeof CAR_LOGOS !== "undefined" ? CAR_LOGOS : null,
      teamLogoOverrides: typeof TEAM_LOGO_OVERRIDES !== "undefined" ? TEAM_LOGO_OVERRIDES : {},
      lmuClassNames: typeof LMU_CLASS_NAMES !== "undefined" ? LMU_CLASS_NAMES : {},
      accClassNames: typeof ACC_CLASS_NAMES !== "undefined" ? ACC_CLASS_NAMES : {},
      acClassNames: typeof AC_CLASS_NAMES !== "undefined" ? AC_CLASS_NAMES : {},
      trackNames: typeof TRACK_NAMES !== "undefined" ? TRACK_NAMES : {},
    };
  }

  function setConfig(cfg) {
    testConfig = cfg;
  }

  function normalizeColor(c) {
    if (!c) return null;
    let s = String(c).trim();
    if (!s) return null;
    if (s.startsWith("rgb") || s.startsWith("hsl")) return s;
    if (s.startsWith("#")) s = s.slice(1);
    if (/^[0-9a-fA-F]{8}$/.test(s)) return `#${s.slice(2, 8)}`;
    if (/^[0-9a-fA-F]{6}$/.test(s) || /^[0-9a-fA-F]{3}$/.test(s)) return `#${s}`;
    return c;
  }

  // "GT3_Gen2_LD" -> "GT3 Gen2"; CLASS_NAME_OVERRIDES tem prioridade.
  function formatClassName(raw) {
    if (!raw) return raw;
    const overrides = config().classNameOverrides || {};
    if (overrides[raw]) return overrides[raw];
    return String(raw)
      .replace(/_(LD|HD|SW)(?=_|$)/gi, "") // sufixos tecnicos que nao fazem parte do nome
      .replace(/_/g, " ")
      .trim();
  }

  function hashColor(str) {
    let h = 0;
    const s = String(str || "");
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return `hsl(${Math.abs(h) % 360}, 65%, 42%)`;
  }

  // Cor de uma classe. rltClasses: classes da temporada do RLT (ou null).
  function classColor(key, rltClasses) {
    const cfg = config();
    if (rltClasses && rltClasses.length) {
      const c = rltClasses.find((x) => x.uniqueName === key || x.name === key);
      const col = c && normalizeColor(c.color);
      if (col) return col;
    }
    const colors = cfg.classColors;
    if (!colors) return cfg.defaultColor;
    if (key && colors[key]) return colors[key];
    const formatted = formatClassName(key);
    if (formatted && colors[formatted]) return colors[formatted];
    if (key) {
      const noSpace = String(key).replace(/\s+/g, "_");
      if (colors[noSpace]) return colors[noSpace];
    }
    for (const [raw, name] of Object.entries(cfg.classNameOverrides || {})) {
      if (name === formatted && colors[raw]) return colors[raw];
    }
    if (key && key !== "—") return hashColor(key);
    return cfg.defaultColor;
  }

  function teamSlug(name) {
    return String(name || "")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "");
  }

  // Nome do carro para mostrar: sem o sufixo de configuracao aerodinamica que
  // o jogo poe no nome ("... - Low Downforce", "... - High Downforce",
  // "... - Speedway").
  function carDisplayName(carName) {
    return String(carName || "")
      .replace(/\s*-\s*(low downforce|high downforce|speedway)\s*$/i, "")
      .trim();
  }

  function manufacturerName(carName) {
    return (carName || "").split(" ")[0];
  }

  // Arquivo do logo da montadora, pelo nome do carro.
  // Ordem: o nome inteiro do carro; uma chave com "*" cujo trecho esteja no
  // nome ("*Corvette" pega "Chevrolet Corvette C8.R", sem diferenciar
  // maiusculas); e por fim a primeira palavra (a marca).
  function carLogo(carName) {
    const logos = config().carLogos;
    if (!logos) return undefined;
    if (carName && logos[carName]) return logos[carName];
    const name = String(carName || "").toLowerCase();
    const hit = name && Object.keys(logos).find((k) => k.startsWith("*") && k.length > 1 && name.includes(k.slice(1).toLowerCase()));
    if (hit) return logos[hit];
    return logos[manufacturerName(carName)];
  }

  // Equipe com nome de montadora (ex: "Porsche", "McLaren") usa o logo dela.
  function carLogoFromTeam(teamName) {
    const logos = config().carLogos;
    if (!teamName || !logos) return null;
    if (logos[teamName]) return logos[teamName];
    const first = manufacturerName(teamName);
    if (logos[first]) return logos[first];
    const slug = teamSlug(teamName);
    for (const key of Object.keys(logos)) {
      if (teamSlug(key) === slug) return logos[key];
    }
    return null;
  }

  // Arquivo do logo da equipe. Ordem: escolha feita no painel (localOverrides),
  // TEAM_LOGO_OVERRIDES do drivers-config.js, e por fim o nome em minusculas
  // com "_" (ex: "Hell Machine" -> hell_machine.png).
  // Depois do nome exato, uma chave com "*" cujo trecho esteja no nome da
  // equipe ("*WRT" pega "BMW M Team WRT"), igual ao CAR_LOGOS: assim o nome que
  // o jogo informa (LMU, sem temporada do RLT) tambem acha o logo.
  function teamLogoFile(teamName, localOverrides) {
    if (!teamName) return null;
    if (localOverrides && localOverrides[teamName]) return localOverrides[teamName];
    const overrides = config().teamLogoOverrides || {};
    if (overrides[teamName]) return overrides[teamName];
    const name = String(teamName).toLowerCase();
    const hit = Object.keys(overrides).find((k) => k.startsWith("*") && k.length > 1 && name.includes(k.slice(1).toLowerCase()));
    if (hit) return overrides[hit];
    const slug = teamSlug(teamName);
    return slug ? `${slug}.png` : null;
  }

  // Troca o nome de classe que o jogo manda pelo nome usado no drivers-config
  // (LMU_CLASS_NAMES / ACC_CLASS_NAMES / AC_CLASS_NAMES), para nomes e cores de classe seguirem
  // a configuracao. Chamado por cada overlay ao receber os dados; o AMS2 nao
  // tem lista porque os nomes dele ja sao as chaves do drivers-config.
  function applyGameClassNames(standings, game) {
    const cfg = config();
    const names = game === "lmu" ? cfg.lmuClassNames : game === "acc" ? cfg.accClassNames : game === "ac" ? cfg.acClassNames : null;
    if (!names) return standings;
    (standings || []).forEach((e) => {
      if (e && e.carClass && names[e.carClass]) e.carClass = names[e.carClass];
    });
    return standings;
  }

  // Caminhos a tentar para o logo de um piloto: equipe primeiro, depois carro.
  // variant ("light" ou "dark", opcional): versao do logo para um fundo que
  // faria o logo normal sumir. O arquivo tem o mesmo nome com o sufixo
  // "__light" ou "__dark" antes da extensao (apex.png -> apex__light.png):
  //   light = logo CLARO, para fundo escuro
  //   dark  = logo ESCURO, para fundo claro
  // A variante vem antes do logo normal na lista; se o arquivo nao existir, o
  // carregador (shared/logos.js) cai no normal.
  function logoPaths(teamName, carName, localOverrides, variant) {
    const carFile = carLogo(carName) || carLogoFromTeam(teamName);
    const teamFile = teamLogoFile(teamName, localOverrides);
    const team = teamFile ? `teams/${teamFile}` : null;
    const car = carFile ? `cars/${carFile}` : null;
    if (variant !== "light" && variant !== "dark") return [team, car];
    const withSuffix = (file) => (file ? file.replace(/(\.[a-z0-9]+)?$/i, (ext) => `__${variant}${ext}`) : null);
    return [withSuffix(team), team, withSuffix(car), car];
  }

  // Nome da pista para o cabecalho da tabela.
  //   location / variation: como o jogo informa (ex: "Interlagos" / "GP",
  //   "Kansai" / "", "ks_vallelunga" / "extended_circuit")
  // TRACK_NAMES (drivers-config.js) troca o nome do jogo pelo nome de verdade:
  // a chave pode ser so a pista ("Kansai") ou pista + tracado ("Kansai GP"),
  // sem diferenciar maiusculas. Uma chave comecando com "*" vale para qualquer
  // nome que CONTENHA aquele trecho ("*Daytona" pega "Daytona International
  // Speedway Road Course"), sem diferenciar maiusculas nem acentos; serve para
  // encurtar nomes compridos sem precisar saber o texto exato. As chaves exatas
  // tem prioridade. Sem entrada na lista, o nome do jogo e so arrumado (sem
  // "ks_", sem "_").
  function trackDisplay(location, variation) {
    const names = config().trackNames || {};
    const lookup = (key) => {
      const k = String(key || "").trim().toLowerCase();
      if (!k) return null;
      const hit = Object.keys(names).find((n) => n.trim().toLowerCase() === k);
      return hit ? String(names[hit]) : null;
    };
    const tidy = (text) => {
      const t = String(text || "")
        .trim()
        .replace(/^ks_/i, "")
        .replace(/_+/g, " ")
        .replace(/([a-z])([A-Z])/g, "$1 $2") // nomes colados do AMS2: "SpaFrancorchamps" -> "Spa Francorchamps"
        .replace(/\s+/g, " ")
        .trim();
      // identificadores todos em minusculas (Assetto Corsa) ganham iniciais maiusculas
      return t && t === t.toLowerCase() ? t.replace(/\b[a-z]/g, (c) => c.toUpperCase()) : t;
    };
    const plain = (text) =>
      String(text || "")
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase();
    // chaves com "*": a primeira da lista cujo trecho aparece no nome
    const contains = (text) => {
      const hay = plain(text);
      if (!hay.trim()) return null;
      const hit = Object.keys(names).find((n) => {
        const key = n.trim();
        if (!key.startsWith("*")) return false;
        const needle = plain(key.slice(1)).trim();
        return needle && hay.includes(needle);
      });
      return hit ? String(names[hit]) : null;
    };
    const loc = String(location || "").trim();
    const lay = String(variation || "").trim();
    const full = lay ? lookup(`${loc} ${lay}`) : null;
    if (full != null) return { name: full, layout: "" };
    let mapped = lookup(loc);
    if (mapped == null) mapped = contains(loc);
    const name = mapped != null ? mapped : tidy(loc);
    // tracado sem o ano no fim ("Spa_Francorchamps_2022" -> "Spa Francorchamps"),
    // e escondido quando e so o nome da pista de novo
    let layout = tidy(lay).replace(/\s*\b(19|20)\d\d$/, "").trim();
    // tracado que comeca com o nome da pista: so o resto ("Interlagos GP" -> "GP")
    if (layout.toLowerCase().startsWith(name.toLowerCase() + " ")) layout = layout.slice(name.length).trim();
    return { name, layout: layout && trackKey(layout) !== trackKey(name) ? layout : "" };
  }

  // ---- etapa da temporada (RLT) que corresponde a pista do jogo ----
  // Texto simplificado para comparar nomes de pista: sem acento, sem
  // pontuacao, sem ano no fim ("interlagos.scb.2011" -> "interlagos scb").
  function trackKey(text) {
    return String(text || "")
      .replace(/([a-z])([A-Z])/g, "$1 $2") // nomes colados do jogo: "CampoGrande" -> "Campo Grande"
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\b(19|20)\d\d\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // Dois nomes batem se sao iguais ou se um contem o outro em palavras
  // inteiras ("interlagos" e "interlagos scb"; "nurburgring" e "nurburgring vedool").
  function sameTrack(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    // "campogrande" e "campo grande": iguais sem os espacos
    if (a.replace(/ /g, "") === b.replace(/ /g, "")) return true;
    return ` ${a} `.includes(` ${b} `) || ` ${b} `.includes(` ${a} `);
  }

  // Procura, nas etapas da temporada, a que acontece na pista do jogo.
  //   events:   rltConfig.events
  //   names:    nomes da pista no jogo (o que o jogo manda, o do
  //             track-names.js, pista + tracado...)
  //   nowMs:    agora, para desempatar quando a pista aparece em mais de uma etapa
  // Entre as que batem, vale a etapa mais perto de hoje, de preferencia uma
  // que ainda nao foi concluida. Sem nenhuma, devolve null.
  function matchEvent(events, names, nowMs) {
    const mine = (names || []).map(trackKey).filter(Boolean);
    if (!mine.length) return null;
    const hits = (events || []).filter((e) => {
      const theirs = [e.trackName, e.name, e.circuitOrigin, e.uniqueName].map(trackKey).filter(Boolean);
      return theirs.some((t) => mine.some((m) => sameTrack(t, m)));
    });
    if (!hits.length) return null;
    const distance = (e) => {
      const t = Date.parse(e.eventDate || "");
      return Number.isNaN(t) ? Infinity : Math.abs(t - nowMs);
    };
    const done = (e) => (String(e.completedStatus || "").toLowerCase() === "completed" ? 1 : 0);
    return hits.slice().sort((a, b) => done(a) - done(b) || distance(a) - distance(b) || (a.round || 0) - (b.round || 0))[0];
  }

  // Procura, nas pistas de um multiseason do RLT, a pista do jogo.
  //   tracks:     pistas do multiseason (com name, trackName, circuitName,
  //               circuitOrigin, uniqueName, totalEvents)
  //   names:      nomes da pista no jogo, como no matchEvent
  //   uniqueName: o da etapa do RLT que bateu com a pista (opcional); quando
  //               existe, vale ele, que e exato
  // Nome igual tem prioridade sobre "um contem o outro" ("Interlagos" nao
  // pega "Interlagos SCB" se as duas existirem). No empate, a pista com mais
  // etapas. Sem nenhuma, devolve null.
  function matchTrack(tracks, names, uniqueName) {
    const list = tracks || [];
    if (uniqueName) {
      const exact = list.find((t) => t.uniqueName && String(t.uniqueName).toLowerCase() === String(uniqueName).toLowerCase());
      if (exact) return exact;
    }
    const mine = (names || []).map(trackKey).filter(Boolean);
    if (uniqueName) mine.unshift(trackKey(uniqueName));
    if (!mine.length) return null;
    const keys = (t) => [t.circuitName, t.trackName, t.name, t.circuitOrigin, t.uniqueName].map(trackKey).filter(Boolean);
    const best = (hits) => (hits.length ? hits.slice().sort((a, b) => (b.totalEvents || 0) - (a.totalEvents || 0))[0] : null);
    return (
      best(list.filter((t) => keys(t).some((k) => mine.includes(k)))) ||
      best(list.filter((t) => keys(t).some((k) => mine.some((m) => sameTrack(k, m)))))
    );
  }

  // Pais como o RLT informa (em ingles) -> portugues. O que nao estiver aqui
  // aparece como veio.
  const COUNTRIES_PT = {
    brazil: "Brasil", argentina: "Argentina", "united states": "Estados Unidos", "united states of america": "Estados Unidos", usa: "Estados Unidos", canada: "Canadá", mexico: "México",
    germany: "Alemanha", italy: "Itália", france: "França", spain: "Espanha", portugal: "Portugal", belgium: "Bélgica", netherlands: "Holanda",
    "united kingdom": "Reino Unido", uk: "Reino Unido", "great britain": "Reino Unido", england: "Inglaterra", austria: "Áustria", hungary: "Hungria",
    monaco: "Mônaco", switzerland: "Suíça", "czech republic": "República Tcheca", turkey: "Turquia", russia: "Rússia", japan: "Japão", china: "China",
    australia: "Austrália", "south africa": "África do Sul", bahrain: "Bahrein", "saudi arabia": "Arábia Saudita", "united arab emirates": "Emirados Árabes",
    uae: "Emirados Árabes", qatar: "Catar", singapore: "Singapura", malaysia: "Malásia", azerbaijan: "Azerbaijão", uruguay: "Uruguai", chile: "Chile",
  };

  // Arquivo da bandeira no repositorio de imagens (pasta country/): o nome do
  // pais como o RLT informa, em minusculas, com "_" no lugar dos espacos.
  // Etiqueta de punicao pendente: DT (drive-through) ou SG (stop & go) no AMS2;
  // no LMU o jogo so informa quantas ha (PEN, ou PEN x2). Sem punicao: "".
  const PENALTY_SHORT = { driveThrough: "DT", stopGo: "SG" };
  function penaltyLabel(entry) {
    if (!entry) return "";
    if (entry.penaltyType && PENALTY_SHORT[entry.penaltyType]) return PENALTY_SHORT[entry.penaltyType];
    if (entry.penalties > 0) return entry.penalties > 1 ? `PEN x${entry.penalties}` : "PEN";
    return "";
  }

  function flagFile(country) {
    const slug = String(country || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    return slug ? `country/${slug}.png` : null;
  }

  // Numero da bateria (corrida 1, 2... ou quali 1, 2...) para o cabecalho.
  //   heats:    baterias daquele tipo na etapa, em ordem, com `completed`
  //             (resultado ja lancado no RLT)
  //   override: escolha do painel. null/undefined = automatico; 0 = sem
  //             numero; outro numero = essa bateria
  // No automatico vale a primeira bateria ainda sem resultado; se todas ja
  // tem, a ultima. Etapa com uma bateria so (ou sem etapa) fica sem numero.
  function heatNumber(heats, override) {
    if (override != null && override !== "") {
      const n = Math.floor(Number(override));
      return n > 0 ? n : null;
    }
    const list = heats || [];
    if (list.length <= 1) return null;
    const next = list.findIndex((h) => !(h && h.completed));
    return next === -1 ? list.length : next + 1;
  }

  function countryName(country) {
    const text = String(country || "").trim();
    return COUNTRIES_PT[text.toLowerCase()] || text;
  }

  return {
    setConfig,
    trackDisplay,
    matchEvent,
    matchTrack,
    trackKey,
    countryName,
    flagFile,
    penaltyLabel,
    heatNumber,
    formatClassName,
    hashColor,
    classColor,
    teamSlug,
    manufacturerName,
    carDisplayName,
    carLogo,
    carLogoFromTeam,
    teamLogoFile,
    logoPaths,
    applyGameClassNames,
  };
});
