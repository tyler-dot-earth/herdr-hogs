# Hogs 🐖 which herdr panes are hogging the machine

Live CPU and memory per [herdr](https://herdr.dev) pane, summed over each pane's process tree. Find the hog, close the pane.

- `node hogs.mjs` interactive view (the plugin pane)
- `node hogs.mjs print` one table on stdout, for scripts and agents
- `node hogs.mjs open` opens the plugin pane as a popup (the plugin action)

Linux only (reads `/proc`). Memory is RSS, so memory shared between processes counts twice. Runs `node` from your PATH.

Install locally with `herdr plugin link /path/to/herdr-hogs`. The plugin action is `herdr-hogs.open`.
