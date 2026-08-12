// ---------------------------------------------------------------------------
// Tiny HTML helpers. Every page this app serves is plain, boring HTML:
//   - no JavaScript anywhere (dumbphone browsers may not run it at all)
//   - no external CSS / fonts / frameworks
//   - only the most basic tags: <p>, <a>, <table>, <form>, <select>, <input>
//
// htmlResponse() is the SINGLE place HTML becomes an HTTP response. Extra
// headers (e.g. Set-Cookie) must be passed INTO it - Hono does not merge
// c.header() onto a raw Response you return yourself. Every response is
// Cache-Control: no-store so proxy browsers never cache boards/move links.
// ---------------------------------------------------------------------------

export function escapeHtml(s) {
  return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

export function htmlResponse(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    },
  });
}

// opts.refreshSeconds: <meta http-equiv="refresh"> for pages that wait on
// something (opponent's turn, challenge acceptance). Only used on pages
// with NO side effects in the URL.
export function page(title, body, session, opts = {}) {
  const refresh = opts.refreshSeconds
    ? `<meta http-equiv="refresh" content="${Number(opts.refreshSeconds) || 30}">`
    : '';
  const nav = session
    ? `<a href="/">Home</a> | <a href="/settings">Size</a> | <b>${escapeHtml(session.username)}</b> | <a href="/logout">Logout</a>`
    : '<a href="/">Home</a> | <a href="/settings">Size</a> | <a href="/login">Login</a>';
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${refresh}
<title>${escapeHtml(title)} - Lichess Dumbphone</title>
</head>
<body style="margin:0;padding:6px;font-family:sans-serif;font-size:14px;color:#111;background:#fff;">
<div style="font-size:12px;margin-bottom:8px;">${nav}</div>
<h3 style="margin:4px 0 8px;">${escapeHtml(title)}</h3>
${body}
</body>
</html>`;
}

export function redirectPage(url, msg = 'Please wait...') {
  const u = escapeHtml(url);
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="1;url=${u}">
<title>Redirecting...</title>
</head>
<body style="margin:0;padding:10px;font-family:sans-serif;font-size:14px;">
<p>${escapeHtml(msg)}</p>
<p><a href="${u}">&gt;&gt; Continue</a></p>
</body>
</html>`;
}

export function errorPage(title, msg, backUrl = '/', session = null) {
  const body = `<p>${escapeHtml(msg)}</p><p><a href="${escapeHtml(backUrl)}">&gt;&gt; Back</a></p>`;
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
  let html = '<ul style="padding-left:18px;margin:6px 0;">';
  for (const g of games) {
    const opp = (g.opponent && (g.opponent.username || g.opponent.name)) || '?';
    const oppRating = g.opponent && g.opponent.rating ? ` (${g.opponent.rating})` : '';
    const turn = g.isMyTurn ? ' <b>(your move)</b>' : '';
    html += `<li><a href="/game/${escapeHtml(g.gameId)}">${escapeHtml(g.color || '?')} vs ${escapeHtml(opp)}${oppRating}</a> - ${escapeHtml(g.speed || '')}${turn}</li>`;
  }
  return html + '</ul>';
}
