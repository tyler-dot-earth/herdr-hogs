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

Install from GitHub (also how the [marketplace](https://herdr.dev/plugins/) finds this repo — topic `herdr-plugin`):

```
herdr plugin install tyler-dot-earth/herdr-hogs
```

Or link a local checkout with `herdr plugin link /path/to/herdr-hogs`. Actions: `herdr-hogs.open`, `herdr-hogs.mark-start`, `herdr-hogs.mark-stop`.

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

Its workspace gets the same three tokens via `workspace.report_metadata`, summed over that workspace's hot panes:

| token | example |
| --- | --- |
| `hogs` | `🐖` or `🐖×2` |
| `hogs_cpu` | `329%` |
| `hogs_mem` | `3.7G` |

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

The tokens are always visible in `herdr pane get <id>` / `herdr workspace get <id>`, but the sidebar only draws custom tokens that are named in its rows. Add `$hogs`, `$hogs_cpu`, and `$hogs_mem` to both `ui.sidebar.agents.rows` and `ui.sidebar.spaces.rows` in Herdr's `config.toml`. Unreported tokens and their separators disappear, so cool panes look exactly as before. The plugin never edits `config.toml`.

Three common row layouts:

#### `own-line` (hog metrics on their own row)

```toml
[ui.sidebar.agents]
rows = [
  ["state_icon", "machine", "workspace", "tab"],
  ["agent"],
  ["$hogs", "$hogs_cpu", "$hogs_mem"],
]

[ui.sidebar.spaces]
rows = [
  ["state_icon", "workspace"],
  ["branch", "git_status"],
  ["$hogs", "$hogs_cpu", "$hogs_mem"],
]
```

**spaces**
```
• notifications-idea
  main *
  🐖 412% 2.1G
```

**agents**
```
● local  notifications-idea  1
  codex
  🐖 412% 2.1G
```

#### `end` (pig on the title row, metrics beside the agent / after the workspace)

```toml
[ui.sidebar.agents]
rows = [
  ["state_icon", "machine", "workspace", "tab", "$hogs"],
  ["agent", "$hogs_cpu", "$hogs_mem"],
]

[ui.sidebar.spaces]
rows = [
  ["state_icon", "workspace", "$hogs", "$hogs_cpu", "$hogs_mem"],
  ["branch", "git_status"],
]
```

**spaces**
```
• notifications-idea  🐖 412% 2.1G
  main *
```

**agents**
```
● local  notifications-idea  1  🐖
  codex  412% 2.1G
```

#### `first` (metrics lead the row)

```toml
[ui.sidebar.agents]
rows = [
  ["$hogs", "state_icon", "machine", "workspace", "tab"],
  ["agent", "$hogs_cpu", "$hogs_mem"],
]

[ui.sidebar.spaces]
rows = [
  ["$hogs", "$hogs_cpu", "$hogs_mem", "state_icon", "workspace"],
  ["branch", "git_status"],
]
```

**spaces**
```
🐖 412% 2.1G  • notifications-idea
  main *
```

**agents**
```
🐖  ● local  notifications-idea  1
  codex  412% 2.1G
```

A workspace with two hot panes shows `🐖×2` instead of `🐖`, with CPU and mem summed across those hot panes.
