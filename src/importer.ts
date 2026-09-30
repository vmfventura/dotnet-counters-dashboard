import * as path from 'path';
import * as vscode from 'vscode';
import { DotnetProcess, parseCsvLine, parseStamp, RawSample, splitCsv } from './countersCli';
import { counterKey, DERIVED_KEYS, DERIVED_LABELS, DerivedSample, GC_SEMANTIC_COLUMNS, MetricDeriver, parseCounterName, parseGcSemantics } from './metrics';
import type { LatestCounter } from './session';
import { DEFAULT_THRESHOLDS, Thresholds } from '../media/sessionAnalysis';

export type ImportFormat = 'raw' | 'normalized' | 'json';

/** Data loaded from a file, ready to be shown in a (read-only) session. */
export interface ImportedData {
  file: string;
  format: ImportFormat;
  proc: DotnetProcess;
  project?: string;
  startedAt: number;
  /** Start time of the recorded process, when the export has it (JSON). */
  processStartedAt?: number;
  refreshInterval?: number;
  thresholds?: Thresholds;
  samples: DerivedSample[];
  latest: LatestCounter[];
  /** Original raw dotnet-counters CSV, when the file was one (enables the raw export). */
  rawCsv?: string;
  /** Converts a raw CSV Timestamp to ms epoch (used to filter the raw export by time range). */
  stampToTime: (stamp: string) => number;
}

/**
 * Builds a parser for full CSV timestamps ("09/24/2026 15:26:47", "24/09/2026 3:26:47 PM", "2026-09-24 15:26:47").
 * dotnet-counters writes them in the current culture, so month/day order is inferred from the whole file.
 */
export function makeStampParser(stamps: string[]): (stamp: string) => number {
  const re = /^(\d{1,4})[/.-](\d{1,2})[/.-](\d{1,4})[ T]+(\d{1,2}):(\d{2}):(\d{2})(?:[.,](\d+))?\s*([AaPp]\.?\s*[Mm]\.?)?/;
  let dayFirst = false;
  for (const s of stamps) {
    const m = re.exec(s.trim());
    if (m && m[1].length < 4) {
      if (Number(m[1]) > 12) {
        dayFirst = true;
        break;
      }
      if (Number(m[2]) > 12) {
        break; // month first
      }
    }
  }
  return (stamp: string) => {
    const m = re.exec(stamp.trim());
    if (!m) {
      const t = Date.parse(stamp);
      return Number.isFinite(t) ? t : parseStamp(stamp);
    }
    let [y, mo, d] = m[1].length === 4
      ? [Number(m[1]), Number(m[2]), Number(m[3])]
      : dayFirst
        ? [Number(m[3]), Number(m[2]), Number(m[1])]
        : [Number(m[3]), Number(m[1]), Number(m[2])];
    if (y < 100) {
      y += 2000;
    }
    let h = Number(m[4]);
    const ampm = m[8]?.[0]?.toLowerCase();
    if (ampm === 'p' && h < 12) {
      h += 12;
    } else if (ampm === 'a' && h === 12) {
      h = 0;
    }
    const ms = m[7] ? Number(m[7].slice(0, 3).padEnd(3, '0')) : 0;
    return new Date(y, mo - 1, d, h, Number(m[5]), Number(m[6]), ms).getTime();
  };
}

function importedProc(file: string, name?: string, pid?: number): DotnetProcess {
  return { pid: pid ?? 0, name: name || path.basename(file).replace(/\.[^.]+$/, ''), path: file, commandLine: '' };
}

/** Raw `dotnet-counters collect --format csv` output (also what "Raw CSV" export writes). */
function parseRaw(file: string, text: string): ImportedData {
  const lines = text.split(/\r?\n/);
  const parsed = lines.map(parseCsvLine).filter((p): p is NonNullable<typeof p> => !!p);
  if (!parsed.length) {
    throw new Error('The file has no counter rows.');
  }
  const stampToTime = makeStampParser([...new Set(parsed.map((p) => p.stamp))]);
  const deriver = new MetricDeriver();
  const samples: DerivedSample[] = [];
  const latest = new Map<string, LatestCounter>();
  let cur: RawSample | undefined;
  const flush = () => {
    if (cur) {
      samples.push(deriver.derive(cur));
      cur = undefined;
    }
  };
  for (const p of parsed) {
    if (cur && cur.stamp !== p.stamp) {
      flush();
    }
    if (!cur) {
      cur = { stamp: p.stamp, time: stampToTime(p.stamp), counters: [] };
    }
    cur.counters.push(p.counter);
    latest.set(counterKey(p.counter), { ...p.counter });
  }
  flush();
  samples.sort((a, b) => a.time - b.time);
  // Name exported files as "<process>-<pid>-<date>-raw.csv"; fall back to the file name.
  const m = /^(.+?)-(\d+)-\d{4}-\d{2}-\d{2}T/.exec(path.basename(file));
  const rateIntervals = new Set(parsed.filter((p) => p.counter.type === 'Rate' && /\/\s*\d+(?:\.\d+)?\s*sec/.test(parseCounterName(p.counter.name).unit))
    .map((p) => parseCounterName(p.counter.name).perSeconds));
  return {
    file, format: 'raw', proc: importedProc(file, m?.[1], m ? Number(m[2]) : undefined),
    startedAt: samples[0].time, samples, latest: [...latest.values()], rawCsv: text, stampToTime,
    refreshInterval: rateIntervals.size === 1 ? [...rateIntervals][0] : undefined,
  };
}

