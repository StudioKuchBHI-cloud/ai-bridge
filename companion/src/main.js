'use strict';
// AI Bridge companion: one program with four jobs.
//   (no arguments)  install: copy itself into the user's AI Bridge folder, register, start
//   serve           run the local server (use --background to detach)
//   status | boards | verify | send | autostart | stop | uninstall   the client an AI tool calls
// Per-user only. No administrator rights. Listens on 127.0.0.1.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');
const crypto = require('crypto');

const VERSION = '1.5.0';
const PROTOCOL = 2;
const PORTS = process.env.AIBRIDGE_PORTS ? process.env.AIBRIDGE_PORTS.split(',').map(Number).filter(Boolean) : [3055, 3056, 3057, 3058];
const WIN = process.platform === 'win32';
const MAC = process.platform === 'darwin';
const NO_SYSTEM = !!process.env.AIBRIDGE_NO_SYSTEM; // tests: skip registry and shortcuts
const HOME = process.env.AIBRIDGE_HOME || (WIN
  ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'AIBridge')
  : MAC ? path.join(os.homedir(), 'Library', 'Application Support', 'AIBridge')
  : path.join(os.homedir(), '.local', 'share', 'AIBridge'));
const REG = path.join(HOME, 'bridge.json');
const EXE_NAME = WIN ? 'ai-bridge.exe' : 'ai-bridge';
const INSTALLED_EXE = path.join(HOME, EXE_NAME);

const iidOf = (token) => crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 12);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const out = (s) => process.stdout.write(s + '\n');
function readReg() { try { return JSON.parse(fs.readFileSync(REG, 'utf8')); } catch (e) { return null; } }
function writeReg(o) { fs.mkdirSync(HOME, { recursive: true }); fs.writeFileSync(REG, JSON.stringify(o, null, 2)); }

// ---------- small HTTP helper (client side) ----------
function request(port, method, url, body, token, timeout) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = {};
    if (token) headers.authorization = 'Bearer ' + token;
    if (data) { headers['content-type'] = 'application/json'; headers['content-length'] = data.length; }
    if (process.env.AI_CLIENT) headers['x-client'] = process.env.AI_CLIENT;
    const req = http.request({ host: '127.0.0.1', port, path: url, method, headers, timeout: timeout || 3000 }, (res) => {
      let s = ''; res.on('data', c => s += c);
      res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (e) {} resolve({ status: res.statusCode, json: j }); });
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, json: null }); });
    req.on('error', () => resolve({ status: 0, json: null }));
    if (data) req.write(data);
    req.end();
  });
}
async function health(port) {
  const r = await request(port, 'GET', '/health', undefined, undefined, 700); // short: another program may accept the connection and never answer
  return r.json && r.json.app === 'ai-bridge' ? r.json : null;
}
async function findRunning() {
  // Only an instance that belongs to THIS registration counts. Another user's or folder's AI Bridge on a nearby port does not.
  const reg = readReg();
  if (!reg || !reg.token) return null;
  const iid = iidOf(reg.token);
  const tried = [];
  for (const p of [reg.port, ...PORTS].filter(Boolean)) {
    if (tried.includes(p)) continue; tried.push(p);
    const h = await health(p);
    // Companions before 1.2.0 do not report an id. Accept one only on the exact port this registration recorded, so an upgrade can stop it.
    if (h && (h.iid === iid || (h.iid === undefined && p === reg.port))) return { port: p, health: h, reg };
  }
  return null;
}

// ---------- monitor (status widget, tray icon, restart) ----------
const monitor = require('./monitor');
const monCtx = () => ({ HOME, PORTS, VERSION, INSTALLED_EXE, NO_SYSTEM, readReg, findRunning, health, request, sleep, out, autostartGet, autostartSet });

// ---------- autostart ----------
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
function autostartGet() {
  if (NO_SYSTEM) return fs.existsSync(path.join(HOME, 'autostart.flag'));
  if (WIN) { try { cp.execFileSync('reg', ['query', RUN_KEY, '/v', 'AIBridge'], { stdio: 'ignore' }); return true; } catch (e) { return false; } }
  return false; // macOS launch agent: see MACOS.md
}
function autostartSet(on) {
  if (NO_SYSTEM) { const f = path.join(HOME, 'autostart.flag'); if (on) fs.writeFileSync(f, '1'); else try { fs.unlinkSync(f); } catch (e) {} return autostartGet(); }
  if (WIN) {
    if (on) cp.execFileSync('reg', ['add', RUN_KEY, '/v', 'AIBridge', '/t', 'REG_SZ', '/d', '"' + INSTALLED_EXE + '" serve --background', '/f'], { stdio: 'ignore' });
    else { try { cp.execFileSync('reg', ['delete', RUN_KEY, '/v', 'AIBridge', '/f'], { stdio: 'ignore' }); } catch (e) {} }
  }
  return autostartGet();
}

