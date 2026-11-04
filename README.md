# LLG Overlay (AMS2, LMU, ACC e Assetto Corsa)

Tabela de tempos, driver card e tela de pontuação para transmissões do
Automobilista 2, do Le Mans Ultimate, do Assetto Corsa Competizione e do Assetto Corsa, com integração opcional com o Racing League Tools (RLT) e o OBS.

```
├── start.bat              # sobe tudo: servidor, listener e hotkeys
├── app/                   # aplicativo (.exe): janela do painel e tabela do piloto sobre o jogo
├── listener.ps1           # le a Shared Memory do AMS2 e manda pro servidor via TCP
├── listener-lmu.ps1       # o mesmo para o Le Mans Ultimate
├── hotkeys.ps1            # atalhos globais (funcionam com o jogo em foco)
├── SharedMemory_AMS2.h    # header oficial do AMS2, so de referencia/consulta
├── SharedMemory_LMU/      # headers oficiais do LMU, so de referencia/consulta
├── .env.example           # modelo do arquivo .env (chave do RLT, OBS, portas)
├── server/
│   ├── index.js           # ponto de entrada: HTTP + WebSocket + bridge + OBS
│   ├── env.js             # le o arquivo .env
│   ├── wsServer.js        # WebSocket: broadcast da tabela + recebe comandos
│   ├── tcpBridge.js       # recebe o JSON que o listener.ps1 manda
│   ├── raceState.js       # largada, paradas, tempo de box e bandeiradas
│   ├── rltClient.js       # API do Racing League Tools (pilotos, classes, pontos)
│   └── obsController.js   # integracao opcional com obs-websocket
├── overlay/
│   ├── timing-table.*     # tabela de tempos / pontuacao (Browser Source no OBS)
│   ├── driver-card.*      # card do piloto em foco (Browser Source no OBS)
│   ├── g-force.*          # força G e aceleração do piloto em foco (Browser Source no OBS)
│   ├── driver-table.*     # tabela compacta para o piloto (classes + pontuacao ao vivo)
│   ├── drivers-config.js  # cores, logos, nomes de classe e tabela de pontos
│   ├── shared/            # codigo usado pela overlay E pelo servidor
│   │   ├── names.js       #   normalizacao e casamento de nomes com o RLT
│   │   ├── gaps.js        #   intervalo medido por tempo
│   │   └── colors.js      #   normalizacao de cores
│   └── assets/            # logos de equipes, carros e pistas
├── control-panel/         # painel de controle (outra aba/janela)
└── test/                  # testes automatizados (npm test)
```

## Como funciona

O Node no Windows tem um bug conhecido: o modulo de UDP descarta silenciosamente
certos pacotes de broadcast, e o AMS2 manda exatamente esse tipo. Por isso, em vez
de ler telemetria por UDP, o `listener.ps1` le direto a **Shared Memory** do jogo
(a mesma que SimHub e CrewChief usam), usando so os metodos prontos do .NET.

Fluxo: `jogo (Shared Memory) -> listener -> TCP local -> servidor -> WebSocket -> overlays no OBS`

A cada ciclo o listener copia a Shared Memory inteira e só aceita a cópia se o
número de sequência do jogo não mudou no meio, então um ciclo nunca mistura
dados de dois instantes diferentes.

O servidor guarda o que depende de histórico (posição de largada, paradas,
stint, tempo de box e instante da bandeirada). Recarregar a overlay no OBS não
perde esses dados. Reiniciar o servidor perde.

## Dois jogos: AMS2 e Le Mans Ultimate

Cada jogo tem o seu listener (`listener.ps1` para o AMS2, `listener-lmu.ps1`
para o LMU). Os dois ficam ligados ao mesmo tempo e mandam os dados no mesmo
formato; o servidor usa o jogo que estiver em sessão, então não é preciso
escolher nada. Tabela, driver card e tabela do piloto funcionam igual nos dois.

