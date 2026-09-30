const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const { test, beforeEach } = require('node:test');

class EventEmitter {
  listeners = [];
  event = (fn) => {
    this.listeners.push(fn);
    return { dispose: () => { this.listeners = this.listeners.filter((f) => f !== fn); } };
  };
  fire(value) { for (const fn of this.listeners) { fn(value); } }
  dispose() { this.listeners = []; }
}

const settings = new Map();
const files = new Map();
const warnings = [];
let currentPanel;
let showSaveDialog;
let showQuickPick;
const uri = (fsPath) => ({ fsPath });
const vscode = {
  EventEmitter,
  ViewColumn: { Active: 1 },
  ConfigurationTarget: { Global: 1 },
  Uri: { joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)) },
  workspace: {
    getConfiguration: () => ({ get: (key, fallback) => settings.get(key) ?? fallback }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
    fs: {
      readFile: async (file) => Buffer.from(files.get(file.fsPath)),
      writeFile: async (file, data) => files.set(file.fsPath, Buffer.from(data).toString()),
    },
  },
  window: {
    showSaveDialog: (...args) => showSaveDialog(...args),
    showQuickPick: (...args) => showQuickPick(...args),
    showInformationMessage: async () => undefined,
    showWarningMessage: async (message) => { warnings.push(message); },
    createWebviewPanel: () => {
      const receive = new EventEmitter();
      const disposed = new EventEmitter();
      currentPanel = {
        messages: [],
        receive: (message) => receive.listeners[0](message),
        webview: {
          cspSource: 'test:',
          asWebviewUri: (value) => value.fsPath,
          postMessage: async (message) => { currentPanel.messages.push(structuredClone(message)); return true; },
          onDidReceiveMessage: receive.event,
        },
        onDidDispose: disposed.event,
        reveal() {},
        dispose() {},
      };
      return currentPanel;
    },
  },
};

// Substitute only VS Code and process collection; exercise the real session, panel and importer.
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  if (name === 'vscode') { return vscode; }
  return originalLoad.call(this, name, ...args);
};
const cli = require('../out/countersCli');
cli.CounterCollector = class {
  sample = new EventEmitter();
  exit = new EventEmitter();
  onSample = this.sample.event;
  onExit = this.exit.event;
  start() {}
  stop() {}
  dispose() {}
};
require('../out/processInfo').getProcessStartTime = async () => 1000;
const { CounterSession, exportSession } = require('../out/session');
const { DashboardPanel } = require('../out/dashboardPanel');
const { importFile } = require('../out/importer');
const { DERIVED_KEYS, MetricDeriver } = require('../out/metrics');
const { SessionSnapshot } = require('../out/sessionSnapshot');
const analysis = require('../media/sessionAnalysis');
Module._load = originalLoad;

beforeEach(() => {
  settings.clear();
  settings.set('maxHistoryPoints', 60);
  files.clear();
  warnings.length = 0;
  showSaveDialog = async () => uri('export.json');
  showQuickPick = async () => ({ format: 'json' });
});

function liveSession() {
  return new CounterSession({ pid: 42, name: 'app', path: '', commandLine: '' });
}

function emit(session, from, count) {
  for (let i = from; i < from + count; i++) {
    session.collector.sample.fire({
      time: i * 1000,
      stamp: String(i),
      counters: [
        { provider: 'System.Runtime', name: 'CPU Usage (%)', type: 'Metric', value: i % 100 },
        { provider: 'System.Runtime', name: 'Allocation Rate (B / 1 sec)', type: 'Rate', value: 1234.56789 },
      ],
    });
  }
}

function openPanel(session) {
  DashboardPanel.show(uri(process.cwd()), session, () => {});
  return currentPanel;
}

function exportMessage(samples, format = 'json') {
  return { type: 'export', format, range: { from: samples[0].time, to: samples.at(-1).time }, expectedSamples: samples.length };
}

function sample(time, cpuPercent = 10) {
  return { ...Object.fromEntries(DERIVED_KEYS.map((key) => [key, null])), time, cpuPercent };
}