/** "CSV — normalized metrics" export: timestamp + one column per metric label. */
function parseNormalized(file: string, text: string): ImportedData {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const header = splitCsv(lines[0]);
  const byLabel = new Map(Object.entries(DERIVED_LABELS).map(([k, label]) => [label, k]));
  const cols = header.map((h) => byLabel.get(h.trim()));
  const semanticColumns = Object.entries(GC_SEMANTIC_COLUMNS).map(([key, label]) => [key, header.indexOf(label)] as const);
  const intervalColumn = header.indexOf('Sampling interval (s)');
  const intervals = new Set<number>();
  let invalidInterval = intervalColumn < 0;
  const samples: DerivedSample[] = [];
  for (const line of lines.slice(1)) {
    const cells = splitCsv(line);
    const time = Date.parse(cells[0]);
    if (!Number.isFinite(time)) {
      continue;
    }
    const interval = Number(cells[intervalColumn]);
    if (Number.isFinite(interval) && interval > 0) { intervals.add(interval); }
    else { invalidInterval = true; }
    const s = { time } as DerivedSample;
    for (const k of DERIVED_KEYS) {
      s[k] = null;
    }
    cols.forEach((k, i) => {
      if (k && cells[i] !== undefined && cells[i] !== '') {
        const v = Number(cells[i]);
        (s as unknown as Record<string, number | null>)[k] = Number.isFinite(v) ? v : null;
      }
    });
    const semantics = parseGcSemantics(Object.fromEntries(semanticColumns.map(([key, column]) => [key, cells[column]])));
    if (semantics) { s.gcSemantics = semantics; }
    samples.push(s);
  }
  if (!samples.length) {
    throw new Error('The file has no samples.');
  }
  samples.sort((a, b) => a.time - b.time);
  const m = /^(.+?)-(\d+)-\d{4}-\d{2}-\d{2}T/.exec(path.basename(file));
  return {
    file, format: 'normalized', proc: importedProc(file, m?.[1], m ? Number(m[2]) : undefined),
    startedAt: samples[0].time, samples, latest: [], stampToTime: parseStamp,
    refreshInterval: !invalidInterval && intervals.size === 1 ? [...intervals][0] : undefined,
  };
}

/** "JSON" export: process info, samples with ISO times and the latest counter values. */
function parseJson(file: string, text: string): ImportedData {
  const obj = JSON.parse(text) as {
    process?: { pid?: number; name?: string; path?: string };
    project?: string;
    startedAt?: string;
    processStartedAt?: string;
    refreshInterval?: number;
    analysis?: { thresholds?: Thresholds };
    samples?: Record<string, unknown>[];
    latestCounters?: LatestCounter[];
  };
  if (!Array.isArray(obj.samples)) {
    throw new Error('Not a .NET Counters Dashboard JSON export (no "samples" array).');
  }
  const samples: DerivedSample[] = obj.samples
    .map((raw) => {
      const time = typeof raw.time === 'number' ? raw.time : Date.parse(String(raw.time));
      const s = { time } as DerivedSample;
      for (const k of DERIVED_KEYS) {
        const v = raw[k];
        s[k] = typeof v === 'number' && Number.isFinite(v) ? v : null;
      }
      const semantics = parseGcSemantics(raw.gcSemantics);
      if (semantics) { s.gcSemantics = semantics; }
      return s;
    })
    .filter((s) => Number.isFinite(s.time))
    .sort((a, b) => a.time - b.time);
  if (!samples.length) {
    throw new Error('The file has no samples.');
  }
  const started = obj.startedAt ? Date.parse(obj.startedAt) : NaN;
  const procStarted = obj.processStartedAt ? Date.parse(obj.processStartedAt) : NaN;
  return {
    file, format: 'json',
    proc: importedProc(file, obj.process?.name, obj.process?.pid),
    project: obj.project,
    startedAt: Number.isFinite(started) ? started : samples[0].time,
    processStartedAt: Number.isFinite(procStarted) ? procStarted : undefined,
    refreshInterval: typeof obj.refreshInterval === 'number' && Number.isFinite(obj.refreshInterval) && obj.refreshInterval > 0 ? obj.refreshInterval : undefined,
    thresholds: validThresholds(obj.analysis?.thresholds),
    samples,
    latest: Array.isArray(obj.latestCounters) ? obj.latestCounters : [],
    stampToTime: parseStamp,
  };
}

function validThresholds(value: Thresholds | undefined): Thresholds | undefined {
  if (!value) {
    return undefined;
  }
  for (const key of Object.keys(DEFAULT_THRESHOLDS) as (keyof Thresholds)[]) {
    if (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || value[key] <= 0) {
      return undefined;
    }
  }
  return value;
}

/** Reads a file exported by this extension (or written by `dotnet-counters collect --format csv`). */
export async function importFile(uri: vscode.Uri): Promise<ImportedData> {
  const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8').replace(/^﻿/, '');
  const file = uri.fsPath;
  const first = text.slice(0, 200).trimStart();
  if (first.startsWith('{') || /\.json$/i.test(file)) {
    return parseJson(file, text);
  }
  if (/^Timestamp,Provider,/i.test(first)) {
    return parseRaw(file, text);
  }
  if (/^"?timestamp"?,/i.test(first)) {
    return parseNormalized(file, text);
  }
  throw new Error('Unrecognized file. Expected a raw dotnet-counters CSV, a normalized metrics CSV or a JSON export.');
}
