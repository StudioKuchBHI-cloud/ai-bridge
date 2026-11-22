// Builds dist/ai-bridge.exe: a single program with Node built in (no Node needed on the user's machine).
const { execFileSync } = require('child_process');
const fs = require('fs'), path = require('path');
const dist = path.join(__dirname, 'dist'); fs.mkdirSync(dist, { recursive: true });
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit', cwd: __dirname });
const npx = (args) => run(process.execPath, [path.join(__dirname, 'node_modules', args[0], args[1])].concat(args.slice(2)));
npx(['esbuild', 'bin/esbuild', 'src/main.js', '--bundle', '--platform=node', '--target=node22', '--external:bufferutil', '--external:utf-8-validate', '--outfile=dist/bundle.js']);
fs.writeFileSync(path.join(dist, 'sea-config.json'), JSON.stringify({ main: 'dist/bundle.js', output: 'dist/sea-prep.blob', disableExperimentalSEAWarning: true }));
run(process.execPath, ['--experimental-sea-config', 'dist/sea-config.json']);
const exe = path.join(dist, process.platform === 'win32' ? 'ai-bridge.exe' : 'ai-bridge');
fs.copyFileSync(process.execPath, exe);
npx(['postject', 'dist/cli.js', exe, 'NODE_SEA_BLOB', 'dist/sea-prep.blob', '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2']);
console.log('built', exe, (fs.statSync(exe).size / 1048576).toFixed(1) + ' MB');
