/* Shared by the extension host and the webview. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.SessionAnalysis = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
  }
  const DEFAULT_THRESHOLDS = Object.freeze({
    hotspotCpuPercent: 50,
    freezeGcPausePercent: 10,
    freezeLockContentionsPerSecond: 100,
    highGcCollectionsPerSecond: 20,
  });
  // A sample supports at most one nominal interval across a collection gap.
  // Allow small timestamp jitter without manufacturing gaps between normal samples.

  function sampleEnd(view, index, refreshMs) {
    const current = view[index].time;
    const next = view[index + 1]?.time;
    if (next === undefined || next - current > refreshMs * 1.5) {
      return current + refreshMs;
    }
    return Math.max(current, next);
  }

  function isGap(previous, current, refreshMs) {
    return current.time - previous.time > refreshMs * 1.5;
  }

  function semanticsOf(samples, kind, keys) {
    const sources = new Set(
      samples
        .filter(
          (sample) =>
            keys.some((key) => isFiniteNumber(sample[key])) ||
            sample.gcSemantics?.[kind] === 'mixed'
        )
        .map((sample) => sample.gcSemantics?.[kind] || 'unknown')
    );
    if (sources.size > 1 || sources.has('mixed')) {
      return 'mixed';
    }
    return sources.values().next().value || 'unknown';
  }

  function withTotals(sample) {
    let gcTotal = null;
    if (sample.gcSemantics?.collections === 'inclusive') {
      gcTotal = isFiniteNumber(sample.gen0) ? sample.gen0 : null;
    } else if (
      sample.gcSemantics?.collections === 'exclusive' &&
      [sample.gen0, sample.gen1, sample.gen2].every(isFiniteNumber)
    ) {
      gcTotal = sample.gen0 + sample.gen1 + sample.gen2;
    }
    return { ...sample, gcTotal };
  }

  function semanticKind(key) {
    if (key === 'gcPausePercent') {
      return 'pause';
    }
    if (key === 'gcHeapMB') {
      return 'heap';
    }
    if (['gen0', 'gen1', 'gen2', 'gcTotal'].includes(key)) {
      return 'collections';
    }
    return null;
  }

  function segments(view, key, refreshMs) {
    const result = [];
    let currentSegment = null;
    const kind = semanticKind(key);
    for (let index = 0; index < view.length; index++) {
      const sample = view[index];
      if (!isFiniteNumber(sample[key]) || (kind && sample.gcSemantics?.[kind] === 'mixed')) {
        currentSegment = null;
        continue;
      }
      const previous = view[index - 1];
      if (
        previous &&
        (isGap(previous, sample, refreshMs) ||
          (kind && previous.gcSemantics?.[kind] !== sample.gcSemantics?.[kind]))
      ) {
        currentSegment = null;
      }
      if (!currentSegment) {
        currentSegment = [];
        result.push(currentSegment);
      }
      currentSegment.push(sample);
    }
    return result;
  }

  function gcLabel(kind, semantics) {
    const labels = {
      pause: {
        'interval-pause': 'GC pause time',
        'since-last-gc': 'GC time since last collection',
        unknown: 'GC reported time (origin unknown)',
        mixed: 'GC time (incompatible sources)',
      },
      heap: {
        'last-collection': 'GC heap after last collection (includes fragmentation)',
        'live-estimate': 'GC heap live estimate',
        unknown: 'GC heap (origin unknown)',
        mixed: 'GC heap (incompatible sources)',
      },
      collections: {
        inclusive: 'GC counts by generation (inclusive)',
        exclusive: 'GC counts by maximum generation',
        unknown: 'GC counts (origin unknown)',
        mixed: 'GC counts (incompatible sources)',
      },
    };
    return labels[kind][semantics] || labels[kind].unknown;
  }

  function formatNumber(value, decimals = 1) {
    if (!isFiniteNumber(value)) {
      return '—';
    }
    return value.toLocaleString('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
  }

  function formatTime(timestamp) {
    return new Date(timestamp).toLocaleTimeString('en-US', { hour12: false });
  }

  function formatMemory(value) {
    if (value === null || value === undefined) {
      return '—';
    }
    if (Math.abs(value) >= 1024) {
      return `${formatNumber(value / 1024, 2)} GB`;
    }
    return `${formatNumber(value, 0)} MB`;
  }

  function formatDuration(sec) {
    if (!Number.isFinite(sec)) {
      return '—';
    }
    if (sec < 60) {
      return `${formatNumber(sec, sec < 10 && !Number.isInteger(sec) ? 1 : 0)} s`;
    }
    const hours = Math.floor(sec / 3600);
    const minutes = Math.floor((sec % 3600) / 60);
    const seconds = Math.round(sec % 60);
    if (hours) {
      return `${hours}h ${String(minutes).padStart(2, '0')}m`;
    }
    return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  }
  const plural = (n, word) => `${formatNumber(n, 0)} ${word}${Math.round(n) === 1 ? '' : 's'}`;

  function intervals(view, predicate, peakKey, refreshMs) {
    const result = [];
    let currentInterval = null;
    const kind = semanticKind(peakKey);
    for (let index = 0; index < view.length; index++) {
      const sample = view[index];
      const end = sampleEnd(view, index, refreshMs);
      const previous = view[index - 1];
      if (
        previous &&
        (isGap(previous, sample, refreshMs) ||
          (kind && previous.gcSemantics?.[kind] !== sample.gcSemantics?.[kind]))
      ) {
        currentInterval = null;
      }
      if (!predicate(sample) || end <= sample.time) {
        currentInterval = null;
        continue;
      }
      if (!currentInterval) {
        currentInterval = { from: sample.time, to: end, peak: -Infinity, peakAt: sample.time };
        result.push(currentInterval);
      }
      currentInterval.to = end;
      const value = sample[peakKey];
      if (isFiniteNumber(value) && value > currentInterval.peak) {
        currentInterval.peak = value;
        currentInterval.peakAt = sample.time;
      }
    }
    return result;
  }

  function computeSummary(samples, refreshInterval, thresholds) {
    const refreshMs = refreshInterval * 1000;
    const view = samples.map(withTotals);
    const isHotspot = (sample) =>
      isFiniteNumber(sample.cpuPercent) && sample.cpuPercent >= thresholds.hotspotCpuPercent;
    const isFreeze = (sample) =>
      (isFiniteNumber(sample.gcPausePercent) &&
        sample.gcPausePercent >= thresholds.freezeGcPausePercent) ||
      (isFiniteNumber(sample.lockContentions) &&
        sample.lockContentions >= thresholds.freezeLockContentionsPerSecond);
    const isHighGc = (sample) =>
      isFiniteNumber(sample.gcTotal) && sample.gcTotal >= thresholds.highGcCollectionsPerSecond;
    if (!view.length) {
      return null;
    }
    const sampleDurationsSeconds = view.map(
      (sample, index) => (sampleEnd(view, index, refreshMs) - sample.time) / 1000
    );
    const observedSeconds = sampleDurationsSeconds.reduce((sum, seconds) => sum + seconds, 0);
    const gaps = [];
    view.slice(0, -1).forEach((sample, index) => {
      const end = sampleEnd(view, index, refreshMs);
      if (end < view[index + 1].time) {
        gaps.push({ from: end, to: view[index + 1].time });
      }
    });
    const coverageSeconds = {};
    const gcSemantics = {
      pause: semanticsOf(view, 'pause', ['gcPausePercent']),
      heap: semanticsOf(view, 'heap', ['gcHeapMB']),
      collections: semanticsOf(view, 'collections', ['gen0', 'gen1', 'gen2']),
    };
    const integrateRate = (key) => {
      let total = 0;
      let any = false;
      let covered = 0;
      view.forEach((sample, index) => {
        if (isFiniteNumber(sample[key]) && sampleDurationsSeconds[index] > 0) {
          covered += sampleDurationsSeconds[index];
          total += sample[key] * sampleDurationsSeconds[index];
          any = true;
        }
      });
      coverageSeconds[key] = covered;
      return any ? total : null;
    };
    const metricStatistics = (key) => {
      const values = view.map((sample) => sample[key]).filter(isFiniteNumber);
      let weighted = 0;
      let covered = 0;
      view.forEach((sample, index) => {
        if (isFiniteNumber(sample[key]) && sampleDurationsSeconds[index] > 0) {
          weighted += sample[key] * sampleDurationsSeconds[index];
          covered += sampleDurationsSeconds[index];
        }
      });
      coverageSeconds[key] = covered;
      if (!values.length || !covered) {
        return null;
      }
      return {
        min: values.reduce((a, b) => Math.min(a, b), Infinity),
        max: values.reduce((a, b) => Math.max(a, b), -Infinity),
        avg: weighted / covered,
        first: values[0],
        last: values[values.length - 1],
      };
    };
    const from = view[0].time;
    const to =
      view[view.length - 1].time + sampleDurationsSeconds[sampleDurationsSeconds.length - 1] * 1000;
    const hotspotIntervals = intervals(view, isHotspot, 'cpuPercent', refreshMs);
    const freezeIntervals = intervals(view, isFreeze, 'gcPausePercent', refreshMs);
    const highGcIntervals = intervals(view, isHighGc, 'gcTotal', refreshMs);
    const intervalDurationSeconds = (list) =>
      list.reduce((a, interval) => a + (interval.to - interval.from) / 1000, 0);
    const pause = gcSemantics.pause === 'interval-pause' ? integrateRate('gcPausePercent') : null;
    return {
      from,
      to,
      durationSeconds: (to - from) / 1000,
      observedSeconds,
      missingSeconds: gaps.reduce((sum, gap) => sum + (gap.to - gap.from) / 1000, 0),
      gaps,
      coverageSeconds,
      gcSemantics,
      samples: view.length,
      cpuPercent: metricStatistics('cpuPercent'),
      memoryPercent: metricStatistics('memPercent'),
      workingSetMB: metricStatistics('workingSetMB'),
      gcHeapMB: gcSemantics.heap === 'mixed' ? null : metricStatistics('gcHeapMB'),
      gcPausePercent: gcSemantics.pause === 'mixed' ? null : metricStatistics('gcPausePercent'),
      gcCollectionsPerSecond: metricStatistics('gcTotal'),
      gcCollections: {
        gen0: gcSemantics.collections === 'mixed' ? null : integrateRate('gen0'),
        gen1: gcSemantics.collections === 'mixed' ? null : integrateRate('gen1'),
        gen2: integrateRate('gen2'),
      },
      gcCollectionsTotal: gcSemantics.collections === 'mixed' ? null : integrateRate('gcTotal'),
      gcPauseSeconds: pause === null ? null : pause / 100,
      allocatedMB: integrateRate('allocMBps'),
      exceptions: integrateRate('exceptions'),
      lockContentions: integrateRate('lockContentions'),
      hotspots: {
        count: hotspotIntervals.length,
        seconds: intervalDurationSeconds(hotspotIntervals),
        intervals: hotspotIntervals,
      },
      freezes: {
        count: freezeIntervals.length,
        seconds: intervalDurationSeconds(freezeIntervals),
        longestSeconds: freezeIntervals.reduce(
          (m, interval) => Math.max(m, (interval.to - interval.from) / 1000),
          0
        ),
        intervals: freezeIntervals,
      },
      highGc: {
        count: highGcIntervals.length,
        seconds: intervalDurationSeconds(highGcIntervals),
        intervals: highGcIntervals,
      },
      thresholds: { ...thresholds },
    };
  }

  /** Summary in a JSON-friendly shape (ISO dates) for the export. */

  function summaryForExport(summary) {
    if (!summary) {
      return undefined;
    }
    const serializeIntervals = (list) =>
      list.map((interval) => ({
        from: new Date(interval.from).toISOString(),
        to: new Date(interval.to).toISOString(),
        seconds: (interval.to - interval.from) / 1000,
        peak: interval.peak,
        peakAt: new Date(interval.peakAt).toISOString(),
      }));
    return {
      ...summary,
      from: new Date(summary.from).toISOString(),
      to: new Date(summary.to).toISOString(),
      hotspots: { ...summary.hotspots, intervals: serializeIntervals(summary.hotspots.intervals) },
      freezes: { ...summary.freezes, intervals: serializeIntervals(summary.freezes.intervals) },
      highGc: { ...summary.highGc, intervals: serializeIntervals(summary.highGc.intervals) },
      gaps: summary.gaps.map((gap) => ({
        from: new Date(gap.from).toISOString(),
        to: new Date(gap.to).toISOString(),
      })),
      findings: findings(summary).map((finding) => ({ kind: finding.kind, text: finding.text })),
    };
  }

  function addGcProvenanceFindings(summary, add) {
    if (summary.gcSemantics.pause === 'since-last-gc' && summary.gcPausePercent) {
      add(
        'info',
        'Legacy GC time is reported since the last collection; it cannot determine total pause duration for this interval.'
      );
    } else if (summary.gcSemantics.pause === 'unknown' && summary.gcPausePercent) {
      add('info', 'GC time provenance is unknown; total pause duration is unavailable.');
    }
    if (summary.gcSemantics.pause === 'mixed') {
      add(
        'info',
        'GC time samples have incompatible semantics; no combined pause summary is calculated.'
      );
    }
    if (summary.gcSemantics.heap === 'mixed') {
      add(
        'info',
        'GC heap samples mix live estimates and post-collection measurements; no combined heap summary is calculated.'
      );
    } else if (summary.gcHeapMB && summary.gcSemantics.heap === 'unknown') {
      add(
        'info',
        'GC heap provenance is unknown; its values cannot establish equivalence with another recording.'
      );
    }
    if (
      summary.gcSemantics.collections === 'unknown' &&
      [summary.gcCollections.gen0, summary.gcCollections.gen1, summary.gcCollections.gen2].some(
        isFiniteNumber
      )
    ) {
      add(
        'info',
        'GC collection provenance is unknown; a total across generations is unavailable.'
      );
    } else if (summary.gcSemantics.collections === 'mixed') {
      add(
        'info',
        'GC collection samples mix inclusive and exclusive generation counts; combined Gen0/Gen1 counts and a total are unavailable.'
      );
    }
  }

  function addActivityFindings(summary, add) {
    const thresholds = summary.thresholds;
    if (summary.hotspots.count) {
      const top = summary.hotspots.intervals.reduce((a, b) => (b.peak > a.peak ? b : a));
      add(
        'warning',
        `${plural(summary.hotspots.count, 'performance hotspot')} (CPU ≥ ${thresholds.hotspotCpuPercent}%) lasting ${formatDuration(summary.hotspots.seconds)} in total; peak ${formatNumber(top.peak, 1)}% at ${formatTime(top.peakAt)}.`
      );
    }
    if (summary.freezes.count) {
      add(
        'warning',
        `${plural(summary.freezes.count, 'possible freeze')} (reported GC time ≥ ${thresholds.freezeGcPausePercent}% or lock contention ≥ ${thresholds.freezeLockContentionsPerSecond}/s); longest ${formatDuration(summary.freezes.longestSeconds)}.`
      );
    }
    if (summary.highGc.count) {
      const share = (summary.highGc.seconds / summary.coverageSeconds.gcTotal) * 100;
      add(
        'warning',
        `High GC activity (≥ ${thresholds.highGcCollectionsPerSecond} collections/s) for ${formatDuration(summary.highGc.seconds)} (${formatNumber(share, 0)}% of observed GC samples); average ${formatNumber(summary.gcCollectionsPerSecond?.avg, 1)} collections/s.`
      );
    }
    const gen2 = summary.gcCollections.gen2;
    if (isFiniteNumber(gen2) && gen2 >= 0.5) {
      const perMin = gen2 / (summary.coverageSeconds.gen2 / 60);
      add(
        perMin > 1 ? 'warning' : 'info',
        `${plural(gen2, 'gen 2 (full) collection')} (${formatNumber(perMin, 1)}/min).`
      );
    }
    if (isFiniteNumber(summary.gcPauseSeconds) && summary.durationSeconds > 0) {
      const pct = (summary.gcPauseSeconds / summary.coverageSeconds.gcPausePercent) * 100;
      if (pct >= 10) {
        add(
          'warning',
          `The process spent ${formatNumber(pct, 1)}% of observed GC samples paused in GC (${formatDuration(summary.gcPauseSeconds)}).`
        );
      }
    }
  }

  function addMemoryFindings(summary, add) {
    if (summary.workingSetMB) {
      const growthMB = summary.workingSetMB.last - summary.workingSetMB.first;
      const growthMBPerMinute =
        summary.durationSeconds > 0 ? growthMB / (summary.durationSeconds / 60) : 0;
      if (growthMB > 50 && growthMBPerMinute > 10 && summary.durationSeconds >= 30) {
        add(
          'warning',
          `Working set grew by ${formatMemory(growthMB)} (${formatNumber(growthMBPerMinute, 1)} MB/min) — inspect allocation and retention patterns.`
        );
      } else {
        add(
          'info',
          `Working set ${formatMemory(summary.workingSetMB.first)} → ${formatMemory(summary.workingSetMB.last)} (${growthMB >= 0 ? '+' : '−'}${formatMemory(Math.abs(growthMB))}), peak ${formatMemory(summary.workingSetMB.max)}.`
        );
      }
    }
    if (summary.gcHeapMB) {
      const growthMB = summary.gcHeapMB.last - summary.gcHeapMB.first;
      if (growthMB > 50 && summary.durationSeconds >= 30) {
        add(
          'warning',
          `GC heap grew by ${formatMemory(growthMB)} (${formatMemory(summary.gcHeapMB.first)} → ${formatMemory(summary.gcHeapMB.last)}) — inspect allocation and retention patterns.`
        );
      }
    }
  }

  function addExceptionAndContentionFindings(summary, add) {
    if (isFiniteNumber(summary.exceptions) && summary.exceptions >= 0.5) {
      const rate = summary.exceptions / summary.coverageSeconds.exceptions;
      add(
        rate >= 100 ? 'warning' : 'info',
        `${plural(summary.exceptions, 'exception')} thrown (${formatNumber(rate, 1)}/s).`
      );
    }
    if (isFiniteNumber(summary.lockContentions) && summary.lockContentions >= 0.5) {
      add(
        'info',
        `${plural(summary.lockContentions, 'lock contention')} (${formatNumber(summary.lockContentions / summary.coverageSeconds.lockContentions, 1)}/s).`
      );
    }
  }

  function findings(summary) {
    const result = [];
    const add = (kind, text) => result.push({ kind, text });
    if (summary.missingSeconds > 0) {
      add(
        'info',
        `${formatDuration(summary.missingSeconds)} without samples across ${plural(summary.gaps.length, 'collection gap')}; totals and rates cover observed data only.`
      );
    }

    addGcProvenanceFindings(summary, add);
    addActivityFindings(summary, add);
    addMemoryFindings(summary, add);
    addExceptionAndContentionFindings(summary, add);

    if (!result.some((finding) => finding.kind === 'warning')) {
      result.unshift({
        kind: 'ok',
        text: 'No performance hotspots, possible freezes or high GC activity in this interval.',
      });
    }
    return result;
  }

  return {
    DEFAULT_THRESHOLDS,
    computeSummary,
    summaryForExport,
    findings,
    intervals,
    sampleEnd,
    isGap,
    withTotals,
    semanticsOf,
    segments,
    gcLabel,
  };
});
