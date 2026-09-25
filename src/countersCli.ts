import { ChildProcess, execFile, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

export interface DotnetProcess {
  pid: number;
  name: string;
  path: string;
  /** Full command line (when dotnet-counters shows it). */
  commandLine: string;
}

/** One line of the CSV produced by `dotnet-counters collect --format csv`. */
export interface RawCounter {
  provider: string;
  /** Full name as it appears in the CSV, including unit and tags. E.g. "dotnet.gc.collections ({collection} / 1 sec)[gc.heap.generation=gen0]" */
  name: string;
  type: string;
  value: number;
}

/** All lines sharing the same Timestamp. */
export interface RawSample {
  /** Timestamp as written by dotnet-counters (format depends on the current culture). */
  stamp: string;
  /** Sample time (ms epoch), taken from the CSV Timestamp — used on the X axis. */
  time: number;
  counters: RawCounter[];
}

export function getToolPath(): string {
  const configured = vscode.workspace.getConfiguration('dotnetCounters').get<string>('toolPath')?.trim();
  if (configured && configured !== 'dotnet-counters') {
    return configured;
  }
  // VS Code's PATH does not always include global tools; try the default location.
  const exe = process.platform === 'win32' ? 'dotnet-counters.exe' : 'dotnet-counters';
  const globalTool = path.join(os.homedir(), '.dotnet', 'tools', exe);
  return fs.existsSync(globalTool) ? globalTool : 'dotnet-counters';
}

function run(args: string[], timeoutMs = 15000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(getToolPath(), args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === 'ENOENT') {
          reject(new ToolNotFoundError());
        } else {
          reject(new Error((stderr || stdout || err.message).trim()));
        }
        return;
      }
      resolve(stdout);
    });
  });
}

export class ToolNotFoundError extends Error {
  constructor() {
    super('dotnet-counters was not found. Install it with: dotnet tool install --global dotnet-counters');
  }
}

/** Lists the .NET processes visible to `dotnet-counters ps`. */
export async function listProcesses(): Promise<DotnetProcess[]> {
  const out = await run(['ps']);
  const result: DotnetProcess[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\S+)\s*(.*)$/.exec(line);
    if (!m) {
      continue;
    }
    const pid = Number(m[1]);
    if (pid === process.pid) {
      continue;
    }
    // After the path, recent versions show the command line, separated by several spaces.
    const [exePath, ...rest] = m[3].trim().split(/\s{2,}/);
    result.push({ pid, name: m[2], path: exePath ?? '', commandLine: rest.join(' ').trim() });
  }
  return result.sort((a, b) => a.name.localeCompare(b.name) || a.pid - b.pid);
}

/** Splits a CSV line, honoring quotes. */
export function splitCsv(line: string): string[] {
  const cells: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        cur += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      cells.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  cells.push(cur);
  return cells;
}

/**
 * Converts the CSV Timestamp (current culture format, e.g. "09/24/2026 15:26:47" or "24/09/2026 3:26:47 PM")
 * to ms epoch. Only the time of day is used (it is unambiguous), anchored to today's local date.
 */
export function parseStamp(stamp: string, now = Date.now()): number {
  const m = /(\d{1,2}):(\d{2}):(\d{2})(?:[.,](\d+))?\s*([AaPp]\.?\s*[Mm]\.?)?/.exec(stamp);
  if (!m) {
    return now;
  }
  let h = Number(m[1]);
  const ampm = m[5]?.[0]?.toLowerCase();
  if (ampm === 'p' && h < 12) {
    h += 12;
  } else if (ampm === 'a' && h === 12) {
    h = 0;
  }
  const d = new Date(now);
  d.setHours(h, Number(m[2]), Number(m[3]), m[4] ? Number(m[4].slice(0, 3).padEnd(3, '0')) : 0);
  let t = d.getTime();
  // crossed midnight: the sample is from yesterday
  if (t - now > 60 * 60 * 1000) {
    t -= 24 * 60 * 60 * 1000;
  }
  return t;
}

export function parseCsvLine(line: string): { stamp: string; counter: RawCounter } | undefined {
  const cells = splitCsv(line);
  if (cells.length < 5 || cells[0] === 'Timestamp') {
    return undefined;
  }
  // The counter name may contain commas (tags), so the middle cells are joined back.
  const value = Number(cells[cells.length - 1]);
  if (!Number.isFinite(value)) {
    return undefined;
  }
  return {
    stamp: cells[0],
    counter: {
      provider: cells[1],
      name: cells.slice(2, cells.length - 2).join(','),
      type: cells[cells.length - 2],
      value,
    },
  };
}