test('live messages and a reopened dashboard expose exactly the retained samples', async () => {
  const session = liveSession();
  const panel = openPanel(session);
  emit(session, 1, 90);
  const replica = [];
  for (const message of panel.messages.filter((m) => m.type === 'sample')) {
    replica.push(message.derived);
    replica.splice(0, Math.max(0, replica.length - message.retainedCount));
  }
  assert.deepEqual(replica, session.samples);
  assert.equal(replica.length, 60);
  await panel.receive({ type: 'ready' });
  assert.deepEqual(panel.messages.find((m) => m.type === 'init').samples, replica);
  session.dispose();
});

test('JSON samples and analysis remain fixed while the save dialog is open', async () => {
  const session = liveSession();
  emit(session, 1, 60);
  const expected = session.createSnapshot().toJson();
  const panel = openPanel(session);
  let finishDialog;
  showSaveDialog = () => new Promise((resolve) => { finishDialog = resolve; });
  const saving = panel.receive({ ...exportMessage(session.samples), analysis: { samples: 999999 } });
  emit(session, 61, 90);
  finishDialog(uri('export.json'));
  await saving;
  const actual = JSON.parse(files.get('export.json'));
  const before = JSON.parse(expected);
  assert.deepEqual(actual.samples, before.samples);
  assert.deepEqual(actual.analysis, before.analysis);
  assert.equal(actual.analysis.samples, actual.samples.length);
  assert.equal(actual.samples.at(-1).time, new Date(60000).toISOString());
  session.dispose();
});

test('Pause preserves an exportable snapshot even after all its samples are evicted', async () => {
  const session = liveSession();
  emit(session, 1, 60);
  const panel = openPanel(session);
  await panel.receive({ type: 'pause' });
  const frozen = panel.messages.find((m) => m.type === 'paused').samples;
  emit(session, 61, 90);
  await panel.receive(exportMessage(frozen));
  const exported = JSON.parse(files.get('export.json'));
  assert.deepEqual(exported.samples.map((s) => Date.parse(s.time)), frozen.map((s) => s.time));
  assert.equal(exported.analysis.samples, frozen.length);
  await panel.receive({ type: 'resume' });
  files.clear();
  await panel.receive(exportMessage(frozen));
  assert.equal(files.size, 0);
  assert.equal(warnings.length, 1);
  session.dispose();
});

test('session action captures data before the format picker opens', async () => {
  const session = liveSession();
  emit(session, 1, 3);
  let finishPicker;
  showQuickPick = () => new Promise((resolve) => { finishPicker = resolve; });
  const saving = exportSession(session);
  emit(session, 4, 10);
  finishPicker({ format: 'json' });
  await saving;
  const exported = JSON.parse(files.get('export.json'));
  assert.equal(exported.samples.length, 3);
  assert.equal(exported.analysis.samples, 3);
  session.dispose();
});

test('collection interval stays fixed when configuration changes', async () => {
  settings.set('refreshInterval', 5);
  const session = liveSession();
  emit(session, 1, 1);
  settings.set('refreshInterval', 1);
  assert.equal(session.refreshInterval, 5);
  const exported = JSON.parse(session.toJson());
  assert.equal(exported.refreshInterval, 5);
  files.set('input.json', JSON.stringify(exported));
  const imported = await importFile(uri('input.json'));
  const restored = new CounterSession(imported.proc, imported.project, imported);
  assert.equal(restored.refreshInterval, 5);
  assert.deepEqual(JSON.parse(restored.toJson()).analysis, exported.analysis);
  restored.dispose();
  session.dispose();
});

test('browser and extension compute identical summaries without mutating samples', () => {
  const browser = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../media/sessionAnalysis.js'), 'utf8'), browser);
  const samples = [sample(1000, 70), sample(2000, 20), sample(3000, 90)];
  samples[0].gen2 = 1;
  const before = structuredClone(samples);
  const host = analysis.summaryForExport(analysis.computeSummary(samples, 1, analysis.DEFAULT_THRESHOLDS));
  const webview = browser.SessionAnalysis.summaryForExport(browser.SessionAnalysis.computeSummary(samples, 1, analysis.DEFAULT_THRESHOLDS));
  assert.deepEqual(JSON.parse(JSON.stringify(webview)), host);
  assert.deepEqual(samples, before);
});

