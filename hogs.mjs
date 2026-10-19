#!/usr/bin/env node
// Herdr plugin: CPU and memory per pane, summed over each pane's process tree.
//
//   node hogs.mjs          interactive view (the plugin pane)
//   node hogs.mjs print    one table on stdout, for scripts and agents
//   node hogs.mjs open     open the plugin pane as a popup (the plugin action)
//   node hogs.mjs mark        poll forever, tagging hot panes and workspaces with a 🐖 token
//   node hogs.mjs mark-once   one measurement, report tokens, exit (for testing)
//   node hogs.mjs mark-start  start `mark` detached, replacing any previous one (startup hook)
//   node hogs.mjs mark-stop   stop the detached `mark` loop; it clears its tokens
//
// A process belongs to the pane whose shell it descends from. A process that
// left that tree (a daemon reparented to init) is matched by the HERDR_PANE_ID
// it inherited, when that names a live pane of this server.
//
// CPU% is top-style: 100 is one core, measured between two /proc samples.
// MEM is resident set size, so memory shared between processes counts twice.

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const SOCKET = process.env.HERDR_SOCKET_PATH;
const PLUGIN_ID = process.env.HERDR_PLUGIN_ID ?? "herdr-hogs";
const envNum = (name, fallback) => {
  const v = Number(process.env[name]);
  return process.env[name] && Number.isFinite(v) && v > 0 ? v : fallback;
};
const GIB = 1024 ** 3;
const REFRESH_MS = envNum("HOGS_REFRESH_MS", 2000);
// Marker thresholds. CPU uses the same units as the table: 100 = one core.
const CPU_PCT = envNum("HOGS_CPU_PCT", 80);
const MEM_BYTES = envNum("HOGS_MEM_BYTES", envNum("HOGS_MEM_GIB", 1.5) * GIB);
// Tokens expire on their own if the marker dies, so no stale pig outlives it.
const TTL_MS = Math.round(envNum("HOGS_TTL_MS", REFRESH_MS * 3));
const SOURCE = "herdr-hogs";
const STATE_DIR = process.env.HERDR_PLUGIN_STATE_DIR ?? path.join(os.homedir(), ".local/state/herdr/plugins", PLUGIN_ID);
const PID_FILE = path.join(STATE_DIR, "mark.pid");
const LOG_FILE = path.join(STATE_DIR, "mark.log");
const DETAIL_ROWS = 8;
const CLK_TCK = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }));
const PAGE_SIZE = Number(execFileSync("getconf", ["PAGESIZE"], { encoding: "utf8" }));

// The socket answers one request per connection.
function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(SOCKET);
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("connect", () => sock.write(`${JSON.stringify({ id: method, method, params })}\n`));
    sock.on("data", (chunk) => {
      buf += chunk;
      const end = buf.indexOf("\n");
      if (end < 0) return;
      sock.destroy();
      const msg = JSON.parse(buf.slice(0, end));
      if (msg.error) reject(new Error(`${method}: ${msg.error.code}: ${msg.error.message}`));
      else resolve(msg.result);
    });
    sock.on("error", reject);
    sock.on("close", () => reject(new Error(`${method}: no response`)));
  });
}

function readProcs() {
  const procs = new Map();
  for (const name of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    let stat;
    try {
      stat = fs.readFileSync(`/proc/${name}/stat`, "utf8");
    } catch {
      continue; // exited since readdir
    }
    // comm may contain spaces and parens; the numeric fields follow the last ")".
    const close = stat.lastIndexOf(")");
    const f = stat.slice(close + 2).split(" ");
    const pid = Number(name);
    procs.set(pid, {
      pid,
      comm: stat.slice(stat.indexOf("(") + 1, close),
      ppid: Number(f[1]),
      ticks: Number(f[11]) + Number(f[12]),
      start: f[19],
      rss: Number(f[21]) * PAGE_SIZE,
    });
  }
  return procs;
}

// "pid:starttime" -> { pane, socket } | null. A process's initial environment never changes.
const herdrEnvCache = new Map();