// ---------- instructions file for AI tools ----------
function instructionsText() {
  const exe = INSTALLED_EXE;
  return `# AI Bridge: instructions for an AI assistant

AI Bridge lets you read and edit the FigJam board that the user has open with the AI Bridge plugin.
Everything here runs on the user's computer. Follow these steps in order.

## 1. Use the client program
Client: \`${exe}\`
Run it from a terminal. Add \`AI_CLIENT=<your name>\` in the environment if you can, so the user sees which tool connected.
Windows PowerShell example: \`$env:AI_CLIENT='my-assistant'; & '${exe}' verify\`

## 2. Verify the connection before you change anything
Run: \`"${exe}" verify\`
It performs a real read through the plugin and prints the board name, the page name, a 4-letter board code and the workspace section.
- Tell the user exactly what it printed. Ask them to confirm it is the board they mean, and wait for a yes.
- If several boards are open it lists them and stops. Ask the user which code to use, then add \`--board CODE\` to every command.
- If it says no workspace section is chosen, ask the user to select a section in FigJam and press "Use selected section" in the plugin. You cannot edit until they do.
- The file name comes from Figma's document name. The plugin cannot read the file key, so do not claim you verified the file URL.

## 2b. If you are a desktop app
If AI Bridge appears to you as tools (\`bridge_instructions\`, \`bridge_status\`, \`bridge_verify\`, \`bridge_send\`), use them instead of the command line. \`bridge_send\` takes the same operations as below, and an \`export\` operation returns the picture to you.

## 3. Commands
| Command | What it does |
|---|---|
| \`status\` | Is the companion running, and which boards are connected |
| \`boards\` | List connected boards with codes |
| \`verify [--board CODE]\` | Real read of the board identity |
| \`send ops.json [--board CODE]\` | Run a list of operations (use \`-\` to read JSON from standard input) |
| \`autostart on|off|status\` | Start the companion when the user signs in |
| \`connect [claude-desktop|codex|all|status]\` | Add AI Bridge to a desktop app so it appears as tools there |

## 4. Operations (\`ops.json\` holds an array of \`{"op": "...", ...}\`)
The user lists sections for you. A section marked READ you may look at and review (\`context\`, \`read\`, \`find\`, \`tableread\`, \`export\`) but never change. A section marked EDIT, the workspace and sections you create yourself (when the user has switched on "Let the AI create sections") you may also change. Anything else on the board is out of reach. If a change is refused as read only, tell the user which section and ask them to switch it to EDIT in the plugin window; do not try to work around it. \`parent\` is optional and defaults to the workspace. Coordinates are relative to the workspace. Colours are hex strings. Keep batches to about 50 ops and check the results before sending more.

### Read and find
| op | Fields | Notes |
|---|---|---|
| \`context\` | \`id\` (optional), \`limit\`, \`maxText\` | start here. Every section the user listed, each with the user's description, its mode (read or edit) and an outline of what is inside. Use the descriptions to know what each section is for and what the user wants done with it. Item text is shortened to 160 characters; an item with \`cut: true\` was shortened (\`fullLength\` says how long it is). To read it whole, call again with \`maxText\` up to 5000 (and \`id\` to keep the answer small) |
| \`feedback\` | \`id\` (optional), \`maxText\`, \`reach\` | the notes the user left as stickies, each with the item it belongs to. Read only, works in READ and EDIT sections. \`kind\`: problem (red or orange), approved (green), note (other colours). \`how\`: connector (joined by a line), on top (sits on the item), beside (a coloured note near the item, within \`reach\`, default 250). Plain stickies that point at nothing are only counted in \`content\`. Use it when the user says they left feedback or asks you to check their notes: compare what you made with each note and with the section description (what it is used for), say what you would change, and change only EDIT sections after a yes. Notes are cut at 400 characters (\`cut: true\`); raise \`maxText\` for more |
| \`identity\` | none | board name, page, workspace, \`listed\` (the sections above with descriptions and modes), whether you may create sections, sections you made, top-level section names |
| \`read\` | \`parent\` | children of the workspace or of a node inside it |
| \`find\` | \`query\`, \`type\`, \`parent\`, \`limit\`, \`maxText\` | case-insensitive search of names and text (stickies, shapes, text, code, table cells). \`type\` is for example STICKY, SHAPE_WITH_TEXT, TEXT, TABLE, CODE_BLOCK. Use this instead of reading everything. Text is shortened to 120 characters (\`cut: true\`); pass \`maxText\` up to 5000 for the whole text |
| \`selection\` | none | what the user has selected |
| \`export\` | \`id\` (default workspace), \`scale\` (0.1 to 4), \`format\` PNG, JPG or SVG | a picture of the node. The client saves it under the AIBridge folder in \`exports\` and returns the file path in \`file\`. Look at that file to see the board |
| \`freespace\` | \`w\`, \`h\`, \`gap\`, \`where\` (below or right) | an empty spot inside the workspace; says if it fits and what size the workspace needs |

### Tables (a real FigJam table)
| op | Fields | Notes |
|---|---|---|
| \`table\` | \`rows\` (array of arrays of text), \`header\` (default true: first row is the header), \`widths\` (px per column), \`heights\`, \`size\`, \`align\`, \`headerFill\`, \`headerColor\`, \`colFills\`, \`colColors\`, \`rowFills\`, \`rowColors\`, \`boldCols\`, \`boldRows\`, \`name\`, \`parent\`, \`x\`, \`y\` | header colours win over row colours, which win over column colours. At most 2000 cells |
| \`tableread\` | \`id\` | all cell text as rows, so you can read what people typed |
| \`tablecell\` | \`id\`, \`row\`, \`col\`, \`text\`, \`fill\`, \`color\`, \`bold\` | rows and columns count from 0; row 0 is the header |
| \`tablerows\` | \`id\`, \`rows\` (array of arrays), \`at\` (index, default end), \`fill\`, \`bold\` | adds rows |
| \`tablecolumns\` | \`id\`, \`columns\` (one array of cell texts per new column), \`at\`, \`width\` | adds columns |
| \`tableremove\` | \`id\`, \`rows\` (indexes), \`cols\` (indexes) | removes rows or columns |

### Drawing
| op | Fields | Notes |
|---|---|---|
| \`section\` | \`name\`, \`w\`, \`h\`, \`fill\`, \`forceNew\` | a new top-level section; only when the user switched on "Let the AI create sections". Asking for the same name again returns the one you made |
| \`sticky\` | \`text\`, \`color\`, \`x\`, \`y\` | one sticky |
| \`stickies\` | \`texts\`, \`colors\` (cycled), \`cols\`, \`gap\`, \`x\`, \`y\` | many stickies in a grid |
| \`text\` | \`text\`, \`style\` (Regular, Medium, Semi Bold, Bold), \`size\`, \`color\`, \`w\`, \`align\` (LEFT, CENTER, RIGHT), \`x\`, \`y\` | |
| \`shape\` | \`shapeType\`, \`text\`, \`w\`, \`h\`, \`size\`, \`fill\`, \`stroke\`, \`align\`, \`x\`, \`y\` | \`shapeType\`: SQUARE, ELLIPSE, ROUNDED_RECTANGLE, DIAMOND, TRIANGLE_UP, TRIANGLE_DOWN, PARALLELOGRAM_RIGHT, PARALLELOGRAM_LEFT, ENG_DATABASE, ENG_QUEUE, ENG_FILE, ENG_FOLDER |
| \`connector\` | \`from\`, \`to\` (node ids), \`label\`, \`lineType\` (STRAIGHT, ELBOWED, CURVED), \`startCap\`, \`endCap\` (NONE, ARROW_LINES, ARROW_EQUILATERAL, TRIANGLE_FILLED, DIAMOND_FILLED, CIRCLE_FILLED), \`color\`, \`weight\` | |
| \`flow\` | \`items\` (texts or \`{text, fill, shapeType}\`), \`direction\` (row or column), \`w\`, \`h\`, \`gap\`, \`fills\`, \`labels\` (text on each arrow), \`edges\` (\`[{from, to, label}]\` by index, for branches), \`x\`, \`y\` | a flowchart in one command: boxes laid out and joined by arrows |
| \`kanban\` | \`columns\` (\`[{title, color, cards: [text], cardColor}]\`), \`colW\`, \`gap\`, \`x\`, \`y\` | board with column headers and stickies |
| \`timeline\` | \`items\` (\`[{label, text, color}]\`), \`spacing\`, \`x\`, \`y\` | dots on a line with labels |
| \`code\` | \`code\`, \`language\`, \`name\`, \`x\`, \`y\` | a code block |
| \`image\` | \`base64\`, \`w\`, \`h\`, \`name\`, \`x\`, \`y\` | PNG or JPG |
| \`linkcard\` | \`url\`, \`text\`, \`w\`, \`h\` | clickable hyperlink box |

### Vector drawing (only when the plugin open on the board is AI Canvas; \`bridge_status\` shows \`pp\` among its capabilities)
These draw real vectors, the same kind a person draws with the pen and shapes in AI Canvas, and a person can keep editing them with the Anchors and Pen tools. They work only in sections the user set to EDIT, the workspace, and sections you made. A READ section can be read with \`pp.read\` but not drawn in. Coordinates are relative to the section.
| op | Fields | Notes |
|---|---|---|
| \`pp.shape\` | \`kind\` (rectangle, ellipse, triangle, diamond, line), \`w\`, \`h\`, \`x\`, \`y\`, \`radius\` (rectangle corners), plus the style fields below | a shape by position and size. For a line, \`w\` and \`h\` are the run and the rise |
| \`pp.path\` | \`points\` (\`[{x, y, in: {x, y}, out: {x, y}, radius}]\`; \`in\` and \`out\` are absolute curve handles, \`radius\` rounds a corner) or \`paths\` (several \`{points, closed}\`), \`closed\`, \`x\`, \`y\`, \`name\`, plus the style fields below | a free path with corners and curves. Points are shifted so the drawing starts at 0,0 and \`x\`, \`y\` place it. At most 20 paths and 500 points per path |
| \`pp.path\` with \`id\` | \`id\` plus any fields to change | updates a vector you may change: send \`points\` or \`paths\` to replace the shape, or only style fields to restyle it. Position is kept unless you send \`x\`, \`y\` |
| \`pp.restyle\` | \`ids\` plus the style fields | restyles several shapes at once |
| \`pp.read\` | \`id\` or \`parent\`, \`limit\` | the saved drawing (points, handles, style) of one vector, or of every vector in a section, including hand drawings you may not change |
Style fields: \`stroke\` (hex), \`width\` (1 to 100), \`style\` (solid, dashed, dotted), \`dash\`, \`gap\`, \`fill\` (hex, or \`"none"\`), \`fillOpacity\` (0 to 100), \`strokeOpacity\` (0 to 100). Anything you leave out keeps its value (new shapes start as a 4 px solid blue line with no fill).

Rich look (every \`pp.shape\`, \`pp.path\` and \`pp.restyle\` also takes \`rich\`). Gradients, a tapered stroke, brushes and effects, saved next to the drawing so a person editing its points never loses them. Send only the parts you want to change; a part set to \`null\` goes back to the plain style; \`rich: null\` removes the whole look. A refused look draws nothing.
| Part | Value | Notes |
|---|---|---|
| \`stroke\`, \`fill\` | \`{type: "linear", colors: ["#ff0000","#0000ff"], angle: 90}\`, or \`type\` radial, angular, diamond (with \`cx\`, \`cy\`, \`r\` as 0 to 1 of the shape), or \`stops: [{pos, color, opacity}]\` instead of \`colors\` (2 to 8) | a gradient instead of the solid colour. Angle 0 runs left to right, 90 top to bottom |
| \`fill\` as spots | \`{type: "spots", base: "#101018", spots: [{x, y, r, color, opacity}]}\` | up to 8 soft colour spots (x, y, r as 0 to 1 of the shape, r about 0.3 to 0.6) fading to transparent: a freeform-gradient look |
| \`fill\` as mesh | \`{type: "mesh", cols: 3, rows: 3, colors: [9 hex colours, row by row, top left first], smooth: 1}\` | a grid of colour points (2 to 6 each way) blended smoothly, like a gradient mesh. FigJam has no native mesh, so it becomes a picture used as the fill (not a live vector); it is drawn again whenever the shape is edited. Fill only. \`smooth\` 0 to 1 eases the blend between points. For a living, editable alternative use spots |
| \`profile\` | \`"TAPER"\`, \`"WEDGE"\`, \`"QUARTER_TAPER"\`, \`"EYE"\`, \`"MIRRORED_TAPER"\`, \`"UNIFORM"\`, or \`{points: [{position: 0..1, width: 0..1}]}\` | the stroke gets thick and thin along its length; width is a fraction of \`width\`. Use a wide \`width\` (10 to 40) so the effect shows. Open paths only taper at their ends |
| \`brush\` | \`{type: "STRETCH", name: "NOIR"}\` (names: HEIST, BLOCKBUSTER, GRINDHOUSE, BIOPIC, SPAGHETTI_WESTERN, SLASHER, HARDBOILED, VERITE, EPIC, SCREWBALL, ROM_COM, NOIR, PROPAGANDA, MELODRAMA, NEW_WAVE), \`{type: "SCATTER", name: "BUBBLEGUM", gap, wiggle, sizeJitter, angularJitter, rotation}\` (BUBBLEGUM, WITCH_HOUSE, SHOEGAZE, HONKY_TONK, SCREAMO, DRONE, DOO_WOP, SPOKEN_WORD, VAPORWAVE, OI), or \`{type: "DYNAMIC", frequency, wiggle, smoothen}\` | a textured, scattered or wobbly stroke. A brush replaces a profile (you get a warning). Needs a stroke width of about 8 or more to be visible |
| \`effects\` | \`{noise: {size, density, opacity}, texture: {size, radius}, progressiveBlur: {radius, start}, blur, shadow: {x, y, blur, color, opacity}}\` | grain, a rough texture, a blur that grows from top to bottom (replaces plain \`blur\`), a drop shadow |
\`pp.read\` returns the saved look as \`rich\`. Example: \`{"op":"pp.path","points":[...],"width":18,"stroke":"#222222","rich":{"profile":"TAPER","stroke":{"type":"linear","colors":["#ff5a36","#3b6fd4"],"angle":0}}}\`.

### Change and arrange
| op | Fields | Notes |
|---|---|---|
| \`update\` | \`id\`, plus \`text\`, \`x\`, \`y\`, \`name\`, \`fill\`, \`w\`+\`h\` | |
| \`move\` | \`ids\`, \`dx\`, \`dy\` (or \`x\`, \`y\` for a single node) | |
| \`duplicate\` | \`ids\`, \`dx\`, \`dy\`, \`count\` | copies of nodes |
| \`arrange\` | \`ids\`, \`action\` (\`align\` or \`distribute\`), \`align\` (LEFT, CENTER, RIGHT, TOP, MIDDLE, BOTTOM; aligns to the first id), \`axis\` (H or V), \`gap\` | |
| \`fit\` | \`padding\` | resizes the workspace to fit what is inside it |
| \`remove\` | \`ids\` | only nodes inside the workspace |
| \`clear\` | none | empties the workspace section |
| \`zoom\` | none | scroll the view to the workspace |

Sections: FigJam cannot put a section inside another section, so the \`section\` op makes a new top-level section in empty space. It works only while the user has switched on "Let the AI create sections" in the plugin window (check \`identity\`: \`canCreate\`). x and y are chosen for you. At most 20 per session. You may work inside sections you made and nowhere else you were not given; switching the option off releases them.
Results may include \`warnings\`: parts of the request FigJam did not accept. Read them and fix the request.

## 5. Rules
- Report which board you connected to, and wait for the user's yes, before the first edit.
- Work only inside the workspace section. Never delete content you did not create.
- If a command says the plugin is not connected, ask the user to open the AI Bridge plugin in their board.
- Never ask the user to copy source files, install Node.js or type a port number. The companion already did that.
`;
}

