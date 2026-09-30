import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { DERIVED_LABELS } from './metrics';
import { CounterSession, exportSession, TimeRange } from './session';
import { SessionSnapshot } from './sessionSnapshot';

/** Webview panel with the charts of a session. One panel per session. */
export class DashboardPanel implements vscode.Disposable {
  private static readonly panels = new Map<number, DashboardPanel>();
  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;
  private frozen: SessionSnapshot | undefined;

  /** @param preserveFocus open without stealing focus (used when a watched project attaches automatically). */
  static show(extensionUri: vscode.Uri, session: CounterSession, onRestart: (s: CounterSession) => void, preserveFocus = false): void {
    const existing = DashboardPanel.panels.get(session.id);
    if (existing) {
      existing.panel.reveal(undefined, preserveFocus);
      return;
    }
    DashboardPanel.panels.set(session.id, new DashboardPanel(extensionUri, session, onRestart, preserveFocus));
  }

  static closeFor(session: CounterSession): void {
    DashboardPanel.panels.get(session.id)?.panel.dispose();
  }

  static isOpen(session: CounterSession): boolean {
    return DashboardPanel.panels.has(session.id);
  }

  private readonly panel: vscode.WebviewPanel;

  private constructor(private readonly extensionUri: vscode.Uri, private readonly session: CounterSession, onRestart: (s: CounterSession) => void, preserveFocus: boolean) {
    const media = vscode.Uri.joinPath(extensionUri, 'media');
    this.panel = vscode.window.createWebviewPanel('dotnetCounters.dashboard', `Counters: ${session.title}`, { viewColumn: vscode.ViewColumn.Active, preserveFocus }, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [media],
    });
    this.panel.iconPath = vscode.Uri.joinPath(media, 'activity.svg');
    this.panel.webview.html = this.html();