function herdrEnv(proc) {
  const key = `${proc.pid}:${proc.start}`;
  if (!herdrEnvCache.has(key)) {
    let env = null;
    try {
      const vars = fs.readFileSync(`/proc/${proc.pid}/environ`, "utf8").split("\0");
      const get = (name) => vars.find((v) => v.startsWith(`${name}=`))?.slice(name.length + 1);
      const pane = get("HERDR_PANE_ID");
      if (pane) env = { pane, socket: get("HERDR_SOCKET_PATH") };
    } catch {} // another user's process, or exited
    herdrEnvCache.set(key, env);
  }
  return herdrEnvCache.get(key);
}

// "pane_id:terminal_id" -> shell pid. A terminal keeps its shell for life, so only new panes are asked.
const shellPids = new Map();

async function sample() {
  const { snapshot } = await call("session.snapshot");
  const keys = new Map(snapshot.panes.map((pane) => [`${pane.pane_id}:${pane.terminal_id}`, pane.pane_id]));
  await Promise.all(
    [...keys].filter(([key]) => !shellPids.has(key)).map(([key, pane_id]) =>
      call("pane.process_info", { pane_id }).then(
        (result) => shellPids.set(key, result.process_info.shell_pid),
        () => {}, // closed since the snapshot
      ),
    ),
  );
  const procs = readProcs();
  const shells = new Map();
  for (const [key, pid] of shellPids) {
    if (keys.has(key) && procs.has(pid)) shells.set(pid, keys.get(key));
    else shellPids.delete(key);
  }
  for (const key of herdrEnvCache.keys()) {
    const [pid, start] = key.split(":");
    if (procs.get(Number(pid))?.start !== start) herdrEnvCache.delete(key);
  }
  return { snapshot, shells, procs, at: performance.now() };
}

function measure(prev, cur) {
  const seconds = (cur.at - prev.at) / 1000;
  const { snapshot, procs, shells: shellPane } = cur;
  const serverPid = procs.get(shellPane.keys().next().value)?.ppid;
  const livePanes = new Set(snapshot.panes.map((p) => p.pane_id));

  for (const proc of procs.values()) {
    const before = prev.procs.get(proc.pid);
    // A pid absent from the previous sample, or reused, started within the interval.
    const base = before?.start === proc.start ? before.ticks : 0;
    proc.cpu = ((proc.ticks - base) / CLK_TCK / seconds) * 100;
  }

  const owner = new Map();
  const ownerOf = (pid) => {
    if (owner.has(pid)) return owner.get(pid);
    const proc = procs.get(pid);
    let pane = shellPane.get(pid) ?? null;
    if (!pane && proc && pid !== serverPid && proc.ppid > 0) {
      pane = ownerOf(proc.ppid);
      const env = pane ? null : herdrEnv(proc);
      if (env?.socket === SOCKET && livePanes.has(env.pane)) pane = env.pane;
    }
    owner.set(pid, pane);
    return pane;
  };

  const workspaces = new Map(snapshot.workspaces.map((w) => [w.workspace_id, w]));
  const tabs = new Map(snapshot.tabs.map((t) => [t.tab_id, t]));
  const agentNames = new Map(snapshot.agents.filter((a) => a.name).map((a) => [a.pane_id, a.name]));
  const rows = new Map(
    snapshot.panes.map((pane) => {
      const ws = workspaces.get(pane.workspace_id);
      const tab = tabs.get(pane.tab_id);
      const where = `${ws?.label ?? pane.workspace_id}${ws?.tab_count > 1 ? `/${tab?.label}` : ""}`;
      return [
        pane.pane_id,
        {
          id: pane.pane_id,
          where,
          agent: agentNames.get(pane.pane_id) ?? pane.agent ?? "",
          title: pane.label ?? pane.terminal_title_stripped ?? "",
          cpu: 0,
          rss: 0,
          procs: [],
        },
      ];
    }),
  );
  const herdr = { cpu: 0, rss: 0, count: 0 };
  for (const proc of procs.values()) {
    const row = rows.get(ownerOf(proc.pid));
    const total = row ?? (proc.pid === serverPid || proc.comm === "herdr" ? herdr : null);
    if (!total) continue;
    total.cpu += proc.cpu;
    total.rss += proc.rss;
    if (row) row.procs.push(proc);
    else herdr.count++;
  }
  for (const row of rows.values()) row.procs.sort(byUsage("cpu"));
  return { rows: [...rows.values()], herdr };
}

