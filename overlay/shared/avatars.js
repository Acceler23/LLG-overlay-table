// overlay/shared/avatars.js
// Foto do piloto (pasta drivers/ do repositorio de imagens), para o driver card.
// Nome do arquivo: "<nome no RLT>__<nome no jogo>.png", por exemplo
// "Ben Keating__BenKeating88.png". Tambem vale so um dos dois:
// "Ben Keating.png" (nome no RLT ou nome no jogo).
// A comparacao ignora maiusculas, acentos e pontuacao ("Ben KEATING" = "ben keating").
// Ordem da busca:
//   1. nome no RLT e nome no jogo
//   2. nome no RLT (com ou sem nome no jogo no arquivo)
//   3. nome no jogo (como segunda parte, ou o nome inteiro do arquivo)
(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.LLGAvatars = api;
})(typeof self !== "undefined" ? self : this, function (root) {
  const names = typeof module === "object" && module.exports ? require("./names") : root.LLGNames;
  const norm = (s) => names.normalizeName(String(s || ""));

  // files: nomes de arquivo da pasta drivers/
  function createIndex(files) {
    return (files || [])
      .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
      .map((file) => {
        const base = file.replace(/\.[^.]+$/, "");
        const cut = base.indexOf("__");
        return cut >= 0
          ? { file, a: norm(base.slice(0, cut)), b: norm(base.slice(cut + 2)) }
          : { file, a: norm(base), b: null };
      })
      .filter((e) => e.a || e.b);
  }

  // rltNames: nomes do piloto no RLT (exibicao, nome e sobrenome...); gameName: nome no jogo
  function find(index, rltNames, gameName) {
    const rlt = (rltNames || []).map(norm).filter(Boolean);
    const game = norm(gameName);
    const pick = (test) => {
      const hit = (index || []).find(test);
      return hit ? hit.file : null;
    };
    return (
      (rlt.length && game && pick((e) => e.b && e.b === game && rlt.includes(e.a))) ||
      (rlt.length && pick((e) => rlt.includes(e.a))) ||
      (game && pick((e) => e.b === game || (!e.b && e.a === game))) ||
      null
    );
  }

  return { createIndex, find };
});
