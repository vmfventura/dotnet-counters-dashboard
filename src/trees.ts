import * as vscode from 'vscode';
import { DotnetProcess, listProcesses, ToolNotFoundError } from './countersCli';
import { formatUptime, getProcessStartTimes } from './processInfo';
import { findWorkspaceProjects, projectsMatching, WorkspaceProject } from './projectResolver';
import { CounterSession } from './session';

export class ProcessItem extends vscode.TreeItem {
  constructor(readonly proc: DotnetProcess, readonly project: WorkspaceProject | undefined, readonly startedAt?: number) {
    super(proc.name, vscode.TreeItemCollapsibleState.None);
    const up = startedAt ? ` · up ${formatUptime(Date.now() - startedAt)}` : '';
    this.description = `PID ${proc.pid}${up}${project ? ' · workspace project' : ''}`;
    const since = startedAt ? `\n\nRunning for **${formatUptime(Date.now() - startedAt)}** (started ${new Date(startedAt).toLocaleString()})` : '';
    this.tooltip = new vscode.MarkdownString(`**${proc.name}** — PID ${proc.pid}${since}\n\n\`${proc.path || '—'}\``);
    this.iconPath = new vscode.ThemeIcon(project ? 'star-full' : 'server-process');
    this.contextValue = project ? 'process.project' : 'process';
    this.command = { command: 'dotnetCounters.monitorProcess', title: 'Monitor', arguments: [this] };
  }
}

export class ProcessTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  private error: string | undefined;

  refresh(): void {
    this._onDidChange.fire();
  }

  getTreeItem(el: vscode.TreeItem): vscode.TreeItem {
    return el;
  }

  async getChildren(): Promise<vscode.TreeItem[]> {
    try {
      const [procs, projects] = await Promise.all([listProcesses(), findWorkspaceProjects()]);
      this.error = undefined;
      const starts = await getProcessStartTimes(procs.map((p) => p.pid)).catch(() => new Map<number, number>());
      const items = procs.map((p) => new ProcessItem(p, projectsMatching(p, projects), starts.get(p.pid)));
      // Workspace project processes first.
      return items.sort((a, b) => Number(!!b.project) - Number(!!a.project));
    } catch (e) {
      this.error = (e as Error).message;
      const item = new vscode.TreeItem(e instanceof ToolNotFoundError ? 'dotnet-counters is not installed' : 'Failed to list processes');
      item.description = this.error;
      item.tooltip = this.error;
      item.iconPath = new vscode.ThemeIcon('error');
      if (e instanceof ToolNotFoundError) {
        item.command = { command: 'dotnetCounters.installTool', title: 'Install' };
        item.description = 'click to install';
      }
      return [item];
    }
  }
}

export class SessionItem extends vscode.TreeItem {
  constructor(readonly session: CounterSession) {
    super(session.title, vscode.TreeItemCollapsibleState.None);
    const running = session.state === 'running';
    this.description = session.imported
      ? `imported · ${session.sampleCount} samples`
      : running
        ? `collecting · ${session.sampleCount} samples`
        : `stopped${session.error ? ' · error' : ''} · ${session.sampleCount} samples`;
    this.tooltip = session.imported ? `Imported from ${session.imported.file}` : session.error ?? `${session.projectName ? `Project: ${session.projectName}\n` : ''}Started: ${new Date(session.startedAt).toLocaleString()}`;
    this.iconPath = new vscode.ThemeIcon(session.imported ? 'file' : running ? 'pulse' : session.error ? 'warning' : 'debug-stop');
    this.contextValue = running ? 'session.running' : 'session.stopped';
    this.command = { command: 'dotnetCounters.openSession', title: 'Open dashboard', arguments: [this] };
  }
}

export class SessionTreeProvider implements vscode.TreeDataProvider<SessionItem> {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  constructor(private readonly sessions: () => CounterSession[]) {}

  refresh(): void {
    this._onDidChange.fire();
  }

  getTreeItem(el: SessionItem): vscode.TreeItem {
    return el;
  }

  getChildren(): SessionItem[] {
    return this.sessions().map((s) => new SessionItem(s));
  }
}