const byUsage = (key) => {
  const other = key === "cpu" ? "rss" : "cpu";
  return (a, b) => b[key] - a[key] || b[other] - a[other];
};

// Nix wrappers exec the real binary as ".name-wrapped".
const unwrapped = (name) => name.replace(/^\.(.+)-wrapped$/, "$1");

function command(proc) {
  try {
    const argv = fs.readFileSync(`/proc/${proc.pid}/cmdline`, "utf8").split("\0").filter(Boolean);
    if (argv.length) {
      const [exe, ...args] = argv;
      const short = args.map((arg) => (arg.startsWith("/") ? path.basename(arg) : arg));
      return [unwrapped(path.basename(exe)), ...short].join(" ");
    }
  } catch {} // exited
  return proc.comm;
}

function bytes(n) {
  const units = ["B", "K", "M", "G", "T"];
  let i = 0;
  for (; n >= 1024 && i < units.length - 1; i++) n /= 1024;
  return `${i > 0 && n < 10 ? n.toFixed(1) : n.toFixed(0)}${units[i]}`;
}

function fit(text, width) {
  if (width <= 0) return "";
  const flat = text.replace(/[\x00-\x1f\x7f]+/g, " ");
  return flat.length > width ? `${flat.slice(0, width - 1)}…` : flat.padEnd(width);
}

function columns([cpu, mem, procs, where, agent, title, heaviest], width) {
  const left = `${cpu.padStart(6)} ${mem.padStart(6)} ${procs.padStart(5)}  ${fit(where, 16)} ${fit(agent, 10)} `;
  const rest = Math.max(0, width - left.length);
  const titleWidth = Math.floor(rest * 0.4);
  return `${left}${fit(title, titleWidth)} ${fit(heaviest, rest - titleWidth - 1)}`.slice(0, width);
}

const HEADER = ["CPU%", "MEM", "PROCS", "WHERE", "AGENT", "TITLE", "HEAVIEST PROCESS"];

function rowLine(row, width) {
  const top = row.procs[0];
  const heaviest = top ? `${top.cpu.toFixed(1).padStart(5)}% ${command(top)}` : "";
  return columns(
    [row.cpu.toFixed(1), bytes(row.rss), String(row.procs.length), row.where, row.agent, row.title, heaviest],
    width,
  );
}

function detailLine(proc, width) {
  const line = `${proc.cpu.toFixed(1).padStart(6)} ${bytes(proc.rss).padStart(6)}   └ ${String(proc.pid).padEnd(8)} ${command(proc)}`;
  return fit(line, width);
}

function summary(view) {
  const inPanes = view.rows.reduce((n, row) => n + row.procs.length, 0);
  const { herdr } = view;
  const used = os.totalmem() - os.freemem();
  return [
    `Herdr hogs 🐖 · ${view.rows.length} panes · ${inPanes} processes · CPU% where 100 = one core`,
    `herdr server+clients ${herdr.cpu.toFixed(1)}% ${bytes(herdr.rss)} (${herdr.count} procs) · ` +
      `load ${os.loadavg()[0].toFixed(2)} on ${os.availableParallelism()} cores · ` +
      `memory ${bytes(used)} of ${bytes(os.totalmem())} in use`,
  ];
}

async function runPrint() {
  const first = await sample();
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const view = measure(first, await sample());
  const width = process.stdout.columns ?? 200;
  const rows = view.rows.sort(byUsage("cpu")).map((row) => rowLine(row, width));
  process.stdout.write(`${[...summary(view), "", columns(HEADER, width), ...rows].join("\n")}\n`);
}

