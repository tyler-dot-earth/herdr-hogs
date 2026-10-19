# Hogs 🐖 which herdr panes are hogging the machine

Live CPU and memory per [herdr](https://herdr.dev) pane, summed over each pane's process tree. Find the hog, close the pane.

- `node hogs.mjs` interactive view (the plugin pane)
- `node hogs.mjs print` one table on stdout, for scripts and agents
- `node hogs.mjs open` opens the plugin pane as a popup (the plugin action)
- `node hogs.mjs mark` polls forever and puts a 🐖 on hot panes and their workspaces (foreground)
- `node hogs.mjs mark-once` one measurement, report the markers, print what is hot, exit
- `node hogs.mjs mark-start` starts `mark` detached, replacing any previous one (the startup hook)
- `node hogs.mjs mark-stop` stops the detached `mark`; it clears its markers on the way out

Linux only (reads `/proc`). Memory is RSS, so memory shared between processes counts twice. Runs `node` from your PATH.

Install locally with `herdr plugin link /path/to/herdr-hogs`. Actions: `herdr-hogs.open`, `herdr-hogs.mark-start`, `herdr-hogs.mark-stop`.

## Sidebar markers

Every refresh, a pane is hot when its process tree uses

- CPU ≥ **80%** (100 = one core, same units as the table), or
- RSS ≥ **1.5 GiB**.

A hot pane gets display-only pane tokens via `pane.report_metadata` (source `herdr-hogs`):

| token | example |
| --- | --- |
| `hogs` | `🐖` |
| `hogs_cpu` | `329%` |
| `hogs_mem` | `3.7G` |

Its workspace gets `hogs` = `🐖` (one hot pane) or `🐖×2` (count of hot panes) via `workspace.report_metadata`.

Tokens are cleared as soon as a pane cools down. Every report also carries a TTL (3× the refresh, 6 s by default) and a `seq`, so if the marker dies the pigs vanish on their own and a stale report never overwrites a newer one. Nothing is renamed and no toasts are sent.

Overrides (environment of the `mark` process):

| variable | default |
| --- | --- |
| `HOGS_CPU_PCT` | `80` |
| `HOGS_MEM_BYTES` | 1.5 GiB (`1610612736`) |
| `HOGS_MEM_GIB` | `1.5` (used when `HOGS_MEM_BYTES` is unset) |
| `HOGS_REFRESH_MS` | `2000` (also the interactive view's refresh) |
| `HOGS_TTL_MS` | 3 × refresh |

### The marker daemon

Herdr startup hooks are one-shot, so `[[startup]]` runs `mark-start`, which spawns `node hogs.mjs mark` in its own session and exits. The pid is in `$HERDR_PLUGIN_STATE_DIR/mark.pid`, the log in `$HERDR_PLUGIN_STATE_DIR/mark.log` (on this machine `~/.local/state/herdr/plugins/herdr-hogs/`; running `mark-start`/`mark-stop` by hand outside Herdr falls back to the same directory). A new `mark-start` (next server start, live handoff, or the action) kills the previous marker first; a marker that finds a different live marker in the pid file exits; a marker whose socket disappears exits. Startup hooks do not run on `herdr plugin link`, so after changing the code run `herdr plugin action invoke herdr-hogs.mark-start`.

### Showing the pig

The tokens are always visible in `herdr pane get <id>` / `herdr workspace get <id>`, but the sidebar only draws custom tokens that are named in its rows. Add `$hogs` (and optionally `$hogs_cpu`, `$hogs_mem`) to `ui.sidebar.agents.rows` and `$hogs` to `ui.sidebar.spaces.rows` in Herdr's `config.toml`. Starting from the defaults:

```toml
[ui.sidebar.agents]
rows = [
  ["state_icon", "machine", "workspace", "tab", "$hogs"],
  ["agent", "$hogs_cpu", "$hogs_mem"],
]

[ui.sidebar.spaces]
rows = [
  ["state_icon", "workspace", "$hogs"],
  ["branch", "git_status"],
]
```

The plugin never edits `config.toml`. Unreported tokens and their separators disappear, so cool panes look exactly as before.