    this.disposables.push(
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m, onRestart)),
      session.onSample(({ derived, raw }) => {
        void this.panel.webview.postMessage({ type: 'sample', derived, counters: raw.counters, retainedCount: session.samples.length, sampleCount: session.sampleCount });
      }),
      session.onStateChange((s) => {
        void this.panel.webview.postMessage({ type: 'state', state: s.state, error: s.error, endedAt: s.endedAt });
      }),
      // keep every open panel in sync with the setting
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('dotnetCounters')) {
          void this.panel.webview.postMessage({ type: 'thresholds', thresholds: this.session.thresholds });
        }
        if (e.affectsConfiguration('dotnetCounters.theme')) {
          const theme = vscode.workspace.getConfiguration('dotnetCounters').get<string>('theme', 'auto');
          void this.panel.webview.postMessage({ type: 'theme', theme });
        }
      }),
    );
  }

  private async onMessage(m: { type: string; format?: 'csv' | 'json' | 'raw'; dataUrl?: string; theme?: string; range?: TimeRange; expectedSamples?: number }, onRestart: (s: CounterSession) => void): Promise<void> {
    switch (m.type) {
      case 'ready':
        void this.panel.webview.postMessage({
          type: 'init',
          title: this.session.title,
          pid: this.session.proc.pid,
          name: this.session.proc.name,
          path: this.session.proc.path,
          project: this.session.projectName,
          startedAt: this.session.startedAt,
          processStartedAt: this.session.processStartedAt,
          endedAt: this.session.endedAt,
          state: this.session.state,
          error: this.session.error,
          labels: DERIVED_LABELS,
          thresholds: this.session.thresholds,
          refreshInterval: this.session.refreshInterval,
          imported: this.session.imported ? { file: this.session.imported.file, format: this.session.imported.format } : undefined,
          hasRawCsv: this.session.hasRawCsv,
          theme: vscode.workspace.getConfiguration('dotnetCounters').get<string>('theme', 'auto'),
          samples: this.session.samples,
          sampleCount: this.session.sampleCount,
          counters: [...this.session.latest.values()],
        });
        void this.session.processInfo.then((t) => this.panel.webview.postMessage({ type: 'processInfo', processStartedAt: t }));
        break;
      case 'stop':
        this.session.stop();
        break;
      case 'restart':
        if (!this.session.imported) {
          onRestart(this.session);
        }
        break;
      case 'pause':
        this.frozen = this.session.createSnapshot();
        void this.panel.webview.postMessage({ type: 'paused', samples: this.frozen.data.samples });
        break;
      case 'resume':
        this.frozen = undefined;
        break;
      case 'export': {
        if (!m.range || !Number.isFinite(m.range.from) || !Number.isFinite(m.range.to) || m.range.from > m.range.to) {
          return;
        }
        const snapshot = this.session.createSnapshot(m.range, this.frozen);
        if (!snapshot.data.samples.length || snapshot.data.samples.length !== m.expectedSamples) {
          void vscode.window.showWarningMessage('The selected data is no longer retained. Refresh the selection or pause the dashboard before exporting.');
          return;
        }
        await exportSession(this.session, m.format, m.range, snapshot);
        break;
      }
      case 'setTheme':
        await vscode.workspace.getConfiguration('dotnetCounters').update('theme', m.theme, vscode.ConfigurationTarget.Global);
        break;
      case 'savePng':
        await this.savePng(m.dataUrl ?? '', m.range);
        break;
    }
  }

  private async savePng(dataUrl: string, range?: TimeRange): Promise<void> {
    const b64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    const hhmmss = (t: number) => new Date(t).toTimeString().slice(0, 8).replace(/:/g, '');
    const name = `${this.session.proc.name}-${this.session.proc.pid}-dashboard${range ? `-${hhmmss(range.from)}-${hhmmss(range.to)}` : ''}.png`;
    const target = await vscode.window.showSaveDialog({
      defaultUri: folder ? vscode.Uri.joinPath(folder, name) : undefined,
      filters: { PNG: ['png'] },
      title: 'Save charts as image',
    });
    if (target) {
      await vscode.workspace.fs.writeFile(target, Buffer.from(b64, 'base64'));
      void vscode.window.showInformationMessage(`Image saved to ${target.fsPath}`);
    }
  }

  private html(): string {
    const webview = this.panel.webview;
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    const analysisScript = webview.asWebviewUri(vscode.Uri.joinPath(media, 'sessionAnalysis.js'));
    const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'dashboard.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(media, 'dashboard.css'));
    const nonce = crypto.randomBytes(16).toString('base64');
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>.NET Counters</title>
</head>
<body>
<div class="viz-root">
  <header class="top">
    <div class="ident">
      <h1 id="title">Starting…</h1>
      <div class="sub" id="subtitle"></div>
    </div>
    <div class="status" id="status"><span class="dot"></span><span id="statusText">Connecting to process…</span><span id="uptimeText" class="uptime"></span></div>
  </header>

  <div class="toolbar" role="toolbar">
    <div class="seg" role="group" aria-label="Time window" id="range">
      <button data-range="60" class="on">1 min</button>
      <button data-range="300">5 min</button>
      <button data-range="900">15 min</button>
      <button data-range="0">All</button>
    </div>
    <button id="pause" title="Freeze the charts (collection keeps running)">Pause</button>
    <div class="seg" role="group" aria-label="Theme" id="theme">
      <button data-theme="auto" class="on" title="Follow the VS Code theme">Auto</button>
      <button data-theme="light">Light</button>
      <button data-theme="dark">Dark</button>
    </div>
    <span class="spacer"></span>
    <button id="stop" title="Stop dotnet-counters">Stop</button>
    <button id="restart" title="New session for the same process" hidden>Restart</button>
    <div class="menu">
      <button id="exportBtn" aria-haspopup="true">Export ▾</button>
      <div class="menu-list" id="exportMenu" hidden>
        <div class="menu-note" id="exportScope">Scope: all data</div>
        <button data-export="csv">CSV — normalized metrics</button>
        <button data-export="json">JSON — metrics + counters</button>
        <button data-export="raw">Raw CSV (all counters)</button>
        <button data-export="png">PNG — charts</button>
      </div>
    </div>
  </div>

  <section class="timeline" id="timelineSection" aria-label="Timeline">
    <div class="timeline-head">
      <h2>Timeline</h2>
      <span class="divider"></span>
      <button class="icon-btn" id="analyzeAll" title="Analyze all data">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 3h9M2 6h9M2 9h5M2 12h4"/><circle cx="12" cy="11.5" r="2.5"/></svg>
        Analyze all
      </button>
      <button class="icon-btn" id="analyzeSel" title="Analyze the selected time interval (or double-click the selection / press Enter)" disabled>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 5V2h3M11 2h3v3M2 11v3h3"/><circle cx="10.5" cy="10.5" r="2.5"/><path d="M12.4 12.4L14.5 14.5"/></svg>
        Analyze selection
      </button>
      <button class="icon-btn" id="clearSel" title="Clear the selection (Esc)" disabled>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M14 2L8.5 7.5M6 6.5l3.5 3.5L7 14.5 2.5 10z"/></svg>
        Clear
      </button>
      <span class="spacer"></span>
      <span class="hint" id="selInfo">Drag on the timeline to select a time interval</span>
    </div>
    <div class="timeline-legend" id="timelineLegend"></div>
    <div class="hint" id="historyInfo" hidden></div>
    <canvas id="timeline" role="img" aria-label="Timeline with CPU, GC and memory lanes. Drag to select a time interval." tabindex="0"></canvas>
  </section>

  <div class="analysis-bar" id="analysisBar" hidden>
    <span id="analysisText"></span>
    <span class="spacer"></span>
    <button id="backToLive">Back to live view</button>
  </div>
  <section class="analysis" id="analysis" hidden>
    <h2>Interval analysis</h2>
    <ul class="findings" id="findings"></ul>
    <div class="summary" id="summary"></div>
  </section>

  <section class="tiles" id="tiles"></section>
  <div id="error" class="error" hidden></div>
  <section class="charts" id="charts"></section>

  <section class="table-wrap">
    <div class="table-head">
      <h2>All counters <span class="muted" id="counterCount"></span></h2>
      <input id="filter" type="search" placeholder="Filter counters…" aria-label="Filter counters">
    </div>
    <table>
      <thead><tr><th>Provider</th><th>Counter</th><th>Type</th><th class="num">Value</th></tr></thead>
      <tbody id="counterRows"></tbody>
    </table>
  </section>
  <!-- inside .viz-root so it inherits the series color variables -->
  <div class="tooltip" id="tooltip" hidden></div>
</div>
<script nonce="${nonce}" src="${analysisScript}"></script>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    DashboardPanel.panels.delete(this.session.id);
    this.disposables.forEach((d) => d.dispose());
    this.panel.dispose();
  }
}
