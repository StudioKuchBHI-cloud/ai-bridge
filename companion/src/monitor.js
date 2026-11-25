'use strict';
// AI Bridge monitor: a tiny local web page (the "desk widget") plus a tray icon that tell the person whether the bridge works,
// restart it in one press, and show how much CPU and memory the AI Bridge programs use. Windows only for the parts that need Windows.
// It runs as its own process so it still works while the bridge is stopped.
const cp = require('child_process'), fs = require('fs'), path = require('path'), http = require('http'), crypto = require('crypto'), os = require('os');

const HISTORY_MAX = 100; // 100 samples of 3 seconds = the last 5 minutes
const MONITOR_PORTS = [3060, 3061, 3062, 3063, 3064, 3065, 3066, 3067, 3068, 3069];

const SYS = path.join(process.env.SystemRoot || 'C:\Windows', 'System32');
const PS_EXE = process.platform === 'win32' && fs.existsSync(path.join(SYS, 'WindowsPowerShell', 'v1.0', 'powershell.exe')) ? path.join(SYS, 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell';
const sysExe = (n) => process.platform === 'win32' && fs.existsSync(path.join(SYS, n + '.exe')) ? path.join(SYS, n + '.exe') : n;
function execP(file, args, timeout) {
  return new Promise((resolve) => { cp.execFile(file, args, { windowsHide: true, timeout: timeout || 8000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve({ err, stdout: String(stdout || '') })); });
}

// All AI Bridge programs that are running for this person: [{ pid, role, mb, cpuTime, cmd }]
// Only programs started from THIS install (the installed exe, or the exe the caller runs from) count: another folder's AI Bridge is never listed or stopped.
const samePath = (a, b) => !!a && !!b && path.resolve(String(a)).toLowerCase() === path.resolve(String(b)).toLowerCase();
async function listProcs(ctx) {
  if (process.platform !== 'win32') return [];
  const ps = "Get-CimInstance Win32_Process -Filter \"Name='ai-bridge.exe'\" | Select-Object ProcessId,ExecutablePath,CommandLine,WorkingSetSize,KernelModeTime,UserModeTime | ConvertTo-Json -Compress";
  const r = await execP(PS_EXE, ['-NoProfile', '-NonInteractive', '-Command', ps]);
  let j; try { j = JSON.parse(r.stdout.trim() || '[]'); } catch (e) { return []; }
  if (!Array.isArray(j)) j = [j];
  return j.filter(p => p && (!ctx || samePath(p.ExecutablePath, ctx.INSTALLED_EXE) || samePath(p.ExecutablePath, process.execPath))).map(p => {
    const cmd = String(p.CommandLine || '');
    const args = cmd.replace(/^\s*("[^"]*"|\S+)\s*/, '');
    const role = /^serve\b/.test(args) ? 'bridge' : /^mcp\b/.test(args) ? 'agent' : /^monitor\b/.test(args) ? 'monitor' : 'other';
    return { pid: p.ProcessId, role, mb: Math.round((p.WorkingSetSize || 0) / 1048576), cpuTime: (Number(p.KernelModeTime) || 0) + (Number(p.UserModeTime) || 0), cmd };
  });
}

// Which program listens on each of the given ports: Map port -> pid
async function portHolders(ports) {
  const m = new Map();
  if (process.platform !== 'win32') return m;
  const r = await execP(sysExe('netstat'), ['-ano', '-p', 'tcp']);
  for (const line of r.stdout.split(/\r?\n/)) {
    const f = line.trim().split(/\s+/);
    if (f.length >= 5 && /LISTEN/i.test(f[3])) { const mm = /:(\d+)$/.exec(f[1]); if (mm && ports.includes(Number(mm[1]))) m.set(Number(mm[1]), Number(f[4])); }
  }
  return m;
}

async function procName(pid) {
  const r = await execP(sysExe('tasklist'), ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH']);
  const mm = /^"([^"]+)"/.exec(r.stdout.trim()); return mm ? mm[1] : 'another program';
}

async function killPid(pid) { const r = await execP(sysExe('taskkill'), ['/PID', String(pid), '/F']); return !r.err; }

// Ports we use and who holds each: free, our own bridge, or another program (named).
async function portReport(ctx, procs) {
  const holders = await portHolders(ctx.PORTS);
  const out = [];
  for (const port of ctx.PORTS) {
    const pid = holders.get(port);
    if (!pid) { out.push({ port, state: 'free' }); continue; }
    const mine = procs.find(p => p.pid === pid);
    out.push(mine ? { port, state: 'bridge', pid, role: mine.role } : { port, state: 'other', pid, holder: await procName(pid) });
  }
  return out;
}

// Stop the bridge program(s) that hold our ports (and the one in bridge.json), then start one fresh bridge. The token stays.
// everything:true also ends the agents' connections (ai-bridge mcp). Other programs are never touched.
async function restart(ctx, opts) {
  opts = opts || {};
  const procs = await listProcs(ctx);
  const holders = await portHolders(ctx.PORTS);
  const reg = ctx.readReg();
  const target = new Set();
  for (const p of procs) {
    if (p.pid === process.pid) continue;
    if (p.role === 'bridge' && ([...holders.values()].includes(p.pid) || (reg && reg.pid === p.pid))) target.add(p.pid); // only copies that hold our ports or are registered
    if (opts.everything && p.role === 'agent') target.add(p.pid);
  }
  const killed = [], failed = [];
  for (const pid of target) { (await killPid(pid)) ? killed.push(pid) : failed.push(pid); }
  const mine = new Set(killed);
  for (let i = 0; i < 20; i++) { // wait until the killed programs have let go of the ports
    const h = await portHolders(ctx.PORTS);
    if (![...h.values()].some(pid => mine.has(pid))) break;
    await ctx.sleep(250);
  }
  const blockers = [];
  const h2 = await portHolders(ctx.PORTS);
  for (const [port, pid] of h2) blockers.push({ port, pid, holder: await procName(pid) });
  let run = null;
  if (!opts.noStart) {
    try { cp.spawn(fs.existsSync(ctx.INSTALLED_EXE) ? ctx.INSTALLED_EXE : process.execPath, ['serve'], { detached: true, stdio: 'ignore', windowsHide: true, env: process.env }).unref(); } catch (e) {}
    for (let i = 0; i < 30 && !run; i++) { await ctx.sleep(300); run = await ctx.findRunning(); }
  }
  return { ok: !!run || !!opts.noStart, port: run ? run.port : null, killed, failed, blockers, message: run ? 'AI Bridge restarted on port ' + run.port + '.' : opts.noStart ? 'Stopped.' : 'AI Bridge did not start. ' + (blockers.length ? 'Port ' + blockers[0].port + ' is held by ' + blockers[0].holder + '.' : 'Try again, or open AI Bridge from the Start menu.') };
}

// Used by the bridge itself when every port looks taken: clear its own old copies that no longer answer, then it can try again.
async function clearStale(ctx) {
  const procs = await listProcs(ctx);
  const holders = await portHolders(ctx.PORTS);
  const cleared = [];
  for (const [port, pid] of holders) {
    const p = procs.find(x => x.pid === pid);
    if (!p || p.role !== 'bridge' || pid === process.pid) continue;
    const alive = await ctx.health(port);
    if (alive) continue; // it answers: a working bridge (maybe someone else's), leave it
    if (await killPid(pid)) cleared.push({ port, pid });
  }
  if (cleared.length) await ctx.sleep(600);
  return cleared;
}

function whoHolds(ctx) { return portHolders(ctx.PORTS).then(async (h) => { const o = []; for (const [port, pid] of h) o.push(port + ' (' + await procName(pid) + ')'); return o; }); }

// ---------- the monitor program ----------
function openWindow(url) {
  if (process.platform !== 'win32') return;
  const tries = [['msedge', ['--app=' + url, '--window-size=380,600']], ['chrome', ['--app=' + url, '--window-size=380,600']]];
  const go = (i) => {
    if (i >= tries.length) { try { cp.spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch (e) {} return; }
    const c = cp.spawn('cmd', ['/c', 'start', '""', tries[i][0]].concat(tries[i][1]), { detached: true, stdio: 'ignore', windowsHide: true });
    c.on('error', () => go(i + 1)); c.on('exit', (code) => { if (code) go(i + 1); }); c.unref();
  };
  go(0);
}

function trayScript() {
  return [
    "param([int]$Port, [string]$Key, [string]$Exe)",
    "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing",
    "$base = 'http://127.0.0.1:' + $Port",
    "$ni = New-Object System.Windows.Forms.NotifyIcon; $ni.Visible = $true; $ni.Text = 'AI Bridge'",
    "function Make-Icon($c) { $bmp = New-Object System.Drawing.Bitmap 16,16; $g = [System.Drawing.Graphics]::FromImage($bmp); $g.SmoothingMode = 'AntiAlias'; $g.Clear([System.Drawing.Color]::Transparent); $br = New-Object System.Drawing.SolidBrush ($c); $g.FillEllipse($br, 1, 1, 13, 13); $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(90,0,0,0)), 1; $g.DrawEllipse($pen, 1, 1, 13, 13); $g.Dispose(); $h = $bmp.GetHicon(); [System.Drawing.Icon]::FromHandle($h) }",
    "$green = Make-Icon ([System.Drawing.Color]::FromArgb(34,160,90)); $grey = Make-Icon ([System.Drawing.Color]::FromArgb(140,140,140)); $red = Make-Icon ([System.Drawing.Color]::FromArgb(210,60,50))",
    "function Post($a) { try { Invoke-RestMethod -Method Post -Uri ($base + '/api/action') -Headers @{ 'x-key' = $Key } -ContentType 'application/json' -Body ('{\"action\":\"' + $a + '\"}') -TimeoutSec 40 | Out-Null } catch {} }",
    "function Open-Widget { Start-Process -FilePath $Exe -ArgumentList 'monitor' -WindowStyle Hidden }",
    "$menu = New-Object System.Windows.Forms.ContextMenuStrip",
    "$i1 = $menu.Items.Add('Open widget'); $i1.add_Click({ Open-Widget })",
    "$i2 = $menu.Items.Add('Restart AI Bridge'); $i2.add_Click({ $ni.Text = 'AI Bridge: restarting'; Post 'restart' })",
    "$i3 = $menu.Items.Add('Stop everything'); $i3.add_Click({ Post 'stop-all' })",
    "$menu.Items.Add('-') | Out-Null",
    "$i4 = $menu.Items.Add('Quit monitor'); $i4.add_Click({ Post 'quit'; $ni.Visible = $false; [System.Windows.Forms.Application]::Exit() })",
    "$ni.ContextMenuStrip = $menu; $ni.add_DoubleClick({ Open-Widget })",
    "$script:fails = 0",
    "$t = New-Object System.Windows.Forms.Timer; $t.Interval = 3000",
    "$t.add_Tick({ try { $s = Invoke-RestMethod -Uri ($base + '/api/status') -TimeoutSec 5; $script:fails = 0; if ($s.state -eq 'running') { $ni.Icon = $green; $ni.Text = 'AI Bridge: working (port ' + $s.bridge.port + ')' } elseif ($s.state -eq 'blocked') { $ni.Icon = $red; $ni.Text = 'AI Bridge: problem, ports busy' } else { $ni.Icon = $grey; $ni.Text = 'AI Bridge: not running' } } catch { $script:fails++; if ($script:fails -ge 3) { $ni.Visible = $false; [System.Windows.Forms.Application]::Exit() } } })",
    "$ni.Icon = $grey; $t.Start(); [System.Windows.Forms.Application]::Run()"
  ].join('\r\n');
}

async function runMonitor(ctx, argv) {
  const noWindow = argv.includes('--no-window');
  const monFile = path.join(ctx.HOME, 'monitor.json');
  const ping = (port) => new Promise((resolve) => { const r = http.get({ host: '127.0.0.1', port, path: '/api/ping', timeout: 1200 }, (res) => { let b = ''; res.on('data', d => b += d); res.on('end', () => { try { resolve(JSON.parse(b).app === 'ai-bridge-monitor'); } catch (e) { resolve(false); } }); }); r.on('error', () => resolve(false)); r.on('timeout', () => { r.destroy(); resolve(false); }); });
  let prev = null; try { prev = JSON.parse(fs.readFileSync(monFile, 'utf8')); } catch (e) {}
  if (prev && prev.port && await ping(prev.port)) { ctx.out('The AI Bridge monitor is already running.'); if (!noWindow && !ctx.NO_SYSTEM) openWindow('http://127.0.0.1:' + prev.port + '/'); return; }

  const KEY = crypto.randomBytes(16).toString('hex');
  const cores = Math.max(1, os.cpus().length);
  const history = []; let lastCpu = new Map(), lastAt = 0, snap = null, inflight = null;

  function sample() { if (!inflight) inflight = doSample().finally(() => { inflight = null; }); return inflight; } // callers during a sample wait for it
  async function doSample() {
    try {
      const procs = await listProcs(ctx); const now = Date.now();
      const dt = (now - lastAt) * 10000; // ms -> 100ns units
      const cpu = new Map(); let total = 0, mb = 0;
      const rows = procs.map(p => {
        let pct = 0; if (lastAt && lastCpu.has(p.pid) && dt > 0) pct = Math.max(0, (p.cpuTime - lastCpu.get(p.pid)) / dt / cores * 100);
        cpu.set(p.pid, p.cpuTime); total += pct; mb += p.mb;
        return { pid: p.pid, role: p.role, mb: p.mb, cpu: Math.round(pct * 10) / 10 };
      });
      lastCpu = cpu; lastAt = now;
      const run = await ctx.findRunning();
      let boards = [];
      if (run) { try { const b = await ctx.request(run.port, 'GET', '/boards', undefined, (run.reg || ctx.readReg() || {}).token, 3000); boards = (b.json && b.json.boards) || []; } catch (e) {} }
      const ports = await portReport(ctx, procs);
      const blocked = !run && ports.every(p => p.state !== 'free');
      history.push({ t: now, cpu: Math.round(total * 10) / 10, mb }); while (history.length > HISTORY_MAX) history.shift();
      snap = { state: run ? 'running' : blocked ? 'blocked' : 'stopped', time: now, version: ctx.VERSION,
        bridge: run ? { port: run.port, version: run.health && run.health.version, boards: boards.map(b => ({ name: b.name, code: b.code, page: b.page, workspace: b.workspace })) } : null,
        agents: rows.filter(r => r.role === 'agent').length, procs: rows, ports, totals: { cpu: Math.round(total * 10) / 10, mb, cores },
        autostart: ctx.autostartGet(), monitorAutostart: monitorAutostartGet(ctx), history };
    } catch (e) { snap = snap || { state: 'stopped', error: String(e.message || e), history }; }
  }

  let busy = false;
  const act = {
    async restart() { if (busy) return { ok: false, message: 'Already working on it.' }; busy = true; try { const r = await restart(ctx, {}); await sample(); return r; } finally { busy = false; } },
    async 'stop-all'() { if (busy) return { ok: false, message: 'Already working on it.' }; busy = true; try { const r = await restart(ctx, { everything: true, noStart: true }); await sample(); return r; } finally { busy = false; } },
    async start() { if (busy) return { ok: false, message: 'Already working on it.' }; busy = true; try { let run = await ctx.findRunning(); if (!run) { try { cp.spawn(fs.existsSync(ctx.INSTALLED_EXE) ? ctx.INSTALLED_EXE : process.execPath, ['serve'], { detached: true, stdio: 'ignore', windowsHide: true, env: process.env }).unref(); } catch (e) {} for (let i = 0; i < 30 && !run; i++) { await ctx.sleep(300); run = await ctx.findRunning(); } } await sample(); return { ok: !!run, port: run ? run.port : null, message: run ? 'AI Bridge is running on port ' + run.port + '.' : 'AI Bridge did not start.' }; } finally { busy = false; } },
    async autostart(b) { try { const on = ctx.autostartSet(!!b.on); await sample(); return { ok: true, on }; } catch (e) { return { ok: false, message: String(e.message || e) }; } },
    async 'monitor-autostart'(b) { try { const on = monitorAutostartSet(ctx, !!b.on); await sample(); return { ok: true, on }; } catch (e) { return { ok: false, message: String(e.message || e) }; } },
    async 'desktop-icon'() { try { return desktopIcon(ctx); } catch (e) { return { ok: false, message: String(e.message || e) }; } },
    async quit() { setTimeout(() => process.exit(0), 200); return { ok: true }; }
  };

  const server = http.createServer(async (req, res) => {
    const port = server.address().port;
    const host = String(req.headers.host || '');
    if (host !== '127.0.0.1:' + port && host !== 'localhost:' + port) { res.writeHead(403); return res.end('forbidden'); }
    const origin = req.headers.origin; if (origin && origin !== 'http://127.0.0.1:' + port && origin !== 'http://localhost:' + port) { res.writeHead(403); return res.end('forbidden'); }
    const json = (code, o) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(o)); };
    const url = req.url.split('?')[0];
    if (req.method === 'GET' && url === '/api/ping') return json(200, { app: 'ai-bridge-monitor' });
    if (req.method === 'GET' && url === '/api/status') { if (!snap) await sample(); return json(200, snap); }
    if (req.method === 'GET' && (url === '/' || url === '/index.html')) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY' }); return res.end(pageHtml(KEY)); }
    if (req.method === 'POST' && url === '/api/action') {
      if (req.headers['x-key'] !== KEY) return json(403, { ok: false, message: 'missing key' });
      let b = ''; req.on('data', d => { b += d; if (b.length > 2000) req.destroy(); });
      req.on('end', async () => { let m = {}; try { m = JSON.parse(b || '{}'); } catch (e) {} const f = act[m.action]; if (!f) return json(400, { ok: false, message: 'unknown action' }); json(200, await f(m)); });
      return;
    }
    res.writeHead(404); res.end('not found');
  });
  const ok = await new Promise((resolve) => { let i = 0; const next = () => { if (i >= MONITOR_PORTS.length) return resolve(false); const p = MONITOR_PORTS[i++]; server.once('error', next); server.listen(p, '127.0.0.1', () => { server.removeListener('error', next); resolve(true); }); }; next(); });
  if (!ok) { ctx.out('Could not open a port for the monitor (3060-3069 are in use).'); process.exit(2); }
  const port = server.address().port;
  fs.mkdirSync(ctx.HOME, { recursive: true }); fs.writeFileSync(monFile, JSON.stringify({ app: 'ai-bridge-monitor', port, pid: process.pid }));
  process.on('exit', () => { try { const c = JSON.parse(fs.readFileSync(monFile, 'utf8')); if (c.pid === process.pid) fs.unlinkSync(monFile); } catch (e) {} });
  ctx.out('AI Bridge monitor on http://127.0.0.1:' + port + '/');
  await sample(); setInterval(sample, 3000);
  if (!ctx.NO_SYSTEM && process.platform === 'win32') {
    try {
      const ps1 = path.join(ctx.HOME, 'tray.ps1'); fs.writeFileSync(ps1, '﻿' + trayScript());
      cp.spawn(PS_EXE, ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-Port', String(port), '-Key', KEY, '-Exe', fs.existsSync(ctx.INSTALLED_EXE) ? ctx.INSTALLED_EXE : process.execPath], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } catch (e) {}
    if (!noWindow) openWindow('http://127.0.0.1:' + port + '/');
  }
}

// ---------- start with Windows / desktop icon ----------
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
function monitorAutostartGet(ctx) {
  if (ctx.NO_SYSTEM) return fs.existsSync(path.join(ctx.HOME, 'monitor-autostart.flag'));
  if (process.platform !== 'win32') return false;
  try { cp.execFileSync(sysExe('reg'), ['query', RUN_KEY, '/v', 'AIBridgeMonitor'], { stdio: 'ignore' }); return true; } catch (e) { return false; }
}
function monitorAutostartSet(ctx, on) {
  if (ctx.NO_SYSTEM) { const f = path.join(ctx.HOME, 'monitor-autostart.flag'); if (on) fs.writeFileSync(f, '1'); else try { fs.unlinkSync(f); } catch (e) {} return monitorAutostartGet(ctx); }
  if (process.platform === 'win32') {
    if (on) cp.execFileSync(sysExe('reg'), ['add', RUN_KEY, '/v', 'AIBridgeMonitor', '/t', 'REG_SZ', '/d', '"' + ctx.INSTALLED_EXE + '" monitor --no-window', '/f'], { stdio: 'ignore' });
    else { try { cp.execFileSync(sysExe('reg'), ['delete', RUN_KEY, '/v', 'AIBridgeMonitor', '/f'], { stdio: 'ignore' }); } catch (e) {} }
  }
  return monitorAutostartGet(ctx);
}
function desktopIcon(ctx) {
  if (ctx.NO_SYSTEM || process.platform !== 'win32') return { ok: false, message: 'Only on Windows.' };
  const desk = path.join(process.env.USERPROFILE || os.homedir(), 'Desktop');
  const ps = "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('" + path.join(desk, 'AI Bridge Monitor.lnk').replace(/'/g, "''") + "');$s.TargetPath='" + ctx.INSTALLED_EXE.replace(/'/g, "''") + "';$s.Arguments='monitor';$s.Description='Shows whether AI Bridge is working';$s.Save()";
  cp.execFileSync(PS_EXE, ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore' });
  return { ok: true, message: 'Added "AI Bridge Monitor" to your desktop.' };
}

function pageHtml(key) { return require('./monitor-page').html.replace('__KEY__', key); }

module.exports = { runMonitor, restart, clearStale, whoHolds, listProcs, portHolders, openWindow, monitorAutostartSet, monitorAutostartGet, desktopIcon };
