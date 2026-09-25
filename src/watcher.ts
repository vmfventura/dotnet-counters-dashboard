import * as vscode from 'vscode';
import { DotnetProcess, listProcesses, ToolNotFoundError } from './countersCli';
import { matchesProject } from './projectResolver';
import type { CounterSession } from './session';

/** A project (process name) the user wants to monitor whenever it runs. */
export interface WatchTarget {
  id: string;
  /** Process name to match (AssemblyName / project name). */
  name: string;
  /** Project folder, to also match executables under its bin/ folder. */
  projectDir?: string;
  enabled: boolean;
}

const STORAGE_KEY = 'dotnetCounters.watches';

/**
 * Keeps the list of watched projects (per workspace) and polls `dotnet-counters ps`;
 * when a matching process appears it asks the extension to attach a session to it.
 */
export class ProjectWatcher implements vscode.Disposable {
  private targets: WatchTarget[];
  private timer: NodeJS.Timeout | undefined;
  private polling = false;
  private disposed = false;
  /** Last poll error (e.g. dotnet-counters missing), shown in the tree. */
  lastError: string | undefined;
  private errorShown = false;

  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(
    private readonly state: vscode.Memento,
    private readonly sessions: () => CounterSession[],
    private readonly attach: (proc: DotnetProcess, target: WatchTarget) => void,
  ) {
    this.targets = state.get<WatchTarget[]>(STORAGE_KEY, []);
    this.schedule(500);
  }

  get all(): readonly WatchTarget[] {
    return this.targets;
  }

  /** Sessions attached for this target, newest first. */
  sessionsFor(t: WatchTarget): CounterSession[] {
    return this.sessions().filter((s) => !s.imported && s.watchId === t.id);
  }

  runningSessionFor(t: WatchTarget): CounterSession | undefined {
    return this.sessionsFor(t).find((s) => s.state === 'running');
  }

  has(name: string): WatchTarget | undefined {
    return this.targets.find((t) => t.name.toLowerCase() === name.toLowerCase());
  }

  async add(name: string, projectDir?: string): Promise<WatchTarget> {
    const existing = this.has(name);
    if (existing) {
      existing.enabled = true;
      existing.projectDir = existing.projectDir ?? projectDir;
      await this.save();
      return existing;
    }
    const t: WatchTarget = { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, name, projectDir, enabled: true };
    this.targets.push(t);
    await this.save();
    return t;
  }

  async remove(t: WatchTarget): Promise<void> {
    this.targets = this.targets.filter((x) => x.id !== t.id);
    await this.save();
  }

  async setEnabled(t: WatchTarget, enabled: boolean): Promise<void> {
    const x = this.targets.find((y) => y.id === t.id);
    if (x) {
      x.enabled = enabled;
      await this.save();
    }
  }

  /** Re-render trees / status and poll right away (e.g. after a session ended). */
  notify(): void {
    this._onDidChange.fire();
    this.schedule(200);
  }

  private async save(): Promise<void> {
    await this.state.update(STORAGE_KEY, this.targets);
    this.notify();
  }

  private schedule(delayMs?: number): void {
    if (this.disposed) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }
    const seconds = vscode.workspace.getConfiguration('dotnetCounters').get<number>('watchPollSeconds', 3);
    this.timer = setTimeout(() => void this.poll(), delayMs ?? Math.max(1, seconds) * 1000);
  }

  private async poll(): Promise<void> {
    const active = this.targets.filter((t) => t.enabled);
    if (!active.length || this.polling) {
      this.schedule();
      return;
    }
    this.polling = true;
    try {
      const procs = await listProcesses();
      if (this.lastError) {
        this.lastError = undefined;
        this._onDidChange.fire();
      }
      for (const t of active) {
        for (const p of procs) {
          if (matchesProject(p, t.name, t.projectDir) && !this.isHandled(p.pid)) {
            this.attach(p, t);
          }
        }
      }
    } catch (e) {
      this.lastError = (e as Error).message;
      this._onDidChange.fire();
      if (e instanceof ToolNotFoundError && !this.errorShown) {
        this.errorShown = true;
        void vscode.window.showErrorMessage(`Watched projects: ${this.lastError}`, 'Install dotnet-counters').then((c) => {
          if (c) {
            void vscode.commands.executeCommand('dotnetCounters.installTool');
          }
        });
      }
    } finally {
      this.polling = false;
      this.schedule();
    }
  }

  /** A PID is handled while a session collects it, or after the user stopped it manually (do not re-attach). */
  private isHandled(pid: number): boolean {
    return this.sessions().some((s) => !s.imported && s.proc.pid === pid && (s.state === 'running' || s.stoppedByUser));
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this._onDidChange.dispose();
  }
}

export class WatchItem extends vscode.TreeItem {
  constructor(readonly target: WatchTarget, watcher: ProjectWatcher) {
    super(target.name, vscode.TreeItemCollapsibleState.None);
    const running = watcher.runningSessionFor(target);
    const count = watcher.sessionsFor(target).length;
    if (!target.enabled) {
      this.description = 'paused';
      this.iconPath = new vscode.ThemeIcon('eye-closed');
    } else if (running) {
      this.description = `monitoring PID ${running.proc.pid}`;
      this.iconPath = new vscode.ThemeIcon('pulse', new vscode.ThemeColor('charts.green'));
    } else if (watcher.lastError) {
      this.description = 'error — see tooltip';
      this.iconPath = new vscode.ThemeIcon('warning');
    } else if (watcher.sessionsFor(target)[0]?.stoppedByUser) {
      this.description = 'stopped by you · attaches on next start';
      this.iconPath = new vscode.ThemeIcon('eye');
    } else {
      this.description = 'waiting for process…';
      this.iconPath = new vscode.ThemeIcon('eye');
    }
    this.tooltip = new vscode.MarkdownString(
      `**${target.name}** — watched project\n\n` +
        (target.projectDir ? `Folder: \`${target.projectDir}\`\n\n` : '') +
        (target.enabled
          ? running
            ? `Monitoring PID ${running.proc.pid}. When the process exits the extension waits for the next start.`
            : 'Waiting — the dashboard opens automatically when the process starts.'
          : 'Paused — not waiting for the process.') +
        (count ? `\n\n${count} session(s) recorded.` : '') +
        (watcher.lastError ? `\n\n⚠ ${watcher.lastError}` : ''),
    );
    this.contextValue = target.enabled ? 'watch.enabled' : 'watch.paused';
    this.command = { command: 'dotnetCounters.openWatch', title: 'Open', arguments: [this] };
  }
}

export class WatchTreeProvider implements vscode.TreeDataProvider<WatchItem> {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  constructor(private readonly watcher: ProjectWatcher) {
    watcher.onDidChange(() => this._onDidChange.fire());
  }

  refresh(): void {
    this._onDidChange.fire();
  }

  getTreeItem(el: WatchItem): vscode.TreeItem {
    return el;
  }

  getChildren(): WatchItem[] {
    return this.watcher.all.map((t) => new WatchItem(t, this.watcher));
  }
}
