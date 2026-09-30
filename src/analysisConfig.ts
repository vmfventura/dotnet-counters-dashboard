import * as vscode from 'vscode';
import { DEFAULT_THRESHOLDS, Thresholds } from '../media/sessionAnalysis';

export function analysisThresholds(): Thresholds {
  const cfg = vscode.workspace.getConfiguration('dotnetCounters');
  return {
    hotspotCpuPercent: cfg.get<number>('hotspotCpuPercent', DEFAULT_THRESHOLDS.hotspotCpuPercent),
    freezeGcPausePercent: cfg.get<number>('freezeGcPausePercent', DEFAULT_THRESHOLDS.freezeGcPausePercent),
    freezeLockContentionsPerSecond: cfg.get<number>('freezeLockContentionsPerSecond', DEFAULT_THRESHOLDS.freezeLockContentionsPerSecond),
    highGcCollectionsPerSecond: cfg.get<number>('highGcCollectionsPerSecond', DEFAULT_THRESHOLDS.highGcCollectionsPerSecond),
  };
}
