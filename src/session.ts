import * as fs from 'fs';
import * as vscode from 'vscode';
import { CounterCollector, DotnetProcess, parseCsvLine, parseStamp, RawSample } from './countersCli';
import type { ImportedData } from './importer';
import { getProcessStartTime } from './processInfo';
import { counterKey, DERIVED_KEYS, DERIVED_LABELS, DerivedSample, MetricDeriver } from './metrics';

export interface LatestCounter {
  provider: string;
  name: string;
  type: string;
  value: number;
}

export type SessionState = 'running' | 'stopped';

/** Inclusive time range in ms epoch. */
export interface TimeRange {
  from: number;
  to: number;
}

let nextId = 1;

/** A monitoring session for one process, or a read-only session loaded from an exported file. */
export class CounterSession implements vscode.Disposable {
  readonly id = nextId++;
  readonly startedAt: number;
  state: SessionState = 'running';
  error: string | undefined;
  readonly samples: DerivedSample[] = [];
  readonly latest = new Map<string, LatestCounter>();
  sampleCount = 0;
  /** When the monitored process itself started (ms epoch), if the OS lets us know. */
  processStartedAt: number | undefined;
  /** Resolves once the process start time lookup finished. */
  readonly processInfo: Promise<number | undefined>;
  /** When collection stopped (live) or the last sample time (imported). */
  endedAt: number | undefined;
  /** Set when the session was attached automatically for a watched project. */
  watchId: string | undefined;
  /** True once the user stopped this session (as opposed to the process exiting). */
  stoppedByUser = false;

  private readonly collector: CounterCollector | undefined;
  private readonly deriver = new MetricDeriver();
  private readonly _onSample = new vscode.EventEmitter<{ derived: DerivedSample; raw: RawSample }>();
  readonly onSample = this._onSample.event;
  private readonly _onStateChange = new vscode.EventEmitter<CounterSession>();
  readonly onStateChange = this._onStateChange.event;

  constructor(readonly proc: DotnetProcess, readonly projectName: string | undefined, readonly imported?: ImportedData) {
    const cfg = vscode.workspace.getConfiguration('dotnetCounters');
    if (imported) {
      this.startedAt = imported.startedAt;
      this.state = 'stopped';
      this.samples.push(...imported.samples);
      this.sampleCount = imported.samples.length;
      for (const c of imported.latest) {
        this.latest.set(counterKey(c), { ...c });
      }
      this.collector = undefined;
      this.processStartedAt = imported.processStartedAt;
      this.processInfo = Promise.resolve(imported.processStartedAt);
      this.endedAt = imported.samples[imported.samples.length - 1]?.time;
      return;
    }
    this.startedAt = Date.now();
    const lookup = () => getProcessStartTime(proc.pid).catch(() => undefined);
    this.processInfo = lookup()
      .then((t) => t ?? new Promise<number | undefined>((r) => setTimeout(() => r(lookup()), 5000)))
      .then((t) => (this.processStartedAt = t));
    const maxPoints = cfg.get<number>('maxHistoryPoints', 3600);
    this.collector = new CounterCollector(proc.pid, cfg.get<string>('counters', 'System.Runtime'), cfg.get<number>('refreshInterval', 1));
    this.collector.onSample((raw) => {
      const derived = this.deriver.derive(raw);
      this.sampleCount++;
      this.samples.push(derived);
      if (this.samples.length > maxPoints) {
        this.samples.splice(0, this.samples.length - maxPoints);
      }
      for (const c of raw.counters) {
        this.latest.set(counterKey(c), { ...c });
      }
      this._onSample.fire({ derived, raw });
    });
    this.collector.onExit((err) => {
      this.state = 'stopped';
      this.error = err;
      this.endedAt = Date.now();
      this._onStateChange.fire(this);
    });
    this.collector.start();
  }

  get title(): string {
    return this.imported ? `${this.proc.name} (imported)` : `${this.proc.name} (${this.proc.pid})`;
  }

  get rawCsvPath(): string | undefined {
    return this.collector?.csvPath;
  }

  /** Whether the raw dotnet-counters CSV is available for export. */
  get hasRawCsv(): boolean {
    return this.imported ? !!this.imported.rawCsv : true;
  }

  /** Sampling interval in seconds (configured for live sessions, inferred for imported files). */
  get refreshInterval(): number {
    if (!this.imported) {
      return vscode.workspace.getConfiguration('dotnetCounters').get<number>('refreshInterval', 1);
    }
    const d = this.samples.slice(1, 2001).map((s, i) => s.time - this.samples[i].time).filter((x) => x > 0).sort((a, b) => a - b);
    return d.length ? Math.max(0.1, d[Math.floor(d.length / 2)] / 1000) : 1;
  }

