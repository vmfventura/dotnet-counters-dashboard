import type { DotnetProcess } from './countersCli';
import { DERIVED_KEYS, DERIVED_LABELS, DerivedSample, GC_SEMANTIC_COLUMNS } from './metrics';
import type { LatestCounter, TimeRange } from './session';
import { computeSummary, summaryForExport, Thresholds } from '../media/sessionAnalysis';

export interface SnapshotData {
  process: DotnetProcess;
  project?: string;
  startedAt: number;
  processStartedAt?: number;
  refreshInterval: number;
  thresholds: Thresholds;
  samples: readonly DerivedSample[];
  latestCounters: readonly LatestCounter[];
  range?: TimeRange;
}

/** Data captured before an asynchronous dialog or while the dashboard is paused. */
export class SessionSnapshot {
  readonly data: SnapshotData;

  constructor(data: SnapshotData) {
    this.data = {
      ...data,
      process: { ...data.process },
      range: data.range ? { ...data.range } : undefined,
      thresholds: { ...data.thresholds },
      samples: data.samples.map((s) => s.gcSemantics ? { ...s, gcSemantics: { ...s.gcSemantics } } : { ...s }),
      latestCounters: data.latestCounters.map((c) => ({ ...c })),
    };
  }

  toDerivedCsv(): string {
    const semanticKeys = Object.keys(GC_SEMANTIC_COLUMNS) as (keyof typeof GC_SEMANTIC_COLUMNS)[];
    const header = ['timestamp', ...DERIVED_KEYS.map((k) => DERIVED_LABELS[k]), ...semanticKeys.map((k) => GC_SEMANTIC_COLUMNS[k]), 'Sampling interval (s)'];
    const rows = this.data.samples.map((s) => [
      new Date(s.time).toISOString(),
      ...DERIVED_KEYS.map((k) => s[k] === null ? '' : String(s[k])),
      ...semanticKeys.map((k) => s.gcSemantics?.[k] ?? ''),
      String(this.data.refreshInterval),
    ]);
    return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\n') + '\n';
  }

  toJson(): string {
    const d = this.data;
    const summary = computeSummary(d.samples, d.refreshInterval, d.thresholds);
    return JSON.stringify({
      process: d.process,
      project: d.project,
      startedAt: new Date(d.startedAt).toISOString(),
      processStartedAt: d.processStartedAt ? new Date(d.processStartedAt).toISOString() : undefined,
      exportedAt: new Date().toISOString(),
      refreshInterval: d.refreshInterval,
      gcSemantics: summary?.gcSemantics,
      range: d.range ? { from: new Date(d.range.from).toISOString(), to: new Date(d.range.to).toISOString() } : undefined,
      analysis: summaryForExport(summary),
      metrics: DERIVED_LABELS,
      samples: d.samples.map((s) => ({ ...s, time: new Date(s.time).toISOString() })),
      latestCounters: d.latestCounters,
    }, null, 2);
  }
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