// ---------- server ----------
async function serve(argv) {
  if (argv.includes('--background')) {
    const running = await findRunning();
    if (running) { out('AI Bridge is already running on port ' + running.port); return; }
    const child = cp.spawn(process.execPath, ['serve'], { detached: true, stdio: 'ignore', windowsHide: true, env: process.env });
    child.unref();
    out('AI Bridge started in the background');
    return;
  }
  const { WebSocketServer } = require('ws');
  let reg = readReg();
  if (!reg || !reg.token) reg = { app: 'ai-bridge', token: crypto.randomBytes(24).toString('hex') };
  const TOKEN = reg.token;

  const boards = new Map(); // id -> state
  const pending = new Map();
  let seq = 0;
  const newCode = () => { const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; let c; do { c = Array.from(crypto.randomBytes(4), b => A[b % A.length]).join(''); } while ([...boards.values()].some(b => b.code === c)); return c; };
  const announcePeers = () => boards.forEach(b => { try { b.ws.send(JSON.stringify({ type: 'peers', others: boards.size - 1 })); } catch (e) {} });
  const publicBoard = (b) => ({ code: b.code, id: b.id, name: b.name, page: b.page, plugin: b.kind, caps: b.caps, pluginVersion: b.pluginVersion, workspace: b.scope ? b.scope.name : null, canCreate: !!b.canCreate, owned: b.owned || [], connectedAt: b.connectedAt, verifiedAt: b.verifiedAt || null, verifiedBy: b.verifiedBy || null });
  const authOk = (req) => {
    const h = String(req.headers.authorization || '');
    if (!h.startsWith('Bearer ')) return false;
    const a = Buffer.from(h.slice(7)), b = Buffer.from(TOKEN);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  function pick(sel) {
    const list = [...boards.values()];
    if (!list.length) return { err: { code: 503, error: 'no board connected. Ask the user to open the AI Bridge plugin in the FigJam board they want to work on.', boards: [] } };
    if (sel) {
      const s = String(sel).toLowerCase();
      const hit = list.filter(b => b.code.toLowerCase() === s || b.id === sel || String(b.name).toLowerCase() === s);
      if (hit.length === 1) return { board: hit[0] };
      return { err: { code: 404, error: hit.length ? 'board name is ambiguous, use the code' : 'no board matches', boards: list.map(publicBoard) } };
    }
    if (list.length === 1) return { board: list[0] };
    return { err: { code: 409, error: 'several boards are connected. Ask the user which one, then pass --board CODE.', boards: list.map(publicBoard) } };
  }

  const server = http.createServer((req, res) => {
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.headers.origin) return send(403, { error: 'browser requests are not allowed' });
    if (req.method === 'GET' && req.url === '/health') return send(200, { app: 'ai-bridge', version: VERSION, protocol: PROTOCOL, boards: boards.size, iid: iidOf(TOKEN) });
    if (!authOk(req)) return send(401, { error: 'missing or wrong token. The client reads it from ' + REG });
    if (req.method === 'GET' && req.url === '/boards') return send(200, { boards: [...boards.values()].map(publicBoard) });
    if (req.method === 'POST' && req.url === '/shutdown') { send(200, { ok: true }); setTimeout(() => process.exit(0), 100); return; }
    if (req.method === 'POST' && req.url === '/cmd') {
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) return send(415, { error: 'content-type must be application/json' });
      const chunks = []; let size = 0;
      req.on('data', c => { size += c.length; if (size > 64 * 1024 * 1024) { req.destroy(); } else chunks.push(c); });
      req.on('end', () => {
        let parsed; try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { return send(400, { error: 'bad json' }); }
        const p = pick(parsed.board);
        if (p.err) return send(p.err.code, { error: p.err.error, boards: p.err.boards });
        const b = p.board;
        const need = [...new Set((parsed.ops || []).map(o => o && typeof o.op === 'string' && o.op.includes('.') ? o.op.split('.')[0] : 'base'))];
        const missing = need.filter(c => !b.caps.includes(c));
        if (missing.length) return send(422, { error: 'The plugin open on this board (' + (b.kind === 'point-pattern' ? 'AI Canvas' : 'AI Bridge') + ') cannot do "' + missing.join('", "') + '" operations. ' + (missing.includes('pp') ? (b.kind === 'point-pattern' ? 'AI Canvas is open, but this version cannot do vector operations yet.' : 'Ask the user to open AI Canvas in this board.') : 'Check the operation names in the instructions.'), board: publicBoard(b) });
        const id = ++seq;
        const client = String(req.headers['x-client'] || parsed.client || 'unknown').slice(0, 60);
        const t = setTimeout(() => { pending.delete(id); send(504, { error: 'timeout waiting for FigJam. Is the plugin window still open?' }); }, 120000);
        pending.set(id, (result) => {
          clearTimeout(t);
          const ops = parsed.ops || [];
          const idIdx = ops.findIndex(o => o && o.op === 'identity');
          if (idIdx >= 0 && result[idIdx] && result[idIdx].ok) {
            b.verifiedAt = Date.now(); b.verifiedBy = client;
            const d = result[idIdx].data || {};
            if (d.scope !== undefined) b.scope = d.scope ? { id: d.scope.id, name: d.scope.name } : null;
            try { b.ws.send(JSON.stringify({ type: 'verified', by: client, at: b.verifiedAt })); } catch (e) {}
          }
          send(200, { board: publicBoard(b), result });
        });
        b.ws.send(JSON.stringify({ type: 'cmd', id, ops: parsed.ops || [], client }));
      });
      return;
    }
    send(404, { error: 'not found' });
  });

  const wss = new WebSocketServer({
    server, maxPayload: 256 * 1024 * 1024,
    verifyClient: (info) => { const o = info.origin; return !o || o === 'null' || /^https:\/\/([a-z0-9-]+\.)?figma\.com$/.test(o) || (!!process.env.AIBRIDGE_TEST_ORIGIN && o === process.env.AIBRIDGE_TEST_ORIGIN); } // AIBRIDGE_TEST_ORIGIN is for automated UI tests only
  });
  wss.on('error', () => {}); // listen errors are handled where we pick a port
  wss.on('connection', (ws) => {
    let me = null;
    ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (data) => {
      let m; try { m = JSON.parse(data.toString()); } catch (e) { return; }
      if (m.type === 'hello') {
        if (m.protocol !== PROTOCOL) { ws.send(JSON.stringify({ type: 'incompatible', server: { version: VERSION, protocol: PROTOCOL }, plugin: { protocol: m.protocol } })); setTimeout(() => ws.close(), 200); return; }
        const KINDS = ['ai-bridge', 'point-pattern'];
        const kind = KINDS.includes(m.kind) ? m.kind : 'ai-bridge';
        const caps = Array.isArray(m.caps) ? m.caps.filter(c => /^[a-z]{1,12}$/.test(String(c))).slice(0, 10) : ['base'];
        me = { id: crypto.randomBytes(6).toString('hex'), code: newCode(), kind, caps, pluginVersion: String(m.pluginVersion || '').slice(0, 20), ws, name: String(m.name || 'Untitled').slice(0, 200), page: String(m.page || '').slice(0, 200), scope: m.scope || null, canCreate: !!m.canCreate, owned: Array.isArray(m.owned) ? m.owned.slice(0, 20).map(x => String(x).slice(0, 80)) : [], connectedAt: Date.now() };
        boards.set(me.id, me);
        ws.send(JSON.stringify({ type: 'welcome', id: me.id, code: me.code, version: VERSION, protocol: PROTOCOL, autostart: autostartGet(), others: boards.size - 1 }));
        out('board connected: ' + me.name + ' [' + me.code + ']');
        announcePeers();
        return;
      }
      if (!me) return;
      if (m.type === 'identity') { me.name = String(m.name || me.name).slice(0, 200); me.page = String(m.page || me.page).slice(0, 200); me.scope = m.scope || null; me.canCreate = !!m.canCreate; me.owned = Array.isArray(m.owned) ? m.owned.slice(0, 20).map(x => String(x).slice(0, 80)) : []; return; }
      if (m.type === 'result' && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
      if (m.type === 'set-autostart') { let on = false, err = null; try { on = autostartSet(!!m.on); } catch (e) { err = String(e.message || e); } ws.send(JSON.stringify({ type: 'autostart', on, error: err })); return; }
    });
    ws.on('close', () => { if (me && boards.get(me.id) === me) { boards.delete(me.id); out('board disconnected: ' + me.name); announcePeers(); } });
  });
  setInterval(() => { wss.clients.forEach(ws => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; try { ws.ping(); } catch (e) {} }); }, 20000).unref();

  // Pick a port. If one answers as AI Bridge we are a duplicate; if another program holds it, move on.
  for (let attempt = 0; attempt < 2; attempt++) {
  for (const port of PORTS) {
    const existing = await health(port);
    if (existing && existing.iid === iidOf(TOKEN)) { out('AI Bridge is already running on port ' + port); return; }
    if (existing) continue; // another person's AI Bridge holds this port: use the next one
    const ok = await new Promise((resolve) => {
      const onErr = (e) => { server.removeListener('listening', onOk); resolve(e.code === 'EADDRINUSE' ? false : Promise.reject(e)); };
      const onOk = () => { server.removeListener('error', onErr); resolve(true); };
      server.once('error', onErr); server.once('listening', onOk); server.listen(port, '127.0.0.1');
    }).catch(() => false);
    if (ok) {
      writeReg({ app: 'ai-bridge', version: VERSION, protocol: PROTOCOL, port, token: TOKEN, exe: fs.existsSync(INSTALLED_EXE) ? INSTALLED_EXE : process.execPath, instructions: path.join(HOME, 'instructions.md'), pid: process.pid, startedAt: new Date().toISOString() });
      try { fs.unlinkSync(path.join(HOME, 'last-error.txt')); } catch (e) {}
      out('AI Bridge listening on http://127.0.0.1:' + port);
      return; // keep process alive via the server
    }
  }
  if (attempt === 0) { // every port looks taken: clear old AI Bridge copies that no longer answer, then try once more
    let cleared = []; try { cleared = await monitor.clearStale(monCtx()); } catch (e) {}
    if (cleared.length) { out('Cleared ' + cleared.length + ' old AI Bridge copy(ies) that no longer answered.'); continue; }
  }
  break;
  }
  let holders = []; try { holders = await monitor.whoHolds(monCtx()); } catch (e) {}
  const msg = 'Ports ' + PORTS.join(', ') + ' are all in use' + (holders.length ? ': ' + holders.join(', ') : ' by other programs') + '. Close the program holding one of them, or open the AI Bridge monitor and press Restart.';
  try { fs.mkdirSync(HOME, { recursive: true }); fs.writeFileSync(path.join(HOME, 'last-error.txt'), msg); } catch (e) {}
  out(msg); process.exit(2);
}

