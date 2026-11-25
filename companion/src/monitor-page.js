'use strict';
// The desk widget page. Served by the monitor at http://127.0.0.1:<port>/ . No outside resources: everything is inline.
// The page script uses plain string joins (no template literals) so this file can hold it as one template string.
exports.html = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI Bridge monitor</title>
<style>
:root{--bg:#f6f4ee;--card:#fff;--ink:#1d1d1b;--mute:#6b6a64;--line:#dedbd0;--ok:#1f9a5a;--off:#8a8a85;--bad:#d03c32;--accent:#1d1d1b;--accentInk:#fff;--cpu:#3b6fd4;--ram:#c07a1a}
@media (prefers-color-scheme:dark){:root{--bg:#181816;--card:#232321;--ink:#efede6;--mute:#a09e95;--line:#3a3935;--ok:#37c27a;--off:#8a8a85;--bad:#ef6a5f;--accent:#efede6;--accentInk:#181816;--cpu:#7aa2f0;--ram:#e0a24a}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:13px/1.45 system-ui,Segoe UI,sans-serif;padding:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px;margin-bottom:10px}
.head{display:flex;align-items:center;gap:12px}
.light{width:38px;height:38px;border-radius:50%;background:var(--off);flex:none;box-shadow:0 0 0 4px color-mix(in srgb,var(--off) 25%,transparent)}
.light.running{background:var(--ok);box-shadow:0 0 0 4px color-mix(in srgb,var(--ok) 28%,transparent)}
.light.blocked{background:var(--bad);box-shadow:0 0 0 4px color-mix(in srgb,var(--bad) 28%,transparent)}
h1{font-size:16px;margin:0}.sub{color:var(--mute);margin:2px 0 0}
.facts{display:flex;gap:14px;margin-top:10px;color:var(--mute);flex-wrap:wrap}.facts b{color:var(--ink)}
.boards{margin:8px 0 0;padding:0;list-style:none}.boards li{display:flex;justify-content:space-between;gap:8px;padding:3px 0;border-top:1px solid var(--line)}.code{font-family:ui-monospace,Consolas,monospace;color:var(--mute)}
.warn{margin-top:8px;color:var(--bad)}
.row{display:flex;gap:8px;flex-wrap:wrap}
button{font:inherit;border:1px solid var(--line);background:var(--card);color:var(--ink);padding:7px 12px;border-radius:7px;cursor:pointer}
button.primary{background:var(--accent);color:var(--accentInk);border-color:var(--accent)}
button:disabled{opacity:.5;cursor:default}
.msg{min-height:18px;margin-top:8px;color:var(--mute)}
h2{font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:var(--mute);margin:0 0 8px}
.gl{display:flex;justify-content:space-between;align-items:baseline}.gl span{color:var(--mute)}.gl b{font-size:15px}
canvas{width:100%;height:56px;display:block;margin:2px 0 8px}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:3px 0;border-top:1px solid var(--line);font-size:12px}th{color:var(--mute);font-weight:500}td.n,th.n{text-align:right}
.note{color:var(--mute);font-size:12px;margin-top:6px}
label.sw{display:flex;align-items:center;gap:8px;padding:4px 0}
</style></head><body>
<div class="card">
  <div class="head"><div id="light" class="light"></div><div><h1 id="title">AI Bridge</h1><p class="sub" id="sub">Checking</p></div></div>
  <div class="facts"><span>Port <b id="port">-</b></span><span>Boards <b id="nb">0</b></span><span>Agents <b id="na">0</b></span><span>Version <b id="ver">-</b></span></div>
  <ul class="boards" id="boards"></ul>
  <div class="warn" id="warn"></div>
</div>
<div class="card">
  <div class="row"><button class="primary" id="bRestart">Restart AI Bridge</button><button id="bStop">Stop everything</button></div>
  <div class="msg" id="msg"></div>
  <div class="note">Restart stops the AI Bridge program and starts one fresh copy. Your agents stay connected. Stop everything also ends their AI Bridge connections, so reopen those chats afterwards.</div>
</div>
<div class="card">
  <h2>Usage, last 5 minutes</h2>
  <div class="gl"><span>CPU (all AI Bridge programs)</span><b id="cpuN">0%</b></div><canvas id="cCpu"></canvas>
  <div class="gl"><span>Memory</span><b id="ramN">0 MB</b></div><canvas id="cRam"></canvas>
  <table><thead><tr><th>Program</th><th class="n">PID</th><th class="n">CPU</th><th class="n">MB</th></tr></thead><tbody id="rows"></tbody></table>
  <div class="note">Power in watts cannot be measured per program on Windows, so it is not shown.</div>
</div>
<div class="card">
  <label class="sw"><input type="checkbox" id="swBridge"> Start AI Bridge when I sign in</label>
  <label class="sw"><input type="checkbox" id="swMon"> Show this status icon when I sign in</label>
  <div class="row" style="margin-top:6px"><button id="bDesk">Put an icon on my desktop</button></div>
</div>
<script>
var KEY="__KEY__", last=null, stopArm=0;
function $(i){return document.getElementById(i);}
function css(n){return getComputedStyle(document.documentElement).getPropertyValue(n).trim();}
function post(a,extra){var b=Object.assign({action:a},extra||{});return fetch("/api/action",{method:"POST",headers:{"x-key":KEY,"content-type":"application/json"},body:JSON.stringify(b)}).then(function(r){return r.json();});}
function setMsg(t){$("msg").textContent=t||"";}
var ROLE={bridge:"AI Bridge",agent:"Agent connection",monitor:"This monitor",other:"Other"};
function draw(id,vals,color,unit){var c=$(id),d=window.devicePixelRatio||1,w=c.clientWidth,h=c.clientHeight;c.width=w*d;c.height=h*d;var g=c.getContext("2d");g.scale(d,d);g.clearRect(0,0,w,h);
 g.strokeStyle=css("--line");g.lineWidth=1;g.beginPath();g.moveTo(0,h-.5);g.lineTo(w,h-.5);g.stroke();if(vals.length<2)return;
 var mx=Math.max.apply(null,vals.concat([unit==="%"?5:50]));mx=unit==="%"?Math.max(5,Math.ceil(mx/5)*5):Math.ceil(mx/50)*50;
 g.strokeStyle=color;g.lineWidth=2;g.lineJoin="round";g.beginPath();vals.forEach(function(v,i){var x=i/(vals.length-1)*(w-2)+1,y=h-3-(v/mx)*(h-8);if(i)g.lineTo(x,y);else g.moveTo(x,y);});g.stroke();
 g.fillStyle=css("--mute");g.font="10px system-ui";g.fillText(mx+(unit==="%"?"%":" MB"),w-44,10);}
function render(s){last=s;var L=$("light");L.className="light "+(s.state==="running"?"running":s.state==="blocked"?"blocked":"");
 $("title").textContent=s.state==="running"?"AI Bridge is working":s.state==="blocked"?"AI Bridge cannot start":"AI Bridge is not running";
 $("sub").textContent=s.state==="running"?"Your AI tools can reach your boards.":s.state==="blocked"?"Every port it uses is taken.":"Press Restart AI Bridge to start it.";
 document.title=$("title").textContent;
 $("port").textContent=s.bridge?s.bridge.port:"-";$("ver").textContent=s.bridge&&s.bridge.version?s.bridge.version:"-";
 var bs=s.bridge?s.bridge.boards:[];$("nb").textContent=bs.length;$("na").textContent=s.agents;
 $("boards").innerHTML="";bs.forEach(function(b){var li=document.createElement("li");var a=document.createElement("span");a.textContent=b.name||"Board";var c=document.createElement("span");c.className="code";c.textContent=b.code;li.appendChild(a);li.appendChild(c);$("boards").appendChild(li);});
 var w=[];(s.ports||[]).forEach(function(p){if(p.state==="other")w.push("Port "+p.port+" is held by "+p.holder+".");});$("warn").textContent=s.state!=="running"?w.join(" "):"";
 var h=s.history||[];draw("cCpu",h.map(function(x){return x.cpu;}),css("--cpu"),"%");draw("cRam",h.map(function(x){return x.mb;}),css("--ram"),"MB");
 $("cpuN").textContent=s.totals.cpu+"%";$("ramN").textContent=s.totals.mb+" MB";
 var tb=$("rows");tb.innerHTML="";(s.procs||[]).forEach(function(p){var tr=document.createElement("tr");[ROLE[p.role]||p.role,p.pid,p.cpu+"%",p.mb].forEach(function(v,i){var td=document.createElement("td");if(i)td.className="n";td.textContent=v;tr.appendChild(td);});tb.appendChild(tr);});
 if(!(s.procs||[]).length){var tr=document.createElement("tr");var td=document.createElement("td");td.colSpan=4;td.textContent="No AI Bridge programs are running.";tr.appendChild(td);tb.appendChild(tr);}
 if(document.activeElement!==$("swBridge"))$("swBridge").checked=!!s.autostart;if(document.activeElement!==$("swMon"))$("swMon").checked=!!s.monitorAutostart;}
function poll(){fetch("/api/status",{cache:"no-store"}).then(function(r){return r.json();}).then(render).catch(function(){$("title").textContent="Monitor stopped";$("sub").textContent="Reopen it from the Start menu or the tray icon.";$("light").className="light";});}
$("bRestart").onclick=function(){var b=this;b.disabled=true;setMsg("Restarting...");post("restart").then(function(r){setMsg(r.message);b.disabled=false;poll();}).catch(function(){b.disabled=false;setMsg("The monitor did not answer.");});};
$("bStop").onclick=function(){var b=this;if(Date.now()-stopArm>4000){stopArm=Date.now();b.textContent="Press again to confirm";setTimeout(function(){b.textContent="Stop everything";},4000);return;}stopArm=0;b.textContent="Stop everything";b.disabled=true;setMsg("Stopping...");post("stop-all").then(function(r){setMsg(r.message);b.disabled=false;poll();});};
$("swBridge").onchange=function(){var on=this.checked;post("autostart",{on:on}).then(function(r){if(!r.ok){setMsg(r.message);}poll();});};
$("swMon").onchange=function(){var on=this.checked;post("monitor-autostart",{on:on}).then(function(r){if(!r.ok){setMsg(r.message);}poll();});};
$("bDesk").onclick=function(){post("desktop-icon").then(function(r){setMsg(r.message);});};
poll();setInterval(poll,3000);window.addEventListener("resize",function(){if(last)render(last);});
</script></body></html>`;