test('selected JSON and CSV exports reimport without changing metric precision or findings', async () => {
  const session = liveSession();
  emit(session, 1, 10);
  const selected = { from: 3000, to: 7000 };
  const exported = JSON.parse(session.toJson(selected));
  files.set('selected.json', JSON.stringify(exported));
  const json = await importFile(uri('selected.json'));
  assert.deepEqual(json.samples, session.samplesIn(selected));
  settings.set('hotspotCpuPercent', 1);
  const restored = new CounterSession(json.proc, json.project, json);
  assert.deepEqual(JSON.parse(restored.toJson()).analysis, exported.analysis);
  files.set('selected.csv', session.toDerivedCsv(selected));
  const csv = await importFile(uri('selected.csv'));
  assert.deepEqual(csv.samples, session.samplesIn(selected));
  restored.dispose();
  session.dispose();
});

test('a snapshot copies values, counters and thresholds rather than aliasing live objects', () => {
  const samples = [sample(1000)];
  const counters = [{ provider: 'System.Runtime', name: 'CPU Usage', type: 'Metric', value: 10 }];
  const thresholds = { ...analysis.DEFAULT_THRESHOLDS };
  const snapshot = new SessionSnapshot({ process: { pid: 42, name: 'app', path: '', commandLine: '' }, startedAt: 1000, refreshInterval: 1, thresholds, samples, latestCounters: counters });
  samples[0].cpuPercent = 99;
  counters[0].value = 99;
  thresholds.hotspotCpuPercent = 1;
  const result = JSON.parse(snapshot.toJson());
  assert.equal(result.samples[0].cpuPercent, 10);
  assert.equal(result.latestCounters[0].value, 10);
  assert.equal(result.analysis.thresholds.hotspotCpuPercent, 50);
});

test('large imported sessions are retained and analyzed without argument-limit errors', () => {
  const samples = Array.from({ length: 210000 }, (_, i) => sample(i * 1000));
  const proc = { pid: 0, name: 'large', path: '', commandLine: '' };
  const session = new CounterSession(proc, undefined, { proc, file: 'large.json', format: 'json', startedAt: 0, samples, latest: [], stampToTime: Date.parse });
  assert.equal(session.samples.length, 210000);
  assert.equal(analysis.computeSummary(session.samples, 1, analysis.DEFAULT_THRESHOLDS).samples, 210000);
  session.dispose();
});

test('raw CSV range filtering preserves the original recording date', async () => {
  files.set('old.csv', 'Timestamp,Provider,Counter Name,Counter Type,Mean/Increment\n09/24/2026 15:26:47,System.Runtime,CPU Usage (%),Metric,10\n09/25/2026 15:26:47,System.Runtime,CPU Usage (%),Metric,20\n');
  const imported = await importFile(uri('old.csv'));
  const session = new CounterSession(imported.proc, undefined, imported);
  // Exercise the live-file path too: it must parse the recorded date instead of anchoring to today.
  const file = path.join(__dirname, 'raw-date-fixture.tmp');
  fs.writeFileSync(file, imported.rawCsv);
  session.imported = undefined;
  session.collector = { csvPath: file, dispose() {} };
  try {
    const time = imported.samples[0].time;
    const filtered = session.readRawCsv({ from: time, to: time });
    assert.match(filtered, /09\/24\/2026/);
    assert.doesNotMatch(filtered, /09\/25\/2026/);
  } finally {
    fs.unlinkSync(file);
    session.dispose();
  }
});

function summarize(samples, refresh = 1) {
  return analysis.computeSummary(samples, refresh, analysis.DEFAULT_THRESHOLDS);
}

function derivedGc(time, counters) {
  return new MetricDeriver().derive({ time, stamp: String(time), counters: counters.map(([name, value, type = 'Metric']) => ({ provider: 'System.Runtime', name, value, type })) });
}

