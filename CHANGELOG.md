# Changelog

All notable changes to this extension are documented in this file.

## 0.1.0

Initial release.

- Live monitoring of .NET processes through `dotnet-counters`.
- Session timeline with CPU, GC and memory lanes, and detection of performance hotspots, possible freezes and high GC activity.
- Time-interval selection and analysis with automatic findings and a summary.
- Detailed charts, stat tiles and a table with every counter.
- Discovery of workspace projects and waiting for their process to start.
- Watched projects, saved per workspace, with automatic attach on every run.
- Process uptime in the process list, dashboard and status bar.
- Export to normalized CSV, JSON, raw CSV and PNG, optionally limited to a time interval.
- Import of exported files and of CSV files recorded with `dotnet-counters`.
- Light, dark and automatic themes.
