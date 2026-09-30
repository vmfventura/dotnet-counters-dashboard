const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { spawnSync } = require('node:child_process');

const root = resolve(__dirname, '..');

function run(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(process.env.npm_execpath, ['version', 'patch', '--no-git-tag-version']);

const { name, version } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
run(require.resolve('@vscode/vsce/vsce'), [
  'package',
  '--no-rewrite-relative-links',
  '--allow-missing-repository',
  '--out', `${name}-${version}-local.vsix`,
]);
