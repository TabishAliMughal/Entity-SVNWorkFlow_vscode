# Entity-SVNWorkflow for VS Code

SVN workflows inside VS Code, powered by the `svn.exe` command line client that ships with TortoiseSVN. It brings the day-to-day SVN features of Zend Studio and TortoiseSVN into the editor: a dedicated SVN sidebar, side-by-side compare with per-hunk pull, blame, history, conflict resolution, merge, branches/tags and more.

## Features

- **SVN pane**: Outgoing / Incoming / All changes for the working copy of the open folder, shown as `<file> (last committer)`, grouped by changelist, with a conflicts group, tree or list view and status bar counts.
- **Zero setup**: works on the working copy of the folder you open (found automatically, nothing registered or saved); credentials and certificate trust are remembered per server, passwords in VS Code's secret storage; checkout offers to open the new folder.
- **Override and Update / Override and Commit**: replace local changes with the server version, or server changes with yours, with a verified local backup you can restore.
- **Compare and pull**: side-by-side compare of your file with the incoming (or any) revision; pull a single change block with one click. The local side is editable.
- **Blame and history**: per-line author annotations in the gutter (toggle per editor), history with author/message/path/date filters, per-revision diff, update to or revert to a revision.
- **Conflicts**: 3-way merge editor (mine | result | theirs), quick resolve for many files, tree and property conflicts.
- **Everyday SVN**: add, ignore, update, commit dialog with changelists, revert, cleanup, switch, relocate, sparse checkout (depth), delete/rename/move/copy (also from Explorer renames), locks, properties and externals.
- **Merge and branching**: sync merge, cherry-pick, reintegrate, merge info, create/list/delete branches and tags, export.
- **More**: unified diff export, patch create/apply, shelving, command log with masked passwords, credential and certificate management.

## Requirements

- VS Code 1.85 or newer (Windows).
- TortoiseSVN with the **command line client tools** installed (provides `svn.exe`), or set `svnWorkflow.svnPath` to an existing `svn.exe`.

## Install

- **Marketplace**: search for "Entity-SVNWorkflow" (`TabishAliMughal.Entity-SVNWorkflow`) in the Extensions view.
- **From a .vsix**: download `Entity-SVNWorkflow-<version>.vsix` from the GitHub release, then run `code --install-extension Entity-SVNWorkflow-<version>.vsix` or use Extensions view -> `...` -> Install from VSIX.

## Quick start

1. Open a folder that is, or is inside, an SVN working copy. The extension finds it automatically (or use **SVN: Checkout** and open the folder it offers).
2. For a repository that needs a login, run **SVN: Set Repository Username and Password**.
3. Open the **SVN** icon in the Activity Bar to see outgoing and incoming changes.
4. Right-click a file or folder (Explorer, editor, or the SVN pane) for the **SVN** menu: update, commit, compare, blame, history, revert and the rest. All commands are also in the Command Palette under the `SVN:` prefix.

## Configuration highlights

| Setting | Purpose |
| --- | --- |
| `svnWorkflow.svnPath` | Full path to `svn.exe`; empty means auto-detect. |
| `svnWorkflow.incomingCheckIntervalSeconds` | How often to check the server for incoming changes (0 disables). |
| `svnWorkflow.overrideBackupsToKeep` | How many Override and Commit backups to keep. |
| `svnWorkflow.explorerFileOps` | Record Explorer renames/deletes as `svn move` / `svn delete` (ask, auto, off). |
| `svnWorkflow.shelve.mode` | Shelving backend: auto, native or patch. |
| `svnWorkflow.layout.*` | Trunk / branches / tags layout used by merge and branch pickers. |
| `svnWorkflow.commandLog.verbosity` | What the "SVN Commands" output channel records. |

Open Settings and search for "SVN" for the full list.

## Source and issues

https://github.com/TabishAliMughal/Entity-SVNWorkFlow_vscode (report problems under Issues).

## Security

SVN operations are disabled in untrusted workspaces. Passwords are passed to `svn` on stdin and are never written to the command line, settings or logs. Self-signed https certificates must be confirmed and are pinned by fingerprint.

## Development

```
npm install
npm run build          # typecheck + bundle with esbuild (npm run watch while developing)
npm run lint
npm test               # unit tests (vitest)
npm run test:svn       # live tests against local svn servers (see test-env/)
npm run test:integration   # end-to-end tests inside a VS Code host
npm run package        # lint + production build + .vsix
```

Press F5 ("Run Extension") to start an Extension Development Host. The local SVN test servers are managed with `python test-env/envctl.py setup` and `reset`.

## Publishing

Every push to `main` runs `.github/workflows/publish.yml`: lint, unit tests, auto-versioned package (patch bump from the latest `v*` tag; set a higher `version` in package.json for minor/major), publish to the VS Code Marketplace via GitHub OIDC, then tag and GitHub release with the `.vsix`. Add `[skip ci]` to a commit message to skip a release. See `docs/packaging.md`.

## License

Proprietary. See `LICENSE`.
