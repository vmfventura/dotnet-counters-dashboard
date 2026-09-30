import * as os from 'os';
import type { RawCounter, RawSample } from './countersCli';

export interface GcSemantics {
  pause?: 'interval-pause' | 'since-last-gc' | 'unknown' | 'mixed';
  heap?: 'last-collection' | 'live-estimate' | 'unknown' | 'mixed';
  collections?: 'inclusive' | 'exclusive' | 'unknown' | 'mixed';
}

/** Common units; GC provenance preserves differences between EventCounters and Meters. */
export interface DerivedSample {
  time: number;
  gcSemantics?: GcSemantics;
  cpuPercent: number | null;
  memPercent: number | null;
  workingSetMB: number | null;
  gcHeapMB: number | null;
  gcCommittedMB: number | null;
  gen0: number | null;
  gen1: number | null;
  gen2: number | null;
  gcPausePercent: number | null;
  allocMBps: number | null;
  threadPoolThreads: number | null;
  threadPoolQueue: number | null;
  threadPoolWorkItems: number | null;
  exceptions: number | null;
  lockContentions: number | null;
}

export type MetricKey = keyof Omit<DerivedSample, 'time' | 'gcSemantics'>;

export const DERIVED_KEYS: MetricKey[] = [
  'cpuPercent', 'memPercent', 'workingSetMB', 'gcHeapMB', 'gcCommittedMB',
  'gen0', 'gen1', 'gen2', 'gcPausePercent', 'allocMBps',
  'threadPoolThreads', 'threadPoolQueue', 'threadPoolWorkItems', 'exceptions', 'lockContentions',
];

export const DERIVED_LABELS: Record<MetricKey, string> = {
  cpuPercent: 'CPU (%)',
  memPercent: 'Memory (% of system total)',
  workingSetMB: 'Working set (MB)',
  gcHeapMB: 'GC heap (MB)',
  gcCommittedMB: 'GC committed (MB)',
  gen0: 'GC gen0 (/s)',
  gen1: 'GC gen1 (/s)',
  gen2: 'GC gen2 (/s)',
  gcPausePercent: 'Time in GC (%)',
  allocMBps: 'Allocation rate (MB/s)',
  threadPoolThreads: 'ThreadPool threads',
  threadPoolQueue: 'ThreadPool queue length',
  threadPoolWorkItems: 'ThreadPool work items (/s)',
  exceptions: 'Exceptions (/s)',
  lockContentions: 'Lock contentions (/s)',
};

export const GC_SEMANTIC_COLUMNS = {
  pause: 'GC pause semantics', heap: 'GC heap semantics', collections: 'GC collection semantics',
} as const;

/** Older exports have no provenance: do not infer it from the latest counters or runtime name. */
export function parseGcSemantics(value: unknown): GcSemantics | undefined {
  if (!value || typeof value !== 'object') { return undefined; }
  const raw = value as Record<string, unknown>;
  const result: GcSemantics = {};
  if (typeof raw.pause === 'string' && ['interval-pause', 'since-last-gc', 'unknown', 'mixed'].includes(raw.pause)) {
    result.pause = raw.pause as GcSemantics['pause'];
  }
  if (typeof raw.heap === 'string' && ['last-collection', 'live-estimate', 'unknown', 'mixed'].includes(raw.heap)) {
    result.heap = raw.heap as GcSemantics['heap'];
  }
  if (typeof raw.collections === 'string' && ['inclusive', 'exclusive', 'unknown', 'mixed'].includes(raw.collections)) {
    result.collections = raw.collections as GcSemantics['collections'];
  }
  return Object.keys(result).length ? result : undefined;
}

const MB = 1024 * 1024;

export interface ParsedName {
  base: string;
  unit: string;
  tags: string;
  /** Divisor that normalizes "/ N sec" rates to per-second. */
  perSeconds: number;
}

export function parseCounterName(name: string): ParsedName {
  const m = /^(.*?)\s*(?:\(([^()]*)\))?\s*(?:\[(.*)\])?$/.exec(name.trim());
  const base = (m?.[1] ?? name).trim();
  const unit = (m?.[2] ?? '').trim();
  const tags = (m?.[3] ?? '').trim();
  const per = /\/\s*(\d+(?:\.\d+)?)\s*sec/.exec(unit);
  return { base, unit, tags, perSeconds: per ? Number(per[1]) || 1 : 1 };
}

export class MetricDeriver {
  private cpuCount = os.cpus().length || 1;
  private readonly totalMemMB = os.totalmem() / MB;

