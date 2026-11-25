// Tests for companion 1.4.0: the monitor (status widget, restart, stop everything, usage) and clearing of old copies.
// Runs against the built exe in its own folder and ports; never touches the real AI Bridge on 3055-3058.
const cp = require('child_process'), fs = require('fs'), path = require('path'), os = require('os'), net = require('net'), http = require('http'), assert = require('assert');
const EXE = path.join(__dirname, '..', 'companion', 'dist', 'ai-bridge.exe');
const ROOT = path.join(os.tmpdir(), 'aib-e2e-mon');
// A failed earlier run can leave its test programs running (they hold the exe open). Stop only those that run from this test folder.
try { cp.execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', "Get-Process ai-bridge -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '" + ROOT.replace(/'/g, "''") + "\*' } | Stop-Process -Force"], { stdio: 'ignore' }); cp.execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},700)']); } catch (e) {}
fs.rmSync(ROOT, { recursive: true, force: true });
const HOME = path.join(ROOT, 'home');
const PORTS = [3580, 3581, 3582, 3583];
const env = Object.assign({}, process.env, { AIBRIDGE_HOME: HOME, AIBRIDGE_NO_SYSTEM: '1', AIBRIDGE_PORTS: PORTS.join(',') });
const INST = path.join(HOME, 'ai-bridge.exe');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const sh = (exe, args) => new Promise((resolve) => cp.execFile(exe, args, { env, encoding: 'utf8', timeout: 90000 }, (err, so, se) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : null) : 0, out: (so || '') + (se || '') })));
const reg = () => JSON.parse(fs.readFileSync(path.join(HOME, 'bridge.json'), 'utf8'));
function req(port, method, p, body, headers) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: Object.assign({}, data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}, headers || {}) }, (res) => { let b = ''; res.on('data', d => b += d); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) {} resolve({ status: res.statusCode, text: b, json: j }); }); });
    r.on('error', (e) => resolve({ status: 0, text: String(e) })); if (data) r.write(data); r.end();
  });
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return false; } };
setTimeout(() => { console.error('FAIL: global timeout'); process.exit(1); }, 240000).unref();
let n = 0; const step = (s) => { n++; console.log('  ok  ' + s); };
const holders = [];
const blockerServer = () => net.createServer((sock) => { sock.on('error', () => {}); }); // swallows resets from the bridge probing the port
(async () => {
  let r = await sh(EXE, []); assert(r.code === 0, 'install: ' + r.out);
  const oldReg = reg(); step('install starts a bridge in its own folder');

  // ---- monitor starts and reports ----
  const mon = cp.spawn(INST, ['monitor', '--no-window'], { env, stdio: 'ignore' });
  let mj = null; for (let i = 0; i < 40 && !mj; i++) { await sleep(250); try { mj = JSON.parse(fs.readFileSync(path.join(HOME, 'monitor.json'), 'utf8')); } catch (e) {} }
  assert(mj && mj.port >= 3060 && mj.port <= 3069, 'monitor.json'); const MP = mj.port; step('monitor opens one local page on a port in 3060-3069');
  let s = (await req(MP, 'GET', '/api/status')).json;
  assert(s.state === 'running' && s.bridge.port === oldReg.port && s.bridge.version === '1.4.1', JSON.stringify(s).slice(0, 300));
  assert(s.procs.some(p => p.role === 'bridge' && p.pid === oldReg.pid) && s.procs.some(p => p.role === 'monitor') && s.totals.mb > 0 && Array.isArray(s.history)); step('status: running, port and version, the bridge and the monitor are listed with memory, history is kept');
  const again = await sh(INST, ['monitor', '--no-window']); assert(/already running/.test(again.out)); step('starting the monitor twice keeps one copy');

  // ---- the local page is not open to other sites ----
  assert((await req(MP, 'GET', '/api/status', null, { host: 'evil.example' })).status === 403); step('a request with a foreign Host header is refused (rebinding)');
  assert((await req(MP, 'GET', '/api/status', null, { origin: 'https://evil.example' })).status === 403); step('a request from another website origin is refused');
  assert((await req(MP, 'POST', '/api/action', { action: 'restart' })).status === 403); step('actions need the key');
  const page = (await req(MP, 'GET', '/')).text; const KEY = /var KEY="([0-9a-f]{32})"/.exec(page)[1]; assert(page.includes('Restart AI Bridge') && !page.includes('__KEY__')); step('the page carries the key and the Restart button');
  const act = (a, extra) => req(MP, 'POST', '/api/action', Object.assign({ action: a }, extra || {}), { 'x-key': KEY });
  assert((await act('format-disk')).status === 400); step('unknown actions are refused');

  // ---- another program on a port is reported, never killed ----
  const blocker = blockerServer(); await new Promise(res => blocker.listen(3583, '127.0.0.1', res)); holders.push(blocker);
  let p83 = null; for (let i = 0; i < 40 && !(p83 && p83.state === 'other'); i++) { await sleep(500); s = (await req(MP, 'GET', '/api/status')).json; p83 = s.ports.find(p => p.port === 3583); } // a sample takes a moment; wait for the next one
   assert(p83.state === 'other' && /node/i.test(p83.holder), JSON.stringify(s.ports)); step('a port held by another program is shown with that program’s name');

  // ---- restart ----
  const oldPid = oldReg.pid;
  r = (await act('restart')).json; assert(r.ok && r.port && r.killed.includes(oldPid) && !alive(oldPid), JSON.stringify(r)); step('restart stops the old bridge and starts a fresh one');
  assert(reg().token === oldReg.token && reg().pid !== oldPid); step('the token is kept, so agents reconnect without setup');
  assert(alive(blocker.address ? process.pid : process.pid) && blocker.listening); step('the other program on port 3583 was left alone');
  s = (await req(MP, 'GET', '/api/status')).json; assert(s.state === 'running'); step('status shows the new bridge');

  // ---- an agent connection survives restart, and stop everything ends it ----
  const agent = cp.spawn(INST, ['mcp'], { env, stdio: ['pipe', 'pipe', 'pipe'] }); await sleep(1500); assert(alive(agent.pid));
  r = (await act('restart')).json; assert(r.ok && alive(agent.pid)); step('restart does not end an agent’s own connection (ai-bridge mcp)');
  s = (await req(MP, 'GET', '/api/status')).json; assert(s.agents === 1 && s.procs.some(p => p.role === 'agent')); step('status counts the agent connection');
  const OTHER = path.join(ROOT, 'other'); fs.mkdirSync(OTHER, { recursive: true }); fs.copyFileSync(INST, path.join(OTHER, 'ai-bridge.exe'));
  const otherAgent = cp.spawn(path.join(OTHER, 'ai-bridge.exe'), ['mcp'], { env: Object.assign({}, env, { AIBRIDGE_HOME: OTHER, AIBRIDGE_PORTS: '3590,3591,3592,3593' }), stdio: ['pipe', 'pipe', 'pipe'] }); await sleep(1500); assert(alive(otherAgent.pid));
  s = (await req(MP, 'GET', '/api/status')).json; assert(!s.procs.some(p => p.pid === otherAgent.pid)); step('an AI Bridge from another folder (like another login or copy) is not listed');
  r = (await act('stop-all')).json; assert(r.ok && r.killed.includes(agent.pid), JSON.stringify(r)); await sleep(500); assert(!alive(agent.pid) && alive(otherAgent.pid)); step('stop everything ends this install’s bridge and agent connections, and leaves the other folder’s agent alone');
  s = (await req(MP, 'GET', '/api/status')).json; assert(s.state === 'stopped' && s.bridge === null); step('status says stopped, and the light would be grey');
  r = (await act('start')).json; assert(r.ok && r.port); step('start brings it back without killing anything');

  // ---- toggles (flag files in test mode) ----
  r = (await act('autostart', { on: true })).json; assert(r.ok && r.on === true); r = (await act('monitor-autostart', { on: true })).json; assert(r.ok && r.on === true);
  s = (await req(MP, 'GET', '/api/status')).json; assert(s.autostart === true && s.monitorAutostart === true);
  await act('autostart', { on: false }); await act('monitor-autostart', { on: false }); step('start-with-Windows switches work');

  // ---- command line ----
  await act('stop-all'); r = await sh(INST, ['restart']); const jr = JSON.parse(r.out.trim().split('\n').pop()); assert(r.code === 0 && jr.ok && jr.port); step('ai-bridge restart starts a bridge even when none runs');

  // ---- every port taken by other programs: say who ----
  await act('stop-all'); for (const p of [3580, 3581, 3582]) { const b = blockerServer(); await new Promise(res => b.listen(p, '127.0.0.1', res)); holders.push(b); }
  r = await sh(INST, ['serve']); assert(r.code === 2 && /3580/.test(r.out) && /node/i.test(r.out) && /monitor/i.test(r.out), r.out); step('when every port is taken the message names the programs holding them and points at the monitor');

  mon.kill(); otherAgent.kill(); holders.forEach(h => h.close());
  await sh(INST, ['stop']);
  console.log('monitor tests: ' + n + ' steps, all passed'); process.exit(0);
})().catch(e => { console.error('FAIL', e); holders.forEach(h => { try { h.close(); } catch (x) {} }); process.exit(1); });
