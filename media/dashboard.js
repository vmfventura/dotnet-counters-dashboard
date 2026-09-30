// @ts-check
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

  /** Set when the session was loaded from a file (read-only). @type {{ file: string, format: string } | null} */
  let imported = null;
  /** When the monitored process started / when monitoring ended (ms epoch). */
  let processStartedAt = null;
  let endedAt = null;
  let sessionState = 'running';
  /** True until the extension answers with the process start time. */
  let processLookupPending = true;
  /** @type {any[]} */
  let samples = [];
  /** Snapshot shown while the dashboard is paused. @type {any[] | null} */
  let frozen = null;
  /** @type {Map<string, any>} */
  const counters = new Map();
  let rangeSeconds = 60;
  let paused = false;
  let sampleCount = 0;
  let refreshMs = 1000;
  let thresholds = { ...SessionAnalysis.DEFAULT_THRESHOLDS };
  /** Interval drawn on the timeline. @type {{ from: number, to: number } | null} */
  let selection = null;
  /** Interval being analyzed (drives tiles, charts and the analysis section). @type {{ from: number, to: number, live?: boolean } | null} */
  let analysis = null;

  const data = () => (paused && frozen ? frozen : samples);

  const nf = (v, d = 1) =>
    v === null || v === undefined || !Number.isFinite(v)
      ? '—'
      : v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const timeFmt = (t) => new Date(t).toLocaleTimeString('en-US', { hour12: false });
  const fmtMB = (v) => (v === null || v === undefined ? '—' : Math.abs(v) >= 1024 ? `${nf(v / 1024, 2)} GB` : `${nf(v, 0)} MB`);
  function fmtDur(sec) {
    if (!Number.isFinite(sec)) {
      return '—';
    }
    if (sec < 60) {
      return `${nf(sec, sec < 10 && !Number.isInteger(sec) ? 1 : 0)} s`;
    }
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.round(sec % 60);
    return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m ${String(s).padStart(2, '0')}s`;
  }
  const plural = (n, word) => `${nf(n, 0)} ${word}${Math.round(n) === 1 ? '' : 's'}`;
  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch] || ch);
  }

  // ---------- Chart definitions: one axis per chart, at most 3 series ----------
  const CHARTS = [
    { id: 'cpu', title: 'CPU', unit: '%', digits: 1, series: [{ key: 'cpuPercent', label: 'CPU' }], minMax: 5 },
    { id: 'mem', title: 'System memory used by the process', unit: '%', digits: 2, series: [{ key: 'memPercent', label: 'Memory' }], minMax: 1 },
    {
      id: 'memmb', title: 'Memory', unit: 'MB', digits: 0,
      series: [
        { key: 'workingSetMB', label: 'Working set' },
        { key: 'gcCommittedMB', label: 'GC committed' },
        { key: 'gcHeapMB', label: 'GC heap' },
      ],
    },
    {
      id: 'gc', title: 'Garbage collections by generation', unit: '/s', digits: 1,
      series: [
        { key: 'gen0', label: 'Gen 0' },
        { key: 'gen1', label: 'Gen 1' },
        { key: 'gen2', label: 'Gen 2' },
      ],
      minMax: 1,
    },
    { id: 'gcpause', title: 'GC reported time', unit: '%', digits: 2, series: [{ key: 'gcPausePercent', label: 'GC reported time' }], minMax: 1 },
    { id: 'alloc', title: 'Allocation rate', unit: 'MB/s', digits: 2, series: [{ key: 'allocMBps', label: 'Allocation' }], minMax: 1 },
    { id: 'tpwork', title: 'ThreadPool — completed work items', unit: '/s', digits: 0, series: [{ key: 'threadPoolWorkItems', label: 'Work items' }], minMax: 5 },
    {
      id: 'tp', title: 'ThreadPool', unit: '', digits: 0,
      series: [
        { key: 'threadPoolThreads', label: 'Threads' },
        { key: 'threadPoolQueue', label: 'Queue' },
      ],
      minMax: 5,
    },
    {
      id: 'exc', title: 'Exceptions and lock contention', unit: '/s', digits: 1,
      series: [
        { key: 'exceptions', label: 'Exceptions' },
        { key: 'lockContentions', label: 'Lock contentions' },
      ],
      minMax: 1,
    },
  ];

  const TILES = [
    { key: 'cpuPercent', label: 'CPU', unit: '%', digits: 1 },
    { key: 'memPercent', label: 'Memory (% of system)', unit: '%', digits: 2 },
    { key: 'workingSetMB', label: 'Working set', unit: 'MB', digits: 0 },
    { key: 'gcHeapMB', label: 'GC heap', unit: 'MB', digits: 0 },
    { key: 'gcTotal', label: 'GCs', unit: '/s', digits: 1 },
    { key: 'gcPausePercent', label: 'GC reported time', unit: '%', digits: 2 },
  ];

  function cssVar(name) {
    return getComputedStyle(document.querySelector('.viz-root') || document.body).getPropertyValue(name).trim();
  }
  const seriesColor = (i) => cssVar(`--series-${i + 1}`);

  function sizeCanvas(c) {
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (!w || !h) {
      return null;
    }
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    const ctx = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h };
  }

  // ---------- Canvas line chart ----------
  class LineChart {
    constructor(def, parent) {
      this.def = def;
      this.el = document.createElement('div');
      this.el.className = 'chart';
      this.el.hidden = true;
      this.el.innerHTML = `<div class="chart-head"><h2>${def.title}${def.unit ? ` <span class="muted">(${def.unit})</span>` : ''}</h2><span class="now"></span></div>`;
      this.legend = document.createElement('div');
      this.legend.className = 'legend';
      if (def.series.length > 1) {
        this.el.appendChild(this.legend);
      }
      this.canvas = document.createElement('canvas');
      this.canvas.setAttribute('role', 'img');
      this.canvas.setAttribute('aria-label', def.title);
      this.el.appendChild(this.canvas);
      parent.appendChild(this.el);
      this.now = /** @type {HTMLElement} */ (this.el.querySelector('.now'));
      this.hoverX = null;
      this.view = [];
      this.canvas.addEventListener('mousemove', (e) => {
        this.hoverX = e.offsetX;
        this.draw();
      });
      this.canvas.addEventListener('mouseleave', () => {
        this.hoverX = null;
        hideTooltip();
        this.draw();
      });
      new ResizeObserver(() => this.draw()).observe(this.canvas);
    }

    setData(view) {
      this.view = view;
      if (this.def.id === 'gcpause') {
        this.def.title = SessionAnalysis.gcLabel('pause', SessionAnalysis.semanticsOf(view, 'pause', ['gcPausePercent']));
        this.def.series[0].label = this.def.title;
      } else if (this.def.id === 'gc') {
        this.def.title = SessionAnalysis.gcLabel('collections', SessionAnalysis.semanticsOf(view, 'collections', ['gen0', 'gen1', 'gen2']));
      }
      const heapSeries = this.def.series.find((se) => se.key === 'gcHeapMB');
      if (heapSeries) { heapSeries.label = SessionAnalysis.gcLabel('heap', SessionAnalysis.semanticsOf(view, 'heap', ['gcHeapMB'])); }
      this.el.querySelector('h2').textContent = `${this.def.title}${this.def.unit ? ` (${this.def.unit})` : ''}`;
      const has = view.some((s) => this.def.series.some((se) => s[se.key] !== null && s[se.key] !== undefined));
      this.el.hidden = !has;
      const last = view[view.length - 1];
      if (this.def.series.length === 1) {
        this.now.textContent = last ? `${nf(last[this.def.series[0].key], this.def.digits)} ${this.def.unit}` : '';
      } else {
        this.legend.innerHTML = this.def.series
          .map((se, i) => `<span><i class="sw sw-${i + 1}"></i>${se.label} <b>${last ? nf(last[se.key], this.def.digits) : '—'}</b></span>`)
          .join('');
      }
      this.draw();
    }

    draw() {
      if (this.el.hidden) {
        return;
      }
      const c = sizeCanvas(this.canvas);
      if (c) {
        renderPlot(c.ctx, this.def, this.view, c.w, c.h, this.hoverX);
      }
    }
  }

  /** Y scale with 1/2/5 × 10^n steps and 3–5 divisions. */
  function niceScale(max) {
    const raw = Math.max(max, 1e-9) / 4;
    const exp = Math.pow(10, Math.floor(Math.log10(raw)));
    const f = raw / exp;
    const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * exp;
    const ticks = Math.max(1, Math.ceil(max / step - 1e-9));
    return { yMax: step * ticks, ticks, step };
  }
  const tickDigitsFor = (step) => (step >= 1 ? 0 : Math.min(4, Math.ceil(-Math.log10(step))));

  /** Draws the chart. Reused for the PNG export. */
  function renderPlot(ctx, def, view, w, h, hoverX) {
    const font = getComputedStyle(document.body).fontFamily;
    const textSecondary = cssVar('--text-secondary') || '#888';
    const grid = cssVar('--grid');
    const axis = cssVar('--axis');
    const pad = { l: 46, r: 10, t: 8, b: 20 };
    const pw = w - pad.l - pad.r;
    const ph = h - pad.t - pad.b;

    let max = def.minMax || 0;
    for (const s of view) {
      for (const se of def.series) {
        const v = s[se.key];
        if (v !== null && v !== undefined && v > max) {
          max = v;
        }
      }
    }
    const { yMax, ticks, step } = niceScale(max * 1.05);
    const t0 = view.length ? view[0].time : Date.now();
    const t1 = view.length ? view[view.length - 1].time : t0 + 1;
    const span = Math.max(t1 - t0, 1000);
    const x = (t) => pad.l + ((t - t0) / span) * pw;
    const y = (v) => pad.t + ph - (v / yMax) * ph;

    ctx.font = `11px ${font}`;
    ctx.textBaseline = 'middle';
    // horizontal grid + Y axis labels
    const tickDigits = tickDigitsFor(step);
    for (let i = 0; i <= ticks; i++) {
      const v = step * i;
      const yy = Math.round(y(v)) + 0.5;
      ctx.strokeStyle = i === 0 ? axis : grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(pad.l, yy);
      ctx.lineTo(w - pad.r, yy);
      ctx.stroke();
      ctx.fillStyle = textSecondary;
      ctx.textAlign = 'right';
      ctx.fillText(nf(v, tickDigits), pad.l - 6, yy);
    }
    // X axis: time of day
    ctx.textBaseline = 'top';
    const xTicks = Math.max(2, Math.min(6, Math.floor(pw / 90)));
    for (let i = 0; i <= xTicks; i++) {
      const t = t0 + (span / xTicks) * i;
      ctx.textAlign = i === 0 ? 'left' : i === xTicks ? 'right' : 'center';
      ctx.fillText(timeFmt(t), x(t), h - pad.b + 5);
    }
    if (!view.length) {
      return;
    }

    // lines (2px, with gaps where there is no value)
    def.series.forEach((se, i) => {
      ctx.strokeStyle = seriesColor(i);
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (const points of SessionAnalysis.segments(view, se.key, refreshMs)) {
        points.forEach((s, index) => {
          if (index === 0) { ctx.moveTo(x(s.time), y(s[se.key])); }
          else { ctx.lineTo(x(s.time), y(s[se.key])); }
        });
      }
      ctx.stroke();
    });

    // hover: crosshair + markers + tooltip
    if (hoverX !== null && hoverX !== undefined && hoverX >= pad.l - 4) {
      const best = nearest(view, t0 + ((hoverX - pad.l) / pw) * span);
      const bx = x(best.time);
      ctx.strokeStyle = axis;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(bx) + 0.5, pad.t);
      ctx.lineTo(Math.round(bx) + 0.5, pad.t + ph);
      ctx.stroke();
      const surface = cssVar('--surface-2') || '#fff';
      def.series.forEach((se, i) => {
        const v = best[se.key];
        if (v === null || v === undefined) {
          return;
        }
        ctx.beginPath();
        ctx.arc(bx, y(v), 4, 0, Math.PI * 2);
        ctx.fillStyle = seriesColor(i);
        ctx.fill();
        ctx.strokeStyle = surface;
        ctx.lineWidth = 2;
        ctx.stroke();
      });
      const rows = def.series
        .map((se, i) => `<div class="row"><i class="sw sw-${i + 1}"></i>${se.label}<b>${nf(best[se.key], def.digits)} ${def.unit}</b></div>`)
        .join('');
      showTooltip(`<div class="t">${timeFmt(best.time)}</div>${rows}`, ctx.canvas, bx);
    }
  }

  function nearest(view, t) {
    let best = view[0];
    for (const s of view) {
      if (Math.abs(s.time - t) < Math.abs(best.time - t)) {
        best = s;
      }
    }
    return best;
  }

  const tooltip = $('tooltip');
  function showTooltip(html, canvas, bx) {
    tooltip.innerHTML = html;
    tooltip.hidden = false;
    const r = canvas.getBoundingClientRect();
    const tw = tooltip.offsetWidth;
    let left = r.left + bx + 12;
    if (left + tw > window.innerWidth - 8) {
      left = r.left + bx - tw - 12;
    }
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${r.top + 8}px`;
  }
  function hideTooltip() {
    tooltip.hidden = true;
  }

  // ---------- Event detection (timeline markers and interval analysis) ----------
  const has = (v) => v !== null && v !== undefined;
  const isHotspot = (s) => has(s.cpuPercent) && s.cpuPercent >= thresholds.hotspotCpuPercent;
  const isFreeze = (s) =>
    (has(s.gcPausePercent) && s.gcPausePercent >= thresholds.freezeGcPausePercent) ||
    (has(s.lockContentions) && s.lockContentions >= thresholds.freezeLockContentionsPerSecond);
  const isHighGc = (s) => has(s.gcTotal) && s.gcTotal >= thresholds.highGcCollectionsPerSecond;

  /** Contiguous intervals where `pred` holds, with the peak of `peakKey`. */
  function intervals(view, pred, peakKey) {
    return SessionAnalysis.intervals(view, pred, peakKey, refreshMs);
  }

  // ---------- Timeline: CPU / GC / Memory lanes, markers and interval selection ----------
  const TL = { gutter: 112, right: 52, top: 4, gap: 6, axis: 20, lanes: [{ id: 'cpu', h: 100 }, { id: 'gc', h: 60 }, { id: 'mem', h: 116 }] };

  function tlLayout(w) {
    let y = TL.top;
    const lanes = TL.lanes.map((l) => {
      const r = { ...l, y };
      y += l.h + TL.gap;
      return r;
    });
    const x0 = TL.gutter;
    const x1 = w - TL.right;
    return { lanes, x0, x1, pw: Math.max(10, x1 - x0), bottom: y - TL.gap, height: y - TL.gap + TL.axis };
  }
  function tlSpan(all) {
    const t0 = all.length ? all[0].time : Date.now();
    const end = all.length ? all[all.length - 1].time + refreshMs : t0;
    return { t0, t1: Math.max(end, t0 + 60000) };
  }
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /** Draws the timeline. Reused for the PNG export (without hover). */
  function renderTimeline(ctx, w, all, opts) {
    const L = tlLayout(w);
    const { t0, t1 } = tlSpan(all);
    const x = (t) => L.x0 + ((t - t0) / (t1 - t0)) * L.pw;
    const font = getComputedStyle(document.body).fontFamily;
    const ink = cssVar('--text-primary') || '#000';
    const ink2 = cssVar('--text-secondary') || '#777';
    const grid = cssVar('--grid');
    const surface = cssVar('--surface-2') || '#fff';
    const col = { cpu: cssVar('--tl-cpu'), hot: cssVar('--tl-hotspot'), frz: cssVar('--tl-freeze'), gc: cssVar('--tl-gc'), mem: cssVar('--tl-mem') };
    const lastOf = (k) => {
      for (let i = all.length - 1; i >= 0; i--) {
        if (has(all[i][k])) {
          return all[i][k];
        }
      }
      return null;
    };
    const maxOf = (k) => all.reduce((m, s) => (has(s[k]) && s[k] > m ? s[k] : m), 0);
    const [cpuL, gcL, memL] = L.lanes;

    // lane backgrounds + gutter labels
    const tint = { cpu: col.cpu, gc: col.gc, mem: col.mem };
    const names = { cpu: 'CPU', gc: 'GC', mem: 'Memory' };
    const values = { cpu: `${nf(lastOf('cpuPercent'), 1)} %`, gc: `${nf(lastOf('gcTotal'), 1)} /s`, mem: fmtMB(lastOf('workingSetMB')) };
    for (const lane of L.lanes) {
      ctx.save();
      ctx.globalAlpha = 0.09;
      ctx.fillStyle = tint[lane.id];
      roundRect(ctx, 0, lane.y, w, lane.h, 6);
      ctx.fill();
      ctx.restore();
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillStyle = ink;
      ctx.font = `600 13px ${font}`;
      ctx.fillText(names[lane.id], 10, lane.y + 8);
      ctx.fillStyle = ink2;
      ctx.font = `12px ${font}`;
      ctx.fillText(values[lane.id], 10, lane.y + 26);
    }

    const rightLabel = (text, yy) => {
      ctx.fillStyle = ink2;
      ctx.font = `10px ${font}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, L.x1 + 6, yy);
    };
    const hLine = (yy) => {
      ctx.strokeStyle = grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(L.x0, Math.round(yy) + 0.5);
      ctx.lineTo(L.x1, Math.round(yy) + 0.5);
      ctx.stroke();
    };

    if (!all.length) {
      ctx.fillStyle = ink2;
      ctx.font = `12px ${font}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Waiting for data…', (L.x0 + L.x1) / 2, L.bottom / 2);
      return;
    }

    // --- CPU lane: marker rows (hotspots, possible freezes) + CPU line ---
    const drawIntervals = (list, color, yy) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      for (const iv of list) {
        const a = x(iv.from) + 2;
        const b = Math.max(a, x(iv.to) - 2);
        ctx.beginPath();
        ctx.moveTo(a, yy);
        ctx.lineTo(b, yy);
        ctx.stroke();
      }
    };
    drawIntervals(intervals(all, isHotspot, 'cpuPercent'), col.hot, cpuL.y + 12);
    drawIntervals(intervals(all, isFreeze, 'gcPausePercent'), col.frz, cpuL.y + 22);
    {
      const top = cpuL.y + 32;
      const bot = cpuL.y + cpuL.h - 4;
      const { yMax } = niceScale(Math.max(maxOf('cpuPercent') * 1.05, 5));
      const y = (v) => bot - (v / yMax) * (bot - top);
      hLine(top);
      rightLabel(`${nf(yMax, 0)} %`, top);
      ctx.strokeStyle = col.cpu;
      ctx.lineWidth = 1.5;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      for (const points of SessionAnalysis.segments(all, 'cpuPercent', refreshMs)) {
        points.forEach((s, index) => {
          if (index === 0) { ctx.moveTo(x(s.time), y(s.cpuPercent)); }
          else { ctx.lineTo(x(s.time), y(s.cpuPercent)); }
        });
      }
      ctx.stroke();
    }

    // --- GC lane: one bar per sample (collections/s), darker when activity is high ---
    {
      const top = gcL.y + 6;
      const bot = gcL.y + gcL.h - 4;
      const { yMax } = niceScale(Math.max(maxOf('gcTotal') * 1.05, 1));
      rightLabel(`${nf(yMax, 0)}/s`, top + 2);
      const slot = L.pw / Math.max(1, (t1 - t0) / refreshMs);
      for (let i = 0; i < all.length; i++) {
        const s = all[i];
        if (!has(s.gcTotal) || s.gcTotal <= 0) {
          continue;
        }
        const next = SessionAnalysis.sampleEnd(all, i, refreshMs);
        const a = x(s.time);
        const bw = Math.max(1, x(next) - a - (slot > 3 ? 1 : 0));
        const bh = Math.max(1, (s.gcTotal / yMax) * (bot - top));
        ctx.globalAlpha = isHighGc(s) ? 1 : 0.45;
        ctx.fillStyle = col.gc;
        ctx.fillRect(a, bot - bh, bw, bh);
      }
      ctx.globalAlpha = 1;
    }

    // --- Memory lane: working set area with a right-hand Y axis ---
    {
      const top = memL.y + 8;
      const bot = memL.y + memL.h - 4;
      const { yMax, ticks, step } = niceScale(Math.max(maxOf('workingSetMB') * 1.05, 1));
      const y = (v) => bot - (v / yMax) * (bot - top);
      for (let i = 1; i <= ticks; i++) {
        hLine(y(step * i));
        rightLabel(nf(step * i, tickDigitsFor(step)), y(step * i));
      }
      for (const pts of SessionAnalysis.segments(all, 'workingSetMB', refreshMs)) {
        const grad = ctx.createLinearGradient(0, top, 0, bot);
        grad.addColorStop(0, col.mem);
        grad.addColorStop(1, 'transparent');
        ctx.beginPath();
        ctx.moveTo(x(pts[0].time), bot);
        for (const s of pts) {
          ctx.lineTo(x(s.time), y(s.workingSetMB));
        }
        ctx.lineTo(x(pts[pts.length - 1].time), bot);
        ctx.closePath();
        ctx.globalAlpha = 0.35;
        ctx.fillStyle = grad;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = col.mem;
        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';
        ctx.beginPath();
        pts.forEach((s, i) => (i ? ctx.lineTo(x(s.time), y(s.workingSetMB)) : ctx.moveTo(x(s.time), y(s.workingSetMB))));
        ctx.stroke();
      }
      rightLabel('MB', bot - 4);
    }

    // --- X axis ---
    ctx.fillStyle = ink2;
    ctx.font = `11px ${font}`;
    ctx.textBaseline = 'top';
    const xTicks = Math.max(2, Math.min(8, Math.floor(L.pw / 110)));
    for (let i = 0; i <= xTicks; i++) {
      const t = t0 + ((t1 - t0) / xTicks) * i;
      ctx.textAlign = i === 0 ? 'left' : i === xTicks ? 'right' : 'center';
      ctx.fillText(timeFmt(t), x(t), L.bottom + 5);
    }

    // --- Selection: dim outside, outline, drag handles ---
    const sel = opts.selection;
    if (sel) {
      const a = Math.max(L.x0, x(sel.from));
      const b = Math.min(L.x1, x(sel.to));
      ctx.save();
      ctx.globalAlpha = 0.6;
      ctx.fillStyle = surface;
      ctx.fillRect(L.x0, 0, Math.max(0, a - L.x0), L.bottom);
      ctx.fillRect(b, 0, Math.max(0, L.x1 - b), L.bottom);
      ctx.restore();
      ctx.strokeStyle = opts.analyzed ? cssVar('--accent') || ink : ink;
      ctx.globalAlpha = opts.analyzed ? 1 : 0.75;
      ctx.lineWidth = 1.5;
      roundRect(ctx, a, 1, Math.max(2, b - a), L.bottom - 2, 6);
      ctx.stroke();
      ctx.globalAlpha = 1;
      const hy = gcL.y + gcL.h / 2;
      for (const [hx, dir] of [[a, -1], [b, 1]]) {
        ctx.fillStyle = cssVar('--tl-handle') || ink;
        roundRect(ctx, hx - 7, hy - 16, 14, 32, 7);
        ctx.fill();
        ctx.strokeStyle = cssVar('--tl-handle-ink') || '#fff';
        ctx.lineWidth = 1.6;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(hx - dir * 1.5, hy - 4);
        ctx.lineTo(hx + dir * 2, hy);
        ctx.lineTo(hx - dir * 1.5, hy + 4);
        ctx.stroke();
      }
    }

    // --- Hover crosshair + tooltip ---
    const hx = opts.hoverX;
    if (has(hx) && hx >= L.x0 && hx <= L.x1) {
      const s = nearest(all, t0 + ((hx - L.x0) / L.pw) * (t1 - t0));
      const bx = x(s.time);
      ctx.strokeStyle = cssVar('--axis');
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(bx) + 0.5, 0);
      ctx.lineTo(Math.round(bx) + 0.5, L.bottom);
      ctx.stroke();
      const flags = [
        isHotspot(s) ? `<div class="row"><i class="sw sw-hot"></i>Performance hotspot</div>` : '',
        isFreeze(s) ? `<div class="row"><i class="sw sw-frz"></i>Possible freeze</div>` : '',
        isHighGc(s) ? `<div class="row"><i class="sw sw-gc"></i>High GC activity</div>` : '',
      ].join('');
      showTooltip(
        `<div class="t">${timeFmt(s.time)}</div>` +
          `<div class="row">CPU<b>${nf(s.cpuPercent, 1)} %</b></div>` +
          `<div class="row">GC<b>${nf(s.gcTotal, 1)} /s</b></div>` +
          `<div class="row">${SessionAnalysis.gcLabel('pause', s.gcSemantics?.pause || 'unknown')}<b>${nf(s.gcPausePercent, 2)} %</b></div>` +
          `<div class="row">Working set<b>${fmtMB(s.workingSetMB)}</b></div>` +
          flags,
        ctx.canvas,
        bx,
      );
    }
  }

  const tl = /** @type {HTMLCanvasElement} */ ($('timeline'));
  let tlHoverX = null;
  /** @type {null | { mode: string, startT: number, orig: any, moved: boolean, startX: number }} */
  let drag = null;

  function drawTimeline() {
    const c = sizeCanvas(tl);
    if (c) {
      const analyzed = !!analysis && !analysis.live && !!selection && analysis.from === selection.from && analysis.to === selection.to;
      renderTimeline(c.ctx, c.w, data(), { hoverX: drag ? null : tlHoverX, selection, analyzed });
    }
  }
  new ResizeObserver(() => drawTimeline()).observe(tl);

  function tlGeom() {
    const L = tlLayout(tl.clientWidth);
    const { t0, t1 } = tlSpan(data());
    return {
      L, t0, t1,
      timeAt: (px) => t0 + Math.min(1, Math.max(0, (px - L.x0) / L.pw)) * (t1 - t0),
      xAt: (t) => L.x0 + ((t - t0) / (t1 - t0)) * L.pw,
    };
  }
  function hitTest(px) {
    if (!selection) {
      return 'new';
    }
    const g = tlGeom();
    const a = g.xAt(selection.from);
    const b = g.xAt(selection.to);
    if (Math.abs(px - a) <= 8) {
      return 'left';
    }
    if (Math.abs(px - b) <= 8) {
      return 'right';
    }
    return px > a && px < b ? 'move' : 'new';
  }

  tl.addEventListener('pointerdown', (e) => {
    if (!data().length || e.button !== 0) {
      return;
    }
    try {
      tl.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic events have no active pointer */
    }
    const g = tlGeom();
    drag = { mode: hitTest(e.offsetX), startX: e.offsetX, startT: g.timeAt(e.offsetX), orig: selection ? { ...selection } : null, moved: false };
    hideTooltip();
  });
  tl.addEventListener('pointermove', (e) => {
    const g = tlGeom();
    if (!drag) {
      tlHoverX = e.offsetX;
      const mode = hitTest(e.offsetX);
      tl.classList.toggle('resize', mode === 'left' || mode === 'right');
      tl.classList.toggle('grab', mode === 'move');
      drawTimeline();
      return;
    }
    if (Math.abs(e.offsetX - drag.startX) > 3) {
      drag.moved = true;
    }
    if (!drag.moved) {
      return;
    }
    const t = g.timeAt(e.offsetX);
    const minLen = refreshMs;
    if (drag.mode === 'new' || !drag.orig) {
      selection = { from: Math.min(drag.startT, t), to: Math.max(drag.startT, t) };
    } else if (drag.mode === 'move') {
      const len = drag.orig.to - drag.orig.from;
      const from = Math.min(Math.max(g.t0, drag.orig.from + (t - drag.startT)), g.t1 - len);
      selection = { from, to: from + len };
    } else if (drag.mode === 'left') {
      selection = { from: Math.min(t, drag.orig.to - minLen), to: drag.orig.to };
    } else {
      selection = { from: drag.orig.from, to: Math.max(t, drag.orig.from + minLen) };
    }
    updateSelectionUi();
    drawTimeline();
  });
  tl.addEventListener('pointerup', () => {
    if (!drag) {
      return;
    }
    if (!drag.moved && drag.mode === 'new') {
      selection = null; // a plain click outside the selection clears it
    } else if (selection && selection.to - selection.from < refreshMs) {
      selection = null;
    }
    drag = null;
    updateSelectionUi();
    drawTimeline();
  });
  tl.addEventListener('pointerleave', () => {
    tlHoverX = null;
    hideTooltip();
    drawTimeline();
  });
  tl.addEventListener('dblclick', () => selection && analyzeSelection());
  tl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && selection) {
      analyzeSelection();
    } else if (e.key === 'Escape') {
      clearSelection();
    }
  });

  function updateSelectionUi() {
    /** @type {HTMLButtonElement} */ ($('analyzeSel')).disabled = !selection;
    /** @type {HTMLButtonElement} */ ($('clearSel')).disabled = !selection && !analysis;
    $('selInfo').textContent = selection
      ? `Selected ${timeFmt(selection.from)} – ${timeFmt(selection.to)} (${fmtDur((selection.to - selection.from) / 1000)}) · double-click or Enter to analyze`
      : 'Drag on the timeline to select a time interval';
    $('exportScope').textContent = `Scope: ${scopeLabel()}`;
  }
  function setAnalysis(a) {
    analysis = a;
    $('range').querySelectorAll('button').forEach((b) => b.classList.toggle('dim', !!a));
    updateSelectionUi();
    renderAll();
  }
  function analyzeSelection() {
    if (selection) {
      setAnalysis({ ...selection });
    }
  }
  function clearSelection() {
    selection = null;
    setAnalysis(null);
  }
  $('analyzeAll').addEventListener('click', () => {
    selection = null;
    setAnalysis({ from: -Infinity, to: Infinity, live: true });
  });
  $('analyzeSel').addEventListener('click', analyzeSelection);
  $('clearSel').addEventListener('click', clearSelection);
  $('backToLive').addEventListener('click', clearSelection);

  function renderLegend() {
    const t = thresholds;
    $('timelineLegend').innerHTML =
      `<span><i class="sw sw-hot"></i>Performance hotspot (CPU ≥ ${t.hotspotCpuPercent}%)</span>` +
      `<span><i class="sw sw-frz"></i>Possible freeze (reported GC time ≥ ${t.freezeGcPausePercent}% or lock contention ≥ ${t.freezeLockContentionsPerSecond}/s)</span>` +
      `<span><i class="bar sw sw-gc dim"></i>GC collections/s</span>` +
      `<span><i class="bar sw sw-gc"></i>High GC activity (≥ ${t.highGcCollectionsPerSecond}/s)</span>` +
      `<span><i class="sw sw-mem"></i>Working set</span>`;
  }

  // ---------- Interval analysis ----------
  function computeSummary(view) {
    return SessionAnalysis.computeSummary(view, refreshMs / 1000, thresholds);
  }
  const findings = SessionAnalysis.findings;

  function renderAnalysis(view) {
    const bar = $('analysisBar');
    const sec = $('analysis');
    if (!analysis) {
      bar.hidden = true;
      sec.hidden = true;
      return;
    }
    const S = computeSummary(view);
    bar.hidden = false;
    sec.hidden = false;
    $('analysisText').textContent = analysis.live
      ? `Analyzing all data (live)${S ? ` · ${timeFmt(S.from)} – ${timeFmt(S.to)} · ${fmtDur(S.durationSeconds)} · ${S.samples} samples` : ''}`
      : `Analyzing selected interval ${timeFmt(analysis.from)} – ${timeFmt(analysis.to)}${S ? ` · ${fmtDur(S.durationSeconds)} · ${S.samples} samples` : ''}`;
    if (!S) {
      $('findings').innerHTML = '<li class="info"><span class="ico">i</span><span>No samples in this interval.</span></li>';
      $('summary').innerHTML = '';
      return;
    }
    const icon = { warning: '▲', info: 'i', ok: '✓' };
    const kindLabel = { warning: 'Warning', info: 'Info', ok: 'OK' };
    $('findings').innerHTML = findings(S)
      .map((f) => `<li class="${f.kind}"><span class="ico" aria-hidden="true">${icon[f.kind]}</span><span class="kind">${kindLabel[f.kind]}</span><span>${escapeHtml(f.text)}</span></li>`)
      .join('');
    const g = S.gcCollections;
    const gcTotal = S.gcCollectionsTotal;
    const card = (label, value, sub) => `<div class="card"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub || ''}</div></div>`;
    $('summary').innerHTML = [
      card('Duration', fmtDur(S.durationSeconds), `${S.samples} samples · ${fmtDur(S.observedSeconds)} observed · ${fmtDur(S.missingSeconds)} without data`),
      ...(processStartedAt ? [card('Process age', fmtUptime(S.from - processStartedAt), `at interval start · ${fmtUptime(S.to - processStartedAt)} at end`)] : []),
      card('CPU (avg)', S.cpuPercent ? `${nf(S.cpuPercent.avg, 1)} %` : '—', S.cpuPercent ? `max ${nf(S.cpuPercent.max, 1)} % · ${plural(S.hotspots.count, 'hotspot')}` : ''),
      card('Working set', S.workingSetMB ? fmtMB(S.workingSetMB.last) : '—', S.workingSetMB ? `start ${fmtMB(S.workingSetMB.first)} · peak ${fmtMB(S.workingSetMB.max)}` : ''),
      card('Memory (% of system)', S.memoryPercent ? `${nf(S.memoryPercent.last, 2)} %` : '—', S.memoryPercent ? `max ${nf(S.memoryPercent.max, 2)} %` : ''),
      card(SessionAnalysis.gcLabel('heap', S.gcSemantics.heap), S.gcHeapMB ? fmtMB(S.gcHeapMB.last) : '—', S.gcHeapMB ? `start ${fmtMB(S.gcHeapMB.first)} · peak ${fmtMB(S.gcHeapMB.max)}` : ''),
      card('GC collections', nf(gcTotal, 0), `${S.gcSemantics.collections} · gen0 ${nf(g.gen0, 0)} · gen1 ${nf(g.gen1, 0)} · gen2 ${nf(g.gen2, 0)}`),
      card('Paused in GC', has(S.gcPauseSeconds) ? fmtDur(S.gcPauseSeconds) : '—', has(S.gcPauseSeconds) ? `${nf((S.gcPauseSeconds / S.coverageSeconds.gcPausePercent) * 100, 2)} % of observed GC samples` : SessionAnalysis.gcLabel('pause', S.gcSemantics.pause)),
      card('Allocated', fmtMB(S.allocatedMB), has(S.allocatedMB) ? `${nf(S.allocatedMB / S.coverageSeconds.allocMBps, 1)} MB/s` : ''),
      card('Possible freezes', nf(S.freezes.count, 0), S.freezes.count ? `longest ${fmtDur(S.freezes.longestSeconds)}` : ''),
      card('Exceptions', nf(S.exceptions, 0), has(S.exceptions) ? `${nf(S.exceptions / S.coverageSeconds.exceptions, 1)}/s` : ''),
      card('Lock contentions', nf(S.lockContentions, 0), has(S.lockContentions) ? `${nf(S.lockContentions / S.coverageSeconds.lockContentions, 1)}/s` : ''),
    ].join('');
  }

  // ---------- UI construction ----------
  const chartsEl = $('charts');
  const charts = CHARTS.map((d) => new LineChart(d, chartsEl));

  const tilesEl = $('tiles');
  tilesEl.innerHTML =
    '<div class="tile" id="uptimeTile"><div class="label">Process uptime</div><div class="value">—</div><div class="stats"></div></div>' +
    TILES.map(
      (t) => `<div class="tile" data-key="${t.key}"><div class="label">${t.label}</div><div class="value">—</div><div class="stats"></div></div>`,
    ).join('');

  // ---------- Process uptime (ticks every second while the session is live) ----------
  /** "3d 04h 12m", "2h 13m 05s", "5m 07s", "42s". */
  function fmtUptime(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const p = (n) => String(n).padStart(2, '0');
    return d ? `${d}d ${p(h)}h ${p(m)}m` : h ? `${h}h ${p(m)}m ${p(sec)}s` : m ? `${m}m ${p(sec)}s` : `${sec}s`;
  }
  function renderUptime() {
    try {
      renderUptimeUnsafe();
    } catch {
      /* the uptime is informative; never let it break the rest of the UI */
    }
  }
  function setUptimeText(text) {
    const el = document.getElementById('uptimeText');
    if (el) {
      el.textContent = text;
    }
  }
  function renderUptimeUnsafe() {
    const tile = $('uptimeTile');
    if (!tile) {
      return;
    }
    const live = !imported && sessionState === 'running';
    const last = samples.length ? samples[samples.length - 1].time : null;
    const end = live ? Date.now() : endedAt || last;
    const label = imported ? 'Process uptime (end of recording)' : live ? 'Process uptime' : 'Process uptime (at stop)';
    /** @type {HTMLElement} */ (tile.querySelector('.label')).textContent = label;
    const value = /** @type {HTMLElement} */ (tile.querySelector('.value'));
    const stats = /** @type {HTMLElement} */ (tile.querySelector('.stats'));
    if (!processStartedAt || !end) {
      value.textContent = '—';
      stats.textContent = imported ? 'not recorded in this file' : processLookupPending ? 'reading process start time…' : 'start time not available';
      setUptimeText('');
      return;
    }
    const up = fmtUptime(end - processStartedAt);
    value.textContent = up;
    stats.textContent = `started ${new Date(processStartedAt).toLocaleString('en-US')}`;
    setUptimeText(` · up ${up}`);
  }
  setInterval(() => {
    if (!imported && sessionState === 'running') {
      renderUptime();
    }
  }, 1000);

  function visibleSamples() {
    const all = data();
    if (analysis) {
      return all.filter((s) => s.time >= analysis.from && s.time <= analysis.to);
    }
    if (!rangeSeconds || !all.length) {
      return all;
    }
    const from = all[all.length - 1].time - rangeSeconds * 1000;
    let i = all.length - 1;
    while (i > 0 && all[i - 1].time >= from) {
      i--;
    }
    return all.slice(i);
  }

  /** Time range + samples used by the export (analyzed interval, else the drawn selection, else everything). */
  function exportScope() {
    const r = analysis && !analysis.live ? analysis : !analysis && selection ? selection : null;
    const view = r ? data().filter((s) => s.time >= r.from && s.time <= r.to) : data();
    return { range: r ? { from: r.from, to: r.to } : undefined, view };
  }
  function scopeLabel() {
    const { range } = exportScope();
    if (range) {
      return `interval ${timeFmt(range.from)} – ${timeFmt(range.to)}`;
    }
    return paused ? 'paused snapshot' : sampleCount > samples.length ? 'all retained data' : 'all data';
  }

  const withTotals = SessionAnalysis.withTotals;

  function renderTiles(view) {
    for (const t of TILES) {
      const el = /** @type {HTMLElement} */ (tilesEl.querySelector(`[data-key="${t.key}"]`));
      let tileView = view;
      const kind = { gcHeapMB: 'heap', gcPausePercent: 'pause', gcTotal: 'collections' }[t.key];
      if (kind) {
        const semantics = SessionAnalysis.semanticsOf(view, kind, [t.key]);
        el.querySelector('.label').textContent = t.key === 'gcTotal' ? `GCs (${semantics})` : SessionAnalysis.gcLabel(kind, semantics);
        if (semantics === 'mixed') { tileView = []; }
      }
      const values = tileView.map((s) => s[t.key]).filter(has);
      let weighted = 0;
      let covered = 0;
      tileView.forEach((s, i) => {
        if (has(s[t.key])) {
          const seconds = (SessionAnalysis.sampleEnd(tileView, i, refreshMs) - s.time) / 1000;
          weighted += s[t.key] * seconds;
          covered += seconds;
        }
      });
      const last = [...tileView].reverse().find((s) => has(s[t.key]));
      /** @type {HTMLElement} */ (el.querySelector('.value')).innerHTML = last ? `${nf(last[t.key], t.digits)}<small>${t.unit}</small>` : '—';
      /** @type {HTMLElement} */ (el.querySelector('.stats')).textContent = values.length
        ? `min ${nf(values.reduce((a, b) => Math.min(a, b), Infinity), t.digits)} · avg ${nf(covered ? weighted / covered : null, t.digits)} · max ${nf(values.reduce((a, b) => Math.max(a, b), -Infinity), t.digits)}`
        : '';
    }
  }

  function renderAll() {
    const view = visibleSamples();
    renderTiles(view);
    charts.forEach((c) => c.setData(view));
    drawTimeline();
    renderAnalysis(view);
    $('exportScope').textContent = `Scope: ${scopeLabel()}`;
    $('historyInfo').hidden = sampleCount <= samples.length;
    $('historyInfo').textContent = `Showing the retained history (${samples.length.toLocaleString('en-US')} samples). Earlier samples are available in the full raw CSV export from Monitoring Sessions.`;
  }

  // ---------- Table with all counters ----------
  const filterEl = /** @type {HTMLInputElement} */ ($('filter'));
  let tableDirty = true;
  function formatCounter(v) {
    const abs = Math.abs(v);
    return nf(v, Number.isInteger(v) ? 0 : abs >= 100 ? 1 : abs >= 1 ? 2 : 4);
  }
  function renderTable() {
    if (!tableDirty) {
      return;
    }
    tableDirty = false;
    const q = filterEl.value.trim().toLowerCase();
    const rows = [...counters.values()]
      .filter((c) => !q || `${c.provider} ${c.name}`.toLowerCase().includes(q))
      .sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name));
    $('counterCount').textContent = `(${counters.size})`;
    $('counterRows').innerHTML = rows
      .map(
        (c) =>
          `<tr><td>${escapeHtml(c.provider)}</td><td class="name">${escapeHtml(c.name)}</td><td>${escapeHtml(c.type)}</td><td class="num">${formatCounter(c.value)}</td></tr>`,
      )
      .join('');
  }
  filterEl.addEventListener('input', () => {
    tableDirty = true;
    renderTable();
  });

  // ---------- State / header ----------
  function setState(state, error) {
    sessionState = state;
    try {
      applyState(state, error);
    } finally {
      renderUptime();
    }
  }
  function applyState(state, error) {
    const st = $('status');
    if (imported) {
      st.className = 'status';
      $('statusText').textContent = `Imported ${imported.format === 'raw' ? 'raw CSV' : imported.format === 'json' ? 'JSON' : 'CSV'}`;
      $('stop').hidden = true;
      $('restart').hidden = true;
      $('error').hidden = true;
      return;
    }
    st.className = `status ${state === 'running' ? 'running' : error ? 'error' : ''}`;
    $('statusText').textContent = state === 'running' ? 'Collecting' : error ? 'Stopped with error' : 'Stopped';
    $('stop').hidden = state !== 'running';
    $('restart').hidden = state === 'running';
    const errEl = $('error');
    errEl.hidden = !error;
    errEl.textContent = error || '';
  }

  // ---------- Toolbar ----------
  $('range').addEventListener('click', (e) => {
    const b = /** @type {HTMLElement} */ (e.target).closest('button');
    if (!b) {
      return;
    }
    rangeSeconds = Number(b.dataset.range);
    $('range').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    if (analysis) {
      setAnalysis(null); // picking a live window leaves the analysis mode
    } else {
      renderAll();
    }
  });
  $('pause').addEventListener('click', () => {
    if (paused) {
      paused = false;
      frozen = null;
      vscode.postMessage({ type: 'resume' });
      $('pause').textContent = 'Pause';
      $('pause').classList.remove('on');
      renderAll();
      return;
    }
    // The host captures the snapshot, including samples that arrive while this request is in flight.
    /** @type {HTMLButtonElement} */ ($('pause')).disabled = true;
    /** @type {HTMLButtonElement} */ ($('exportBtn')).disabled = true;
    vscode.postMessage({ type: 'pause' });
  });
  $('stop').addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
  $('restart').addEventListener('click', () => vscode.postMessage({ type: 'restart' }));

  const menu = $('exportMenu');
  $('exportBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    $('exportScope').textContent = `Scope: ${scopeLabel()}`;
    menu.hidden = !menu.hidden;
  });
  document.addEventListener('click', () => (menu.hidden = true));
  menu.addEventListener('click', (e) => {
    const b = /** @type {HTMLElement} */ (e.target).closest('button');
    if (!b) {
      return;
    }
    menu.hidden = true;
    const { range, view } = exportScope();
    if (b.dataset.export === 'png') {
      vscode.postMessage({ type: 'savePng', dataUrl: exportPng(range, view), range });
    } else {
      if (!view.length) {
        return;
      }
      // Pin the exact visible samples, including 'all' and paused exports.
      const snapshotRange = { from: view[0].time, to: view[view.length - 1].time };
      vscode.postMessage({ type: 'export', format: b.dataset.export, range: snapshotRange, expectedSamples: view.length });
    }
  });

  /** Composes the timeline and every visible chart into a single image. */
  function exportPng(range, view) {
    const visible = charts.filter((c) => !c.el.hidden);
    const cols = 2;
    const cw = 640;
    const ch = 260;
    const width = cols * cw;
    const dpr = 2;
    const header = 52;
    const tlH = tlLayout(width - 24).height + 16;
    const rows = Math.ceil(visible.length / cols) || 1;
    const height = header + tlH + rows * ch;
    const canvas = document.createElement('canvas');
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
    ctx.scale(dpr, dpr);
    ctx.fillStyle = cssVar('--surface-1') || '#fff';
    ctx.fillRect(0, 0, width, height);
    const font = getComputedStyle(document.body).fontFamily;
    const fg = cssVar('--text-primary') || '#000';
    ctx.fillStyle = fg;
    ctx.font = `600 16px ${font}`;
    ctx.textBaseline = 'top';
    ctx.fillText($('title').textContent || '', 16, 12);
    ctx.font = `12px ${font}`;
    ctx.fillStyle = cssVar('--text-secondary');
    ctx.fillText(`Scope: ${range ? `interval ${timeFmt(range.from)} – ${timeFmt(range.to)}` : 'all data'} · exported ${new Date().toLocaleString('en-US')}`, 16, 32);
    ctx.save();
    ctx.translate(12, header);
    renderTimeline(ctx, width - 24, data(), { hoverX: null, selection: range || null, analyzed: !!range });
    ctx.restore();
    hideTooltip();
    visible.forEach((c, i) => {
      const ox = (i % cols) * cw;
      const oy = header + tlH + Math.floor(i / cols) * ch;
      ctx.save();
      ctx.translate(ox + 12, oy + 8);
      ctx.fillStyle = fg;
      ctx.font = `600 13px ${font}`;
      ctx.textBaseline = 'top';
      ctx.fillText(`${c.def.title}${c.def.unit ? ` (${c.def.unit})` : ''}`, 0, 0);
      // legend
      let lx = 0;
      ctx.font = `11px ${font}`;
      if (c.def.series.length > 1) {
        c.def.series.forEach((se, si) => {
          ctx.fillStyle = seriesColor(si);
          ctx.fillRect(lx, 24, 12, 3);
          ctx.fillStyle = cssVar('--text-secondary');
          ctx.fillText(se.label, lx + 16, 19);
          lx += ctx.measureText(se.label).width + 32;
        });
      }
      ctx.translate(0, 36);
      renderPlot(ctx, c.def, view, cw - 24, ch - 52, null);
      ctx.restore();
    });
    return canvas.toDataURL('image/png');
  }

  // ---------- Messages from the extension ----------
  let renderQueued = false;
  function queueRender() {
    if (renderQueued) {
      return;
    }
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      if (!paused) {
        renderAll();
      }
      renderTable();
    });
  }

  window.addEventListener('message', (e) => {
    const m = e.data;
    switch (m.type) {
      case 'init':
        $('title').textContent = m.imported ? `${m.name}${m.pid ? ` — PID ${m.pid}` : ''} (imported)` : `${m.name} — PID ${m.pid}`;
        $('subtitle').textContent = [m.project ? `Project: ${m.project}` : '', m.imported ? `Imported from ${m.imported.file}` : m.path, `${m.imported ? 'Recorded' : 'Started'} ${new Date(m.startedAt).toLocaleString('en-US')}`]
          .filter(Boolean)
          .join(' · ');
        if (m.thresholds) {
          thresholds = m.thresholds;
        }
        imported = m.imported || null;
        processStartedAt = m.processStartedAt || null;
        processLookupPending = !processStartedAt && !m.imported;
        setTimeout(() => {
          processLookupPending = false;
          renderUptime();
        }, 15000);
        endedAt = m.endedAt || null;
        if (imported) {
          // a recorded file is best seen whole
          rangeSeconds = 0;
          $('range').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x.dataset.range === '0'));
        }
        /** @type {HTMLElement} */ (document.querySelector('[data-export="raw"]')).hidden = m.hasRawCsv === false;
        if (m.refreshInterval) {
          refreshMs = m.refreshInterval * 1000;
        }
        renderLegend();
        samples = m.samples.map(withTotals);
        sampleCount = m.sampleCount;
        counters.clear();
        for (const c of m.counters) {
          counters.set(`${c.provider}|${c.name}`, c);
        }
        tableDirty = true;
        setState(m.state, m.error);
        queueRender();
        break;
      case 'paused':
        frozen = m.samples.map(withTotals);
        paused = true;
        /** @type {HTMLButtonElement} */ ($('pause')).disabled = false;
        /** @type {HTMLButtonElement} */ ($('exportBtn')).disabled = false;
        $('pause').textContent = 'Resume';
        $('pause').classList.add('on');
        renderAll();
        break;
      case 'sample':
        sampleCount = m.sampleCount;
        samples.push(withTotals(m.derived));
        if (samples.length > m.retainedCount) {
          samples.splice(0, samples.length - m.retainedCount);
        }
        for (const c of m.counters) {
          counters.set(`${c.provider}|${c.name}`, c);
        }
        tableDirty = true;
        queueRender();
        break;
      case 'state':
        endedAt = m.endedAt || endedAt;
        setState(m.state, m.error);
        break;
      case 'processInfo':
        processLookupPending = false;
        processStartedAt = m.processStartedAt || null;
        renderUptime();
        break;
      case 'thresholds':
        thresholds = m.thresholds;
        renderLegend();
        renderAll();
        break;
    }
  });

  // ---------- Theme: auto (follows VS Code), light or dark ----------
  let themeMode = 'auto';
  function applyTheme(mode) {
    themeMode = mode === 'light' || mode === 'dark' ? mode : 'auto';
    const b = document.body;
    if (themeMode === 'auto') {
      delete b.dataset.theme;
    } else {
      b.dataset.theme = themeMode;
    }
    const vscodeLight = b.classList.contains('vscode-light') || b.classList.contains('vscode-high-contrast-light');
    b.dataset.effective = themeMode === 'auto' ? (vscodeLight ? 'light' : 'dark') : themeMode;
    $('theme').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x.dataset.theme === themeMode));
    renderAll();
  }
  $('theme').addEventListener('click', (e) => {
    const btn = /** @type {HTMLElement} */ (e.target).closest('button');
    if (btn && btn.dataset.theme) {
      applyTheme(btn.dataset.theme);
      vscode.setState({ ...(vscode.getState() || {}), theme: themeMode });
      vscode.postMessage({ type: 'setTheme', theme: themeMode });
    }
  });
  window.addEventListener('message', (e) => {
    if (e.data.type === 'theme' || (e.data.type === 'init' && e.data.theme)) {
      applyTheme(e.data.theme);
    }
  });

  // the VS Code theme may change while the panel is open
  new MutationObserver(() => applyTheme(themeMode)).observe(document.body, { attributes: true, attributeFilter: ['class'] });

  renderLegend();
  updateSelectionUi();
  applyTheme((vscode.getState() || {}).theme || 'auto');
  vscode.postMessage({ type: 'ready' });
})();