  stop(): void {
    // remembered so a watched project does not immediately re-attach to the same process
    this.stoppedByUser = true;
    this.collector?.stop();
  }

  /** Samples inside the range (all samples when no range is given). */
  samplesIn(range?: TimeRange): DerivedSample[] {
    return range ? this.samples.filter((s) => s.time >= range.from && s.time <= range.to) : this.samples;
  }

  /** CSV of the normalized metrics (one row per sample). */
  toDerivedCsv(range?: TimeRange): string {
    const header = ['timestamp', ...DERIVED_KEYS.map((k) => DERIVED_LABELS[k])];
    const rows = this.samplesIn(range).map((s) => [
      new Date(s.time).toISOString(),
      ...DERIVED_KEYS.map((k) => (s[k] === null ? '' : String(round(s[k] as number)))),
    ]);
    return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
  }

  toJson(range?: TimeRange, analysis?: unknown): string {
    return JSON.stringify({
      process: this.proc,
      project: this.projectName,
      startedAt: new Date(this.startedAt).toISOString(),
      processStartedAt: this.processStartedAt ? new Date(this.processStartedAt).toISOString() : undefined,
      exportedAt: new Date().toISOString(),
      range: range ? { from: new Date(range.from).toISOString(), to: new Date(range.to).toISOString() } : undefined,
      analysis,
      metrics: DERIVED_LABELS,
      samples: this.samplesIn(range).map((s) => ({ ...s, time: new Date(s.time).toISOString() })),
      latestCounters: [...this.latest.values()],
    }, null, 2);
  }

  /** Raw content written by dotnet-counters (all counters), optionally limited to a time range. */
  readRawCsv(range?: TimeRange): string {
    const file = this.rawCsvPath;
    const text = this.imported ? this.imported.rawCsv ?? '' : file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (!range) {
      return text;
    }
    const now = Date.now();
    const toTime = this.imported ? this.imported.stampToTime : (stamp: string) => parseStamp(stamp, now);
    const lines = text.split(/\r?\n/);
    const kept = lines.filter((line, i) => {
      if (i === 0) {
        return true; // header
      }
      const parsed = parseCsvLine(line);
      if (!parsed) {
        return false;
      }
      const t = toTime(parsed.stamp);
      return t >= range.from && t <= range.to;
    });
    return kept.join('\n') + '\n';
  }

  dispose(): void {
    this.collector?.dispose();
    this._onSample.dispose();
    this._onStateChange.dispose();
  }
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** Saves a session's data to a file chosen by the user. */
export async function exportSession(session: CounterSession, format?: 'csv' | 'json' | 'raw', range?: TimeRange, analysis?: unknown): Promise<void> {
  if (!format) {
    const pick = await vscode.window.showQuickPick([
      { label: 'CSV — normalized metrics', description: 'CPU %, memory %, GC, …', format: 'csv' as const },
      { label: 'JSON — metrics + latest values of all counters', format: 'json' as const },
      { label: 'Raw dotnet-counters CSV', description: 'all counters, all samples', format: 'raw' as const },
    ], { title: `Export ${session.title}` });
    if (!pick) {
      return;
    }
    format = pick.format;
  }
  if (format === 'raw' && !session.hasRawCsv) {
    void vscode.window.showWarningMessage('The raw dotnet-counters CSV is not available for this session (it was imported from a normalized CSV or JSON file).');
    return;
  }
  const stamp = new Date(session.startedAt).toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const base = `${session.proc.name}-${session.proc.pid}-${stamp}`;
  const ext = format === 'json' ? 'json' : 'csv';
  const hhmmss = (t: number) => new Date(t).toTimeString().slice(0, 8).replace(/:/g, '');
  const suffix = (range ? `-${hhmmss(range.from)}-${hhmmss(range.to)}` : '') + (format === 'raw' ? '-raw' : '');
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  const defaultUri = folder ? vscode.Uri.joinPath(folder, `${base}${suffix}.${ext}`) : undefined;
  const target = await vscode.window.showSaveDialog({
    defaultUri,
    filters: format === 'json' ? { JSON: ['json'] } : { CSV: ['csv'] },
    title: range ? `Export ${session.title} (selected interval)` : `Export ${session.title}`,
  });
  if (!target) {
    return;
  }
  const content = format === 'json' ? session.toJson(range, analysis) : format === 'raw' ? session.readRawCsv(range) : session.toDerivedCsv(range);
  await vscode.workspace.fs.writeFile(target, Buffer.from(content, 'utf8'));
  const open = await vscode.window.showInformationMessage(`Data exported to ${target.fsPath}`, 'Open');
  if (open) {
    await vscode.window.showTextDocument(target);
  }
}
