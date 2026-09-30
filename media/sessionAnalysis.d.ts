import type { DerivedSample, GcSemantics, MetricKey } from '../src/metrics';

export interface Thresholds {
  hotspotCpuPercent: number;
  freezeGcPausePercent: number;
  freezeLockContentionsPerSecond: number;
  highGcCollectionsPerSecond: number;
}

export interface Interval {
  from: number;
  to: number;
  peak: number;
  peakAt: number;
}

export interface Stats {
  min: number;
  max: number;
  avg: number;
  first: number;
  last: number;
}

interface IntervalSummary {
  count: number;
  seconds: number;
  intervals: Interval[];
}

export interface Summary {
  from: number;
  to: number;
  durationSeconds: number;
  observedSeconds: number;
  missingSeconds: number;
  gaps: { from: number; to: number }[];
  coverageSeconds: Partial<Record<MetricKey | 'gcTotal', number>>;
  gcSemantics: Required<GcSemantics>;
  samples: number;
  cpuPercent: Stats | null;
  memoryPercent: Stats | null;
  workingSetMB: Stats | null;
  gcHeapMB: Stats | null;
  gcPausePercent: Stats | null;
  gcCollectionsPerSecond: Stats | null;
  gcCollections: { gen0: number | null; gen1: number | null; gen2: number | null };
  gcCollectionsTotal: number | null;
  gcPauseSeconds: number | null;
  allocatedMB: number | null;
  exceptions: number | null;
  lockContentions: number | null;
  hotspots: IntervalSummary;
  freezes: IntervalSummary & { longestSeconds: number };
  highGc: IntervalSummary;
  thresholds: Thresholds;
}

export const DEFAULT_THRESHOLDS: Readonly<Thresholds>;
export function computeSummary(samples: readonly DerivedSample[], refreshInterval: number, thresholds: Thresholds): Summary | null;
export function findings(summary: Summary): { kind: string; text: string }[];
export function summaryForExport(summary: Summary | null): Record<string, unknown> | undefined;
export function isGap(previous: { time: number }, current: { time: number }, refreshMs: number): boolean;
export function sampleEnd(view: readonly { time: number }[], index: number, refreshMs: number): number;
export function withTotals(sample: DerivedSample): DerivedSample & { gcTotal: number | null };
export function semanticsOf(samples: readonly DerivedSample[], kind: keyof GcSemantics, keys: MetricKey[]): string;
export function segments(samples: readonly DerivedSample[], key: MetricKey, refreshMs: number): DerivedSample[][];
export function gcLabel(kind: keyof GcSemantics, semantics: string): string;
