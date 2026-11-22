// End-to-end test of the real ai-bridge.exe in a clean, isolated home folder, with fake FigJam plugins.
const cp = require('child_process'), fs = require('fs'), path = require('path'), os = require('os'), net = require('net'), http = require('http'), assert = require('assert');
const WebSocket = require(path.join(__dirname, '..', 'companion', 'node_modules', 'ws'));
const EXE = path.join(__dirname, '..', 'companion', 'dist', 'ai-bridge.exe');
const HOME = path.join(os.tmpdir(), 'aib-e2e', 'home'); fs.rmSync(path.dirname(HOME), { recursive: true, force: true });
// Environment of a machine without Node: PATH holds only Windows itself.
const env = Object.assign({}, process.env, { AIBRIDGE_HOME: HOME, AIBRIDGE_NO_SYSTEM: '1', AIBRIDGE_PORTS: '3570,3571,3572,3573', PATH: 'C:\\Windows\\System32;C:\\Windows' });
const INST = path.join(HOME, 'ai-bridge.exe');
// Async on purpose: the fake plugins live in this process and must keep answering while the client runs.
const sh = (exe, args) => new Promise((resolve) => { cp.execFile(exe, args, { env, encoding: 'utf8', timeout: 60000 }, (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : null) : 0, out: (stdout || '') + (stderr || '') })); });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const reg = () => JSON.parse(fs.readFileSync(path.join(HOME, 'bridge.json'), 'utf8'));
const get = (port, p, headers) => new Promise(res => http.get({ host: '127.0.0.1', port, path: p, headers }, r => { let s = ''; r.on('data', c => s += c); r.on('end', () => res({ status: r.statusCode, body: s })); }).on('error', () => res({ status: 0 })));
const post = (port, p, body, headers) => new Promise(res => { const q = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers }, r => { let s = ''; r.on('data', c => s += c); r.on('end', () => res({ status: r.statusCode, body: s })); }); q.end(body); });
function fakePlugin(port, name, opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    const ws = new WebSocket('ws://localhost:' + port, { origin: opts.origin === undefined ? 'null' : opts.origin });
    const st = { ws, got: [], scope: opts.scope || { id: '9:1', name: name + ' workspace' } };
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', protocol: opts.protocol || 2, name, page: 'Page 1', scope: st.scope })));
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString()); st.got.push(m);
      if (m.type === 'welcome') { st.welcome = m; resolve(st); }
      if (m.type === 'incompatible') resolve(st);
      if (m.type === 'cmd') ws.send(JSON.stringify({ type: 'result', id: m.id, result: m.ops.map(o => o.op === 'identity' ? { ok: true, op: 'identity', data: { fileName: name, page: 'Page 1', scope: st.scope, sections: [{ id: '9:1', name: st.scope.name }] } } : o.op === 'export' ? { ok: true, op: 'export', data: { name: 'Work space', format: 'PNG', base64: Buffer.from([137, 80, 78, 71]).toString('base64') } } : { ok: true, op: o.op, data: {} }) }));
    });
    ws.on('error', (e) => resolve({ error: e.message, got: [] }));
  });
}
setTimeout(() => { console.error('FAIL: global timeout'); process.exit(1); }, 150000).unref();
const step = (s) => console.log('  ok  ' + s);
(async () => {
  // --- port conflict: every port 3055-3058 held by other programs (3055 is held by an older bridge on this machine)
  const dummies = []; for (const p of [3570, 3571, 3572, 3573]) await new Promise(r => { const s = net.createServer().listen(p, '127.0.0.1', r); s.on('error', () => r()); dummies.push(s); });
  let r = await sh(EXE, []);
  assert(r.code === 2 && /Ports 3570, 3571, 3572, 3573 are all in use/.test(r.out), 'occupied ports reported (exit ' + r.code + '): ' + r.out);
  assert(fs.existsSync(path.join(HOME, 'last-error.txt')), 'last-error.txt written'); step('all ports busy: installer says so in plain words, exit 2');
  dummies.forEach(d => d.close()); await sleep(300);

  // --- first install on a "clean machine" (no Node on PATH)
  const noNode = cp.spawnSync('node', ['-v'], { env, encoding: 'utf8' }); assert(noNode.error, 'node is not available in the test PATH');
  r = await sh(EXE, []); assert(r.code === 0 && /AI Bridge is running/.test(r.out), 'first install: ' + r.out);
  assert(fs.existsSync(INST) && fs.existsSync(path.join(HOME, 'instructions.md')) && fs.existsSync(path.join(HOME, 'bridge.json')), 'files in place');
  step('first install without Node: installed, registered, started (port ' + r.out.match(/port (\d+)/)[1] + ')');
  const R1 = reg(), port = R1.port, token = R1.token;
  assert(R1.exe === INST && R1.instructions.endsWith('instructions.md'), 'registration points at installed exe and instructions');
  const instr = fs.readFileSync(path.join(HOME, 'instructions.md'), 'utf8');
  assert(instr.includes('ai-bridge.exe') && !/Claude|Codex/.test(instr), 'instructions file is tool-neutral and names the client'); step('instructions file is tool-neutral and names the installed client');

  // --- authorization
  assert((await get(port, '/health')).status === 200, '/health is public');
  assert((await get(port, '/boards')).status === 401, 'no token refused');
  assert((await get(port, '/boards', { authorization: 'Bearer nope' })).status === 401, 'wrong token refused');
  assert((await get(port, '/boards', { authorization: 'Bearer ' + token, origin: 'https://evil.example' })).status === 403, 'browser origin refused');
  assert((await post(port, '/cmd', '{"ops":[]}', { authorization: 'Bearer ' + token, 'content-type': 'text/plain' })).status === 415, 'non-JSON refused');
  step('local clients: no token, wrong token, browser origin and non-JSON are all refused');
  const evil = await fakePlugin(port, 'x', { origin: 'https://evil.example' }); assert(evil.error, 'website cannot connect as a plugin'); step('a website cannot connect as a plugin');
  const old = await fakePlugin(port, 'x', { protocol: 1 }); assert(old.got.some(m => m.type === 'incompatible'), 'old plugin told it is incompatible'); step('incompatible plugin protocol is reported');

  // --- companion running, no board yet
  r = await sh(INST, ['status']); assert(/"companion": "running"/.test(r.out) && /"boards": \[\]/.test(r.out)); step('status: companion running, no board');
  r = await sh(INST, ['verify']); assert(r.code === 4 && /no board connected/.test(r.out)); step('verify before a board connects: clear message');

  // --- board one connects, AI verifies
  const p1 = await fakePlugin(port, 'Board One'); assert(p1.welcome.code.length === 4);
  r = await sh(INST, ['verify']); assert(r.code === 0 && /VERIFIED/.test(r.out) && /Board name: Board One/.test(r.out) && r.out.includes('Board code: ' + p1.welcome.code) && /Workspace section: Board One workspace/.test(r.out), 'verify output: ' + r.out);
  await sleep(200); assert(p1.got.some(m => m.type === 'verified'), 'plugin is told the AI verified');
  step('AI verify: real read through the plugin; prints board name, code, workspace; plugin is notified');

  // --- board two connects: switching boards must not be silent
  const p2 = await fakePlugin(port, 'Board Two'); assert(p2.welcome.others === 1, 'second board told about the first');
  r = await sh(INST, ['verify']); assert(r.code === 4 && /several boards/.test(r.out) && r.out.includes(p1.welcome.code) && r.out.includes(p2.welcome.code), 'ambiguous: ' + r.out);
  step('two boards open: the AI is stopped and given both codes');
  const opsFile = path.join(os.tmpdir(), 'aib-ops.json'); fs.writeFileSync(opsFile, JSON.stringify([{ op: 'sticky', text: 'hi' }]));
  r = await sh(INST, ['send', opsFile]); assert(r.code === 4, 'send without board refused when several boards');
  r = await sh(INST, ['send', opsFile, '--board', p2.welcome.code]); assert(r.code === 0 && /Board Two/.test(r.out) && !/Board One/.test(r.out)); step('send --board CODE reaches only that board');
  fs.writeFileSync(opsFile, JSON.stringify([{ op: 'export' }])); r = await sh(INST, ['send', opsFile, '--board', p2.welcome.code]);
  const exp = JSON.parse(r.out).result[0].data;
  assert(r.code === 0 && !('base64' in exp) && fs.readFileSync(exp.file).length === 4, 'export saved to a file, not printed: ' + r.out); step('export: the client saves the picture to a file and prints the path, not the data');
  assert(p1.got.filter(m => m.type === 'cmd').length === 1, 'board one received only its own verify'); step('the other board received nothing');
  p1.ws.close(); await sleep(300);
  r = await sh(INST, ['verify']); assert(r.code === 0 && /Board Two/.test(r.out)); step('board one closes: the AI sees exactly one board and verifies it');
  p2.ws.close(); await sleep(300);

  // --- preference from the plugin
  const p3 = await fakePlugin(port, 'Board Three'); p3.ws.send(JSON.stringify({ type: 'set-autostart', on: true })); await sleep(300);
  assert(p3.got.some(m => m.type === 'autostart' && m.on === true) && (await sh(INST, ['autostart', 'status'])).out.includes('on')); step('"Start at sign-in" toggle from the plugin is applied (test mode: flag file, not the registry)');
  p3.ws.close(); await sleep(200);

  // --- repeat launch
  r = await sh(EXE, []); assert(r.code === 0, 'repeat install ' + r.out); assert(reg().token === token, 'token kept'); step('repeat install: updates in place; token and registration kept');
  // --- stopped companion
  await sh(INST, ['stop']); await sleep(600);
  r = await sh(INST, ['status']); assert(/"companion": "stopped"/.test(r.out)); r = await sh(INST, ['verify']); assert(r.code === 3 && /Start it/.test(r.out)); step('stopped companion: status says stopped; verify says how to start it');
  await sh(INST, ['serve', '--background']); await sleep(1500); assert(/"companion": "running"/.test((await sh(INST, ['status'])).out)); step('serve --background restarts it (what the Start menu and sign-in entries run)');
  await sh(INST, ['stop']); await sleep(400);
  console.log('companion tests: all passed');
})().catch(async e => { console.error('FAIL', e.stack || e.message); await sh(INST, ['stop']); process.exit(1); });
