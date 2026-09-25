import * as path from 'path';
import * as vscode from 'vscode';
import { DotnetProcess } from './countersCli';

export interface WorkspaceProject {
  /** Expected process name (AssemblyName, or the .csproj file name). */
  processName: string;
  csproj: vscode.Uri;
}

/** Finds the workspace .csproj/.fsproj/.vbproj files and the assembly name each one produces. */
export async function findWorkspaceProjects(): Promise<WorkspaceProject[]> {
  const files = await vscode.workspace.findFiles('**/*.{csproj,fsproj,vbproj}', '**/{bin,obj,node_modules}/**', 200);
  const projects: WorkspaceProject[] = [];
  for (const file of files) {
    let processName = path.basename(file.fsPath).replace(/\.(cs|fs|vb)proj$/i, '');
    try {
      const xml = Buffer.from(await vscode.workspace.fs.readFile(file)).toString('utf8');
      const m = /<AssemblyName>\s*([^<]+?)\s*<\/AssemblyName>/i.exec(xml);
      if (m && !m[1].includes('$(')) {
        processName = m[1];
      }
    } catch {
      // fall back to the file name
    }
    projects.push({ processName, csproj: file });
  }
  return projects.sort((a, b) => a.processName.localeCompare(b.processName));
}

/** A process matches a project by process name or by executable path (the project's bin/ folder). */
export function matchesProject(proc: DotnetProcess, name: string, projectDir?: string): boolean {
  const n = name.toLowerCase();
  if (proc.name.toLowerCase() === n) {
    return true;
  }
  const p = proc.path.toLowerCase();
  if (path.basename(p).replace(/\.(exe|dll)$/i, '') === n) {
    return true;
  }
  // `dotnet MyApp.dll` → the process name is "dotnet", but the command line contains the dll
  if (proc.name.toLowerCase() === 'dotnet' && new RegExp(`(^|[\\\\/ "])${escapeRegex(n)}\\.dll\\b`, 'i').test(proc.commandLine)) {
    return true;
  }
  return !!projectDir && p.startsWith(path.join(projectDir, 'bin').toLowerCase());
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function projectsMatching(proc: DotnetProcess, projects: WorkspaceProject[]): WorkspaceProject | undefined {
  return projects.find((pr) => matchesProject(proc, pr.processName, path.dirname(pr.csproj.fsPath)));
}
