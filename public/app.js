// Progressive enhancement for JavaScript-capable small-screen browsers
// (e.g. Cloudmosa/Puffin-style "cloudphone" browsers on QVGA-class
// 128x160/240x320 screens running a real, if remote, Chromium engine).
//
// Every page already works with none of this: server-rendered plain HTML,
// <a href>/<form> navigation, <meta http-equiv="refresh"> polling - that's
// the whole app for a dumbphone browser that can't (or won't) run
// JavaScript, and this file changes nothing about that path. This script
// is loaded with a plain <script defer>, so a browser that can't run it
// just never requests/executes it and the page behaves exactly as if this
// file didn't exist.
//
// On top of that baseline, when this script *does* run, it:
//   1. Measures the real viewport and asks the server (via cookies) to
//      render the chess board at an exact pixel size instead of picking
//      from the four fixed dumbphone presets.
//   2. Intercepts same-origin link/form navigation inside #app and does it
//      via fetch() instead, swapping only the page content in place (no
//      full reload/flicker) - and polls faster than the plain meta-refresh
//      interval on pages that already auto-refresh, so opponent moves and
//      match-found events show up sooner ("live" moves).
//
// If anything here throws or a fetch() fails, everything falls back to a
// normal full-page browser navigation - never a dead end, just back to
// behaving like a plain dumbphone page for that one interaction.
(function () {
  'use strict';

  if (!/\bjs\b/.test(document.documentElement.className)) {
    document.documentElement.className += (document.documentElement.className ? ' ' : '') + 'js';
  }

  function readCookie(name) {
    var escaped = name.replace(/[.$?*|{}()[\]\\/+^]/g, '\\$&');
    var m = document.cookie.match(new RegExp('(?:^|; )' + escaped + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }

  function setCookie(name, value) {
    document.cookie = name + '=' + encodeURIComponent(value) + '; Path=/; Max-Age=31536000';
  }

  // -----------------------------------------------------------------
  // AJAX navigation ("live" moves without full page reloads)
  // -----------------------------------------------------------------

  var refreshTimer = null;

  function scheduleAutoRefresh() {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = null;
    var app = document.getElementById('app');
    if (!app) return;
    var seconds = parseFloat(app.getAttribute('data-refresh-seconds') || '');
    if (!seconds || seconds <= 0) return;
    var url = app.getAttribute('data-refresh-url') || location.href;
    // Dumbphones get whatever interval the server chose (5-30s, via the
    // plain meta-refresh tag it renders). A cloudphone can afford to poll
    // faster for a more "live" feel, so cap it here regardless of what the
    // server asked for.
    var waitMs = Math.min(seconds, 4) * 1000;
    refreshTimer = setTimeout(function () {
      followAndRender(url, { push: false }).catch(scheduleAutoRefresh);
    }, waitMs);
  }

  function renderDoc(doc, finalUrl, push) {
    var newApp = doc.getElementById('app');
    var app = document.getElementById('app');
    if (newApp && app) {
      var i, oldAttrs = Array.prototype.slice.call(app.attributes);
      for (i = 0; i < oldAttrs.length; i++) app.removeAttribute(oldAttrs[i].name);
      var newAttrs = Array.prototype.slice.call(newApp.attributes);
      for (i = 0; i < newAttrs.length; i++) app.setAttribute(newAttrs[i].name, newAttrs[i].value);
      app.innerHTML = newApp.innerHTML;
    }
    if (doc.title) document.title = doc.title;
    var displayUrl = finalUrl.href;
    if (displayUrl !== location.href) {
      try {
        if (push) history.pushState({}, '', displayUrl);
        else history.replaceState({}, '', displayUrl);
      } catch (e) { /* ignore - URL bar just won't update, content still did */ }
    }
    if (finalUrl.hash) {
      var id = finalUrl.hash.slice(1);
      var el = document.getElementById(id) || document.getElementsByName(id)[0];
      // 'nearest' (not the scrollIntoView default of 'start') only moves the
      // viewport the minimum amount needed - if the board/selected square is
      // already visible, nothing scrolls at all, so tapping a piece to
      // select it doesn't yank the view away from where you're looking.
      if (el && el.scrollIntoView) setTimeout(function () { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }, 0);
    }
    scheduleAutoRefresh();
    autosizeBoard();
  }

  // Fetches `url`, following the app's own "please wait..." meta-refresh
  // interstitials (src/ui.js's redirectPage()) instantly instead of
  // flashing them on screen - real HTTP redirects (3xx) are already
  // followed transparently by fetch() itself. Cross-origin targets (Lichess
  // OAuth, the "create a token" link, etc.) always fall back to a real
  // navigation, both because fetch() can't read a cross-origin response
  // body and because a login redirect needs to be a real top-level
  // navigation anyway.
  function followAndRender(url, options) {
    options = options || {};
    var push = options.push !== false;
    var currentUrl = url;
    var currentMethod = options.method || 'GET';
    var currentBody = options.body || null;

    function step(depth) {
      if (depth > 5) return Promise.resolve();
      var target;
      try {
        target = new URL(currentUrl, location.href);
      } catch (e) {
        return Promise.resolve();
      }
      if (target.origin !== location.origin) {
        location.href = target.href;
        return Promise.resolve();
      }
      var fetchOpts = { method: currentMethod, credentials: 'same-origin' };
      if (currentBody) {
        fetchOpts.body = currentBody;
        fetchOpts.headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
      }
      return fetch(target.href, fetchOpts).then(function (res) {
        var finalUrl;
        try {
          finalUrl = new URL(res.url || target.href, location.href);
        } catch (e) {
          finalUrl = target;
        }
        if (!finalUrl.hash) finalUrl.hash = target.hash;
        return res.text().then(function (text) {
          var doc = new DOMParser().parseFromString(text, 'text/html');
          var appDoc = doc.getElementById('app');
          var metaRefresh = doc.querySelector('meta[http-equiv="refresh" i]');
          if (!appDoc && metaRefresh) {
            var match = /url=(.+)$/i.exec(metaRefresh.getAttribute('content') || '');
            if (match) {
              currentUrl = match[1].trim();
              currentMethod = 'GET';
              currentBody = null;
              return step(depth + 1);
            }
          }
          renderDoc(doc, finalUrl, push);
        });
      });
    }

    return step(0).catch(function () {
      // Network hiccup, parse failure, whatever - fall back to a real
      // navigation rather than leaving the tap/submit looking dead.
      try { location.href = new URL(currentUrl, location.href).href; } catch (e) { location.reload(); }
    });
  }

  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest && e.target.closest('#app a[href]');
    if (!a) return;
    if (a.target && a.target !== '' && a.target !== '_self') return;
    var href = a.getAttribute('href');
    if (!href || /^(mailto:|tel:|javascript:)/i.test(href)) return;
    var url;
    try {
      url = new URL(href, location.href);
    } catch (err) {
      return;
    }
    if (url.origin !== location.origin) return; // real navigation, e.g. lichess.org
    e.preventDefault();
    followAndRender(url.href, { push: true });
  });

  document.addEventListener('submit', function (e) {
    var form = e.target && e.target.closest && e.target.closest('#app form');
    if (!form) return;
    var action = form.getAttribute('action') || location.href;
    var url;
    try {
      url = new URL(action, location.href);
    } catch (err) {
      return;
    }
    if (url.origin !== location.origin) return; // let the browser submit normally
    e.preventDefault();
    var method = (form.getAttribute('method') || 'GET').toUpperCase();
    if (method === 'GET') {
      url.search = new URLSearchParams(new FormData(form)).toString();
      followAndRender(url.href, { push: true });
    } else {
      var body = new URLSearchParams(new FormData(form));
      followAndRender(url.href, { push: true, method: 'POST', body: body });
    }
  });

  window.addEventListener('popstate', function () {
    followAndRender(location.href, { push: false });
  });

  // -----------------------------------------------------------------
  // Board auto-sizing: measure the real viewport and ask the server for
  // an exact-pixel board instead of the four fixed dumbphone presets.
  // Only runs on pages that opted in via data-autosize (the actual game/
  // puzzle boards - not /settings, which intentionally shows several
  // boards side by side for comparison and manages sizing itself).
  // -----------------------------------------------------------------

  var autosizeInFlight = false;

  function autosizeBoard() {
    var app = document.getElementById('app');
    if (!app || app.getAttribute('data-autosize') !== '1') return;
    // A piece is currently selected (legal destinations highlighted) - don't
    // re-check sizing right now. Selecting a piece scrolls the view slightly,
    // which on mobile browsers can collapse/expand the address bar and
    // change window.innerHeight; without this guard that could recompute a
    // different "ideal" size and trigger a re-render that yanks the view
    // away from the piece you just selected. Sizing gets re-checked again
    // as soon as the selection is cancelled or a move is played.
    if (/[?&]selected=/.test(location.search)) return;
    var pinned = readCookie('bsize');
    if (pinned && pinned !== 'custom') return; // user manually picked a fixed preset on /settings - respect it
    var board = document.getElementById('board');
    if (!board) return;
    var currentCell = parseInt(board.getAttribute('data-cell') || '', 10);
    if (!currentCell) return;
    // Chess board is 8x8 plus (up to) one coordinate-label column/row on
    // each side, so ~9 cells across each dimension. A little margin on
    // each so nothing touches the very edge of the screen or forces
    // horizontal scrolling; vertical scrolling past the board for the
    // move form/buttons below it is fine, so the height margin is small.
    var marginW = 10;
    var marginH = 20;
    var byWidth = Math.floor((window.innerWidth - marginW) / 9);
    var byHeight = Math.floor((window.innerHeight - marginH) / 9);
    var ideal = Math.min(byWidth, byHeight);
    if (!isFinite(ideal)) return;
    ideal = Math.max(10, Math.min(48, ideal));
    if (Math.abs(ideal - currentCell) <= 2) return; // close enough - avoid reload churn
    if (autosizeInFlight) return;
    autosizeInFlight = true;
    setCookie('bsize', 'custom');
    setCookie('bcell', String(ideal));
    followAndRender(location.href, { push: false }).then(
      function () { autosizeInFlight = false; },
      function () { autosizeInFlight = false; }
    );
  }

  var resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(autosizeBoard, 300);
  });

  function init() {
    // app.js drives its own (faster) polling loop instead - see
    // scheduleAutoRefresh() - so the plain meta-refresh tag dumbphones
    // rely on would otherwise just cause a redundant/jarring full reload
    // on top of it.
    var meta = document.querySelector('meta[http-equiv="refresh" i]');
    if (meta && meta.parentNode) meta.parentNode.removeChild(meta);
    scheduleAutoRefresh();
    autosizeBoard();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