Só no LMU aparecem, **ao lado direito da tabela** (fora dela, como o relógio
da volta mais rápida), duas informações por piloto:
- **Pneu**: a letra do composto num círculo da cor dele: S branco, M amarelo,
  H vermelho, W azul. Com compostos diferentes na frente e atrás aparecem as
  duas letras.
- **VE**: energia virtual restante, em %. Fica amarela abaixo de 30% e
  vermelha abaixo de 15%. Carros sem energia virtual (LMP2) ficam em branco.

Os nomes e as cores das classes do LMU seguem o `drivers-config.js`: a lista
`LMU_CLASS_NAMES` diz como cada classe do jogo se chama aqui (`Hyper` vira
`Hypercar`, `GT3` vira `LMGT3`), e a cor é a de `CLASS_COLORS` para esse nome.

A tabela continua com 500 px. Com pneus, VE e o relógio ao lado, a fonte do
OBS precisa de pelo menos 650 px de largura no LMU.

No LMU a equipe e o número do carro vêm do próprio jogo e aparecem no driver
card mesmo sem temporada do RLT. O número de paradas também vem do jogo.

**Piloto em foco no LMU**: a memória do jogo não informa qual carro a câmera
está mostrando, então o servidor pergunta à API local do próprio LMU
(`http://localhost:6397/rest/watch/focus`). Assim o destaque e o driver card
acompanham a câmera também como espectador. Se a API não responder, vale o
carro do jogador.

Limitação no LMU: a linha amarela de "causou bandeira" não existe.

Os offsets usados pelo `listener-lmu.ps1` foram medidos compilando os headers
oficiais. Se uma atualização do LMU mudar as structs, precisam ser medidos de
novo. Os headers em `SharedMemory_LMU/` são da Studio 397 e a licença deles
não permite redistribuição: eles não vão para a pasta do aplicativo.

## Assetto Corsa Competizione

O ACC não mostra os adversários pela Shared Memory, então não tem listener: o
servidor conversa direto com a **API de transmissão** do jogo, a mesma que as
ferramentas de transmissão usam (`server/accClient.js`). Ele entra sozinho
quando o ACC está numa sessão, igual aos outros jogos.

A API precisa estar ligada no jogo. Em
`Documentos\Assetto Corsa Competizione\Config\broadcasting.json`:

```json
{ "updListenerPort": 9000, "connectionPassword": "asd", "commandPassword": "" }
```

Com `updListenerPort` em 0 a API fica desligada. O jogo só lê esse arquivo ao
abrir. A porta e a senha são lidas desse mesmo arquivo, então não há nada para
configurar aqui.

O que muda no ACC:
- **Piloto em foco**: vem do próprio jogo e acompanha a câmera, também como espectador.
- **Classe**: o jogo não informa; ela sai do modelo do carro (GT3, GT4, GT2,
  CUP, ST, CHL, TCX). Os nomes exibidos e as cores vêm de `ACC_CLASS_NAMES` e
  `CLASS_COLORS` no `drivers-config.js`.
- **Equipe e número** vêm do jogo e aparecem no driver card sem temporada do RLT.
- **Bandeirada**: o jogo não marca quem terminou. O líder é dado como terminado
  quando a corrida encerra, e os demais quando completam a volta em que estavam.
- **Não existe no ACC**: abandono (DNF), safety car e a linha de "causou bandeira".
- As corridas são por tempo, então o cabeçalho mostra o relógio e não voltas.

## Carsets do Automobilista 2

