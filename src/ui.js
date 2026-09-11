// ui.js — rendering helpers.
// Dumbphones get exactly the same markup as before (meta refresh, plain HTML,
// no scripts, no CSS). "Cloud phone" browsers (CloudMosha CloudPhone etc. —
// headless Chromium, full client-side JS) additionally get: viewport CSS,
// tap-target styling, an auto-sized board (from the real screen size),
// locally ticking clocks, and in-place board updates via ?frag=1 polling.

export function escapeHtml(s) {
  return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

// Same as before, except a header value may now be an array (used for
// multiple Set-Cookie cookies on /settings). Single strings behave exactly
// as they did before.
export function htmlResponse(body, status = 200, headers = {}) {
  const h = new Headers({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  for (const [k, v] of Object.entries(headers || {})) {
    if (Array.isArray(v)) { for (const item of v) h.append(k, String(item)); }
    else h.append(k, String(v));
  }
  return new Response(body, { status, headers: h });
}

// ---------------------------------------------------------------------------
// Device / screen detection
// ---------------------------------------------------------------------------

// Browsers that keep the plain meta-refresh UI (no JS assumed).
const DUMB_UA = /kaios|opera mini|opera mobi|nitro|nokia|midp|obigo|teleca|netfront|jbrowser|maui|symbian/i;

// Cloud phones run full Chromium -> full JS. Desktop Chrome also matches,
// which is fine: it just gets the enhanced (superset) UI.
export function detectDevice(ua = '', screenCookie = '') {
  const s = String(ua || '');
  const cloud =
    /cloudphone|cloudmosha|puffin/i.test(s) ||
    (/chrome|chromium|crios|edg\//i.test(s) && !DUMB_UA.test(s));
  const screen = parseScreenCookie(screenCookie);
  return { cloud, screen, autoSize: screen ? autoBoardSizeKey(screen.w, screen.h) : null };
}

// '240x320' -> {w:240,h:320}. Stored orientation-agnostic (min x max).
export function parseScreenCookie(v) {
  const m = /(\d{2,5})x(\d{2,5})/.exec(String(v || ''));
  if (!m) return null;
  const w = +m[1], h = +m[2];
  if (w < 60 || h < 60 || w > 8000 || h > 8000) return null;
  return { w, h };
}

// Maps a screen to one of chess.js's named BOARD_SIZES. Thresholds leave
// room for the page margin: 128x160 -> tiny (116px board), 240x320 -> normal
// (220px), 320+ -> large, in-between -> small.
export function autoBoardSizeKey(w, h) {
  const n = Math.min(+w || 0, +h || 0);
  if (n >= 280) return 'large';
  if (n >= 225) return 'normal';
  if (n >= 150) return 'small';
  return 'tiny';
}

// Clock text in CSS px widths: m:ss, h:mm:ss, tenths under 10s.
export function fmtClockMs(ms) {
  ms = Math.max(0, Math.floor(+ms || 0));
  const t = Math.floor(ms / 1000);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  if (h) return `${h}:${p(m)}:${p(s)}`;
  if (ms < 10000) return `${m}:${p(s)}.${Math.floor(ms / 100) % 10}`;
  return `${m}:${p(s)}`;
}

// ---------------------------------------------------------------------------
// Live-mode building blocks (harmless no-ops on dumbphones)
// ---------------------------------------------------------------------------

function clockStateScript(state) {
  const json = JSON.stringify(state || {}).replace(/</g, '\\u003c');
  return `<script type="application/json" id="clockstate">${json}</script>`;
}

// Everything inside #boardzone is replaced in place by the live poller:
// player bars (with clocks), the board, prompts and the move form. Static
// actions (resign, refresh, home links) stay OUTSIDE the zone so a tap on
// them can never be interrupted by a swap.
export function boardZone(inner, clockState) {
  return `<div id="boardzone">${inner}</div>${clockStateScript(clockState)}`;
}

// Response body for GET /game/:id?frag=1 — just the zone + fresh clock JSON.
export function fragmentResponse(inner, clockState) {
  return htmlResponse(boardZone(inner, clockState));
}

// ---------------------------------------------------------------------------
// Page shell
// ---------------------------------------------------------------------------

const CP_CSS = `html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:4px;font:14px/1.4 sans-serif;overflow-wrap:break-word}
p{margin:3px 0}
a{display:inline-block;padding:4px 8px;margin:1px 0;border:1px solid #aaa;border-radius:3px;background:#eee;color:#00d;text-decoration:none}
button,select,input,textarea{font:15px sans-serif;padding:4px 6px;max-width:100%;box-sizing:border-box}
form{margin:4px 0}
table{border-collapse:collapse}
.clk.low{color:#c22;font-weight:bold}
@media (max-width:159px){body{font:11px/1.3 sans-serif}a{padding:2px 4px;font-size:11px}button,select,input,textarea{font-size:12px;padding:2px 3px}}`;

// Runs before the live engine: reads the real screen size via JS props, saves
// it in the 'scr' cookie so the server can size the board, then reloads once.
// Guards against reload loops (data-scr attribute + sessionStorage flag).
const BOOT_JS = `(function(){
try{
var d=document.documentElement,sw=screen.width||0,sh=screen.height||0;
if(!sw||!sh)return;
var k=Math.min(sw,sh)+'x'+Math.max(sw,sh);
if(d.getAttribute('data-scr')===k){try{sessionStorage.removeItem('__scrTried')}catch(e){}return}
try{if(sessionStorage.getItem('__scrTried'))return}catch(e){}
document.cookie='scr='+k+';path=/;max-age=31536000';
try{sessionStorage.setItem('__scrTried','1')}catch(e){}
if(document.cookie.indexOf('scr=')!==-1)location.reload();
}catch(e){}})();`;

// Live engine: local clock countdown + in-place board-zone polling.
const LIVE_JS = `(function(){
if(window.__sync)return;
var cs=document.getElementById('clockstate');
if(!cs)return;
var S;try{S=JSON.parse(cs.textContent)}catch(e){return}
var TERM={mate:1,resign:1,stalemate:1,draw:1,outoftime:1,timeout:1,cheat:1,variantend:1,aborted:1,nostart:1,unknown:1,created:1};
function over(){return S.stop===1||TERM[String(S.status||'').toLowerCase()]===1}
function el(id){return document.getElementById(id)}
var clk={w:el('clk-w'),b:el('clk-b')},tm={w:el('tm-w'),b:el('tm-b')};
var frozen={},deadline={w:0,b:0};
function pad(n){return n<10?'0'+n:''+n}
function fmt(ms){ms=Math.max(0,ms|0);var t=Math.floor(ms/1000),h=Math.floor(t/3600),m=Math.floor((t%3600)/60),s=t%60;
if(h)return h+':'+pad(m)+':'+pad(s);
if(ms<10000)return m+':'+pad(s)+'.'+(Math.floor(ms/100)%10);
return m+':'+pad(s)}
function paint(side){var e=clk[side];if(!e)return;
var left=frozen[side]||0;
if(deadline[side])left=Math.max(0,deadline[side]-Date.now());
e.textContent=fmt(left);
e.className='clk'+(deadline[side]&&left<30000?' low':'')}
function marks(){for(var s in tm){if(!tm[s])continue;tm[s].style.display=(!over()&&S.turn===s)?'':'none'}}
function reseed(){frozen.w=+S.wtime||0;frozen.b=+S.btime||0;deadline.w=deadline.b=0;
if(S.status==='started'&&(S.turn==='w'||S.turn==='b'))deadline[S.turn]=Date.now()+(S.turn==='w'?frozen.w:frozen.b);
paint('w');paint('b');marks()}
var POLL=(+S.poll>0?+S.poll:3)*1000,timer=null,fails=0,stopped=false,dirtyAt=0,hiddenSkips=0;
function zone(){return document.getElementById('boardzone')}
function busy(){var z=zone();if(!z)return true;var a=document.activeElement;
if(a&&z.contains(a)){var t=a.tagName;if(t==='SELECT'||t==='INPUT'||t==='TEXTAREA'||t==='BUTTON')return true}
return !!(dirtyAt&&Date.now()-dirtyAt<60000)}
function arm(ms){if(timer)clearTimeout(timer);timer=setTimeout(poll,ms)}
function poll(){timer=null;if(stopped)return;
if(document.hidden&&hiddenSkips<3){hiddenSkips++;arm(POLL);return}
hiddenSkips=0;
if(busy()){arm(POLL);return}
var z=zone();if(!z){stopped=true;return}
var u=S.frag||(location.pathname+'?frag=1');
u+=(u.indexOf('?')===-1?'?':'&')+'r='+Date.now();
fetch(u,{headers:{Accept:'text/html'}}).then(function(r){
if(!r.ok)throw new Error(r.status);return r.text()}).then(function(html){
if(stopped)return;
var t=document.createElement('div');t.innerHTML=html;
var nz=t.querySelector('#boardzone'),nc=t.querySelector('#clockstate');
if(!nz||!nc)throw new Error('frag');
z.innerHTML=nz.innerHTML;
try{S=JSON.parse(nc.textContent)}catch(e){throw new Error('json')}
clk={w:el('clk-w'),b:el('clk-b')};tm={w:el('tm-w'),b:el('tm-b')};
fails=0;reseed();
if(over()){stopped=true;return}
arm(POLL)}).catch(function(){if(stopped)return;fails++;
if(fails>=5){location.reload();return}
arm(Math.min(POLL*fails,15000))})}
document.addEventListener('input',function(e){var z=zone(),t=e.target;if(!z||!t)return;
if(z.contains(t)&&(t.tagName==='SELECT'||t.tagName==='INPUT'||t.tagName==='TEXTAREA'))dirtyAt=Date.now()},true);
document.addEventListener('visibilitychange',function(){
if(!document.hidden&&!stopped&&!timer)poll()});
setInterval(function(){if(stopped)return;paint('w');paint('b')},250);
if(over()){stopped=true}
reseed();
if(!stopped)arm(POLL);
})();`;

export function page(title, body, session, opts = {}) {
  const dev = opts.device && opts.device.cloud ? opts.device : null;
  const live = !!(dev && opts.live);

  // Dumbphones (and pages without live mode): meta refresh exactly as before.
  let refresh = '';
  if (opts.refreshSeconds && !live) {
    if (opts.refreshUrl) {
      refresh = `<meta http-equiv="refresh" content="${opts.refreshSeconds};url=${escapeHtml(opts.refreshUrl)}">`;
    } else {
      refresh = `<meta http-equiv="refresh" content="${opts.refreshSeconds}">`;
    }
  }

  let headExtra = '';
  let htmlAttrs = '';
  let bodyTag = '<body>';
  if (dev) {
    htmlAttrs = dev.screen ? ` data-scr="${escapeHtml(dev.screen.w + 'x' + dev.screen.h)}"` : '';
    bodyTag = '<body class="cp">';
    headExtra = `<meta name="viewport" content="width=device-width,initial-scale=1"><style>${CP_CSS}</style>`;
  }

  // Safety net on cloud phones: if JS is unavailable, fall back to meta refresh.
  const noScript = live && opts.refreshSeconds
    ? `<noscript><meta http-equiv="refresh" content="${opts.refreshSeconds}${opts.refreshUrl ? `;url=${escapeHtml(opts.refreshUrl)}` : ''}"></noscript>`
    : '';

  const scripts = dev ? `<script>${BOOT_JS}</script>${live ? `<script>${LIVE_JS}</script>` : ''}` : '';

  const nav = session
    ? `<p><a href="/">Home</a> | <a href="/settings">Size</a> | ${escapeHtml(session.username)} | <a href="/logout">Logout</a></p>`
    : `<p><a href="/">Home</a> | <a href="/settings">Size</a> | <a href="/login">Login</a></p>`;

  return `<!DOCTYPE html>
<html${htmlAttrs}><head><meta charset="utf-8">${refresh}${noScript}${headExtra}<title>${escapeHtml(title)}</title></head>
 ${bodyTag}
 ${nav}
<h3 style="margin:6px 0;">${escapeHtml(title)}</h3>
 ${body}
 ${scripts}</body></html>`;
}

export function redirectPage(url, msg = 'Please wait...') {
  const u = escapeHtml(url);
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${u}"><title>Please wait...</title></head>
<body><p>${escapeHtml(msg)}</p><p><a href="${u}">&gt; Continue</a></p></body></html>`;
}

export function errorPage(title, msg, backUrl = '/', session = null) {
  const body = `<p>${escapeHtml(msg)}</p><p><a href="${escapeHtml(backUrl)}">&gt; Back</a></p>`;
  return page(title, body, session);
}

export function selectField(name, options, selected) {
  let html = `<select name="${escapeHtml(name)}">`;
  for (const o of options) {
    const sel = String(o.value) === String(selected) ? ' selected' : '';
    html += `<option value="${escapeHtml(o.value)}"${sel}>${escapeHtml(o.label)}</option>`;
  }
  return html + '</select>';
}

export function renderGamesList(games) {
  if (!Array.isArray(games) || games.length === 0) return '';
  let html = '<ul style="margin:4px 0;padding-left:16px;">';
  for (const g of games) {
    const opp = (g.opponent && (g.opponent.username || g.opponent.name)) || '?';
    const oppRating = g.opponent && g.opponent.rating ? ` (${g.opponent.rating})` : '';
    const turn = g.isMyTurn ? ' (your move)' : '';
    html += `<li><a href="/game/${escapeHtml(g.gameId)}#board">${escapeHtml(g.color || '?')} vs ${escapeHtml(opp)}${oppRating}</a> - ${escapeHtml(g.speed || '')}${turn}</li>`;
  }
  return html + '</ul>';
}

// Compact name / clock / turn bar rendered above or below the board.
// Passing side:'w'|'b' adds element ids so the live script can update the
// clock in place; omitting it produces the exact old markup (dumbphones).
export function playerBar(name, opts = {}) {
  const side = opts.side === 'w' || opts.side === 'b' ? opts.side : '';
  const clock = opts.clock
    ? (side
        ? ` | <b id="clk-${side}" class="clk">${escapeHtml(opts.clock)}</b>`
        : ` | <b>${escapeHtml(opts.clock)}</b>`)
    : '';
  const turn = opts.toMove
    ? (side
        ? `<b id="tm-${side}"> | to move</b>`
        : ' | <b>to move</b>')
    : '';
  return `<p style="margin:2px 0;text-align:center;"><b>${escapeHtml(name)}</b>${clock}${turn}</p>`;
}
