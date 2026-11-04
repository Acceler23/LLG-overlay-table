const test = require("node:test");
const assert = require("node:assert/strict");

// framecap.js le window e localStorage ao carregar: simula o que o OBS oferece
function load() {
  const listeners = {};
  global.window = { addEventListener: (n, f) => (listeners[n] = f) };
  global.localStorage = { getItem: () => null, setItem: () => {} };
  delete require.cache[require.resolve("../overlay/shared/framecap.js")];
  const fc = require("../overlay/shared/framecap.js");
  const visible = (v) => listeners.obsSourceVisibleChanged({ detail: { visible: v } });
  return { fc, visible };
}

test("fonte escondida no OBS nao desenha; ao aparecer, desenha so o ultimo pedido", () => {
  const { fc, visible } = load();
  const calls = [];
  const render = (x) => calls.push(x);
  fc.run(render, [1]);
  visible(false);
  assert.equal(fc.isHidden(), true);
  fc.run(render, [2]);
  fc.run(render, [3]);
  assert.deepEqual(calls, [1], "nada desenhado enquanto escondida");
  visible(true);
  assert.deepEqual(calls, [1, 3], "ao aparecer, so o desenho mais novo");
  fc.run(render, [4]);
  assert.deepEqual(calls, [1, 3, 4]);
  delete global.window;
  delete global.localStorage;
});