Em **Pilotar › Pinturas** cada temporada tem um botão de ligar e desligar
(`server/carsetLibrary.js`, a mesma lógica do Cubic Paint Shop):
- **Ligar**: na primeira vez baixa o carset e guarda numa biblioteca
  (`carsets\` na pasta de dados). Depois copia só as texturas usadas para
  `Overrides\<carro>\carset_<temporada>\` e acrescenta as pinturas no
  `<carro>.xml` do jogo entre os marcadores
  `<!-- TRANSPLANTE-CARSET:<temporada> -->` e `<!-- /TRANSPLANTE-CARSET:... -->`.
- **Desligar**: tira exatamente isso. As pinturas do piloto (fora dos
  marcadores) nunca são tocadas, um ID de pintura já ocupado nunca é
  sobrescrito, e o `<carro>.xml` original fica copiado em `.xml.pre-transplante`.
- O formato é o do Paint Shop: um carset ligado por um aparece ligado no outro.
- Pode ligar com o jogo aberto; vale quando ele carregar de novo.

A instalação antiga, descrita abaixo, continua no painel antigo. A lista vem do
arquivo `AMS2_CarsetList.json` do repositório de imagens, com o nome da
temporada e o link do arquivo no Google Drive:

```json
[{ "Season": "Porsche Cup - Temporada 4", "CarSet": "https://drive.google.com/file/d/.../view" }]
```

O arquivo pode ser `.zip`, `.rar` ou `.7z` (é aberto pelo extrator do próprio
Windows) e precisa ter uma pasta por carro, com o mesmo nome que o carro tem em
`<Automobilista 2>VehiclesTexturesCustomLiveriesOverrides`, na pasta do
jogo na Steam. Pode vir dentro de uma pasta com o nome do carset. Só as pastas
dos carros do carset são alteradas, e o jogo precisa estar fechado.

Modos de instalação:
- **Trocar as pinturas desses carros** (padrão): o que havia na pasta de cada
  carro do carset ganha `_old_` no início do nome (`lets_go` vira
  `_old_lets_go`) e o jogo deixa de usar; depois o carset é copiado. Nada é
  apagado, com uma exceção: se já existir um `_old_` com o mesmo nome, de uma
  instalação anterior, ele dá lugar ao novo.
- **Não mexer nas antigas**: copia por cima; arquivo de mesmo nome é substituído.
- **Só atualizar os arquivos que já existem com o mesmo nome**: não acrescenta
  nem renomeia nada.

Em nenhum modo o `<carro>_dist.xml` é substituído: ele é do próprio jogo.

## Assetto Corsa (o primeiro)

O Assetto Corsa só mostra para programas de fora os dados do carro do jogador.
Os dados de todos os carros só existem para apps Python que rodam dentro do
jogo, então a overlay tem um app pequeno, sem janela, em `ac-app/LLGOverlay`.
Ele manda os carros para o servidor (`server/acClient.js`), e o `listener.ps1`
completa com a sessão atual e o tempo restante.

Instalação, uma vez só: no painel, no fim da página, clique em **Instalar no
Assetto Corsa 1**. O botão acha o jogo nas bibliotecas da Steam, copia o app e
o ativa. Depois entre de novo na sessão. Se preferir fazer à mão:

1. Copie a pasta `ac-app/LLGOverlay` para `<Assetto Corsa>\apps\python\`.
2. Ative o app: no jogo, em Opções > Geral > UI Modules, marque "LLG Overlay".
   Ou acrescente em `Documentos\Assetto Corsa\cfg\python.ini`:

   ```ini
   [LLGOVERLAY]
   ACTIVE=1
   ```

3. Entre de novo na sessão. O jogo só carrega apps quando a sessão abre.

Funciona com o jogo puro, sem Content Manager nem Custom Shaders Patch.

O que muda no Assetto Corsa:
- **Piloto em foco**: o carro em foco na câmera do jogo.
- **Classe**: o jogo não tem classes de corrida. Vale a etiqueta com `#` do
  carro (`#GT3`, `#Supercars`...); sem ela, `Street` ou `Race`. Para trocar os
  nomes, use `AC_CLASS_NAMES` no `drivers-config.js`.
- **Nome do carro, equipe e número** vêm das pastas do carro e da pintura
  (`ui_car.json` e `ui_skin.json`).
- **Corrida por voltas** mostra voltas no cabeçalho; por tempo, o relógio.
- **Não existe no Assetto Corsa**: abandono (DNF), safety car, volta de
  formação e a linha de "causou bandeira".

## Aplicativo (.exe)

Para quem só quer usar, sem instalar Node nem abrir terminal:

```bash
npm install
npm run build
```

Isso gera a pasta `dist/LLG Overlay-win32-x64` (não compactada, cerca de
370 MB). Copie a pasta inteira para quem for usar; dentro dela está o
`LLG Overlay.exe` e um `LEIA-ME.txt`. Nem a chave do RLT nem o resto do seu
`.env` vão junto.

**Instalador (o jeito mais fácil para quem vai usar).** Um arquivo só, com
assistente em português, atalho na área de trabalho e desinstalador:

```bash
npm run installer
```

Gera `dist/LLG-Overlay-Setup-vX.Y.Z.exe` (cerca de 110 MB), com a versão do
`package.json`. Precisa do Inno Setup 6 (`winget install JRSoftware.InnoSetup`).
Os arquivos ficam em [`installer/`](installer/).

- Instala só para o usuário, **sem pedir administrador**, em
  `%LOCALAPPDATA%\Programs\LLG Overlay`. A pasta aceita escrita, então a
  atualização automática continua funcionando.
- Cria o atalho "LLG Overlay" na área de trabalho e no menu Iniciar, e oferece
  abrir o programa no fim.
- Se o programa estiver aberto, avisa e o fecha antes de copiar. Instalar uma
  versão nova por cima mantém as configurações.
- **Desinstalar**: Configurações > Aplicativos > Aplicativos instalados >
  LLG Overlay (ou "Desinstalar o LLG Overlay" no menu Iniciar). Fecha o programa,
  apaga a pasta inteira e os atalhos, tira o app do Assetto Corsa que o painel
  instala na pasta do jogo (e a linha dele no `python.ini`) e pergunta se apaga
  também as configurações em `%APPDATA%\LLG Overlay`. Os carsets instalados no
  AMS2 e as cenas criadas no OBS ficam: são do usuário.
- Para testes: `/VERYSILENT` instala sem perguntar nada (fecha o programa se
  estiver aberto); no desinstalador, `/VERYSILENT` mantém as configurações.

**Chave do RLT.** Na primeira vez que alguém abre o aplicativo, o painel pede
a chave de acesso e a guarda naquele computador (criptografada, no
`settings.json` da pasta de dados do usuário). Depois disso não pergunta mais.
Para gerar a chave que você passa para as pessoas:

```bash
npm run encrypt-key
```

O comando lê `RLT_API_KEY` do seu `.env` e mostra a chave criptografada
(começa com `llg1:`). É esse texto que a pessoa cola no aplicativo. Ele também
fica em `server/rlt-key.enc`, que está fora do git e não entra no aplicativo.
Quem tem o aplicativo e a chave criptografada consegue, com algum trabalho,
chegar à chave do RLT, então só passe para quem pode tê-la.

**Publicar uma versão pelo GitHub.** O arquivo `.github/workflows/release.yml`
faz o GitHub montar o aplicativo e criar um Release com o instalador e o zip
para download (o zip é o que a atualização automática baixa).
Para disparar, crie uma tag de versão:

```bash
git tag v0.2.0
git push origin v0.2.0
```

Ou, pelo site, vá em Actions > Release > Run workflow e informe a versão. Antes
de montar, ele confere a sintaxe dos arquivos `.js` e roda os testes; se algo
falhar, nenhum Release é criado. O download fica em
`https://github.com/<usuário>/<repositório>/releases/latest`. Num repositório
privado, só quem tem acesso a ele consegue baixar.

O aplicativo faz sozinho o que o `start.bat` faz em três janelas:
- sobe o servidor e inicia o listener e os atalhos, escondidos;
- abre o **painel de controle** numa janela própria, com os **links das overlays** prontos para copiar para o OBS;
- guarda a temporada aplicada para a próxima vez;
- mostra a **tabela do piloto** numa janela transparente por cima do jogo.

**Tabela do piloto**: versão compacta para quem está pilotando. Mostra a
classe do piloto com o líder e os carros em volta dele, os primeiros das
outras classes e, com temporada do RLT aplicada, a pontuação do campeonato
projetada ao vivo. No painel: marque "Mostrar sobre o jogo", use "Mover" para
arrastar e "Tamanho" para ajustar. O jogo precisa estar em **janela sem
bordas**; em tela cheia exclusiva a janela não aparece. Ela também funciona
como fonte de navegador (`/overlay/driver-table.html`) e não obedece aos
atalhos da tabela da transmissão.

Para ajustar cores, logos e pontos na pasta gerada, edite
`resources/app/overlay/drivers-config.js` (o painel tem um botão que abre a
pasta). As configurações e os registros do listener ficam em
`%APPDATA%\LLG Overlay`.

O aplicativo não é assinado: na primeira execução o Windows mostra o aviso do
SmartScreen ("Mais informações" → "Executar assim mesmo").

Em desenvolvimento, `npm run app` abre o mesmo aplicativo direto do código.

## Desempenho (PC no limite)

Medido num PC que mal roda o jogo (AMS2 + OBS + overlay, CPU a 93%):

| Peça | Antes | Agora |
| --- | --- | --- |
| Leitor do AMS2 (`listener.ps1`) | ~40% de um núcleo, 4 leituras/s | ~0,8%, 7-10 leituras/s |
| As 4 fontes do OBS visíveis (tabela, card, mapa, G-force) | ~41% | ~22% |
| Só a tabela visível | ~18% | ~3% |
| As 4 fontes escondidas | ~41% (escondida desenhava igual) | ~3% |
| Leitor do LMU com o LMU fechado | ~4% | ~0,5% |

- **Leitor do AMS2**: o trabalho de cada ciclo roda em C# compilado (o PowerShell só compila, com cache em `%LOCALAPPDATA%\LLG Overlay\cache`, e inicia). A saída é a mesma de antes, campo a campo. O leitor antigo fica em `listener-legacy.ps1`; `LLG_LISTENER_LEGACY=1` faz o aplicativo usar ele.
- **Fonte escondida não desenha**: o OBS avisa a página quando a fonte some (`obsSourceVisibleChanged`). Ela continua recebendo e calculando (histórico dos intervalos, setores, mapa), mas não desenha; ao aparecer, desenha na hora com os dados atuais (`overlay/shared/framecap.js`).
- **Escrita repetida não vira trabalho**: `overlay/shared/domguard.js`, o primeiro script de cada overlay, faz cada escrita no DOM (texto, classe, atributo, estilo) conferir o valor atual antes; igual, não escreve. Na fonte do OBS cada escrita fazia a página ser redesenhada e copiada, mesmo sem nada mudar na tela.
- **Uma fonte só (opcional)**: `overlay/cena.html` (1920×1080) junta tabela, driver card, mapa e G-force. Mais barata com as quatro sempre visíveis, mas não dá para mostrar e esconder cada uma no OBS. Parâmetros: `?sem=mapa,gforce` tira overlays; `?mapa=1480,20` muda o lugar de uma (x,y em px).
- **Montar no OBS**: `node tools/obs-montar.js` cria uma fonte por overlay na cena atual do OBS, com URL, tamanho e posição (precisa do servidor WebSocket do OBS ligado; a senha é lida do próprio OBS). `--unica` cria a fonte única (`cena.html`).
- A memória dos jogos é aberta só para leitura.

**Testar sem o jogo**: `node tools/replay-sessao.js [pasta]` reproduz uma sessão gravada pelo Cubic Racing Analyser pela mesma ponte do listener (`--vel=4`, `--inicio=600`, `--loop`).

**Dados de exemplo do "Editar na tela"**: com as overlays do piloto destravadas e o jogo fora de sessão, elas mostram 30 s de uma corrida de Stock Car em Curitiba, em loop, com os nomes trocados ("Piloto 01"..., "Você"), para dar para posicionar e dimensionar com algo na tela (`server/demo.js`, arquivo `server/demo/curitiba-stockcar.json.gz`). Só as janelas do piloto em edição usam; as overlays do OBS ignoram. Para gerar outro trecho: `node tools/replay-sessao.js [pasta] --demo=server/demo/curitiba-stockcar.json.gz --inicio=600 --dur=30`.

## Como rodar

Dê dois cliques em `start.bat`. Ele instala as dependências na primeira vez e
abre três janelas: servidor, listener e hotkeys.

Manualmente:

```bash
npm install
npm start
```

e, em outra janela do PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\listener.ps1
```

Depois:
- No AMS2: só precisa estar numa sessão.
- No OBS: Browser Source apontando para `http://localhost:8080/overlay/timing-table.html` (fundo transparente). O driver card fica em `http://localhost:8080/overlay/driver-card.html`.
- **Modo demo** (ver o layout sem o jogo): `.../timing-table.html?demo=1`.
- Painel de controle: `http://localhost:8080/panel/panel.html`.

## Configuração (.env)

Copie `.env.example` para `.env` e preencha. O `.env` fica fora do git.

| Variável | Para quê |
| --- | --- |
| `RLT_API_KEY` | Chave da API do Racing League Tools, para quem roda pelo código. Aceita a chave pura ou a criptografada (`llg1:...`). Sem ela, vale a chave salva pelo painel. |
| `OBS_WS_URL`, `OBS_WS_PASSWORD` | Conexão com o OBS (Ferramentas > WebSocket Server Settings). |
| `HTTP_PORT`, `BRIDGE_PORT` | Portas do servidor (8080) e do listener (5607). |
| `ALLOW_LAN` | `1` libera o painel e a overlay para outros aparelhos da rede. |
| `ASSETS_BASE_URL` | Fonte online das imagens. Padrão: repositório `liga_lets_go_imageAssets`. Vazio usa só a pasta local. |
| `ASSETS_PATH` | Outra pasta local no lugar de `overlay/assets`. |

**Nunca escreva a chave do RLT em arquivos do projeto**: eles vão para o GitHub.

**Acesso pela rede**: por padrão o servidor só responde a este computador,
porque o painel troca a pasta de assets e a chave do RLT. Para usar o painel de
um celular ou de outro PC, defina `ALLOW_LAN=1` no `.env`.

**OBS**: pode ser aberto antes ou depois do servidor. A conexão é tentada de
novo a cada 5 segundos e também quando cai.

## Racing League Tools

Com a chave configurada, escolha a temporada no painel de controle. A overlay
passa a usar nome completo, equipe, classe e cor de cada piloto vindos do RLT,
e libera a tela de pontuação.

**Casamento de nomes**: o nome do jogo é comparado com o nome, os apelidos e o
"nome no jogo" cadastrados no RLT. As regras:
- Sobrenome igual só vale se o primeiro nome não contradiz. "J. Santos" casa
  com "João Santos", nunca com "Leandro Santos".
- Cada piloto do RLT fica com no máximo um carro. Se dois carros disputam o
  mesmo piloto, vence o nome mais completo.
- Empate entre dois pilotos não é resolvido no chute: o carro fica com o nome
  do jogo e sem classe até você desempatar.

Para desempatar ou corrigir um apelido, edite `RLT_INGAME_MAP` em
`overlay/drivers-config.js`:

```js
const RLT_INGAME_MAP = {
  "xXSpeedyXx": "João Santos",
};
```

## Personalizar cor por classe, logo e pontos

Edite `overlay/drivers-config.js`:
- `CLASS_NAME_OVERRIDES`: para classes que não seguem o padrão `PALAVRA_PALAVRA` (sufixos `_LD`/`_HD`/`_SW` são removidos e `_` vira espaço automaticamente).
- `CLASS_COLORS`: cor de cada classe, usando o nome **já formatado** como chave.
- `CAR_LOGOS`: logo pela primeira palavra de `carName` (nome da montadora).
- `TEAM_LOGO_OVERRIDES`: arquivo de logo para equipes cujo nome não bate com o arquivo.
- `RACE_POINTS_DEFAULT`: pontos por posição de chegada, usados na coluna "Pts proj.".
- `RACE_POINTS_BY_SEASON`: tabela de pontos própria para uma temporada, pelo nome exato da season no RLT.

Pra descobrir os nomes exatos de `carClass`/`carName`, abra o DevTools do
navegador (F12 → Console) na página da tabela e digite
`latestStandings.map(e => [e.carClass, e.carName])`.

**Imagens**: a overlay busca cada imagem primeiro na fonte online (repositório
`liga_lets_go_imageAssets`, pastas `teams/` e `cars/`) e usa a pasta local
`overlay/assets/` como reserva quando o arquivo não existe online ou não há
internet. O painel de controle troca a fonte online sem reiniciar.

**Variantes de logo**: na página de disputas a linha fica na cor da equipe, e
um logo da mesma cor some. Para esses casos, suba uma variante com o mesmo nome
e o sufixo `__light` ou `__dark` antes da extensão, em `teams/` ou `cars/`:
`apex.png` → `apex__light.png` (logo **claro**, usado em fundo escuro) e
`apex__dark.png` (logo **escuro**, usado em fundo claro). Quando a variante não
existe, vale o logo normal.

**Relógio da volta mais rápida**: em corrida, o ícone `clock.png` aparece ao
lado da tabela, na altura da linha do piloto com a melhor volta. Na página
Geral é a melhor volta da corrida; nas páginas por classe há um relógio por
classe. Por padrão fica à direita da tabela, então a fonte do OBS precisa ter
pelo menos 535 px de largura. Com `?clock=left` na URL o ícone vai para a
esquerda e a tabela anda 32 px para a direita.

## Atalhos de teclado

Com o `hotkeys.ps1` aberto os atalhos funcionam com o jogo em foco. Sem ele,
funcionam com a página da overlay em foco. O painel de controle tem botões
para página, coluna e destaque.

- `,` e `.` trocam a coluna da direita: Intervalo / Gap líder / Última volta / Melhor volta / Posições / Paradas / Stint / VMax.
- `[` e `]` trocam a página: **Geral**, **Multiclasse** e a classe do piloto em foco.
- `p` liga/desliga o destaque do piloto em foco (o jogo não diferencia pilotar de espectar, só qual carro a câmera está olhando).
- `0` alterna entre a tabela de tempos e a tela de **pontuação** do campeonato (colunas: Pts / Pts proj. / Gap líder).
- `9` liga e desliga a página de **disputas**, só em corrida: os carros que
  ficam pelo menos 5 s com menos de 0,6 s de intervalo para o da frente são
  destacados, e deixam de ser depois de 10 s fora disso (ou na hora, se o
  intervalo passar de 2 s). A velocidade deles aparece ao lado da tabela, e a
  parte da tabela que fica rodando trava onde houver disputa. Ela desliga
  sozinha ao fim da corrida e quando o safety car entra. No painel dá para
  escolher entre a tabela toda (0,6 s) e só as disputas do piloto assistido
  (com 1 s).

**Alternância automática**: no painel, "Alternar colunas sozinho" faz a tabela
passar sozinha pelas colunas da direita (Intervalo, Gap líder, Última volta...),
como a tecla `.`, no intervalo escolhido em "Tempo em cada coluna". Na tela de
pontuação ela passa pelas colunas da pontuação. A troca entre posições e
pontuação continua manual, pela tecla `0`, e só existe com temporada aplicada.

## O que cada coluna mostra

**Intervalo e Gap líder**: medidos por tempo. A overlay guarda em que instante
cada carro passou por cada ponto da pista, e o gap é quanto tempo faz que o
carro da frente passou onde este carro está agora. O valor não oscila em curva
lenta ou reta. Quem está uma volta ou mais atrás aparece como "+1 volta".
Nos primeiros segundos depois de abrir a overlay ainda não há histórico, e o
valor é estimado por distância e velocidade. Na primeira volta a coluna mostra
posições ganhas/perdidas. Depois da bandeirada o valor fica congelado. Em treino
e classificação a coluna mostra a diferença de melhor volta.

**Posições ganhas/perdidas**: compara com o grid de largada, que o servidor
trava quando o pelotão começa a andar. Se o servidor foi aberto com a corrida
em andamento, a referência é a posição daquele momento. O botão **Zerar
largada e paradas** do painel refaz essa referência. Nas páginas por classe a
comparação é dentro da classe.

**Paradas, Stint e tempo de box**: contados pelo servidor para todos os carros,
a partir da entrada e saída do pit lane. A Shared Memory não informa o número
de paradas dos adversários, então um drive-through conta como parada.

**Pts proj.**: pontos do campeonato somados aos pontos da posição atual na
corrida, pela tabela configurada em `drivers-config.js`. Quem abandonou não
projeta pontos.

**VMax**: maior velocidade do piloto na sessão. Zera ao trocar de sessão.

## Testes

```bash
npm test
```

Cobrem o casamento de nomes, o cálculo de intervalo e o estado da corrida no
servidor. Para testar o listener sem o jogo, ele aceita outro mapeamento e
outra porta: `listener.ps1 -MapName nome -BridgePort 15607` (o `listener-lmu.ps1` aceita os mesmos parâmetros).

## Adicionar mais dados

Os campos disponíveis na Shared Memory do AMS2 estão documentados em `SharedMemory_AMS2.h`
(struct `ParticipantInfo` e os arrays por participante). Para uma coluna nova:
adicione a leitura do offset no `listener.ps1` e o campo na renderização em
`overlay/timing-table.js`. Se o dado depende de histórico, calcule em
`server/raceState.js`.

## G-force (força G e aceleração do piloto em foco)

`overlay/g-force.html` (Browser Source no OBS, fundo transparente, fonte sugerida 300 × 380) mostra, para o piloto em foco, um círculo de aderência com a força G lateral e longitudinal (rastro de 1,5 s), os valores, a velocidade, o maior valor dos últimos 10 s, a posição e as voltas (última e melhor). Liga e desliga pelo botão **G-force** do painel ou pela tecla **8** (com o jogo em foco); a escolha fica guardada na própria fonte do OBS. Parâmetros na URL: `?max=3` (G no anel externo), `?peaks=0` (sem a linha de picos), `?flip=acc` (inverte o lado da lateral estimada nesses jogos).

Quem transmite costuma estar parado, e a telemetria completa do AMS2 é de um carro só. Por isso o cálculo escolhe a fonte sozinho, nesta ordem, e o selo do card diz qual está valendo (**TELEMETRIA** ou **ESTIMADO**):

| Jogo | O que usa | Lateral | Longitudinal |
|---|---|---|---|
| AMS2 | `car.localAccel`, só se a velocidade dela bater com a do carro em foco; senão, estimativa | sim | sim |
| LMU | `localAccel` de cada carro (`listener-lmu.ps1`), conferido contra a estimativa | sim | sim |
| ACC | estimativa pela velocidade e posição da API de transmissão | sim (lado ainda não conferido, ver `?flip=acc`) | sim |
| Assetto Corsa | estimativa pela velocidade (o app do jogo não manda a posição) | não | sim |

A estimativa usa só o que o jogo informa de todos os carros (~10 leituras por segundo): a longitudinal é a inclinação da velocidade numa janela de 0,6 s e a lateral é a velocidade vezes a taxa de giro do rumo (`overlay/shared/gforce.js`). Conferida contra a telemetria real do AMS2 (Audi R8 no Spielberg e Cruze em Velocitta, com os dados degradados para 10 Hz e posição de 0,1 m): correlação de 0,88 na longitudinal e 0,94 na lateral, erro típico de 0,25 a 0,33 g. Serve para mostrar o que o carro está fazendo, não para medir. Os dados reais (AMS2 e LMU) são conferidos contra a estimativa e, se divergirem por alguns segundos, a overlay usa a estimativa.

Ainda não conferido dentro do jogo: o lado da lateral no LMU e no ACC (nos dois, virar à direita deve levar o ponto para a direita) e se o `mLocalAccel` do LMU chega com os sinais esperados.