// ---------- client commands ----------
function parseArgs(argv) { const o = { _: [] }; for (let i = 0; i < argv.length; i++) { if (argv[i].startsWith('--')) { o[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true; } else o._.push(argv[i]); } return o; }
async function needServer() {
  const run = await findRunning();
  if (!run) { out(JSON.stringify({ companion: 'stopped', hint: 'Start it: run "' + INSTALLED_EXE + '" serve --background (or Start menu > AI Bridge). If it is not installed, run the AI Bridge installer.' })); process.exit(3); }
  const reg = run.reg || readReg();
  if (!reg || !reg.token) { out(JSON.stringify({ error: 'registration file missing: ' + REG })); process.exit(3); }
  return { port: run.port, token: reg.token, health: run.health };
}
async function cmdStatus() {
  const run = await findRunning();
  if (!run) return out(JSON.stringify({ companion: 'stopped', registration: !!readReg() }, null, 2));
  const b = await request(run.port, 'GET', '/boards', undefined, (run.reg || {}).token);
  out(JSON.stringify({ companion: 'running', version: run.health.version, protocol: run.health.protocol, port: run.port, boards: (b.json && b.json.boards) || [], autostart: autostartGet() }, null, 2));
}
async function cmdBoards() { const s = await needServer(); const b = await request(s.port, 'GET', '/boards', undefined, s.token); out(JSON.stringify(b.json, null, 2)); }
async function sendOps(ops, boardSel) {
  const s = await needServer();
  const r = await request(s.port, 'POST', '/cmd', { ops, board: boardSel }, s.token, 125000);
  await saveExports(r);
  return r;
}
// Exported pictures come back as base64. Save them to files so the AI gets a path, not a wall of text.
async function saveExports(r) {
  if (r.json && Array.isArray(r.json.result)) {
    for (const res of r.json.result) {
      if (res && res.ok && res.data && typeof res.data.base64 === 'string') {
        try {
          const dir = path.join(HOME, 'exports'); fs.mkdirSync(dir, { recursive: true });
          const ext = String(res.data.format || 'png').toLowerCase();
          const file = path.join(dir, String(res.data.name || 'export').replace(/[^\w.-]+/g, '_').slice(0, 40) + '-' + Date.now() + '.' + ext);
          fs.writeFileSync(file, Buffer.from(res.data.base64, 'base64'));
          res.data.file = file; delete res.data.base64;
        } catch (e) { res.data.saveError = String(e.message || e); }
      }
    }
  }
  return r;
}
function verifyText(r) {
  if (r.status !== 200) return { ok: false, text: JSON.stringify(r.json || { error: 'no answer from the companion' }, null, 2) };
  const res = r.json.result[0];
  if (!res || !res.ok) return { ok: false, text: JSON.stringify(r.json, null, 2) };
  const d = res.data, b = r.json.board;
  const lines = [
    'VERIFIED: a real read through the plugin succeeded.',
    'Board name: ' + d.fileName + "   (from Figma's document name; the file key is not verifiable)",
    'Page: ' + d.page,
    'Board code: ' + b.code + '   (the user can see this code in the plugin window)',
    'Plugin: ' + (b.plugin === 'point-pattern' ? 'AI Canvas' : 'AI Bridge') + (b.caps ? ' (can do: ' + b.caps.join(', ') + ')' : ''),
    'Workspace section: ' + (d.scope ? d.scope.name + ' [' + d.scope.id + ']' : (d.canCreate ? 'none chosen. You may create your own section with the section op.' : 'NONE. The user must select a section and press "Use selected section" in the plugin before you can edit, or switch on "Let the AI create sections".')),
    'AI may create sections: ' + (d.canCreate ? 'YES (the user switched it on)' + (d.owned && d.owned.length ? '. Sections you made: ' + d.owned.map(x => x.name).join(', ') : '') : 'no. Only the workspace section can be used.'),
    'Top-level sections: ' + (d.sections.length ? d.sections.map(x => x.name).join(', ') : '(none)'),
    'Now tell the user what you connected to and wait for their confirmation before editing.'
  ];
  return { ok: true, text: lines.join('\n') };
}
async function cmdVerify(a) {
  const v = verifyText(await sendOps([{ op: 'identity' }], a.board));
  out(v.text); if (!v.ok) process.exit(4);
}
async function cmdSend(a) {
  const file = a._[1]; if (!file) { out('usage: send ops.json [--board CODE]   (use - for standard input)'); process.exit(1); }
  const text = file === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(file, 'utf8');
  let ops = JSON.parse(text); if (!Array.isArray(ops)) ops = ops.ops;
  const r = await sendOps(ops, a.board);
  out(JSON.stringify(r.json, null, 2)); if (r.status !== 200) process.exit(4);
}
async function cmdStop() { const run = await findRunning(); if (!run) return out('not running'); await request(run.port, 'POST', '/shutdown', {}, (run.reg || {}).token); out('stopped'); }
async function cmdAutostart(a) {
  const v = a._[1];
  if (v === 'on' || v === 'off') { try { autostartSet(v === 'on'); } catch (e) { out('failed: ' + e.message); process.exit(1); } }
  out('autostart: ' + (autostartGet() ? 'on' : 'off'));
}

// ---------- desktop apps: MCP over standard input and output ----------
// Claude's and Codex's desktop apps start this program with the argument "mcp" and talk to it in JSON-RPC lines.
// Nothing but protocol messages may be written to standard output in this mode.
async function ensureCompanion() {
  let run = await findRunning();
  if (run) return run;
  try { cp.spawn(fs.existsSync(INSTALLED_EXE) ? INSTALLED_EXE : process.execPath, ['serve'], { detached: true, stdio: 'ignore', windowsHide: true, env: process.env }).unref(); } catch (e) {}
  for (let i = 0; i < 20 && !run; i++) { await sleep(300); run = await findRunning(); }
  return run;
}
async function callBridge(ops, board) {
  const run = await ensureCompanion();
  if (!run) return { status: 0, json: { error: 'AI Bridge is not running and could not be started. Ask the user to open AI Bridge from the Start menu.' } };
  const reg = run.reg || readReg();
  const r = await request(run.port, 'POST', '/cmd', { ops, board }, reg && reg.token, 125000);
  await saveExports(r);
  return r;
}
const MCP_TOOLS = [
  { name: 'bridge_instructions', description: 'Read this first. The rules and the full list of operations for drawing on the FigJam board through AI Bridge.', inputSchema: { type: 'object', properties: {} } },
  { name: 'bridge_status', description: 'Is AI Bridge running, and which FigJam boards are connected (with their board codes).', inputSchema: { type: 'object', properties: {} } },
  { name: 'bridge_verify', description: 'Do a real read of the board the user has open in FigJam. Reports the board name, page, board code and workspace section. Tell the user what it reports and wait for their yes before editing. If several boards are open, pass the board code the user names.', inputSchema: { type: 'object', properties: { board: { type: 'string', description: 'board code, only needed when several boards are connected' } } } },
  { name: 'bridge_send', description: 'Run drawing operations on the FigJam board, inside the workspace section the user chose. ops is a list such as [{"op":"table","rows":[["A","B"],["1","2"]]}]. Call bridge_instructions for every operation. An export operation returns the picture so you can look at the board.', inputSchema: { type: 'object', properties: { ops: { type: 'array', items: { type: 'object' } }, board: { type: 'string' } }, required: ['ops'] } }
];
async function mcpCall(name, args) {
  args = args || {};
  if (name === 'bridge_instructions') { let t; try { t = fs.readFileSync(path.join(HOME, 'instructions.md'), 'utf8'); } catch (e) { t = instructionsText(); } return { content: [{ type: 'text', text: t }] }; }
  if (name === 'bridge_status') {
    const run = await ensureCompanion();
    if (!run) return { isError: true, content: [{ type: 'text', text: 'AI Bridge is not running and could not be started.' }] };
    const b = await request(run.port, 'GET', '/boards', undefined, (run.reg || readReg() || {}).token);
    return { content: [{ type: 'text', text: JSON.stringify({ companion: 'running', version: run.health.version, port: run.port, boards: (b.json && b.json.boards) || [] }, null, 2) }] };
  }
  if (name === 'bridge_verify') { const v = verifyText(await callBridge([{ op: 'identity' }], args.board)); return { isError: !v.ok, content: [{ type: 'text', text: v.text }] }; }
  if (name === 'bridge_send') {
    if (!Array.isArray(args.ops)) return { isError: true, content: [{ type: 'text', text: 'ops must be an array' }] };
    const r = await callBridge(args.ops, args.board);
    const content = [{ type: 'text', text: JSON.stringify(r.json, null, 2) }];
    for (const res of ((r.json && r.json.result) || [])) {
      const f = res && res.ok && res.data && res.data.file;
      if (f && /\.(png|jpg)$/i.test(f)) { try { content.push({ type: 'image', data: fs.readFileSync(f).toString('base64'), mimeType: /\.png$/i.test(f) ? 'image/png' : 'image/jpeg' }); } catch (e) {} }
    }
    return { isError: r.status !== 200, content };
  }
  return { isError: true, content: [{ type: 'text', text: 'unknown tool: ' + name }] };
}
async function mcpServe() {
  const write = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  let buf = '';
  process.stdin.setEncoding('utf8');
  async function handle(m) {
    const reply = (result) => { if (m.id !== undefined) write({ jsonrpc: '2.0', id: m.id, result }); };
    const fail = (code, message) => { if (m.id !== undefined) write({ jsonrpc: '2.0', id: m.id, error: { code, message } }); };
    try {
      if (m.method === 'initialize') {
        const ci = m.params && m.params.clientInfo; if (ci && ci.name && !process.env.AI_CLIENT) process.env.AI_CLIENT = String(ci.name).slice(0, 40);
        return reply({ protocolVersion: (m.params && m.params.protocolVersion) || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'ai-bridge', version: VERSION },
          instructions: 'AI Bridge draws on the FigJam board the user has open. Call bridge_instructions first, then bridge_verify, tell the user what it reports and wait for their yes before editing.' });
      }
      if (m.method === 'ping') return reply({});
      if (m.method === 'tools/list') return reply({ tools: MCP_TOOLS });
      if (m.method === 'tools/call') return reply(await mcpCall(m.params && m.params.name, m.params && m.params.arguments));
      if (m.method && m.method.startsWith('notifications/')) return;
      if (m.id !== undefined) fail(-32601, 'method not found: ' + m.method);
    } catch (e) { fail(-32603, String((e && e.message) || e)); }
  }
  process.stdin.on('data', (chunk) => {
    buf += chunk; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch (e) { write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); continue; }
      handle(m);
    }
  });
  process.stdin.on('end', () => setTimeout(() => process.exit(0), 3000));
}