test('a 60-second collection gap adds only one observed second to a hotspot', () => {
  const summary = summarize([sample(0, 90), sample(60000, 10)]);
  assert.equal(summary.durationSeconds, 61);
  assert.equal(summary.observedSeconds, 2);
  assert.equal(summary.missingSeconds, 59);
  assert.equal(summary.hotspots.seconds, 1);
  assert.deepEqual(summary.gaps, [{ from: 1000, to: 60000 }]);
  assert.match(analysis.findings(summary).map((f) => f.text).join('\n'), /59 s without samples/);
});

test('hotspots, freezes and high GC activity split across gaps with consistent durations', () => {
  const samples = [0, 1000, 60000, 61000].map((time) => ({ ...sample(time, 90), lockContentions: 180, gen0: 30, gen1: 0, gen2: 0, gcSemantics: { collections: 'exclusive' } }));
  const summary = summarize(samples);
  for (const kind of ['hotspots', 'freezes', 'highGc']) {
    assert.equal(summary[kind].count, 2);
    assert.equal(summary[kind].seconds, 4);
  }
  assert.equal(summary.freezes.longestSeconds, 2);
  assert.equal(summary.gcCollectionsTotal, 120);
  assert.equal(summary.lockContentions, 720);
  assert.equal(summary.coverageSeconds.lockContentions, 4);
  assert.equal(summary.missingSeconds, 58);
});

test('timestamp jitter is tolerated, duplicate timestamps add no duration, and means use valid coverage', () => {
  const summary = summarize([sample(0, 0), sample(1250, 100), sample(1250, 40)]);
  assert.equal(summary.missingSeconds, 0);
  assert.equal(summary.observedSeconds, 2.25);
  assert.equal(summary.cpuPercent.avg, 40 / 2.25);
  const missing = summarize([{ ...sample(0), exceptions: 20 }, { ...sample(60000), exceptions: null }]);
  assert.equal(missing.exceptions, 20);
  assert.equal(missing.coverageSeconds.exceptions, 1);
});

test('normal contiguous samples preserve marker durations and totals', () => {
  const samples = [0, 1000, 2000].map((time) => ({ ...sample(time, 90), allocMBps: 12 }));
  const summary = summarize(samples);
  assert.equal(summary.observedSeconds, 3);
  assert.equal(summary.missingSeconds, 0);
  assert.equal(summary.hotspots.count, 1);
  assert.equal(summary.hotspots.seconds, 3);
  assert.equal(summary.allocatedMB, 36);
});

test('legacy GC percentages cannot be integrated into pause seconds; modern rates can', () => {
  const legacy = derivedGc(0, [['% Time in GC since last GC (%)', 20]]);
  const modern = derivedGc(0, [['dotnet.gc.pause.time (s / 1 sec)', 0.2, 'Rate']]);
  assert.equal(summarize([legacy]).gcPauseSeconds, null);
  assert.equal(summarize([legacy]).gcSemantics.pause, 'since-last-gc');
  assert.equal(summarize([modern]).gcPauseSeconds, 0.2);
  assert.equal(summarize([modern]).gcSemantics.pause, 'interval-pause');
  const cumulative = derivedGc(0, [['dotnet.gc.pause.time (s)', 100]]);
  assert.equal(cumulative.gcPausePercent, null);
  assert.equal(summarize([cumulative]).gcPauseSeconds, null);
});

test('legacy and modern heaps retain their distinct meaning and share binary memory units', () => {
  const legacy = derivedGc(0, [['GC Heap Size (MB)', 100], ['Working Set (MB)', 100], ['GC Committed Bytes (MB)', 100]]);
  const modern = derivedGc(0, [['dotnet.gc.last_collection.heap.size (By)[gc.heap.generation=gen2]', 100000000], ['dotnet.gc.last_collection.heap.size (By)[gc.heap.generation=loh]', 1048576]]);
  assert.equal(legacy.gcSemantics.heap, 'live-estimate');
  assert.equal(modern.gcSemantics.heap, 'last-collection');
  assert.equal(legacy.gcHeapMB, 100000000 / 1048576);
  assert.equal(legacy.workingSetMB, legacy.gcHeapMB);
  assert.equal(legacy.gcCommittedMB, legacy.gcHeapMB);
  assert.equal(modern.gcHeapMB, legacy.gcHeapMB + 1);
  const delta = derivedGc(0, [['dotnet.gc.last_collection.heap.size (By / 1 sec)', 1000000, 'Rate']]);
  assert.equal(delta.gcHeapMB, null);
});

