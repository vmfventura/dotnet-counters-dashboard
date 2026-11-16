const assert = require('node:assert/strict');
const Module = require('node:module');
const { test } = require('node:test');

class EventEmitter {
  listeners = [];
  event = (fn) => { this.listeners.push(fn); return { dispose() {} }; };
  fire(value) { for (const fn of this.listeners) { fn(value); } }
  dispose() {}
}
class TreeItem {
  constructor(label) { this.label = label; }
}
class MarkdownString {
  constructor(value) { this.value = value; }
}
let list;
const vscode = {
  EventEmitter, TreeItem, MarkdownString,
  ThemeIcon: class { constructor(id) { this.id = id; } },
  ThemeColor: class {},
  TreeItemCollapsibleState: { None: 0 },
  workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
};
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  if (name === 'vscode') { return vscode; }
  if (name === './countersCli') { return { listProcesses: () => list(), ToolNotFoundError: class extends Error {} }; }
  if (name === './projectResolver') { return { matchesProject: (proc, name) => proc.name === name, findWorkspaceProjects: async () => [] }; }
  return originalLoad.call(this, name, ...args);
};
const { ProjectWatcher, WatchItem } = require('../out/watcher');
const { ProcessTreeProvider } = require('../out/trees');
Module._load = originalLoad;

test('watcher attaches during fallback and clears the warning after recovery', async (t) => {
  const target = { id: '1', name: 'App', enabled: true };
  const attached = [];
  const watcher = new ProjectWatcher({ get: () => [target] }, () => [], (proc) => attached.push(proc.pid));
  t.after(() => watcher.dispose());
  list = async () => ({ processes: [{ pid: 42, name: 'App' }], warning: 'partial list' });
  await watcher.poll();
  assert.deepEqual(attached, [42]);
  assert.match(new WatchItem(target, watcher).tooltip.value, /partial list/);
  list = async () => ({ processes: [] });
  await watcher.poll();
  assert.equal(watcher.lastWarning, undefined);
  assert.doesNotMatch(new WatchItem(target, watcher).tooltip.value, /partial list/);
});

test('process tree warns and explains an empty fallback list', async () => {
  list = async () => ({ processes: [], warning: 'partial list' });
  const items = await new ProcessTreeProvider().getChildren();
  assert.equal(items[0].tooltip, 'partial list');
  assert.equal(items[1].label, 'No visible .NET processes found');
});
