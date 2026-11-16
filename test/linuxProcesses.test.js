const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { listLinuxProcesses } = require('../out/linuxProcesses');

test('Linux discovery includes only live processes owning the matching diagnostics socket', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'counters-proc-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'net'));
  const entries = [
    [101, '1001', '11', 'S', '11'],
    [102, '1002', '12', 'Z', '12'],
    [103, '1003', '13', 'S', '999'],
    [104, '1004', '14', 'S', '14'],
    [105, '1005', '15', 'S', '15'],
  ];
  const lines = [];
  for (const [pid, inode, started, state, actualStart] of entries) {
    const dir = path.join(root, String(pid));
    await fs.mkdir(path.join(dir, 'fd'), { recursive: true });
    await fs.writeFile(path.join(dir, 'stat'), `${pid} (app with ) in name) ${[state, ...Array(18).fill('0'), actualStart, '0'].join(' ')}\n`);
    await fs.writeFile(path.join(dir, 'cmdline'), `/bin/App${pid}\0--test\0`);
    await fs.symlink(`/bin/App${pid}${pid === 101 ? ' (deleted)' : ''}`, path.join(dir, 'exe'));
    await fs.symlink(`socket:[${pid === 104 ? '9999' : inode}]`, path.join(dir, 'fd', '4'));
    lines.push(`000: 00000002 00000000 00010000 0001 01 ${inode} /tmp/with space/dotnet-diagnostic-${pid}-${started}-socket`);
  }
  await fs.rm(path.join(root, '105', 'cmdline'));
  await fs.writeFile(path.join(root, 'net', 'unix'), lines.join('\n'));
  assert.deepEqual(await listLinuxProcesses(root), [{ pid: 101, name: 'App101', path: '/bin/App101', commandLine: '/bin/App101 --test' }]);
});

test('Linux discovery reports failure when socket inventory cannot be read', async () => {
  await assert.rejects(listLinuxProcesses('/nonexistent-counters-proc-test'));
});