const style = (code, text) => `\x1b[${code}m${text}\x1b[0m`;

async function runInteractive() {
  const ui = { view: null, error: null, sort: "cpu", selected: null, expanded: null, order: [], scroll: 0 };
  let timer;

  const render = () => {
    const width = process.stdout.columns ?? 120;
    const height = process.stdout.rows ?? 40;
    const lines = [];
    if (ui.view) {
      const rows = [...ui.view.rows].sort(byUsage(ui.sort));
      ui.order = rows.map((row) => row.id);
      if (!ui.order.includes(ui.selected)) ui.selected = ui.order[0] ?? null;

      lines.push(...summary(ui.view).map((line) => fit(line, width)));
      lines.push(
        style(2, fit(`↑↓ jk select · enter expand · f focus pane · c sort cpu · m sort mem · q quit · sorted by ${ui.sort === "cpu" ? "cpu" : "mem"}`, width)),
        ui.error ? style(31, fit(ui.error, width)) : "",
        style(1, columns(HEADER, width)),
      );

      const body = [];
      let first = 0;
      let last = 0;
      for (const row of rows) {
        const selected = row.id === ui.selected;
        if (selected) first = body.length;
        body.push(selected ? style(7, rowLine(row, width)) : rowLine(row, width));
        if (row.id === ui.expanded) {
          for (const proc of row.procs.slice(0, DETAIL_ROWS)) body.push(style(2, detailLine(proc, width)));
        }
        if (selected) last = body.length - 1;
      }
      const room = Math.max(1, height - lines.length);
      if (last >= ui.scroll + room) ui.scroll = last - room + 1;
      if (first < ui.scroll) ui.scroll = first;
      ui.scroll = Math.max(0, Math.min(ui.scroll, body.length - room));
      lines.push(...body.slice(ui.scroll, ui.scroll + room));
    } else {
      lines.push(ui.error ? style(31, ui.error) : "Sampling…");
    }
    process.stdout.write(`\x1b[H${lines.join("\x1b[K\r\n")}\x1b[K\x1b[J`);
  };

  const quit = () => {
    clearTimeout(timer);
    process.exit(0);
  };

  const move = (delta) => {
    const i = ui.order.indexOf(ui.selected) + delta;
    ui.selected = ui.order[Math.max(0, Math.min(i, ui.order.length - 1))] ?? null;
  };

  const focusSelected = async () => {
    if (!ui.selected) return;
    try {
      await call("pane.focus", { pane_id: ui.selected });
      quit();
    } catch (err) {
      ui.error = err.message;
      render();
    }
  };

  process.on("exit", () => {
    process.stdout.write("\x1b[?7h\x1b[?25h\x1b[?1049l");
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
  });
  // Autowrap off: a title with wide characters overflows its cell count and would scroll the frame.
  process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[?7l");
  process.stdout.on("resize", render);
  process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (key) => {
    switch (key) {
      case "q":
      case "\x1b":
      case "\x03":
        return quit();
      case "f":
        return focusSelected();
      case "j":
      case "\x1b[B":
      case "\x1bOB":
        move(1);
        break;
      case "k":
      case "\x1b[A":
      case "\x1bOA":
        move(-1);
        break;
      case "\r":
      case " ":
        ui.expanded = ui.expanded === ui.selected ? null : ui.selected;
        break;
      case "c":
        ui.sort = "cpu";
        break;
      case "m":
        ui.sort = "rss";
        break;
      default:
        return;
    }
    render();
  });

  render();
  let prev = await sample();
  const tick = async () => {
    try {
      const cur = await sample();
      ui.view = measure(prev, cur);
      ui.error = null;
      prev = cur;
    } catch (err) {
      ui.error = err.message;
    }
    render();
    timer = setTimeout(tick, REFRESH_MS);
  };
  timer = setTimeout(tick, 1000);
}

// ---- sidebar markers -------------------------------------------------------