test('legacy generation counts are inclusive, modern counts are exclusive, and partial totals are unavailable', () => {
  const legacy = derivedGc(0, [['Gen 0 GC Count (Count / 1 sec)', 8, 'Rate'], ['Gen 1 GC Count (Count / 1 sec)', 3, 'Rate'], ['Gen 2 GC Count (Count / 1 sec)', 1, 'Rate']]);
  const modern = derivedGc(0, [0, 1, 2].map((gen) => [`dotnet.gc.collections ({collection} / 1 sec)[gc.heap.generation=gen${gen}]`, [5, 2, 1][gen], 'Rate']));
  assert.equal(summarize([legacy]).gcCollectionsTotal, 8);
  assert.equal(summarize([modern]).gcCollectionsTotal, 8);
  assert.equal(summarize([legacy]).gcSemantics.collections, 'inclusive');
  assert.equal(summarize([modern]).gcSemantics.collections, 'exclusive');
  assert.equal(summarize([{ ...modern, gen0: null }]).gcCollectionsTotal, null);
});

test('mixed GC semantics never produce a blended heap, pause duration or generation total', () => {
  const legacy = derivedGc(0, [['GC Heap Size (MB)', 100], ['% Time in GC since last GC (%)', 10], ['Gen 0 GC Count (Count / 1 sec)', 2, 'Rate']]);
  const modern = derivedGc(1000, [['dotnet.gc.last_collection.heap.size (By)', 300000000], ['dotnet.gc.pause.time (s / 1 sec)', 0.1, 'Rate'], ['dotnet.gc.collections ({collection} / 1 sec)[gc.heap.generation=gen0]', 2, 'Rate']]);
  const summary = summarize([legacy, modern]);
  assert.deepEqual(summary.gcSemantics, { pause: 'mixed', heap: 'mixed', collections: 'mixed' });
  assert.equal(summary.gcHeapMB, null);
  assert.equal(summary.gcPausePercent, null);
  assert.equal(summary.gcPauseSeconds, null);
  assert.equal(summary.gcCollectionsTotal, null);
  assert.equal(summary.gcCollections.gen0, null);
  const simultaneous = derivedGc(0, [['GC Heap Size (MB)', 100], ['dotnet.gc.last_collection.heap.size (By)', 100000000]]);
  assert.equal(simultaneous.gcHeapMB, null);
  assert.equal(simultaneous.gcSemantics.heap, 'mixed');
});

test('GC provenance and gap coverage round-trip through JSON and normalized CSV', async () => {
  const samples = [0, 60000].map((time) => derivedGc(time, [['GC Heap Size (MB)', 100], ['% Time in GC since last GC (%)', 10], ['Gen 0 GC Count (Count / 1 sec)', 2, 'Rate']]));
  const proc = { pid: 42, name: 'gc', path: '', commandLine: '' };
  const session = new CounterSession(proc, undefined, { proc, file: 'raw.csv', format: 'raw', startedAt: 0, refreshInterval: 1, samples, latest: [], stampToTime: Date.parse });
  const snapshot = session.createSnapshot();
  for (const [file, content] of [['gc.json', snapshot.toJson()], ['gc.csv', snapshot.toDerivedCsv()]]) {
    files.set(file, content);
    const imported = await importFile(uri(file));
    assert.deepEqual(imported.samples, samples);
    const restored = new CounterSession(imported.proc, undefined, imported);
    assert.equal(restored.refreshInterval, 1);
    const summary = summarize(imported.samples, restored.refreshInterval);
    assert.equal(summary.missingSeconds, 59);
    assert.equal(summary.gcPauseSeconds, null);
    assert.equal(summary.gcSemantics.heap, 'live-estimate');
    restored.dispose();
  }
  const json = JSON.parse(snapshot.toJson());
  assert.equal(json.gcSemantics.pause, 'since-last-gc');
  assert.equal(json.analysis.gaps[0].from, new Date(1000).toISOString());
  samples[0].gcSemantics.pause = 'interval-pause';
  assert.equal(JSON.parse(snapshot.toJson()).gcSemantics.pause, 'since-last-gc');
  session.dispose();
});