// ---------- connect the desktop apps ----------
const CFG_ROOT = process.env.AIBRIDGE_CONFIG_ROOT; // tests only: pretend this folder is the user's profile
function claudeConfigPath() {
  if (CFG_ROOT) return path.join(CFG_ROOT, 'Claude', 'claude_desktop_config.json');
  if (WIN) return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  if (MAC) return path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  return path.join(os.homedir(), '.config', 'Claude', 'claude_desktop_config.json');
}
function codexConfigPath() { return path.join(CFG_ROOT || os.homedir(), '.codex', 'config.toml'); }
function bridgeExe() { return fs.existsSync(INSTALLED_EXE) ? INSTALLED_EXE : process.execPath; }
const DESKTOP_APPS = {
  'claude-desktop': {
    label: 'Claude desktop app',
    detect: () => fs.existsSync(path.dirname(claudeConfigPath())),
    connected: () => { try { const c = JSON.parse(fs.readFileSync(claudeConfigPath(), 'utf8')); return !!(c.mcpServers && c.mcpServers['ai-bridge']); } catch (e) { return false; } },
    connect: () => {
      const f = claudeConfigPath(); let cfg = {};
      if (fs.existsSync(f)) { try { cfg = JSON.parse(fs.readFileSync(f, 'utf8') || '{}'); } catch (e) { throw new Error('The Claude config file is not valid JSON, so I left it alone: ' + f); } }
      if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error('Unexpected content in ' + f + '; left alone.');
      if (fs.existsSync(f)) fs.copyFileSync(f, f + '.bak-aibridge');
      cfg.mcpServers = cfg.mcpServers || {};
      cfg.mcpServers['ai-bridge'] = { command: bridgeExe(), args: ['mcp'] };
      fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(cfg, null, 2));
      return f;
    }
  },
  'codex': {
    label: 'Codex desktop app',
    detect: () => fs.existsSync(path.dirname(codexConfigPath())),
    connected: () => { try { return fs.readFileSync(codexConfigPath(), 'utf8').includes('[mcp_servers.ai-bridge]'); } catch (e) { return false; } },
    connect: () => {
      const f = codexConfigPath(); let t = '';
      try { t = fs.readFileSync(f, 'utf8'); } catch (e) {}
      if (t.includes('[mcp_servers.ai-bridge]')) return f;
      if (t) fs.copyFileSync(f, f + '.bak-aibridge');
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, t + (t && !t.endsWith('\n') ? '\n' : '') + "\n[mcp_servers.ai-bridge]\ncommand = '" + bridgeExe() + "'\nargs = [\"mcp\"]\n");
      return f;
    }
  }
};
async function cmdConnect(a) {
  const which = a._[1];
  if (!which || which === 'status') { Object.entries(DESKTOP_APPS).forEach(([k, v]) => out(k + ': ' + (v.connected() ? 'connected' : v.detect() ? 'installed, not connected' : 'not found'))); return; }
  const list = which === 'all' ? Object.keys(DESKTOP_APPS) : [which];
  for (const k of list) {
    const app = DESKTOP_APPS[k]; if (!app) { out('unknown app: ' + k + ' (use claude-desktop, codex or all)'); process.exit(1); }
    if (!app.detect() && which === 'all') { out(app.label + ': not found, skipped'); continue; }
    const f = app.connect(); out(app.label + ': added AI Bridge (' + f + '). Close and reopen the app once.');
  }
}
function ask(question, seconds) {
  return new Promise((resolve) => {
    const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
    const t = setTimeout(() => { rl.close(); resolve(''); }, (seconds || 20) * 1000);
    rl.question(question, (ans) => { clearTimeout(t); rl.close(); resolve(String(ans).trim().toLowerCase()); });
  });
}

