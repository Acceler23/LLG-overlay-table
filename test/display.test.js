const test = require("node:test");
const assert = require("node:assert/strict");
const display = require("../overlay/shared/display");

display.setConfig({
  classNameOverrides: { GT3_Gen2: "GT3 Gen 2" },
  classColors: { "GT3 Gen 2": "#bf0000", GT4: "#267f00" },
  defaultColor: "rgb(0, 98, 255)",
  carLogos: { Porsche: "porsche.png", McLaren: "mclaren.png" },
  teamLogoOverrides: { Apex: "apex_racing.png", "E.C.H.O": "echo.png" },
});

test("nome de classe: override, sufixos tecnicos e underline", () => {
  assert.equal(display.formatClassName("GT3_Gen2"), "GT3 Gen 2");
  assert.equal(display.formatClassName("GT4_HD"), "GT4");
  assert.equal(display.formatClassName("Carrera_Cup"), "Carrera Cup");
  assert.equal(display.formatClassName("Porsche 911 GT3 Cup 3.8"), "Porsche 911 GT3 Cup 3.8");
});

test("cor de classe: RLT, depois CLASS_COLORS pelo nome formatado, depois derivada", () => {
  const rlt = [{ uniqueName: "pro", name: "Cup", color: "#FFBF0000" }];
  assert.equal(display.classColor("pro", rlt), "#BF0000");
  assert.equal(display.classColor("GT3_Gen2", null), "#bf0000");
  assert.equal(display.classColor("GT4_HD", null), "#267f00");
  assert.match(display.classColor("Classe Nova", null), /^hsl\(/);
  assert.equal(display.classColor("—", null), "rgb(0, 98, 255)");
});

test("logo de equipe: painel, depois TEAM_LOGO_OVERRIDES, depois o nome", () => {
  assert.equal(display.teamLogoFile("Apex", {}), "apex_racing.png");
  assert.equal(display.teamLogoFile("Apex", { Apex: "outro.png" }), "outro.png");
  assert.equal(display.teamLogoFile("Hell Machine", {}), "hell_machine.png");
  assert.equal(display.teamLogoFile("Fênix", null), "fenix.png");
  assert.equal(display.teamLogoFile("", {}), null);
});

test("caminhos de logo: equipe primeiro, carro como reserva", () => {
  assert.deepEqual(display.logoPaths("Apex", "Porsche 911 GT3 R", {}), ["teams/apex_racing.png", "cars/porsche.png"]);
  // equipe com nome de montadora usa o logo da montadora como reserva
  assert.deepEqual(display.logoPaths("McLaren", "Carro Desconhecido", {}), ["teams/mclaren.png", "cars/mclaren.png"]);
  assert.deepEqual(display.logoPaths(null, "Porsche 911", {}), [null, "cars/porsche.png"]);
  // variantes para fundo escuro (light) e claro (dark): vem antes do logo normal
  assert.deepEqual(display.logoPaths("Apex", "Porsche 911 GT3 R", {}, "light"), ["teams/apex_racing__light.png", "teams/apex_racing.png", "cars/porsche__light.png", "cars/porsche.png"]);
  assert.deepEqual(display.logoPaths(null, "Porsche 911", {}, "dark"), [null, null, "cars/porsche__dark.png", "cars/porsche.png"]);
  assert.deepEqual(display.logoPaths("Apex", "Porsche 911 GT3 R", {}, "outra"), ["teams/apex_racing.png", "cars/porsche.png"]);
});

test("nome da pista: lista do drivers-config, senao o nome do jogo arrumado", () => {
  const { trackDisplay, setConfig } = require("../overlay/shared/display");
  setConfig({ trackNames: { Kansai: "Suzuka", "Interlagos Kart 1": "Kartódromo de Interlagos" } });
  try {
    assert.deepEqual(trackDisplay("Kansai", ""), { name: "Suzuka", layout: "" });
    assert.deepEqual(trackDisplay("kansai", "GP"), { name: "Suzuka", layout: "GP" }); // sem diferenciar maiusculas
    assert.deepEqual(trackDisplay("Interlagos", "Kart 1"), { name: "Kartódromo de Interlagos", layout: "" }); // pista + tracado
    assert.deepEqual(trackDisplay("Interlagos", "GP"), { name: "Interlagos", layout: "GP" });
    assert.deepEqual(trackDisplay("ks_vallelunga", "extended_circuit"), { name: "Vallelunga", layout: "Extended Circuit" });
    assert.deepEqual(trackDisplay("spa", "spa"), { name: "Spa", layout: "" }); // tracado igual ao nome nao repete
    assert.deepEqual(trackDisplay("Circuit de Spa-Francorchamps", ""), { name: "Circuit de Spa-Francorchamps", layout: "" });
    assert.deepEqual(trackDisplay("", ""), { name: "", layout: "" });
  } finally {
    setConfig(null);
  }
});

test("etapa do RLT que bate com a pista do jogo", () => {
  const { matchEvent, countryName } = require("../overlay/shared/display");
  const events = [
    { round: 1, trackName: "Nurburgring Vedool", uniqueName: "nurburgring.vedool.2002", circuitOrigin: "Nurburgring", eventDate: "2026-09-17", completedStatus: "Completed" },
    { round: 4, trackName: "Suzuka", uniqueName: "suzuka.2003", circuitOrigin: "Suzuka", eventDate: "2026-10-08", completedStatus: "Completed" },
    { round: 5, trackName: "Spielberg", uniqueName: "spielberg.2016", circuitOrigin: "Speilberg", eventDate: "2026-10-15", completedStatus: "InFuture", country: "Austria" },
    { round: 6, trackName: "Interlagos SCB ", uniqueName: "interlagos.scb.2011", circuitOrigin: "Interlagos", eventDate: "2026-11-08", completedStatus: "InFuture" },
  ];
  const now = Date.parse("2026-10-09T00:00:00Z");
  assert.equal(matchEvent(events, ["Spielberg", "RedBull Ring"], now).round, 5); // o nome do jogo bate, mesmo com outro nome no track-names.js
  assert.equal(matchEvent(events, ["Kansai", "Suzuka"], now).round, 4); // bate pelo nome trocado no track-names.js
  assert.equal(matchEvent(events, ["Nürburgring", "Nürburgring GP"], now).round, 1); // acento e nome mais curto
  assert.equal(matchEvent(events, ["Interlagos", "Interlagos GP"], now).round, 6); // "Interlagos" dentro de "Interlagos SCB"
  assert.equal(matchEvent(events, ["Monza"], now), null);
  assert.equal(matchEvent(events, ["", null], now), null);
  assert.equal(matchEvent(events, ["Spa"], now), null); // "spa" nao e "spielberg"
  assert.equal(countryName("Austria"), "Áustria");
  assert.equal(countryName("Brazil"), "Brasil");
  assert.equal(countryName("Wakanda"), "Wakanda");
  assert.equal(countryName(null), "");
});

test("pista repetida no calendario: vale a etapa nao concluida mais perto de hoje", () => {
  const { matchEvent } = require("../overlay/shared/display");
  const events = [
    { round: 1, trackName: "Cascavel", eventDate: "2026-09-01", completedStatus: "Completed" },
    { round: 3, trackName: "Cascavel", eventDate: "2026-10-18", completedStatus: "InFuture" },
    { round: 5, trackName: "Cascavel", eventDate: "2026-11-25", completedStatus: "InFuture" },
  ];
  assert.equal(matchEvent(events, ["Cascavel"], Date.parse("2026-10-17T20:00:00Z")).round, 3);
  assert.equal(matchEvent(events, ["Cascavel"], Date.parse("2026-11-24T20:00:00Z")).round, 5);
  // todas concluidas: a mais recente em relacao a hoje
  const done = events.map((e) => Object.assign({}, e, { completedStatus: "Completed" }));
  assert.equal(matchEvent(done, ["Cascavel"], Date.parse("2026-12-01T00:00:00Z")).round, 5);
});

test("numero da bateria: pelo que ja tem resultado, ou pela escolha do painel", () => {
  const { heatNumber, flagFile } = require("../overlay/shared/display");
  const two = (a, b) => [{ caption: "Race 1", completed: a }, { caption: "Race 2", completed: b }];
  assert.equal(heatNumber(two(false, false)), 1); // nada lancado: corrida 1
  assert.equal(heatNumber(two(true, false)), 2); // corrida 1 ja tem resultado
  assert.equal(heatNumber(two(true, true)), 2); // tudo lancado: fica na ultima
  assert.equal(heatNumber([{ completed: false }]), null); // etapa de uma corrida so: sem numero
  assert.equal(heatNumber([]), null);
  assert.equal(heatNumber(null), null); // sem etapa
  // escolha do painel: 0 = sem numero, outro = essa bateria, vazio = automatico
  assert.equal(heatNumber(two(true, false), 0), null);
  assert.equal(heatNumber(two(false, false), 2), 2);
  assert.equal(heatNumber(null, 3), 3);
  assert.equal(heatNumber(two(true, false), null), 2);
  assert.equal(heatNumber(two(true, false), ""), 2);
  // arquivo da bandeira
  assert.equal(flagFile("United States Of America"), "country/united_states_of_america.png");
  assert.equal(flagFile("Brazil"), "country/brazil.png");
  assert.equal(flagFile(""), null);
});

test("nome da pista: chave com * vale para qualquer nome que contenha o trecho", () => {
  const { trackDisplay, setConfig } = require("../overlay/shared/display");
  setConfig({ trackNames: { "*Daytona": "Daytona", "*Carlos Pace": "Interlagos", "*Sarthe": "Le Mans", "Circuit de la Sarthe Mulsanne": "Le Mans (sem chicanes)" } });
  try {
    assert.deepEqual(trackDisplay("Daytona International Speedway Road Course", ""), { name: "Daytona", layout: "" });
    assert.deepEqual(trackDisplay("Autódromo José Carlos Pace", ""), { name: "Interlagos", layout: "" }); // sem diferenciar acento
    assert.deepEqual(trackDisplay("AUTODROMO JOSE CARLOS PACE", ""), { name: "Interlagos", layout: "" });
    assert.deepEqual(trackDisplay("Circuit de la Sarthe", ""), { name: "Le Mans", layout: "" });
    assert.deepEqual(trackDisplay("Circuit de la Sarthe Mulsanne", ""), { name: "Le Mans (sem chicanes)", layout: "" }); // a chave exata ganha
    assert.deepEqual(trackDisplay("Sebring International Raceway", ""), { name: "Sebring International Raceway", layout: "" }); // sem regra: como veio
  } finally {
    setConfig(null);
  }
});

test("nome do carro sem o sufixo de downforce/speedway", () => {
  assert.equal(display.carDisplayName("Formula Ultimate Gen2 - Low Downforce"), "Formula Ultimate Gen2");
  assert.equal(display.carDisplayName("Stock Car Pro 2023 - High Downforce"), "Stock Car Pro 2023");
  assert.equal(display.carDisplayName("Formula Vintage - speedway"), "Formula Vintage");
  assert.equal(display.carDisplayName("Porsche 911 GT3 R"), "Porsche 911 GT3 R");
  assert.equal(display.carDisplayName(null), "");
});

test("etapa do RLT: nome colado do jogo bate com o nome com espaco", () => {
  const events = [
    { round: 3, trackName: "Jacarepagua", uniqueName: "jacarepagua.1996", country: "Brazil" },
    { round: 4, trackName: "Campo Grande", uniqueName: "campo.grande.2009", country: "Brazil" },
  ];
  // o AMS2 manda "CampoGrande" como pista e como tracado
  const hit = display.matchEvent(events, ["CampoGrande", "CampoGrande CampoGrande"], Date.parse("2026-10-17"));
  assert.equal(hit && hit.round, 4);
  // tudo em minusculas e colado tambem
  assert.equal(display.matchEvent(events, ["campogrande"], 0).round, 4);
  assert.equal(display.matchEvent(events, ["Interlagos"], 0), null);
});

test("logo do carro: nome inteiro, trecho com * e por fim a marca", () => {
  display.setConfig({
    carLogos: { Chevrolet: "chevrolet.png", Corvette: "corvette.png", "*Corvette": "corvette.png", "Copa Uno": "fiat.png", Porsche: "porsche.png" },
    teamLogoOverrides: {},
  });
  assert.equal(display.carLogo("Corvette Z06 GT3.R"), "corvette.png"); // LMU
  assert.equal(display.carLogo("Chevrolet Corvette C8.R"), "corvette.png"); // * vence a marca
  assert.equal(display.carLogo("Chevrolet Camaro"), "chevrolet.png");
  assert.equal(display.carLogo("Copa Uno"), "fiat.png");
  assert.equal(display.carLogo("Porsche 911 GT3 R"), "porsche.png");
  assert.equal(display.carLogo(""), undefined);
});

test("logo da equipe: painel, nome exato, trecho com * e por fim o nome", () => {
  display.setConfig({ carLogos: {}, teamLogoOverrides: { Apex: "apex_racing.png", "*WRT": "wrt.png", "*square": "square.png" } });
  assert.equal(display.teamLogoFile("Apex", {}), "apex_racing.png");
  assert.equal(display.teamLogoFile("BMW M Team WRT", {}), "wrt.png"); // nome do LMU
  assert.equal(display.teamLogoFile("SQUARE Racing #12", {}), "square.png"); // sem diferenciar maiusculas
  assert.equal(display.teamLogoFile("Hell Machine", {}), "hell_machine.png");
  assert.equal(display.teamLogoFile("BMW M Team WRT", { "BMW M Team WRT": "outro.png" }), "outro.png"); // o painel vence
});

test("nome da pista colado do AMS2: separa as palavras, tira o ano e nao repete o tracado", () => {
  display.setConfig({ trackNames: {} });
  assert.deepEqual(display.trackDisplay("SpaFrancorchamps", "Spa_Francorchamps_2022"), { name: "Spa Francorchamps", layout: "" });
  assert.deepEqual(display.trackDisplay("CampoGrande", "CampoGrande"), { name: "Campo Grande", layout: "" });
  assert.deepEqual(display.trackDisplay("Nurburgring", "Nordschleife_2020"), { name: "Nurburgring", layout: "Nordschleife" });
  assert.deepEqual(display.trackDisplay("Interlagos", "GP"), { name: "Interlagos", layout: "GP" });
  assert.deepEqual(display.trackDisplay("Interlagos", "Interlagos_GP"), { name: "Interlagos", layout: "GP" });
});

test("penaltyLabel: DT e SG no AMS2, PEN com a quantidade no LMU, vazio sem punicao", () => {
  assert.equal(display.penaltyLabel({ penaltyType: "driveThrough", penalties: 1 }), "DT");
  assert.equal(display.penaltyLabel({ penaltyType: "stopGo" }), "SG");
  assert.equal(display.penaltyLabel({ penalties: 1 }), "PEN");
  assert.equal(display.penaltyLabel({ penalties: 3 }), "PEN x3");
  assert.equal(display.penaltyLabel({ penalties: 0 }), "");
  assert.equal(display.penaltyLabel({ penaltyType: "desconhecido" }), "");
  assert.equal(display.penaltyLabel(null), "");
});