  derive(sample: RawSample): DerivedSample {
    const d: DerivedSample = {
      time: sample.time,
      cpuPercent: null, memPercent: null, workingSetMB: null, gcHeapMB: null, gcCommittedMB: null,
      gen0: null, gen1: null, gen2: null, gcPausePercent: null, allocMBps: null,
      threadPoolThreads: null, threadPoolQueue: null, threadPoolWorkItems: null, exceptions: null, lockContentions: null,
    };
    let cpuSeconds: number | null = null;
    const add = (key: MetricKey, v: number) => {
      d[key] = (d[key] ?? 0) + v;
    };
    const addGc = <K extends keyof GcSemantics>(kind: K, key: MetricKey, value: number | null, semantics: NonNullable<GcSemantics[K]>) => {
      d.gcSemantics ??= {};
      const previous = d.gcSemantics[kind];
      if (previous && previous !== semantics) {
        d.gcSemantics[kind] = 'mixed';
        const keys: MetricKey[] = kind === 'collections' ? ['gen0', 'gen1', 'gen2'] : [key];
        for (const k of keys) { d[k] = null; }
        return;
      }
      d.gcSemantics[kind] = semantics;
      if (value !== null) { add(key, value); }
    };

    for (const c of sample.counters) {
      if (c.provider !== 'System.Runtime') { continue; }
      const p = parseCounterName(c.name);
      const v = c.type === 'Rate' ? c.value / p.perSeconds : c.value;
      const gen = /generation=gen([012])/.exec(p.tags)?.[1];
      switch (p.base) {
        // --- Meters (.NET 9+) ---
        case 'dotnet.process.cpu.count': this.cpuCount = v || this.cpuCount; break;
        case 'dotnet.process.cpu.time': cpuSeconds = (cpuSeconds ?? 0) + v; break;
        case 'dotnet.process.memory.working_set': add('workingSetMB', v / MB); break;
        case 'dotnet.gc.last_collection.heap.size':
          addGc('heap', 'gcHeapMB', c.type === 'Rate' ? null : v / MB, c.type === 'Rate' ? 'unknown' : 'last-collection');
          break;
        case 'dotnet.gc.last_collection.memory.committed_size': add('gcCommittedMB', v / MB); break;
        case 'dotnet.gc.collections': if (gen) { addGc('collections', `gen${gen}` as 'gen0', v, 'exclusive'); } break;
        case 'dotnet.gc.pause.time':
          addGc('pause', 'gcPausePercent', c.type === 'Rate' ? v * 100 : null, c.type === 'Rate' ? 'interval-pause' : 'unknown');
          break;
        case 'dotnet.gc.heap.total_allocated': add('allocMBps', v / MB); break;
        // dotnet-counters reports UpDownCounters as 'Rate' (deltas); only absolute values are usable.
        case 'dotnet.thread_pool.thread.count': if (c.type !== 'Rate') { add('threadPoolThreads', v); } break;
        case 'dotnet.thread_pool.queue.length': if (c.type !== 'Rate') { add('threadPoolQueue', v); } break;
        case 'dotnet.thread_pool.work_item.count': add('threadPoolWorkItems', v); break;
        case 'dotnet.exceptions': add('exceptions', v); break;
        case 'dotnet.monitor.lock_contentions': add('lockContentions', v); break;
        // --- EventCounters (System.Runtime up to .NET 8) ---
        case 'CPU Usage': add('cpuPercent', v); break;
        // Runtime EventCounters use decimal MB; normalize to the same binary units as Meters.
        case 'Working Set': add('workingSetMB', v * 1_000_000 / MB); break;
        case 'GC Heap Size': addGc('heap', 'gcHeapMB', v * 1_000_000 / MB, 'live-estimate'); break;
        case 'GC Committed Bytes': add('gcCommittedMB', v * 1_000_000 / MB); break;
        case 'Gen 0 GC Count': addGc('collections', 'gen0', v, 'inclusive'); break;
        case 'Gen 1 GC Count': addGc('collections', 'gen1', v, 'inclusive'); break;
        case 'Gen 2 GC Count': addGc('collections', 'gen2', v, 'inclusive'); break;
        case '% Time in GC since last GC': addGc('pause', 'gcPausePercent', v, 'since-last-gc'); break;
        case 'Allocation Rate': add('allocMBps', v / MB); break;
        case 'ThreadPool Thread Count': add('threadPoolThreads', v); break;
        case 'ThreadPool Queue Length': add('threadPoolQueue', v); break;
        case 'ThreadPool Completed Work Item Count': add('threadPoolWorkItems', v); break;
        case 'Exception Count': add('exceptions', v); break;
        case 'Monitor Lock Contention Count': add('lockContentions', v); break;
      }
    }
    if (d.cpuPercent === null && cpuSeconds !== null) {
      d.cpuPercent = (cpuSeconds / this.cpuCount) * 100;
    }
    if (d.workingSetMB !== null) {
      d.memPercent = (d.workingSetMB / this.totalMemMB) * 100;
    }
    return d;
  }
}

export function counterKey(c: RawCounter): string {
  return `${c.provider}|${c.name}`;
}
