import { execFile } from 'child_process';
import * as path from 'path';

/**
 * Start time (ms epoch) of each process, looked up in a single OS call.
 * Processes that exited or that the current user cannot inspect are simply missing from the map.
 */
export function getProcessStartTimes(pids: number[]): Promise<Map<number, number>> {
  const ids = [...new Set(pids.filter((p) => Number.isInteger(p) && p > 0))];
  if (!ids.length) {
    return Promise.resolve(new Map());
  }
  return process.platform === 'win32' ? windowsStartTimes(ids) : unixStartTimes(ids);
}

export async function getProcessStartTime(pid: number): Promise<number | undefined> {
  return (await getProcessStartTimes([pid])).get(pid);
}

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    // A non-zero exit code only means some ids were not found; stdout still has the rest.
    execFile(file, args, { timeout: 10000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (_err, stdout) => resolve(stdout ?? ''));
  });
}

/** Absolute path, so it works even when VS Code was started with a reduced PATH. */
function powershellPath(): string {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

async function windowsStartTimes(ids: number[]): Promise<Map<number, number>> {
  // Get-Process is fast but StartTime throws for elevated/other users' processes;
  // Win32_Process.CreationDate (CIM) is readable for those, so it fills the gaps.
  const script =
    `$ids = @(${ids.join(',')}); $seen = @{}; ` +
    `Get-Process -Id $ids -ErrorAction SilentlyContinue | ForEach-Object { ` +
    `try { "$($_.Id) $($_.StartTime.ToUniversalTime().ToString('o'))"; $seen[$_.Id] = 1 } catch {} }; ` +
    `$missing = @($ids | Where-Object { -not $seen.ContainsKey($_) }); ` +
    `if ($missing.Count) { ` +
    `Get-CimInstance Win32_Process -Filter (($missing | ForEach-Object { "ProcessId=$_" }) -join ' OR ') -ErrorAction SilentlyContinue | ` +
    `Where-Object CreationDate | ForEach-Object { "$($_.ProcessId) $($_.CreationDate.ToUniversalTime().ToString('o'))" } }`;
  let out = await run(powershellPath(), ['-NoProfile', '-NonInteractive', '-Command', script]);
  if (!out.trim()) {
    out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
  }
  const map = new Map<number, number>();
  for (const line of out.split(/\r?\n/)) {
    const m = /^(\d+)\s+(\S+)/.exec(line.trim());
    const t = m ? Date.parse(m[2]) : NaN;
    if (m && Number.isFinite(t)) {
      map.set(Number(m[1]), t);
    }
  }
  return map;
}

/** Linux/macOS: elapsed time from `ps`. `etimes` (seconds) is Linux-only, so parse `etime` ([[dd-]hh:]mm:ss). */
async function unixStartTimes(ids: number[]): Promise<Map<number, number>> {
  const now = Date.now();
  const out = await run('ps', ['-o', 'pid=,etime=', '-p', ids.join(',')]);
  const map = new Map<number, number>();
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s*$/.exec(line);
    if (m) {
      const secs = Number(m[2] ?? 0) * 86400 + Number(m[3] ?? 0) * 3600 + Number(m[4]) * 60 + Number(m[5]);
      map.set(Number(m[1]), now - secs * 1000);
    }
  }
  return map;
}

/** "3d 04h", "2h 13m", "5m 07s", "42s". */
export function formatUptime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  return d ? `${d}d ${p(h)}h` : h ? `${h}h ${p(m)}m` : m ? `${m}m ${p(sec)}s` : `${sec}s`;
}
