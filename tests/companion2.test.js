// Tests for companion 1.2.0: plugin kinds, routing, desktop-app (MCP) mode and the connect helper.
const cp = require('child_process'), fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert');
const WebSocket = require(path.join(__dirname, '..', 'companion', 'node_modules', 'ws'));
const EXE = path.join(__dirname, '..', 'companion', 'dist', 'ai-bridge.exe');
const ROOT = path.join(os.tmpdir(), 'aib-e2e2'); fs.rmSync(ROOT, { recursive: true, force: true });
const HOME = path.join(ROOT, 'home'), PROFILE = path.join(ROOT, 'profile');
const env = Object.assign({}, process.env, { AIBRIDGE_HOME: HOME, AIBRIDGE_NO_SYSTEM: '1', AIBRIDGE_PORTS: '3570,3571,3572,3573', AIBRIDGE_CONFIG_ROOT: PROFILE, PATH: 'C:\\Windows\\System32;C:\\Windows' });
const INST = path.join(HOME, 'ai-bridge.exe');
const sh = (exe, args) => new Promise((resolve) => cp.execFile(exe, args, { env, encoding: 'utf8', timeout: 60000 }, (err, so, se) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : null) : 0, out: (so || '') + (se || '') })));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const reg = () => JSON.parse(fs.readFileSync(path.join(HOME, 'bridge.json'), 'utf8'));
function fakePlugin(port, name, extra) {
  return new Promise((resolve) => {
    const ws = new WebSocket('ws://localhost:' + port, { origin: 'null' });
    const st = { ws, got: [], scope: { id: '9:1', name: name + ' workspace' } };
    ws.on('open', () => ws.send(JSON.stringify(Object.assign({ type: 'hello', protocol: 2, name, page: 'Page 1', scope: st.scope }, extra || {}))));
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString()); st.got.push(m);
      if (m.type === 'welcome') { st.welcome = m; resolve(st); }
      if (m.type === 'cmd') ws.send(JSON.stringify({ type: 'result', id: m.id, result: m.ops.map(o =>
        o.op === 'identity' ? { ok: true, op: 'identity', data: { fileName: name, page: 'Page 1', scope: st.scope, canCreate: !!(extra && extra.canCreate), owned: ((extra && extra.owned) || []).map(n => ({ id: n, name: n })), sections: [{ id: '9:1', name: st.scope.name }] } }
        : o.op === 'export' ? { ok: true, op: 'export', data: { name: 'Workspace', format: 'PNG', base64: Buffer.from([137, 80, 78, 71]).toString('base64') } }
        : { ok: true, op: o.op, data: { echoed: o.op } }) }));
    });
    ws.on('error', (e) => resolve({ error: e.message, got: [] }));
  });
}
// A minimal desktop app: starts "ai-bridge mcp" and speaks JSON-RPC lines to it.
function mcpClient() {
  const child = cp.spawn(INST, ['mcp'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = [], waiters = new Map(); let buf = '', seq = 0, stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.on('data', d => stderr += d);
  child.stdout.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (!l.trim()) continue; lines.push(l); let m; try { m = JSON.parse(l); } catch (e) { continue; } if (m.id !== undefined && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); } } });
  const call = (method, params) => new Promise((resolve, reject) => { const id = ++seq; waiters.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); setTimeout(() => reject(new Error('mcp timeout: ' + method + ' stderr=' + stderr)), 30000); });
  return { call, lines, notify: (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'), close: () => child.kill() };
}
setTimeout(() => { console.error('FAIL: global timeout'); process.exit(1); }, 150000).unref();
let n = 0; const step = (s) => { n++; console.log('  ok  ' + s); };
(async () => {
  let r = await sh(EXE, []); assert(r.code === 0, 'install: ' + r.out);
  const port = reg().port;

  // ----- plugin kinds and routing
  const bridgeP = await fakePlugin(port, 'Board One');            // an older plugin: sends no kind, no caps
  let b = JSON.parse((await sh(INST, ['boards'])).out).boards[0];
  assert(b.plugin === 'ai-bridge' && b.caps.join() === 'base', 'plugin without kind is treated as ai-bridge with base ops'); step('a plugin that sends no kind or caps is treated as AI Bridge with the basic ops (old plugins keep working)');
  fs.writeFileSync(path.join(ROOT, 'pp.json'), JSON.stringify([{ op: 'pp.read' }]));
  r = await sh(INST, ['send', path.join(ROOT, 'pp.json')]); assert(r.code === 4 && /cannot do .{1,2}pp/.test(r.out) && /open AI Canvas/.test(r.out), 'refused: ' + r.out); step('a vector (pp.*) op sent to a board where only AI Bridge is open is refused with a plain message');
  r = await sh(INST, ['verify']); assert(/Plugin: AI Bridge \(can do: base\)/.test(r.out)); step('verify names the plugin and what it can do');
  bridgeP.ws.close(); await sleep(300);
  const ppP = await fakePlugin(port, 'Board One', { kind: 'point-pattern', caps: ['base', 'pp'], pluginVersion: '2.0.0', canCreate: true, owned: ['AI area one'] });
  r = await sh(INST, ['send', path.join(ROOT, 'pp.json')]); assert(r.code === 0 && /"echoed": "pp.read"/.test(r.out), 'pp accepted: ' + r.out); step('the same op is accepted when Point & Pattern is the open plugin');
  b = JSON.parse((await sh(INST, ['boards'])).out).boards[0]; assert(b.plugin === 'point-pattern' && b.caps.includes('pp') && b.pluginVersion === '2.0.0'); step('boards lists the plugin kind, abilities and version');
  assert(b.canCreate === true && b.owned.join() === 'AI area one'); r = await sh(INST, ['verify']); assert(/AI may create sections: YES/.test(r.out) && /Sections you made: AI area one/.test(r.out), r.out); step('boards and verify report that the user let the AI create sections, and which ones it made');
  const odd = await fakePlugin(port, 'Odd', { kind: 'something-else', caps: ['BAD CAP!!', 'ok'] }); const ob = JSON.parse((await sh(INST, ['boards'])).out).boards.find(x => x.name === 'Odd');
  assert(ob.plugin === 'ai-bridge' && ob.caps.join() === 'ok', 'unknown kind and malformed caps are cleaned'); step('an unknown kind and malformed abilities are cleaned, not trusted');
  odd.ws.close(); await sleep(300);

  // ----- desktop app (MCP)
  const app = mcpClient();
  let m = await app.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test-desktop-app', version: '1' } });
  assert(m.result.serverInfo.name === 'ai-bridge' && m.result.capabilities.tools && /bridge_instructions/.test(m.result.instructions)); app.notify('notifications/initialized'); step('MCP: initialize answers with name, tools capability and first-step instructions');
  m = await app.call('tools/list'); assert(['bridge_instructions', 'bridge_status', 'bridge_verify', 'bridge_send'].every(t => m.result.tools.some(x => x.name === t)) && m.result.tools.every(t => t.inputSchema && t.description)); step('MCP: four tools with descriptions and input schemas');
  m = await app.call('tools/call', { name: 'bridge_instructions', arguments: {} }); assert(/Operations/.test(m.result.content[0].text) && /desktop app/.test(m.result.content[0].text)); step('MCP: bridge_instructions returns the ops list');
  m = await app.call('tools/call', { name: 'bridge_verify', arguments: {} }); assert(!m.result.isError && /VERIFIED/.test(m.result.content[0].text) && /Plugin: AI Canvas/.test(m.result.content[0].text)); step('MCP: bridge_verify does a real read and reports the board and plugin');
  m = await app.call('tools/call', { name: 'bridge_send', arguments: { ops: [{ op: 'export' }] } }); const img = m.result.content.find(c => c.type === 'image');
  assert(!m.result.isError && img && img.mimeType === 'image/png' && Buffer.from(img.data, 'base64').length === 4); step('MCP: bridge_send with export returns the picture itself to the app');
  m = await app.call('tools/call', { name: 'bridge_send', arguments: { ops: 'nope' } }); assert(m.result.isError); step('MCP: bad input is reported as a tool error, not a crash');
  m = await app.call('bogus/method', {}); assert(m.error && m.error.code === -32601); step('MCP: unknown methods get a proper error');
  assert(app.lines.every(l => { try { JSON.parse(l); return true; } catch (e) { return false; } })); step('MCP: standard output carried only protocol messages');
  ppP.ws.close(); await sleep(300);
  m = await app.call('tools/call', { name: 'bridge_verify', arguments: {} }); assert(m.result.isError && /no board connected/.test(m.result.content[0].text)); step('MCP: with no board open the app is told to ask the user to open the plugin');
  await sh(INST, ['stop']); await sleep(700);
  m = await app.call('tools/call', { name: 'bridge_status', arguments: {} }); assert(!m.result.isError && /"companion": "running"/.test(m.result.content[0].text)); step('MCP: if the companion was stopped, the desktop app starts it by itself');
  app.close();

  // ----- upgrade from a companion older than 1.2.0 (no instance id in /health): found by the real user, must be stopped and replaced
  await sh(INST, ['stop']); await sleep(600);
  const legacyJs = path.join(ROOT, 'legacy.js');
  fs.writeFileSync(legacyJs, "const http=require('http');http.createServer((q,r)=>{if(q.url==='/health'){r.end(JSON.stringify({app:'ai-bridge',version:'1.1.0',protocol:2,boards:0}));return}if(q.method==='POST'&&q.url==='/shutdown'){r.end('{}');setTimeout(()=>process.exit(0),50);return}r.statusCode=404;r.end('{}')}).listen(3572,'127.0.0.1');");
  const legacy = cp.spawn('node', [legacyJs], { stdio: 'ignore' });
  const old = reg(); fs.writeFileSync(path.join(HOME, 'bridge.json'), JSON.stringify(Object.assign({}, old, { port: 3572, version: '1.1.0' }), null, 2)); await sleep(800);
  const legacyExited = new Promise(res => legacy.on('exit', () => res(true)));
  r = await sh(EXE, []); assert(r.code === 0 && /AI Bridge is running/.test(r.out), 'upgrade over a legacy companion: ' + r.out);
  assert(await Promise.race([legacyExited, sleep(3000).then(() => false)]), 'the old companion was stopped'); assert(reg().token === old.token, 'token kept');
  assert(/"version": "1.4.1"/.test((await sh(INST, ['status'])).out)); step('upgrade: an older companion (no instance id) is recognised by its registered port, stopped and replaced; token kept');

  // ----- connect helper (fake profile folder)
  r = await sh(INST, ['connect', 'status']); assert(/claude-desktop: not found/.test(r.out) && /codex: not found/.test(r.out)); step('connect status: apps that are not installed are reported as not found');
  fs.mkdirSync(path.join(PROFILE, 'Claude'), { recursive: true });
  const cfgFile = path.join(PROFILE, 'Claude', 'claude_desktop_config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'x' } } }));
  r = await sh(INST, ['connect', 'claude-desktop']); assert(r.code === 0, r.out);
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  assert(cfg.theme === 'dark' && cfg.mcpServers.other.command === 'x' && cfg.mcpServers['ai-bridge'].args[0] === 'mcp' && cfg.mcpServers['ai-bridge'].command.endsWith('ai-bridge.exe') && fs.existsSync(cfgFile + '.bak-aibridge'), 'merged, backup made'); step('connect claude-desktop: adds AI Bridge, keeps every other setting, writes a backup first');
  fs.writeFileSync(cfgFile, '{ not json'); r = await sh(INST, ['connect', 'claude-desktop']); assert(r.code !== 0 && fs.readFileSync(cfgFile, 'utf8') === '{ not json'); step('connect: a config file that is not valid JSON is left untouched');
  fs.mkdirSync(path.join(PROFILE, '.codex'), { recursive: true }); const toml = path.join(PROFILE, '.codex', 'config.toml'); fs.writeFileSync(toml, 'model = "x"\n');
  await sh(INST, ['connect', 'codex']); await sh(INST, ['connect', 'codex']); const t = fs.readFileSync(toml, 'utf8');
  assert(t.startsWith('model = "x"') && (t.match(/\[mcp_servers\.ai-bridge\]/g) || []).length === 1 && /args = \["mcp"\]/.test(t)); step('connect codex: appends one block to the Codex config, once, keeping the rest');
  console.log('companion 1.2.0 tests: ' + n + ' steps, all passed');
  await sh(INST, ['stop']);
})().catch(async e => { console.error('FAIL', e.stack || e.message); await sh(INST, ['stop']); process.exit(1); });
