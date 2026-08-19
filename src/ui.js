export function escapeHtml(s) {
  return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

export function htmlResponse(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

export function page(title, body, session, opts = {}) {
  let refresh = '';
  if (opts.refreshSeconds) {
    // If a refreshUrl is provided, force the browser to fetch that exact URL
    // (with cache buster) instead of just reloading the current page.
    if (opts.refreshUrl) {
      refresh = `<meta http-equiv="refresh" content="${opts.refreshSeconds};url=${escapeHtml(opts.refreshUrl)}">`;
    } else {
      refresh = `<meta http-equiv="refresh" content="${opts.refreshSeconds}">`;
    }
  }
  const nav = session
    ? `<p><a href="/">Home</a> | <a href="/settings">Size</a> | ${escapeHtml(session.username)} | <a href="/logout">Logout</a></p>`
    : `<p><a href="/">Home</a> | <a href="/settings">Size</a> | <a href="/login">Login</a></p>`;
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">${refresh}<title>${escapeHtml(title)}</title></head>
<body>
${nav}
<h3 style="margin:6px 0;">${escapeHtml(title)}</h3>
${body}
</body></html>`;
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
export function playerBar(name, opts = {}) {
  const clock = opts.clock ? ` | <b>${escapeHtml(opts.clock)}</b>` : '';
  const turn = opts.toMove ? ' | <b>to move</b>' : '';
  return `<p style="margin:2px 0;text-align:center;"><b>${escapeHtml(name)}</b>${clock}${turn}</p>`;
}
