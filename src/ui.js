// Every page is plain HTML: no <script>, no external CSS/fonts, only
// <table>/<form>/<a> with old-school attributes (bgcolor, width, align).
// This is deliberate - it's what renders correctly on Opera Mini / OEM
// browsers on feature phones like the Nokia/CloudPhone this site targets.

export function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function htmlResponse(html, status = 200, headers = {}) {
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...headers },
  });
}

function nav(session) {
  if (!session) {
    return (
      '<p><a href="/">Home</a> | ' +
      '<a href="/puzzle">Puzzle (no login needed)</a> | ' +
      '<a href="/login">Login (optional, needed to play)</a></p><hr>'
    );
  }
  return (
    `<p>Logged in as <b>${escapeHtml(session.username)}</b><br>` +
    `<a href="/">Home</a> | ` +
    `<a href="/game/new/ai">vs AI</a> | ` +
    `<a href="/game/new/multiplayer">Multiplayer</a> | ` +
    `<a href="/puzzle">Puzzle</a> | ` +
    `<a href="/logout">Logout</a></p><hr>`
  );
}

// Standard page chrome. bodyHtml is trusted (built by our own render code).
export function page(title, bodyHtml, session, opts = {}) {
  const showNav = opts.nav !== false;
  return `<!DOCTYPE html>
<html>
<head>
<title>${escapeHtml(title)}</title>
</head>
<body bgcolor="#ffffff" text="#000000" link="#0000cc" vlink="#551a8b">
<h3>${escapeHtml(title)}</h3>
${showNav ? nav(session) : ''}
${bodyHtml}
</body>
</html>`;
}

// A page whose only job is to send the phone onward. Opera Mini on some OEM
// builds does not follow HTTP redirects reliably, so instead of a 302 we
// render a real HTML page with a meta-refresh AND a plain manual link, per
// the user's request ("my browser doesn't auto redirect").
export function redirectPage(url, message = 'Please wait...', seconds = 1) {
  return `<!DOCTYPE html>
<html>
<head>
<title>Please wait</title>
<meta http-equiv="refresh" content="${seconds};url=${escapeHtml(url)}">
</head>
<body bgcolor="#ffffff" text="#000000">
<p>${escapeHtml(message)}</p>
<p><a href="${escapeHtml(url)}">&gt;&gt; Continue</a></p>
</body>
</html>`;
}

export function errorPage(title, message, backUrl = '/') {
  return `<!DOCTYPE html>
<html>
<head><title>${escapeHtml(title)}</title></head>
<body bgcolor="#ffffff" text="#000000">
<h3>${escapeHtml(title)}</h3>
<p>${escapeHtml(message)}</p>
<p><a href="${escapeHtml(backUrl)}">&lt;&lt; Back</a></p>
</body>
</html>`;
}

export function renderGamesList(games) {
  let html = '<table border="1" cellpadding="4" cellspacing="0" width="100%">';
  html += '<tr><td><b>Opponent</b></td><td><b>Turn</b></td><td></td></tr>';
  for (const g of games) {
    const opp = g.opponent ? g.opponent.username : '?';
    const turn = g.isMyTurn ? 'Your move' : 'Waiting';
    html += `<tr><td>${escapeHtml(opp)}</td><td>${escapeHtml(turn)}</td><td><a href="/game/${escapeHtml(g.gameId)}">Open</a></td></tr>`;
  }
  html += '</table>';
  return html;
}

export function selectField(name, options, selectedValue) {
  let html = `<select name="${escapeHtml(name)}">`;
  for (const opt of options) {
    const value = typeof opt === 'string' ? opt : opt.value;
    const label = typeof opt === 'string' ? opt : opt.label;
    const sel = String(value) === String(selectedValue) ? ' selected' : '';
    html += `<option value="${escapeHtml(value)}"${sel}>${escapeHtml(label)}</option>`;
  }
  html += '</select>';
  return html;
}