test('older exports and invalid GC metadata remain unknown rather than guessing from latest counters', async () => {
  files.set('old.json', JSON.stringify({ samples: [{ ...sample(0), gcPausePercent: 20, gcHeapMB: 100, gen0: 1, gen1: 1, gen2: 1 }], latestCounters: [{ provider: 'System.Runtime', name: 'dotnet.gc.pause.time', type: 'Rate', value: 0.2 }] }));
  const imported = await importFile(uri('old.json'));
  const summary = summarize(imported.samples);
  assert.equal(summary.gcPauseSeconds, null);
  assert.equal(summary.gcCollectionsTotal, null);
  assert.deepEqual(summary.gcSemantics, { pause: 'unknown', heap: 'unknown', collections: 'unknown' });
  files.set('invalid.json', JSON.stringify({ samples: [{ ...sample(0), gcPausePercent: 20, gcSemantics: { pause: ['interval-pause'], heap: 42 } }] }));
  assert.equal((await importFile(uri('invalid.json'))).samples[0].gcSemantics, undefined);
});

test('plot segments break at missing values, timestamp gaps and GC semantic changes', () => {
  const values = [sample(0), sample(1000), sample(60000), sample(61000, null), sample(62000)];
  assert.deepEqual(analysis.segments(values, 'cpuPercent', 1000).map((s) => s.map((p) => p.time)), [[0, 1000], [60000], [62000]]);
  const heaps = [{ ...sample(0), gcHeapMB: 100, gcSemantics: { heap: 'live-estimate' } }, { ...sample(1000), gcHeapMB: 100, gcSemantics: { heap: 'last-collection' } }];
  assert.equal(analysis.segments(heaps, 'gcHeapMB', 1000).length, 2);
  assert.equal(analysis.gcLabel('pause', 'since-last-gc'), 'GC time since last collection');
});

test('modern runtime CSV yields post-collection heap sizes and interval pause rates', async () => {
  const rows = ['Timestamp,Provider,Counter Name,Counter Type,Mean/Increment'];
  for (const [stamp, pause] of [['01/01/2026 00:00:00', 0.001], ['01/01/2026 00:00:01', 0.002]]) {
    for (const generation of ['gen0', 'gen1', 'gen2', 'loh', 'poh']) {
      rows.push(`${stamp},System.Runtime,dotnet.gc.last_collection.heap.size (By)[gc.heap.generation=${generation}],Metric,1048576`);
    }
    rows.push(`${stamp},System.Runtime,dotnet.gc.pause.time (s / 1 sec),Rate,${pause}`);
    for (const generation of ['gen0', 'gen1', 'gen2']) {
      rows.push(`${stamp},System.Runtime,dotnet.gc.collections ({collection} / 1 sec)[gc.heap.generation=${generation}],Rate,${generation === 'gen0' ? 1 : 0}`);
    }
  }
  files.set('runtime.csv', rows.join('\n'));
  const imported = await importFile(uri('runtime.csv'));
  assert.equal(imported.refreshInterval, 1);
  assert.equal(imported.samples.length, 2);
  assert.deepEqual(imported.samples[0].gcSemantics, { heap: 'last-collection', pause: 'interval-pause', collections: 'exclusive' });
  const summary = summarize(imported.samples, imported.refreshInterval);
  assert.equal(summary.gcCollectionsTotal, 2);
  assert.ok(Math.abs(summary.gcPauseSeconds - 0.003) < 1e-12);
  assert.equal(imported.samples[0].gcHeapMB, 5);
});

test('matching names from a custom provider do not acquire System.Runtime GC semantics', () => {
  const derived = new MetricDeriver().derive({ time: 0, stamp: '0', counters: [{ provider: 'Custom.Provider', name: 'GC Heap Size (MB)', type: 'Metric', value: 100 }] });
  assert.equal(derived.gcHeapMB, null);
  assert.equal(derived.gcSemantics, undefined);
});
