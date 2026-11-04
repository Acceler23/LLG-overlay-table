// tools/obs-montar.js
//
// Monta as overlays no OBS pela linha de comando: o mesmo que o botao
// "Montar no OBS" do painel (server/obsSetup.js).
//
//   node tools/obs-montar.js [--unica] [--porta-http=8080]
//
// Padrao: uma fonte de navegador por overlay (tabela, driver card, mapa,
// G-force), para mostrar e esconder cada uma em momentos diferentes da corrida.
// Fonte escondida nao desenha (overlay/shared/framecap.js), entao so custa CPU
// a que esta na tela. --unica: uma fonte so com todas (overlay/cena.html), mais
// barata com as quatro sempre visiveis. Um modo apaga as fontes do outro.
//
// Precisa do servidor WebSocket do OBS ligado; a senha e lida do proprio OBS.

const { createObsSetup } = require("../server/obsSetup");

const args = {};
for (const a of process.argv.slice(2)) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  if (m) args[m[1]] = m[2] === undefined ? true : m[2];
}

(async () => {
  const obs = createObsSetup({ httpPort: Number(args["porta-http"]) || Number(process.env.HTTP_PORT) || 8080 });
  try {
    const r = await obs.setup({ unica: !!args.unica });
    r.done.forEach((d) => console.log(d));
    console.log(`Pronto: cena "${r.scene}" (canvas ${r.canvas}).`);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    obs.close();
  }
})();