// Strictly increasing across restarts, so a new marker's reports are never
// ignored as older than a dead one's.
let lastSeq = 0;
const nextSeq = () => (lastSeq = Math.max(lastSeq + 1, Date.now()));

const pct = (cpu) => `${cpu.toFixed(0)}%`;
const isHot = (row) => row.cpu >= CPU_PCT || row.rss >= MEM_BYTES;
const paneTokens = (row) => ({ hogs: "🐖", hogs_cpu: pct(row.cpu), hogs_mem: bytes(row.rss) });
const PANE_CLEAR = { hogs: null, hogs_cpu: null, hogs_mem: null };
const WS_CLEAR = PANE_CLEAR;
const wsToken = (count) => (count === 1 ? "🐖" : `🐖×${count}`);
const wsTokens = (agg) => ({
  hogs: wsToken(agg.count),
  hogs_cpu: pct(agg.cpu),
  hogs_mem: bytes(agg.rss),
});

function report(kind, id, tokens) {
  const params = { [`${kind}_id`]: id, source: SOURCE, tokens, seq: nextSeq() };
  if (Object.values(tokens).some((v) => v !== null)) params.ttl_ms = TTL_MS;
  return call(`${kind}.report_metadata`, params).catch((err) => {
    if (socketGone(err)) throw err;
  }); // otherwise closed since the snapshot
}

// What this process last told Herdr, so it clears what it set promptly
// instead of waiting for the TTL.
const marked = { panes: new Set(), workspaces: new Set() };

async function applyMarks(view, snapshot) {
  const paneWs = new Map(snapshot.panes.map((p) => [p.pane_id, p.workspace_id]));
  const liveWs = new Set(snapshot.workspaces.map((w) => w.workspace_id));
  const hot = view.rows.filter(isHot);
  const hotIds = new Set(hot.map((r) => r.id));
  // Per hot workspace: pig count plus summed CPU/RSS of its hot panes.
  const perWs = new Map();
  for (const row of hot) {
    const ws = paneWs.get(row.id);
    if (!ws) continue;
    const cur = perWs.get(ws) ?? { count: 0, cpu: 0, rss: 0 };
    cur.count++;
    cur.cpu += row.cpu;
    cur.rss += row.rss;
    perWs.set(ws, cur);
  }
  const jobs = [];
  for (const row of hot) jobs.push(report("pane", row.id, paneTokens(row)));
  // Clear panes this process marked, plus any pig another marker left behind.
  const leftovers = snapshot.panes.filter((p) => p.tokens?.hogs).map((p) => p.pane_id);
  for (const id of new Set([...marked.panes, ...leftovers])) {
    if (!hotIds.has(id) && paneWs.has(id)) jobs.push(report("pane", id, PANE_CLEAR));
  }
  for (const [ws, agg] of perWs) jobs.push(report("workspace", ws, wsTokens(agg)));
  const wsLeft = snapshot.workspaces.filter((w) => w.tokens?.hogs).map((w) => w.workspace_id);
  for (const ws of new Set([...marked.workspaces, ...wsLeft])) {
    if (!perWs.has(ws) && liveWs.has(ws)) jobs.push(report("workspace", ws, WS_CLEAR));
  }
  marked.panes = hotIds;
  marked.workspaces = new Set(perWs.keys());
  await Promise.all(jobs);
  return { hot, perWs };
}

async function clearMarks() {
  const jobs = [];
  for (const id of marked.panes) jobs.push(report("pane", id, PANE_CLEAR));
  for (const ws of marked.workspaces) jobs.push(report("workspace", ws, WS_CLEAR));
  marked.panes = new Set();
  marked.workspaces = new Set();
  await Promise.all(jobs);
}

const thresholds = () =>
  `cpu >= ${CPU_PCT}% or mem >= ${bytes(MEM_BYTES)} · refresh ${REFRESH_MS}ms · ttl ${TTL_MS}ms`;

