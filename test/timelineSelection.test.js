const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const SessionAnalysis = require('../media/sessionAnalysis');

// Run the complete webview script with DOM events; canvas painting is skipped.
class Element {
  listeners = new Map();
  children = new Map();
  clientWidth = 764;
  clientHeight = 0;
  hidden = false;
  value = '';
  textContent = '';
  dataset = {};
  classList = { toggle() {}, add() {}, remove() {}, contains() { return false; } };
  addEventListener(type, fn) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(fn);
    this.listeners.set(type, listeners);
  }
  fire(type, event = {}) { for (const fn of this.listeners.get(type) || []) fn(event); }
  querySelector(selector) {
    if (!this.children.has(selector)) this.children.set(selector, new Element());
    return this.children.get(selector);
  }
  querySelectorAll() { return []; }
  appendChild() {}
  setAttribute() {}
  setPointerCapture() {}
}

function dashboard(mode = 'live', sampleLength = 60) {
  const elements = new Map();
  const el = (id) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  const window = new Element();
  const messages = [];
  const samples = Array.from({ length: sampleLength }, (_, i) => ({ time: i * 1000, cpuPercent: i % 100 }));
  const context = vm.createContext({
    document: {
      body: new Element(), getElementById: el, querySelector: el,
      createElement: () => new Element(), addEventListener() {},
    },
    window, SessionAnalysis,
    getComputedStyle: () => ({ fontFamily: 'sans-serif', getPropertyValue: () => '' }),
    acquireVsCodeApi: () => ({ postMessage: (m) => messages.push(m), getState: () => ({}) }),
    ResizeObserver: class { observe() {} },
    MutationObserver: class { observe() {} },
    setInterval() {}, setTimeout() {}, requestAnimationFrame: (fn) => fn(),
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../media/dashboard.js'), 'utf8'), context);
  window.fire('message', { data: {
    type: 'init', name: 'Test', pid: 1, startedAt: 0, state: 'running',
    samples, sampleCount: samples.length, counters: [], refreshInterval: 1,
    imported: mode === 'imported' ? { file: 'test.json', format: 'json' } : null,
  } });
  if (mode === 'paused') {
    window.fire('message', { data: { type: 'paused', samples } });
    window.fire('message', { data: {
      type: 'sample', derived: { time: sampleLength * 1000, cpuPercent: 100 },
      sampleCount: sampleLength + 1, retainedCount: sampleLength, counters: [],
    } });
  }
  const pointer = (type, seconds) => el('timeline').fire(type, {
    button: 0, pointerId: 1, offsetX: 112 + seconds * 10,
  });
  const drag = (from, to) => {
    pointer('pointerdown', from);
    pointer('pointermove', to);
    pointer('pointerup', to);
  };
  const exported = () => {
    el('exportMenu').fire('click', { target: { closest: () => ({ dataset: { export: 'json' } }) } });
    return JSON.parse(JSON.stringify(messages.at(-1)));
  };
  const sample = (time) => window.fire('message', { data: {
    type: 'sample', derived: { time, cpuPercent: 10 },
    sampleCount: sampleLength + 1, retainedCount: sampleLength + 1, counters: [],
  } });
  return { el, pointer, drag, exported, sample };
}

test('selection drawing stays in the plot when the live window overtakes it', () => {
  const ui = dashboard();
  ui.drag(10, 30);
  const analyzed = ui.el('analysisText').textContent;
  const calls = [];
  const canvas = ui.el('timeline');
  const ctx = new Proxy({ canvas }, {
    get(target, key) {
      return key in target ? target[key] : (...args) => calls.push({ key, args });
    },
  });
  canvas.getContext = () => ctx;
  canvas.clientHeight = 320;

  ui.sample(80000); // Window starts at 20s; only the right endpoint remains visible.
  const handles = () => calls.filter((c) => c.key === 'moveTo' && c.args[1] === 124);
  assert.equal(handles().length, 1);
  assert.ok(handles()[0].args[0] >= 112);
  for (const { args: [x, y, width] } of calls.filter((c) => c.key === 'fillRect' && c.args[1] === 0)) {
    assert.equal(y, 0);
    assert.ok(x >= 112 && x + width <= 712);
  }
  assert.equal(ui.el('analysisText').textContent, analyzed);

  calls.length = 0;
  ui.sample(100000); // Window starts at 40s; the entire selection is outside it.
  assert.equal(handles().length, 0);
  // Only the edge marker band remains, at the left border of the plot.
  assert.deepEqual(calls.filter((c) => c.key === 'fillRect' && c.args[1] === 0).map((c) => c.args.slice(0, 3)), [[112, 0, 3]]);
  assert.equal(ui.el('analysisText').textContent, `${analyzed} · outside the current window`);
  assert.deepEqual(ui.exported().range, { from: 10000, to: 30000 });
});

for (const mode of ['live', 'paused', 'imported']) {
  test(`timeline selection coordinates follow each toolbar window (${mode})`, () => {
    const ui = dashboard(mode, 1801);
    for (const seconds of [60, 300, 900, 0]) {
      ui.el('clearSel').fire('click');
      ui.el('range').fire('click', { target: { closest: () => ({ dataset: { range: String(seconds) } }) } });
      const first = seconds ? 1800000 - seconds * 1000 : 0;
      // The helper maps 0..60 to the full canvas width, regardless of the time window.
      ui.drag(0, 60);
      assert.deepEqual(ui.exported().range, { from: first, to: 1800000 });
      assert.match(ui.el('summary').innerHTML, new RegExp(`${(1800000 - first) / 1000 + 1} samples`));
      // Analyzing must keep the timeline window stable for subsequent resizing.
      ui.drag(60, 30);
      const end = Math.floor((first + (1801000 - first) / 2) / 1000) * 1000;
      assert.deepEqual(ui.exported().range, { from: first, to: end });
    }
  });
}

for (const mode of ['live', 'paused', 'imported']) {
  test(`timeline automatically analyzes selection, move and resize on release (${mode})`, () => {
    const ui = dashboard(mode);
    ui.pointer('pointerdown', 10);
    ui.pointer('pointermove', 30);
    assert.equal(ui.el('analysis').hidden, true);
    ui.pointer('pointerup', 30);
    assert.equal(ui.el('analysis').hidden, false);
    assert.match(ui.el('summary').innerHTML, /21 samples/);
    assert.deepEqual(ui.exported().range, { from: 10000, to: 30000 });

    const previous = ui.el('analysisText').textContent;
    ui.pointer('pointerdown', 20);
    ui.pointer('pointermove', 25);
    assert.equal(ui.el('analysisText').textContent, previous);
    ui.pointer('pointerup', 25);
    assert.deepEqual(ui.exported().range, { from: 15000, to: 35000 });

    ui.drag(15, 12); // Left handle.
    assert.deepEqual(ui.exported().range, { from: 12000, to: 35000 });
    ui.drag(35, 40); // Right handle.
    assert.deepEqual(ui.exported().range, { from: 12000, to: 40000 });
    assert.match(ui.el('summary').innerHTML, /29 samples/);
  });
}

test('outside click and an invalid short selection clear the previous analysis', () => {
  const ui = dashboard();
  ui.drag(10, 30);
  ui.drag(50, 50);
  assert.equal(ui.el('analysis').hidden, true);
  assert.equal(ui.el('analyzeSel').disabled, true);
  assert.deepEqual(ui.exported().range, { from: 0, to: 59000 });
  ui.drag(10, 30);
  ui.drag(50, 50.5); // Above the drag threshold, below the sampling interval.
  assert.equal(ui.el('analysis').hidden, true);
  assert.equal(ui.el('analyzeSel').disabled, true);
});

test('Escape and Clear remove selection and analysis; manual commands remain usable', () => {
  const ui = dashboard();
  for (const clear of [
    () => ui.el('timeline').fire('keydown', { key: 'Escape' }),
    () => ui.el('clearSel').fire('click'),
  ]) {
    ui.drag(10, 30);
    clear();
    assert.equal(ui.el('analysis').hidden, true);
    assert.equal(ui.el('analyzeSel').disabled, true);
  }
  for (const analyze of [
    () => ui.el('analyzeSel').fire('click'),
    () => ui.el('timeline').fire('dblclick'),
    () => ui.el('timeline').fire('keydown', { key: 'Enter' }),
  ]) {
    ui.el('clearSel').fire('click');
    ui.drag(10, 30);
    ui.el('range').fire('click', { target: { closest: () => ({ dataset: { range: '60' } }) } });
    assert.equal(ui.el('analysis').hidden, true);
    analyze();
    assert.equal(ui.el('analysis').hidden, false);
    assert.deepEqual(ui.exported().range, { from: 10000, to: 30000 });
  }
  ui.el('analyzeAll').fire('click');
  assert.match(ui.el('analysisText').textContent, /Analyzing all data/);
  assert.deepEqual(ui.exported().range, { from: 0, to: 59000 });
});

test('chip and edge marker keep an off-window selection visible; Show reveals it without losing the analysis', () => {
  const ui = dashboard();
  assert.equal(ui.el('selChip').hidden, true);
  ui.drag(10, 30);
  assert.equal(ui.el('selChip').hidden, false);
  assert.equal(ui.el('selChip').dataset.state, 'visible');
  assert.equal(ui.el('revealSel').hidden, true);
  assert.match(ui.el('selChipText').textContent, /· 20 s$/);

  ui.sample(80000); // Only the right part of the selection is still in the 1-minute window.
  assert.equal(ui.el('selChip').dataset.state, 'partial');
  assert.equal(ui.el('revealSel').hidden, false);
  assert.match(ui.el('selChipText').textContent, /partly outside the window/);

  ui.sample(100000); // The whole selection left the window.
  assert.equal(ui.el('selChip').dataset.state, 'outside');
  assert.match(ui.el('selChipText').textContent, /· outside the window/);
  assert.match(ui.el('analysisText').textContent, /outside the current window/);

  ui.el('revealSel').fire('click');
  assert.equal(ui.el('selChip').dataset.state, 'visible');
  assert.equal(ui.el('revealSel').hidden, true);
  assert.equal(ui.el('analysis').hidden, false);
  assert.doesNotMatch(ui.el('analysisText').textContent, /outside/);
  assert.deepEqual(ui.exported().range, { from: 10000, to: 30000 });

  ui.el('chipClear').fire('click');
  assert.equal(ui.el('selChip').hidden, true);
  assert.equal(ui.el('analysis').hidden, true);
});

for (const mode of ['live', 'paused', 'imported']) {
  test(`clicking the edge marker widens the window to the selection (${mode})`, () => {
    const ui = dashboard(mode, 600);
    const range = (seconds) => ui.el('range').fire('click', { target: { closest: () => ({ dataset: { range: String(seconds) } }) } });
    range(0);
    ui.drag(1, 3); // "All" maps the plot to 0..600 s, so this selects 10 s – 30 s.
    assert.deepEqual(ui.exported().range, { from: 10000, to: 30000 });
    range(60);
    assert.equal(ui.el('selChip').dataset.state, 'outside');

    // A click away from the marker still starts a new selection gesture.
    ui.el('timeline').fire('pointermove', { offsetX: 300, offsetY: 140 });
    assert.equal(ui.el('selChip').dataset.state, 'outside');

    ui.el('timeline').fire('pointerdown', { button: 0, pointerId: 1, offsetX: 120, offsetY: 140 });
    ui.el('timeline').fire('pointerup', { button: 0, pointerId: 1, offsetX: 120, offsetY: 140 });
    assert.equal(ui.el('selChip').hidden, false);
    assert.equal(ui.el('selChip').dataset.state, 'visible');
    ui.el('timeline').fire('keydown', { key: 'Enter' });
    assert.deepEqual(ui.exported().range, { from: 10000, to: 30000 });
    assert.match(ui.el('summary').innerHTML, /21 samples/);
  });
}
