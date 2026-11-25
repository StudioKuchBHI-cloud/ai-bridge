# AI Bridge companion

A small program that runs on your own computer. It lets an AI tool (Claude Code, Codex, or the Claude and Codex desktop apps) look at, review and (in sections you allow) change parts of a FigJam board, through the **AI Canvas** plugin.

> **Be aware before you run it.** This is early software written quickly by one person. It has been tested against simulated plugins and on one real board over a few sessions. It has **not** been security-audited, the Windows program is **not code-signed**, and the macOS version has **not been built or tried**. Read the "What can go wrong" section first.

## What it is
```
AI tool  ->  ai-bridge program (on your computer, 127.0.0.1)  ->  AI Canvas plugin window in Figma  ->  your board
```
- One program (`ai-bridge.exe`, about 82 MB because it carries its own copy of Node.js, so you do not need Node installed). It is the installer, the local server, and the command-line client an AI tool calls.
- The plugin (AI Canvas, listing pending) connects to it from inside Figma. The program listens only on `127.0.0.1`, on the first free port from 3055 to 3058.
- The AI can only use the sections you share in the plugin. Each is read only (the AI may look at it and review it) until you switch it to Edit. If you switch it on, the AI may also create sections of its own. The plugin enforces these rules.

## What it does not do
- No account, no telemetry, no analytics, no update checks, no calls to any server on the internet. The program only talks to your own computer.
- It does not scan or read your files. It reads only what you point it at: an operations file you give the `send` command, and (only if you accept) the Claude or Codex configuration file when adding itself. Otherwise it passes operations to the plugin and returns the plugin's answers.
- It needs no administrator rights. It installs for the current user only.

## Install (Windows)
1. Download `AI-Bridge-Setup.exe` from the latest release. Compare its SHA-256 with the value in the release notes (`certutil -hashfile AI-Bridge-Setup.exe SHA256`).
2. Windows will probably say "Windows protected your PC" because the file is unsigned. That is true: choose **More info, then Run anyway** only if you are comfortable with that. If you are not, build it yourself (below).
3. It copies itself to `%LOCALAPPDATA%\AIBridge`, writes `bridge.json` (a random token and the port), `instructions.md` (what an AI tool reads), adds Start menu entries "AI Bridge" and "AI Bridge Monitor", and starts. If it finds the Claude or Codex desktop app it asks whether to add AI Bridge to that app's configuration (it saves a `.bak-aibridge` copy first).
4. In FigJam open the AI Canvas plugin, turn on AI mode, add the sections you want to share. The plugin finds the program by itself. The **Copy context for AI** button gives you the text to paste into your AI chat.

Uninstall: run `%LOCALAPPDATA%\AIBridge\ai-bridge.exe uninstall`, then delete the `AIBridge` folder. Remove the entry it added to the Claude or Codex configuration if you accepted it.

## Commands (what an AI tool runs)
`status`, `boards`, `verify`, `send <ops.json | ->`, `autostart on|off|status`, `connect claude-desktop|codex|all|status`, `mcp` (used by desktop apps), `stop`, `restart [--all]`, `monitor [--no-window]`, `serve [--background]`, `uninstall`. `verify` does a real read of the board and prints the file name, page, a four-letter board code and the chosen section, so the person can check the AI is on the right board.

## Drawing looks for the AI (gradients, mesh, tapered strokes, brushes, effects)
The instructions an AI reads include the rich look fields for vector drawings (companion 1.5.0 with AI Canvas plugin 1.5.0). The same text is in [RICH-LOOK-OPERATIONS.md](RICH-LOOK-OPERATIONS.md).

## The monitor (status, restart, usage)
`ai-bridge monitor` (or the Start menu entry "AI Bridge Monitor") opens a small window and a tray icon that show whether the bridge is working (green, grey or red), its port, the boards and agent connections, and the CPU and memory the AI Bridge programs use. **Restart AI Bridge** stops the bridge copies that hold its ports and starts one fresh copy, keeping the token. **Stop everything** also ends the agents' `ai-bridge mcp` connections. It only lists and stops programs started from its own install folder, never other programs. It serves its page only on `127.0.0.1` (ports 3060-3069), checks the Host and Origin of every request, and needs a per-run key for actions. Power use in watts is not shown: Windows does not report it per program.

## What is stored on your computer
- `%LOCALAPPDATA%\AIBridge\`: the program, `bridge.json`, `instructions.md`, `exports\` (pictures an AI exports from the board), and a `last-error.txt` if the ports are all busy.
- If you turn on "Start at sign-in": one entry in `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`.
- Start menu shortcuts. Optionally (switches in the monitor): a sign-in entry for the monitor and a desktop icon. The monitor keeps `monitor.json` and `tray.ps1` in the same folder.

## What can go wrong (known limits, not fixed)
- **Your AI tool sees what it reads.** Whatever the AI reads from your chosen section goes to whichever AI service that tool uses. This program does not control that. Choose the section deliberately.
- **The section rule is enforced by the plugin, not by this program.** The program forwards operations; the plugin refuses anything outside the sections you shared, and any change in a read only section. A modified or fake plugin would not.
- **A web page could pose as a board.** A page inside a sandboxed frame sends the same origin value ("null") as a Figma plugin window, so it could connect as a fake board. It could receive what the AI sends and answer with fake results. It cannot read your real board. Figma gives plugins no secret to prove who they are, so this cannot be closed from this side.
- **Any program running as your Windows user can read the token** in `bridge.json`, and therefore drive the program. This is the normal limit of a per-user tool.
- **Two Windows users on one computer** share ports 3055 to 3058. The programs recognise their own copy by an id derived from the token and move to the next port, but the plugin cannot tell which user's copy it reached.
- **Unsigned.** Windows SmartScreen will warn. There is no certificate and no publisher name.
- **Desktop apps:** the `connect` command edits a configuration file of another application. It keeps a backup, refuses to touch a file that is not valid, and was tested on a fake profile and against a stand-in client. It has **not** been tested against the real Claude and Codex desktop apps.
- **macOS and Linux:** the code has paths for them (an application-support folder, no sign-in entry yet), but nothing was built or run there.
- **Figma's plugin rules:** Figma runs one plugin per file at a time and may change plugin rules. The plugin has not been through Figma's review at the time of writing.
- **Not affiliated** with Figma, Anthropic or OpenAI.

## Build it yourself
Needs Node.js 22 or newer.
```
cd companion
npm install
node build.js        # writes companion/dist/ai-bridge.exe (Node's single-executable feature)
```
The build was run twice on the author's machine and gave byte-identical files; other machines have not been tried. The release file was built from this source with these commands.

## Tests
```
cd companion && npm install && node build.js
node ../tests/companion.test.js
node ../tests/companion2.test.js
node ../tests/monitor.test.js
```
They run the real program in an empty temporary folder with simulated plugins and check: install on a machine without Node on its PATH, token and origin checks, several boards, desktop-app (MCP) mode, the config helper on a fake profile, upgrade from an older version, and busy ports. They do **not** cover real Figma, real desktop apps, a clean virtual machine, or antivirus behaviour.

## Licence
**No licence has been chosen yet.** That means all rights are reserved: you may run the program, but you do not have permission to copy, change or redistribute the code. A licence may be added later.

## Issues
Please report problems as GitHub issues on this repository.
