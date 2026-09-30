# Contributing

Thank you for your interest in improving .NET Counters Dashboard.

## Prerequisites

- [Node.js](https://nodejs.org/) 20 or later
- [.NET SDK](https://dotnet.microsoft.com/download) 10 or later (for the sample application)
- `dotnet-counters`: `dotnet tool install --global dotnet-counters`
- Visual Studio Code 1.85 or later

## Building and running

```shell
npm install
npm run compile        # or: npm run watch
npm test               # session, export and shared-analysis regression tests
```

Open the folder in VS Code and press F5 (configuration **Run Extension**) to start an Extension Development Host with the extension loaded.

## Test application

`sample/LoadApp` is a small console application that cycles through workload phases, each one triggering a detection in the dashboard: idle, CPU hotspot, GC pressure, memory growth and lock contention. It is useful to exercise the timeline, the interval analysis and the watched projects feature.

```shell
dotnet run --project sample/LoadApp            # 15 seconds per phase
dotnet run --project sample/LoadApp -- 30      # 30 seconds per phase
```

The current phase is printed to the console. Press Ctrl+C to stop.

## Packaging

```shell
npm run package        # local build: dotnet-counters-dashboard-<version>-local.vsix
```

Each local build increments the patch version in `package.json` and `package-lock.json`, without creating a Git commit or tag. The VSIX filename ends in `-local`; the extension manifest uses the new numeric version. CI and Marketplace release builds keep the configured version.

Install a local build with:

```shell
code --install-extension dotnet-counters-dashboard-<version>-local.vsix --force
```

Reload the VS Code window after installing, so the new version replaces the one already loaded.

## Continuous integration

`.github/workflows/ci.yml` compiles the extension, runs regression tests, builds the sample application and packages the `.vsix` on every push to `main` and on every pull request. The package is available as a build artifact.

## Publishing to the Visual Studio Marketplace

Releases are published automatically by `.github/workflows/release.yml` when a version tag is pushed.

### One-time setup

1. Create a publisher at <https://marketplace.visualstudio.com/manage> and set its ID in the `publisher` field of `package.json`.
2. Create a personal access token in Azure DevOps (<https://dev.azure.com>, **User settings > Personal access tokens**) with **Organization: All accessible organizations** and the **Marketplace (Manage)** scope.
3. In the GitHub repository, open **Settings > Environments**, create an environment named `marketplace`, and add the token as an environment secret named `VSCE_PAT`. Optionally, add required reviewers to the environment so each release must be approved.
4. Optionally, add the repository to `package.json`, so the Marketplace page links to it:

   ```json
   "repository": { "type": "git", "url": "https://github.com/<owner>/<repo>.git" },
   "bugs": { "url": "https://github.com/<owner>/<repo>/issues" },
   "homepage": "https://github.com/<owner>/<repo>#readme"
   ```

### Releasing a version

1. Update `version` in `package.json` and add an entry to `CHANGELOG.md`.
2. Commit, then create and push a tag that matches the version:

   ```shell
   git tag v0.1.0
   git push origin v0.1.0
   ```

The workflow checks that the tag matches `package.json`, packages the extension with README images and links pointing to that tag, publishes it to the Marketplace, and creates a GitHub release with the `.vsix` attached. If the `VSCE_PAT` secret is not configured, the Marketplace step is skipped: upload the `.vsix` from the GitHub release at <https://marketplace.visualstudio.com/manage> instead. The `images/` folder is excluded from the package, so it must be committed to the repository.

To publish manually instead, sign in with `npx vsce login <publisher-id>` and run `npm run publish` (this requires the `repository` field), or upload the `.vsix` at <https://marketplace.visualstudio.com/manage>.

## README images

The screenshots and the animated demo in `images/` are used by the README and the Marketplace page. Update them after visible UI changes, so both stay accurate. Keep the file names, or update the references in `README.md`.

## Project structure

| Path | Purpose |
|---|---|
| `src/extension.ts` | Activation, commands, views and status bar. |
| `src/countersCli.ts` | Runs `dotnet-counters ps` and `collect`, and reads the CSV output. |
| `src/metrics.ts` | Normalizes counters from both runtime generations into dashboard metrics. |
| `src/session.ts` | Monitoring sessions and exports. |
| `src/importer.ts` | Import of raw CSV, normalized CSV and JSON files. |
| `src/watcher.ts` | Watched projects: persistence, polling and automatic attach. |
| `src/processInfo.ts` | Process start time lookup. |
| `src/projectResolver.ts` | Matching processes to workspace projects. |
| `src/dashboardPanel.ts` | Webview panel and its messages. |
| `media/dashboard.js`, `media/dashboard.css` | Dashboard user interface (timeline, analysis, charts). |
| `.github/workflows/` | Continuous integration and release automation. |

## Guidelines

- Keep the dashboard free of external runtime dependencies; charts are drawn on canvas.
- The webview uses a strict Content Security Policy: do not use inline `style` attributes or inline scripts.
- Keep user-facing text in English.
- Describe user-visible changes in `CHANGELOG.md`.
