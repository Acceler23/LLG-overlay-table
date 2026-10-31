// overlay/shared/names.js
// Normalizacao de nomes e casamento "nome no jogo" -> piloto do RLT.
// Usado pela tabela, pelo driver card (global LLGNames) e pelo servidor (require).
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.LLGNames = api;
})(typeof self !== "undefined" ? self : this, function () {
  const DEFAULT_MIN_SCORE = 0.98;

  // Nome comparavel: sem acento, sem pontuacao, minusculo. Tambem tira as
  // etiquetas de categoria que os pilotos poem no nome do jogo, entre colchetes
  // ou parenteses ("Nei Alves [AM]", "Daniel_Moura(AM)"), e separa nomes
  // grudados com maiuscula no meio ("LeonardoBorges" -> "leonardo borges").
  function normalizeName(name) {
    return String(name || "")
      .replace(/\s*#\d+\s*$/, "") // codigo da conta no online do LMU: "Felipe Antunes#1005"
      .replace(/\[[^\]]*\]/g, "")
      .replace(/\([^)]*\)/g, "")
      .replace(/([a-zà-ÿ])([A-ZÀ-Þ])/g, "$1 $2")
      .replace(/[​-‍﻿­]/g, "")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[|\/\\]+/g, " ")
      .replace(/\./g, " ")
      .replace(/[^a-zA-Z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function nameCandidates(raw) {
    const parts = String(raw || "")
      .split(/[|\/\\]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!parts.length) parts.push(String(raw || ""));
    const out = new Set();
    parts.forEach((p) => {
      const n = normalizeName(p);
      if (n) out.add(n);
    });
    const full = normalizeName(raw);
    if (full) out.add(full);
    return Array.from(out);
  }

  function levenshtein(a, b) {
    const m = a.length;
    const n = b.length;
    if (!m) return n;
    if (!n) return m;
    const dp = new Array(n + 1);
    for (let j = 0; j <= n; j++) dp[j] = j;
    for (let i = 1; i <= m; i++) {
      let prev = dp[0];
      dp[0] = i;
      for (let j = 1; j <= n; j++) {
        const tmp = dp[j];
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + cost);
        prev = tmp;
      }
    }
    return dp[n];
  }

  function nameSimilarity(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    const maxLen = Math.max(a.length, b.length);
    if (!maxLen) return 0;
    return 1 - levenshtein(a, b) / maxLen;
  }

  function tokenJaccard(aTokens, bTokens) {
    if (!aTokens.length || !bTokens.length) return 0;
    const A = new Set(aTokens);
    const B = new Set(bTokens);
    let inter = 0;
    A.forEach((t) => {
      if (B.has(t)) inter += 1;
    });
    return inter / (A.size + B.size - inter);
  }

  // O sobrenome bateu. O resto do nome do jogo ("given") combina com o
  // primeiro nome do candidato? Devolve a nota, ou 0 se contradiz. Isso
  // impede "J. Santos" de virar "Leandro Santos".
  function givenCompat(given, candFirst) {
    if (!given.length) return 0.99; // apenas o sobrenome no jogo
    if (!candFirst) return 0.985; // primeiro nome do candidato desconhecido
    const g = given[0];
    if (g.length === 1) return candFirst.startsWith(g) ? 0.995 : 0;
    if (candFirst.length === 1) return g.startsWith(candFirst) ? 0.995 : 0;
    if (g === candFirst) return 0.997;
    if (g.length >= 3 && candFirst.length >= 3 && (g.startsWith(candFirst) || candFirst.startsWith(g))) return 0.99;
    if (nameSimilarity(g, candFirst) >= 0.8) return 0.99;
    return 0;
  }

  // Nota de 0 a 1 entre um nome do jogo (normalizado) e um nome/alias do piloto.
  // 1 = texto identico. Sobrenome igual conta apenas se o primeiro nome nao contradiz.
  function scoreName(target, tTokens, al, driverFirst, aliasIsLastName, aliasIsPartial) {
    if (!al) return 0;
    // identico a um nome completo vale 1; identico apenas ao sobrenome ou ao
    // primeiro nome vale menos, para o nome completo de outro carro vencer
    if (target === al) return aliasIsPartial ? 0.99 : 1;
    // mesmo nome com ou sem espaco ("jhonismicael" e "jhonis micael")
    if (!aliasIsPartial && target.replace(/ /g, "") === al.replace(/ /g, "")) return 0.995;
    let score = nameSimilarity(target, al);
    const alTokens = al.split(" ").filter(Boolean);

    const jac = tokenJaccard(tTokens, alTokens);
    score = Math.max(score, jac >= 1 ? 0.999 : jac); // mesmos nomes em outra ordem

    const tLast = tTokens[tTokens.length - 1] || "";
    if (tLast.length >= 3) {
      const surnameHit = alTokens.includes(tLast) || (tLast.length >= 4 && al.endsWith(tLast));
      if (surnameHit) {
        const candFirst = alTokens.length >= 2 && !aliasIsLastName ? alTokens[0] : driverFirst;
        score = Math.max(score, givenCompat(tTokens.slice(0, -1), candFirst));
      }
    }

    if (tTokens.length === 1 && target.length >= 3) {
      for (const t of alTokens) {
        const sim = nameSimilarity(target, t);
        if (sim >= 0.9) score = Math.max(score, Math.min(sim, 0.99));
        if (t.startsWith(target) || target.startsWith(t)) {
          const ratio = Math.min(t.length, target.length) / Math.max(t.length, target.length);
          if (ratio >= 0.8) score = Math.max(score, Math.min(ratio, 0.99));
        }
      }
      if (target.length >= 4 && al.includes(target)) score = Math.max(score, 0.98);
    }

    if (target.includes(al) || al.includes(target)) {
      const ratio = Math.min(target.length, al.length) / Math.max(target.length, al.length);
      if (ratio >= 0.75) score = Math.max(score, Math.min(Math.max(ratio, 0.9), 0.99));
    }
    return score;
  }

  function prepDriver(d) {
    const firstFull = normalizeName(d.firstName);
    const driverFirst = firstFull.split(" ")[0] || "";
    const lastName = normalizeName(d.lastName);
    const set = new Set();
    (d.aliases || []).forEach((a) => {
      const n = normalizeName(a);
      if (n) set.add(n);
    });
    [d.driverName, d.displayName, d.inGameName, `${d.firstName || ""} ${d.lastName || ""}`, d.lastName].forEach((v) => {
      const n = normalizeName(v);
      if (n) set.add(n);
    });
    return { d, driverFirst, firstFull, lastName, names: Array.from(set) };
  }

  function scoreDriver(target, tTokens, p) {
    let best = 0;
    for (const al of p.names) {
      const isLast = al === p.lastName;
      const s = scoreName(target, tTokens, al, p.driverFirst, isLast, isLast || al === p.firstFull);
      if (s > best) best = s;
      if (best >= 1) break;
    }
    return best;
  }

  // Junta rltConfig.drivers e rltConfig.standingsRows numa lista unica de pilotos.
  function buildPool(rltConfig) {
    const list = [];
    const seen = new Set();
    function add(d) {
      if (!d) return;
      const key = normalizeName(d.displayName || d.driverName || `${d.firstName || ""} ${d.lastName || ""}`);
      if (!key || seen.has(key)) return;
      seen.add(key);
      list.push(d);
    }
    if (!rltConfig) return list;
    (rltConfig.drivers || []).forEach(add);
    (rltConfig.standingsRows || []).forEach((row) => {
      add({
        displayName: row.displayName,
        driverName: row.driverName,
        inGameName: row.inGameName,
        firstName: row.firstName,
        lastName: row.lastName,
        teamName: row.teamName,
        teamFullName: row.teamFullName,
        teamPrimaryColor: row.teamPrimaryColor,
        teamSecondaryColor: row.teamSecondaryColor,
        raceNumber: row.raceNumber,
        aliases: row.aliases || [],
        uniqueName: row.classUniqueName,
        name: row.className,
        color: row.color,
        position: row.position,
        points: row.points,
        pointsRaw: row.pointsRaw,
        gapToLeader: row.gapToLeader,
      });
    });
    return list;
  }

  // Casador com atribuicao 1 para 1: cada piloto do RLT fica com no maximo um
  // nome do jogo, e empate entre dois pilotos nao e resolvido no chute.
  //   opts.explicitMap: { "nome no jogo": "nome no RLT" } (RLT_INGAME_MAP)
  function createMatcher(pool, opts) {
    const options = opts || {};
    const minScore = options.minScore != null ? options.minScore : DEFAULT_MIN_SCORE;
    const explicitMap = options.explicitMap || null;
    const prepared = (pool || []).map(prepDriver);
    const known = new Map(); // nome cru -> [{ i, score }] em ordem decrescente
    let assigned = new Map(); // nome cru -> piloto

    function findExplicit(raw) {
      if (!explicitMap) return -1;
      const rawN = normalizeName(raw);
      const key = Object.keys(explicitMap).find((k) => {
        const kn = normalizeName(k);
        return kn === rawN || (rawN && kn && (rawN.endsWith(kn) || kn.endsWith(rawN)));
      });
      if (!key) return -1;
      const want = normalizeName(explicitMap[key]);
      if (!want) return -1;
      const wantParts = want.split(" ").filter(Boolean);
      const wantLast = wantParts[wantParts.length - 1] || "";
      // 1) nome identico em qualquer piloto vence
      for (let i = 0; i < prepared.length; i++) {
        if (prepared[i].names.includes(want)) return i;
      }
      // 2) aproximado: sobrenome igual, e primeiro nome igual quando informado
      for (let i = 0; i < prepared.length; i++) {
        const p = prepared[i];
        for (const n of p.names) {
          const parts = n.split(" ").filter(Boolean);
          const last = parts[parts.length - 1];
          if (wantParts.length === 1) {
            if (last === want) return i;
            if (n.endsWith(want) && want.length >= 4) return i;
            continue;
          }
          if (parts.length >= 2 && want.endsWith(n) && n.length >= 4) return i;
          if (parts.length >= 2 && n.endsWith(want)) return i;
          if (last === wantLast && wantLast.length >= 4) {
            if (parts.length >= 2 && parts[0] === wantParts[0]) return i;
            if (p.driverFirst === wantParts[0]) return i;
          }
        }
      }
      return -1;
    }

    // Nome marcado como "ignorar" (valor vazio na lista): nunca e ligado.
    function isIgnored(raw) {
      if (!explicitMap) return false;
      const rawN = normalizeName(raw);
      return Object.keys(explicitMap).some((k) => normalizeName(k) === rawN && !normalizeName(explicitMap[k]));
    }

    // Nome no jogo cadastrado no RLT identico ao do jogo: vem antes de qualquer
    // comparacao aproximada (sem diferenciar maiusculas, acentos e pontuacao).
    function exactInGame(raw) {
      const rawN = normalizeName(raw);
      if (!rawN) return [];
      const hits = [];
      prepared.forEach((p, i) => {
        const list = [p.d.inGameName].concat((p.d.inGameNames || []).map((x) => (x && x.name) || x));
        if (list.some((n) => n && normalizeName(n) === rawN)) hits.push(i);
      });
      return hits;
    }

    function rank(raw) {
      if (isIgnored(raw)) return [];
      const ex = findExplicit(raw);
      if (ex >= 0) return [{ i: ex, score: 2 }];
      const exact = exactInGame(raw);
      if (exact.length === 1) return [{ i: exact[0], score: 1.5 }];
      const targets = nameCandidates(raw).filter((t) => t && t !== "player");
      const best = new Map();
      for (const target of targets) {
        const tTokens = target.split(" ").filter(Boolean);
        prepared.forEach((p, i) => {
          const s = scoreDriver(target, tTokens, p);
          if (s >= minScore && s > (best.get(i) || 0)) best.set(i, s);
        });
      }
      return Array.from(best, ([i, score]) => ({ i, score })).sort((a, b) => b.score - a.score);
    }

    function resolveAll() {
      assigned = new Map();
      const taken = new Set();
      const pending = new Set(known.keys());
      for (;;) {
        let pick = null;
        for (const raw of pending) {
          const free = known.get(raw).filter((c) => !taken.has(c.i));
          if (!free.length) continue;
          // dois pilotos livres com a mesma nota: ambiguo, espera outro nome desempatar
          if (free.length > 1 && free[1].score >= free[0].score - 1e-9) continue;
          // empate entre dois nomes do jogo: fica com o nome mais completo
          const len = normalizeName(raw).length;
          if (!pick || free[0].score > pick.score || (free[0].score === pick.score && len > pick.len)) {
            pick = { raw, i: free[0].i, score: free[0].score, len };
          }
        }
        if (!pick) break;
        assigned.set(pick.raw, prepared[pick.i].d);
        taken.add(pick.i);
        pending.delete(pick.raw);
      }
    }

    // Registra todos os nomes da sessao de uma vez (resolve como conjunto).
    function prime(names) {
      let changed = false;
      (names || []).forEach((raw) => {
        const key = String(raw || "");
        if (known.has(key)) return;
        known.set(key, rank(key));
        changed = true;
      });
      if (changed) resolveAll();
    }

    function lookup(raw) {
      const key = String(raw || "");
      if (!known.has(key)) prime([key]);
      return assigned.get(key) || null;
    }

    // Situacao da ligacao: quem do jogo ficou com quem, quem ficou sem, quem
    // foi ignorado, e os pilotos do RLT que nao ficaram com ninguem.
    function status() {
      const taken = new Set(Array.from(assigned.values()));
      const unmatched = [];
      const ignored = [];
      known.forEach((_, raw) => {
        if (assigned.has(raw)) return;
        if (isIgnored(raw)) ignored.push(raw);
        else unmatched.push(raw);
      });
      return {
        linked: Array.from(assigned, ([raw, d]) => ({ name: raw, driver: d })),
        unmatched,
        ignored,
        freeDrivers: prepared.map((p) => p.d).filter((d) => !taken.has(d)),
      };
    }

    return { prime, lookup, status };
  }

  return {
    normalizeName,
    nameCandidates,
    nameSimilarity,
    scoreName,
    buildPool,
    createMatcher,
  };
});