// ---------- installer ----------
async function install() {
  out('AI Bridge setup (version ' + VERSION + ')');
  out('Installing for this user only. No administrator rights are needed.');
  fs.mkdirSync(HOME, { recursive: true });
  const prev = readReg();
  const run = await findRunning();
  if (run) { out('Stopping the running AI Bridge to update it...'); await request(run.port, 'POST', '/shutdown', {}, (run.reg || {}).token); await sleep(800); }
  let copied = false;
  if (path.resolve(process.execPath).toLowerCase() !== path.resolve(INSTALLED_EXE).toLowerCase()) {
    for (let i = 0; i < 10 && !copied; i++) { try { fs.copyFileSync(process.execPath, INSTALLED_EXE); copied = true; } catch (e) { await sleep(500); } }
    if (!copied) { out('Could not copy the program (is it still running?). Close AI Bridge and try again.'); return 1; }
    out('Installed program: ' + INSTALLED_EXE);
  }
  try { if (!WIN) fs.chmodSync(INSTALLED_EXE, 0o755); } catch (e) {}
  writeReg({ app: 'ai-bridge', version: VERSION, protocol: PROTOCOL, port: (prev && prev.port) || PORTS[0], token: (prev && prev.token) || crypto.randomBytes(24).toString('hex'), exe: INSTALLED_EXE, instructions: path.join(HOME, 'instructions.md'), installedAt: new Date().toISOString() });
  fs.writeFileSync(path.join(HOME, 'instructions.md'), instructionsText());
  out('Wrote instructions for AI tools: ' + path.join(HOME, 'instructions.md'));
  if (WIN && !NO_SYSTEM) {
    try {
      const lnkDir = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
      const ps = "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('" + path.join(lnkDir, 'AI Bridge.lnk').replace(/'/g, "''") + "');$s.TargetPath='" + INSTALLED_EXE.replace(/'/g, "''") + "';$s.Arguments='serve --background';$s.WindowStyle=7;$s.Description='Start AI Bridge';$s.Save()";
      cp.execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore' });
      out('Added Start menu entry: AI Bridge');
      const ps2 = ps.replace('AI Bridge.lnk', 'AI Bridge Monitor.lnk').replace("serve --background", "monitor").replace('$s.WindowStyle=7;', '').replace('Start AI Bridge', 'Shows whether AI Bridge is working');
      cp.execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps2], { stdio: 'ignore' });
      out('Added Start menu entry: AI Bridge Monitor (status, restart, usage)');
    } catch (e) { out('Could not add a Start menu entry (not required).'); }
  }
  out('Starting AI Bridge...');
  const child = cp.spawn(INSTALLED_EXE, ['serve'], { detached: true, stdio: 'ignore', windowsHide: true, env: process.env });
  child.unref();
  let up = null;
  const deadline = Date.now() + 12000;
  while (!up && Date.now() < deadline) { await sleep(300); up = await findRunning(); }
  if (!up) {
    const err = (() => { try { return fs.readFileSync(path.join(HOME, 'last-error.txt'), 'utf8'); } catch (e) { return 'It did not start. Try the Start menu entry AI Bridge.'; } })();
    out('AI Bridge did not start: ' + err); return 2;
  }
  if (process.stdin.isTTY && process.stdout.isTTY) {
    for (const [k, app] of Object.entries(DESKTOP_APPS)) {
      if (!app.detect() || app.connected()) continue;
      const ans = await ask('\nAdd AI Bridge to the ' + app.label + '? It then shows up as a tool the app can use. [Y/n] ', 25);
      if (ans === '' || ans === 'y' || ans === 'yes') { try { const f = app.connect(); out('Added to ' + app.label + ' (' + f + '). Close and reopen the app once.'); } catch (e) { out('Could not add it: ' + e.message); } }
      else out('Skipped. You can do it later with: ai-bridge connect ' + k);
    }
  } else out('To use a desktop app: run  ai-bridge connect claude-desktop  or  ai-bridge connect codex.');
  out('');
  out('Done. AI Bridge is running (port ' + up.port + ').');
  out('Go back to FigJam: the AI Bridge plugin window will connect by itself.');
  return 0;
}
async function uninstall() {
  const run = await findRunning(); if (run) { await request(run.port, 'POST', '/shutdown', {}, (run.reg || {}).token); await sleep(800); }
  try { autostartSet(false); } catch (e) {}
  try { monitor.monitorAutostartSet(monCtx(), false); } catch (e) {}
  if (WIN && !NO_SYSTEM) { for (const d of [path.join(process.env.USERPROFILE || '', 'Desktop'), path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs')]) { try { fs.unlinkSync(path.join(d, 'AI Bridge Monitor.lnk')); } catch (e) {} } }
  if (WIN && !NO_SYSTEM) { try { fs.unlinkSync(path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'AI Bridge.lnk')); } catch (e) {} }
  for (const f of ['bridge.json', 'instructions.md', 'last-error.txt', 'autostart.flag', 'monitor.json', 'monitor-autostart.flag', 'tray.ps1']) { try { fs.unlinkSync(path.join(HOME, f)); } catch (e) {} }
  out('Removed registration, instructions and shortcuts. Delete the folder ' + HOME + ' to remove the program file itself.');
}

(async () => {
  const argv = process.argv.slice(2);
  const a = parseArgs(argv);
  const cmd = a._[0];
  try {
    if (!cmd) { const code = await install(); if (process.stdout.isTTY) await sleep(4000); process.exit(code); }
    else if (cmd === 'serve') await serve(argv);
    else if (cmd === 'install') process.exit(await install());
    else if (cmd === 'status') await cmdStatus();
    else if (cmd === 'boards') await cmdBoards();
    else if (cmd === 'verify') await cmdVerify(a);
    else if (cmd === 'send') await cmdSend(a);
    else if (cmd === 'stop') await cmdStop();
    else if (cmd === 'autostart') await cmdAutostart(a);
    else if (cmd === 'uninstall') await uninstall();
    else if (cmd === 'mcp') await mcpServe();
    else if (cmd === 'monitor') await monitor.runMonitor(monCtx(), argv);
    else if (cmd === 'restart') { const r = await monitor.restart(monCtx(), { everything: !!a.all }); out(JSON.stringify(r)); process.exit(r.ok ? 0 : 2); }
    else if (cmd === 'connect') await cmdConnect(a);
    else if (cmd === 'version') out(VERSION);
    else { out('AI Bridge ' + VERSION + '\ncommands: status, boards, verify, send, autostart, connect, mcp, stop, restart, monitor, serve, install, uninstall'); }
  } catch (e) { out('error: ' + (e && e.message || e)); process.exit(1); }
})();
