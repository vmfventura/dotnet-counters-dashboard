import * as path from 'path';
import * as vscode from 'vscode';
import { DotnetProcess, listProcesses, ToolNotFoundError } from './countersCli';
import { DashboardPanel } from './dashboardPanel';
import { importFile } from './importer';
import { formatUptime } from './processInfo';
import { findWorkspaceProjects, matchesProject } from './projectResolver';
import { CounterSession, exportSession } from './session';
import { ProcessItem, ProcessTreeProvider, SessionItem, SessionTreeProvider } from './trees';
import { ProjectWatcher, WatchItem, WatchTarget, WatchTreeProvider } from './watcher';

const sessions: CounterSession[] = [];

export function activate(context: vscode.ExtensionContext): void {
  const processTree = new ProcessTreeProvider();
  const sessionTree = new SessionTreeProvider(() => sessions);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  let sessionTreeTimer: NodeJS.Timeout | undefined;

  const refreshSessions = () => {
    // throttle tree refreshes (samples arrive every second)
    if (!sessionTreeTimer) {
      sessionTreeTimer = setTimeout(() => {
        sessionTreeTimer = undefined;
        sessionTree.refresh();
      }, 1000);
    }
  };

  const startSession = (proc: DotnetProcess, projectName?: string, opts: { watch?: WatchTarget; open?: boolean } = {}): CounterSession => {
    const running = sessions.find((s) => s.proc.pid === proc.pid && s.state === 'running');
    if (running) {
      if (opts.open !== false) {
        DashboardPanel.show(context.extensionUri, running, restart);
      }
      return running;
    }
    // A new run of a watched project replaces the dashboards of its previous (finished) runs;
    // those sessions stay in the Monitoring Sessions list and can be reopened.
    const previous = opts.watch ? watcher.sessionsFor(opts.watch).filter((s) => s.state === 'stopped') : [];
    const session = new CounterSession(proc, projectName);
    session.watchId = opts.watch?.id;
    sessions.unshift(session);
    session.onSample(({ derived }) => {
      refreshSessions();
      if (sessions.find((s) => s.state === 'running') === session) {
        const cpu = derived.cpuPercent === null ? '—' : `${derived.cpuPercent.toFixed(1)}%`;
        const mem = derived.workingSetMB === null ? '—' : `${derived.workingSetMB.toFixed(0)} MB`;
        const up = session.processStartedAt ? `  Up ${formatUptime(Date.now() - session.processStartedAt)}` : '';
        status.text = `$(pulse) ${proc.name}  CPU ${cpu}  Mem ${mem}${up}`;
        status.tooltip = `dotnet-counters — ${session.title}${session.processStartedAt ? `\nProcess started ${new Date(session.processStartedAt).toLocaleString()}` : ''}\nClick to open the dashboard`;
        status.command = { command: 'dotnetCounters.openSession', title: 'Open', arguments: [session] };
        status.show();
      }
    });
    session.onStateChange((s) => {
      sessionTree.refresh();
      watcher.notify();
      if (!sessions.some((x) => x.state === 'running')) {
        status.hide();
      }
      // For watched projects the process exiting is expected: the watcher simply waits for the next start.
      if (s.error && !s.watchId) {
        void vscode.window.showWarningMessage(`dotnet-counters (${s.title}): ${s.error}`);
      }
    });
    sessionTree.refresh();
    watcher.notify();
    if (opts.open !== false) {
      DashboardPanel.show(context.extensionUri, session, restart, !!opts.watch);
      previous.forEach((s) => DashboardPanel.closeFor(s));
    }
    return session;
  };

  const watcher = new ProjectWatcher(context.workspaceState, () => sessions, (proc, target) => {
    const open = vscode.workspace.getConfiguration('dotnetCounters').get<boolean>('watchOpenDashboard', true);
    startSession(proc, target.name, { watch: target, open });
    vscode.window.setStatusBarMessage(`$(pulse) ${target.name} started (PID ${proc.pid}) — monitoring`, 6000);
  });
  const watchTree = new WatchTreeProvider(watcher);
  const watchStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);
  watchStatus.command = 'dotnetCounters.watches.focus';
  const updateWatchStatus = () => {
    const waiting = watcher.all.filter((t) => t.enabled && !watcher.runningSessionFor(t));
    if (!waiting.length) {
      watchStatus.hide();
      return;
    }
    watchStatus.text = `$(eye) Waiting for ${waiting.length === 1 ? waiting[0].name : `${waiting.length} projects`}…`;
    watchStatus.tooltip = `Watched projects waiting for their process to start:\n${waiting.map((t) => `• ${t.name}`).join('\n')}`;
    watchStatus.show();
  };
  watcher.onDidChange(updateWatchStatus);
  updateWatchStatus();

  /** Adds watches: pick workspace projects, or type a process name. */
  const pickAndWatch = async () => {
    const projects = await findWorkspaceProjects();
    type Item = vscode.QuickPickItem & { project?: (typeof projects)[number] };
    const typeName: Item = { label: '$(edit) Enter a process name…', description: 'for apps outside this workspace' };
    const items: Item[] = [
      ...projects
        .filter((p) => !watcher.has(p.processName)?.enabled)
        .map((p) => ({ label: p.processName, description: vscode.workspace.asRelativePath(p.csproj), project: p })),
      typeName,
    ];
    const picks = await vscode.window.showQuickPick(items, {
      title: 'Watch projects — attach automatically whenever their process starts',
      canPickMany: true,
      placeHolder: 'Select one or more projects',
    });
    if (!picks?.length) {
      return;
    }
    for (const p of picks) {
      if (p === typeName) {
        const name = (await vscode.window.showInputBox({ title: 'Watch process', prompt: 'Process name (e.g. MyApi)' }))?.trim();
        if (name) {
          await watcher.add(name);
        }
      } else if (p.project) {
        await watcher.add(p.project.processName, path.dirname(p.project.csproj.fsPath));
      }
    }
    void vscode.commands.executeCommand('dotnetCounters.watches.focus');
  };

  const restart = (old: CounterSession) => {
    old.stop();
    startSession(old.proc, old.projectName);
  };

  const sessionFrom = (arg: unknown): CounterSession | undefined =>
    arg instanceof SessionItem ? arg.session : arg instanceof CounterSession ? arg : sessions[0];

  const watchFrom = (arg: unknown): WatchTarget | undefined => (arg instanceof WatchItem ? arg.target : undefined);

  context.subscriptions.push(
    status,
    watchStatus,
    watcher,
    vscode.window.registerTreeDataProvider('dotnetCounters.watches', watchTree),

    vscode.commands.registerCommand('dotnetCounters.watchProject', pickAndWatch),

    /** Internal: watch a given name (used by "Keep watching" and the process list). */
    vscode.commands.registerCommand('dotnetCounters.addWatch', async (name: string, projectDir?: string) => {
      await watcher.add(name, projectDir);
      void vscode.commands.executeCommand('dotnetCounters.watches.focus');
    }),

    vscode.commands.registerCommand('dotnetCounters.watchProcess', async (item?: ProcessItem) => {
      if (item) {
        await watcher.add(item.project?.processName ?? item.proc.name, item.project ? path.dirname(item.project.csproj.fsPath) : undefined);
        void vscode.commands.executeCommand('dotnetCounters.watches.focus');
      }
    }),

    vscode.commands.registerCommand('dotnetCounters.unwatch', async (arg?: WatchItem) => {
      const t = watchFrom(arg);
      if (t) {
        await watcher.remove(t);
      }
    }),

    vscode.commands.registerCommand('dotnetCounters.pauseWatch', async (arg?: WatchItem) => {
      const t = watchFrom(arg);
      if (t) {
        await watcher.setEnabled(t, false);
      }
    }),

    vscode.commands.registerCommand('dotnetCounters.resumeWatch', async (arg?: WatchItem) => {
      const t = watchFrom(arg);
      if (t) {
        await watcher.setEnabled(t, true);
      }
    }),

    /** Click on a watched project: open its live dashboard, or the last run's one. */
    vscode.commands.registerCommand('dotnetCounters.openWatch', (arg?: WatchItem) => {
      const t = watchFrom(arg);
      if (!t) {
        return;
      }
      const s = watcher.runningSessionFor(t) ?? watcher.sessionsFor(t)[0];
      if (s) {
        DashboardPanel.show(context.extensionUri, s, restart);
      } else {
        vscode.window.setStatusBarMessage(`$(eye) ${t.name}: ${t.enabled ? 'waiting for the process to start…' : 'paused'}`, 4000);
      }
    }),

    vscode.window.registerTreeDataProvider('dotnetCounters.processes', processTree),
    vscode.window.registerTreeDataProvider('dotnetCounters.sessions', sessionTree),

    vscode.commands.registerCommand('dotnetCounters.refresh', () => processTree.refresh()),

    vscode.commands.registerCommand('dotnetCounters.installTool', () => {
      const t = vscode.window.createTerminal('dotnet-counters');
      t.show();
      t.sendText('dotnet tool install --global dotnet-counters');
    }),

    vscode.commands.registerCommand('dotnetCounters.monitorProcess', async (item?: ProcessItem) => {
      if (item) {
        startSession(item.proc, item.project?.processName);
        return;
      }
      const proc = await pickProcess(await safeList());
      if (proc) {
        startSession(proc);
      }
    }),

    vscode.commands.registerCommand('dotnetCounters.monitorByName', async () => {
      const name = await vscode.window.showInputBox({
        title: 'Monitor by name',
        prompt: 'Process/project name (e.g. MyApi). It will be looked up in dotnet-counters ps.',
        value: vscode.workspace.getConfiguration('dotnetCounters').get<string>('projectName') ?? '',
      });
      if (name?.trim()) {
        await monitorByName(name.trim(), undefined, startSession);
      }
    }),

    vscode.commands.registerCommand('dotnetCounters.monitorProject', async () => {
      const configured = vscode.workspace.getConfiguration('dotnetCounters').get<string>('projectName')?.trim();
      if (configured) {
        await monitorByName(configured, undefined, startSession);
        return;
      }
      const projects = await findWorkspaceProjects();
      if (projects.length === 0) {
        void vscode.commands.executeCommand('dotnetCounters.monitorByName');
        return;
      }
      let project = projects[0];
      if (projects.length > 1) {
        const pick = await vscode.window.showQuickPick(
          projects.map((p) => ({ label: p.processName, description: vscode.workspace.asRelativePath(p.csproj), project: p })),
          { title: 'Which project do you want to monitor?' },
        );
        if (!pick) {
          return;
        }
        project = pick.project;
      }
      await monitorByName(project.processName, path.dirname(project.csproj.fsPath), startSession);
    }),

    vscode.commands.registerCommand('dotnetCounters.openSession', (arg?: SessionItem | CounterSession) => {
      const s = sessionFrom(arg);
      if (s) {
        DashboardPanel.show(context.extensionUri, s, restart);
      }
    }),

    vscode.commands.registerCommand('dotnetCounters.stopSession', (arg?: SessionItem) => sessionFrom(arg)?.stop()),

    vscode.commands.registerCommand('dotnetCounters.removeSession', (arg?: SessionItem) => {
      const s = sessionFrom(arg);
      if (!s) {
        return;
      }
      DashboardPanel.closeFor(s);
      sessions.splice(sessions.indexOf(s), 1);
      s.dispose();
      sessionTree.refresh();
    }),

    vscode.commands.registerCommand('dotnetCounters.importData', async (uri?: vscode.Uri) => {
      const files = uri ? [uri] : await vscode.window.showOpenDialog({
        title: 'Import .NET counters data',
        canSelectMany: true,
        filters: { 'Counters data (CSV, JSON)': ['csv', 'json'], 'All files': ['*'] },
        defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
      });
      for (const file of files ?? []) {
        try {
          const data = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Importing ${path.basename(file.fsPath)}…` },
            () => importFile(file),
          );
          const session = new CounterSession(data.proc, data.project, data);
          sessions.unshift(session);
          sessionTree.refresh();
          DashboardPanel.show(context.extensionUri, session, restart);
        } catch (e) {
          void vscode.window.showErrorMessage(`Could not import ${path.basename(file.fsPath)}: ${(e as Error).message}`);
        }
      }
    }),

    vscode.commands.registerCommand('dotnetCounters.exportSession', async (arg?: SessionItem) => {
      const s = sessionFrom(arg);
      if (s) {
        await exportSession(s);
      } else {
        void vscode.window.showInformationMessage('There are no sessions to export.');
      }
    }),

    { dispose: () => sessions.forEach((s) => s.dispose()) },
  );
}

async function safeList(): Promise<DotnetProcess[]> {
  try {
    return await listProcesses();
  } catch (e) {
    await reportListError(e);
    return [];
  }
}

async function reportListError(e: unknown): Promise<void> {
  if (e instanceof ToolNotFoundError) {
    const choice = await vscode.window.showErrorMessage(e.message, 'Install dotnet-counters');
    if (choice) {
      void vscode.commands.executeCommand('dotnetCounters.installTool');
    }
  } else {
    void vscode.window.showErrorMessage(`dotnet-counters ps failed: ${(e as Error).message}`);
  }
}

async function pickProcess(procs: DotnetProcess[], title = 'Pick the .NET process'): Promise<DotnetProcess | undefined> {
  if (procs.length === 0) {
    return undefined;
  }
  const pick = await vscode.window.showQuickPick(
    procs.map((p) => ({ label: p.name, description: `PID ${p.pid}`, detail: p.path, proc: p })),
    { title, matchOnDescription: true, matchOnDetail: true },
  );
  return pick?.proc;
}

/**
 * Looks up the PID of the process with this name in `dotnet-counters ps`. If it is not running yet,
 * waits (with cancellable progress) for up to `waitForProcessSeconds`.
 */
async function monitorByName(name: string, projectDir: string | undefined, start: (p: DotnetProcess, project?: string) => unknown): Promise<void> {
  const find = async () => (await listProcesses()).filter((p) => matchesProject(p, name, projectDir));
  let matches: DotnetProcess[];
  try {
    matches = await find();
  } catch (e) {
    await reportListError(e);
    return;
  }

  if (matches.length === 0) {
    const waitSeconds = vscode.workspace.getConfiguration('dotnetCounters').get<number>('waitForProcessSeconds', 60);
    matches = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Waiting for "${name}" to start…`, cancellable: true },
      async (progress, token) => {
        const deadline = Date.now() + waitSeconds * 1000;
        while (!token.isCancellationRequested && Date.now() < deadline) {
          progress.report({ message: `${Math.ceil((deadline - Date.now()) / 1000)}s left (start the application)` });
          await new Promise((r) => setTimeout(r, 2000));
          const found = await find().catch(() => []);
          if (found.length) {
            return found;
          }
        }
        return [];
      },
    );
    if (matches.length === 0) {
      const choice = await vscode.window.showWarningMessage(
        `No "${name}" process found in dotnet-counters ps.`,
        'Keep watching',
        'Pick from list',
      );
      if (choice === 'Keep watching') {
        // saved for this workspace: attaches automatically whenever the process starts
        await vscode.commands.executeCommand('dotnetCounters.addWatch', name, projectDir);
      } else if (choice) {
        const proc = await pickProcess(await safeList());
        if (proc) {
          start(proc, name);
        }
      }
      return;
    }
  }

  const proc = matches.length === 1 ? matches[0] : await pickProcess(matches, `There are ${matches.length} "${name}" processes`);
  if (proc) {
    start(proc, name);
  }
}

export function deactivate(): void {
  sessions.forEach((s) => s.dispose());
}