async function runMarkOnce() {
  const first = await sample();
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const cur = await sample();
  const { hot, perWs } = await applyMarks(measure(first, cur), cur.snapshot);
  console.log(`hogs mark-once: ${thresholds()}`);
  for (const row of hot) console.log(`🐖 ${row.id} ${row.where} cpu ${pct(row.cpu)} mem ${bytes(row.rss)}`);
  for (const [ws, agg] of perWs) console.log(`workspace ${ws}: ${wsToken(agg.count)} cpu ${pct(agg.cpu)} mem ${bytes(agg.rss)}`);
  if (!hot.length) console.log("no hogs");
}

function socketGone(err) {
  return ["ENOENT", "ECONNREFUSED", "ENOTSOCK"].includes(err?.code);
}

function readPid() {
  try {
    return Number(fs.readFileSync(PID_FILE, "utf8").trim()) || null;
  } catch {
    return null;
  }
}

// True when pid is alive and is a `hogs.mjs mark` loop, not a reused pid.
function isMarker(pid) {
  try {
    const argv = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
    return argv.some((a) => a.endsWith("hogs.mjs")) && argv.includes("mark");
  } catch {
    return false;
  }
}

async function runMark() {
  const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);
  let stopping = false;
  let timer;
  const stop = async (code, why) => {
    if (stopping) return;
    stopping = true;
    clearTimeout(timer);
    log(`stopping: ${why}`);
    if (why !== "socket gone") await clearMarks().catch(() => {});
    if (readPid() === process.pid) fs.rmSync(PID_FILE, { force: true });
    process.exit(code);
  };
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => stop(0, sig));

  log(`marking: ${thresholds()} · socket ${SOCKET} · pid ${process.pid}`);
  let prev;
  let failures = 0;
  let lastHot = null;
  const tick = async () => {
    // A newer marker took over (startup hook after a handoff): leave quietly.
    const owner = readPid();
    if (owner && owner !== process.pid && isMarker(owner)) return stop(0, `superseded by ${owner}`);
    try {
      const cur = await sample();
      if (prev) {
        const { hot } = await applyMarks(measure(prev, cur), cur.snapshot);
        const now = hot.map((r) => r.id).join(" ");
        if (now !== lastHot) log(hot.length ? `hot: ${now}` : "no hogs");
        lastHot = now;
      }
      prev = cur;
      failures = 0;
    } catch (err) {
      if (socketGone(err)) return stop(0, "socket gone");
      failures++;
      log(`error (${failures}): ${err.message}`);
      if (failures >= 10) return stop(1, "too many errors");
    }
    timer = setTimeout(tick, REFRESH_MS);
  };
  await tick();
}

function stopMarker() {
  const pid = readPid();
  fs.rmSync(PID_FILE, { force: true });
  if (pid && isMarker(pid)) {
    process.kill(pid, "SIGTERM");
    return pid;
  }
  return null;
}

function runMarkStart() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const old = stopMarker();
  const out = fs.openSync(LOG_FILE, "a");
  const child = spawn(process.execPath, [path.join(import.meta.dirname, "hogs.mjs"), "mark"], {
    detached: true, // own session: outlives this one-shot hook
    stdio: ["ignore", out, out],
    cwd: import.meta.dirname,
  });
  fs.writeFileSync(PID_FILE, `${child.pid}\n`);
  child.unref();
  console.log(`hogs: marker pid ${child.pid}${old ? ` (replaced ${old})` : ""} · ${PID_FILE} · log ${LOG_FILE}`);
}

if (!SOCKET) {
  console.error("hogs: HERDR_SOCKET_PATH is not set; run this inside Herdr");
  process.exit(1);
}
const mode = process.argv[2];
if (mode === "print") await runPrint();
else if (mode === "open") await call("plugin.pane.open", { plugin_id: PLUGIN_ID, entrypoint: "hogs" });
else if (mode === "mark") await runMark();
else if (mode === "mark-once") await runMarkOnce();
else if (mode === "mark-start") runMarkStart();
else if (mode === "mark-stop") {
  const pid = stopMarker();
  console.log(pid ? `hogs: stopped marker ${pid}` : "hogs: no marker running");
} else await runInteractive();