/**
 * Runs `dotnet-counters collect` for a PID, writing CSV to a temp file, and tails that file,
 * emitting one sample per Timestamp.
 * dotnet-counters buffers its file writes, so lines arrive in bursts and a group is only
 * complete once the next Timestamp shows up (or the process exits).
 */
export class CounterCollector implements vscode.Disposable {
  readonly csvPath: string;
  private child: ChildProcess | undefined;
  private timer: NodeJS.Timeout | undefined;
  private offset = 0;
  private partial = '';
  private pending: RawSample | undefined;
  private stderr = '';
  private disposed = false;

  private readonly _onSample = new vscode.EventEmitter<RawSample>();
  readonly onSample = this._onSample.event;
  private readonly _onExit = new vscode.EventEmitter<string | undefined>();
  /** Fires with the error message (if any) when dotnet-counters exits. */
  readonly onExit = this._onExit.event;

  constructor(readonly pid: number, private readonly counters: string, private readonly refreshInterval: number) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotnet-counters-'));
    this.csvPath = path.join(dir, `counters-${pid}.csv`);
  }

  start(): void {
    const args = [
      'collect',
      '-p', String(this.pid),
      '--format', 'csv',
      '-o', this.csvPath,
      '--refresh-interval', String(this.refreshInterval),
    ];
    if (this.counters.trim()) {
      args.push('--counters', this.counters.trim());
    }
    this.child = spawn(getToolPath(), args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout?.on('data', () => { /* drain so it never blocks */ });
    this.child.stderr?.on('data', (d: Buffer) => { this.stderr += d.toString(); });
    this.child.on('error', (err: NodeJS.ErrnoException) => {
      this.finish(err.code === 'ENOENT' ? new ToolNotFoundError().message : err.message);
    });
    this.child.on('exit', (code) => {
      this.poll();
      this.flush();
      this.finish(code && code !== 0 ? (this.stderr.trim() || `dotnet-counters exited with code ${code}`) : undefined);
    });
    this.timer = setInterval(() => this.poll(), 250);
  }

  get running(): boolean {
    return !!this.child && this.child.exitCode === null && !this.disposed;
  }

  stop(): void {
    if (this.child && this.child.exitCode === null) {
      // 'q' ends collect cleanly; if it does not react, kill the process.
      try { this.child.stdin?.write('q'); } catch { /* ignore */ }
      const c = this.child;
      setTimeout(() => { if (c.exitCode === null) { c.kill(); } }, 1500);
    }
  }

  private finish(error: string | undefined): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (!this.disposed) {
      this._onExit.fire(error);
    }
  }

  private poll(): void {
    let fd: number | undefined;
    try {
      if (!fs.existsSync(this.csvPath)) {
        return;
      }
      const size = fs.statSync(this.csvPath).size;
      if (size > this.offset) {
        fd = fs.openSync(this.csvPath, 'r');
        const buf = Buffer.alloc(size - this.offset);
        fs.readSync(fd, buf, 0, buf.length, this.offset);
        this.offset = size;
        const text = this.partial + buf.toString('utf8');
        const lines = text.split(/\r?\n/);
        this.partial = lines.pop() ?? '';
        for (const line of lines) {
          const parsed = parseCsvLine(line);
          if (!parsed) {
            continue;
          }
          if (this.pending && this.pending.stamp !== parsed.stamp) {
            this.flush();
          }
          if (!this.pending) {
            this.pending = { stamp: parsed.stamp, time: parseStamp(parsed.stamp), counters: [] };
          }
          this.pending.counters.push(parsed.counter);
        }
      }
    } catch {
      // the file may be briefly locked; retry on the next tick
    } finally {
      if (fd !== undefined) {
        fs.closeSync(fd);
      }
    }
  }

  private flush(): void {
    if (this.pending) {
      const s = this.pending;
      this.pending = undefined;
      this._onSample.fire(s);
    }
  }

  dispose(): void {
    this.stop();
    this.disposed = true;
    if (this.timer) {
      clearInterval(this.timer);
    }
    this._onSample.dispose();
    this._onExit.dispose();
  }
}
