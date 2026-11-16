const assert = require('node:assert/strict');
const Module = require('node:module');
const { test } = require('node:test');

let response;
let fallback;
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  if (name === 'vscode') {
    return { workspace: { getConfiguration: () => ({ get: () => undefined }) } };
  }
  if (name === 'child_process') {
    return { execFile: (_file, _args, _options, callback) => callback(...response) };
  }
  if (name === './linuxProcesses') {
    return { listLinuxProcesses: () => fallback() };
  }
  return originalLoad.call(this, name, ...args);
};
const { listProcesses } = require('../out/countersCli');
Module._load = originalLoad;

test('normal process discovery preserves the dotnet-counters output', async () => {
  response = [null, '42  MyApp  /app/MyApp  /app/MyApp --run\n', ''];
  fallback = () => { throw new Error('unexpected fallback'); };
  assert.deepEqual(await listProcesses(), { processes: [{ pid: 42, name: 'MyApp', path: '/app/MyApp', commandLine: '/app/MyApp --run' }] });
});

test('Linux process discovery falls back only for the observed zombie error', { skip: process.platform !== 'linux' }, async () => {
  const error = "System.IO.IOException: No such process : '/proc/123/environ'\nstack";
  response = [new Error('failed'), '', error];
  fallback = async () => [{ pid: 42, name: 'MyApp', path: '/app/MyApp', commandLine: '' }];
  const result = await listProcesses();
  assert.equal(result.processes[0].pid, 42);
  assert.match(result.warning, /may be missing/);
  fallback = async () => { throw new Error('proc unavailable'); };
  await assert.rejects(listProcesses(), { message: error });
  response = [new Error('failed'), '', 'permission denied'];
  await assert.rejects(listProcesses(), { message: 'permission denied' });
});
