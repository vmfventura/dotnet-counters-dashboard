import * as fs from 'fs/promises';
import * as path from 'path';
import type { DotnetProcess } from './countersCli';

/** Find processes with a live default .NET diagnostics socket visible in this network namespace. */
export async function listLinuxProcesses(procRoot = '/proc'): Promise<DotnetProcess[]> {
  const sockets = await fs.readFile(path.join(procRoot, 'net/unix'), 'utf8');
  const result: DotnetProcess[] = [];
  const seen = new Set<number>();
  for (const line of sockets.split('\n')) {
    const match = /^\s*\S+:\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(\d+)\s+.*\/dotnet-diagnostic-(\d+)-(\d+)-socket$/.exec(line);
    if (!match) { continue; }
    const [, inode, pidText, startTime] = match;
    const pid = Number(pidText);
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid || seen.has(pid)) { continue; }
    const dir = path.join(procRoot, pidText);
    try {
      const stat = await fs.readFile(path.join(dir, 'stat'), 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (fields[0] === 'Z' || fields[0] === 'X' || fields[19] !== startTime) { continue; }
      const fds = await fs.readdir(path.join(dir, 'fd'));
      let ownsSocket = false;
      for (let i = 0; i < fds.length; i += 64) {
        const links = await Promise.all(fds.slice(i, i + 64).map((fd) => fs.readlink(path.join(dir, 'fd', fd)).catch(() => '')));
        if (links.includes(`socket:[${inode}]`)) { ownsSocket = true; break; }
      }
      if (!ownsSocket) { continue; }
      const [exe, cmdline, currentStat] = await Promise.all([
        fs.readlink(path.join(dir, 'exe')),
        fs.readFile(path.join(dir, 'cmdline'), 'utf8'),
        fs.readFile(path.join(dir, 'stat'), 'utf8'),
      ]);
      const currentFields = currentStat.slice(currentStat.lastIndexOf(')') + 2).split(' ');
      if (currentFields[0] === 'Z' || currentFields[0] === 'X' || currentFields[19] !== startTime) { continue; }
      const exePath = exe.replace(/ \(deleted\)$/, '');
      result.push({ pid, name: path.basename(exePath), path: exePath, commandLine: cmdline.split('\0').filter(Boolean).join(' ') });
      seen.add(pid);
    } catch {
      // Processes can exit or become inaccessible while they are being inspected.
    }
  }
  return result.sort((a, b) => a.name.localeCompare(b.name) || a.pid - b.pid);
}
