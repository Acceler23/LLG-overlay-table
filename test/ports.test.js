const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("net");
const { validPort, isPortFree, isLocalPortFree, findFreePort, DEFAULT_HTTP_PORT } = require("../server/ports");

test("porta valida: numero inteiro de 1024 a 65535", () => {
  assert.equal(DEFAULT_HTTP_PORT, 8080);
  assert.equal(validPort("8090"), 8090);
  assert.equal(validPort(80), null, "porta reservada do sistema");
  assert.equal(validPort(70000), null);
  assert.equal(validPort("abc"), null);
  assert.equal(validPort(8080.5), null);
});

test("outro programa so em 127.0.0.1 (painel do servidor AMS2): a porta nao esta livre", async () => {
  const other = net.createServer();
  await new Promise((r) => other.listen(0, "127.0.0.1", r));
  const busy = other.address().port;
  try {
    assert.equal(await isPortFree(busy), false);
    assert.equal(await isLocalPortFree(busy), false);
  } finally {
    other.close();
  }
});

test("porta ocupada por outro programa: nao esta livre, e a busca pula ela", async () => {
  const other = net.createServer();
  await new Promise((r) => other.listen(0, r)); // porta qualquer, como outro programa
  const busy = other.address().port;
  try {
    assert.equal(await isPortFree(busy), false);
    const free = await findFreePort(busy, [busy + 1]);
    assert.ok(free !== busy && free !== busy + 1, `achou ${free}`);
    assert.equal(await isPortFree(free), true);
  } finally {
    other.close();
  }
});
