(() => {
  'use strict';

  // Cloud Phone exposes navigator.hasFeature(). Regular dumbphone browsers
  // usually have no JavaScript at all, and non-Cloud-Phone browsers simply
  // skip this enhancement and keep the normal server-rendered UI.
  const isCloudPhone = typeof navigator !== 'undefined' && typeof navigator.hasFeature === 'function';
  if (!isCloudPhone) return;

  const root = document.documentElement;
  root.classList.add('cloudphone');

  let pollTimer = null;
  let clockTimer = null;
  let pollBusy = false;
  let liveState = null;
  let focusedIndex = 0;
  let resizeTimer = null;

  const GAME_PATH_RE = /^\/game\/[^/]+$/;

  function injectStyles() {
    if (document.getElementById('cloudphone-style')) return;
    const style = document.createElement('style');
    style.id = 'cloudphone-style';
    style.textContent = `
      html.cloudphone, html.cloudphone body { max-width:100%; overflow-x:hidden; }
      html.cloudphone body {
        margin:0;
        padding:3px 5px 18px;
        box-sizing:border-box;
        width:100%;
        font-family:system-ui,-apple-system,sans-serif;
        font-size:13px;
        line-height:1.25;
      }
      html.cloudphone p { margin:4px 0; }
      html.cloudphone h3 { margin:4px 0 5px; font-size:17px; }
      html.cloudphone h4 { margin:5px 0 3px; font-size:14px; }
      html.cloudphone hr { margin:5px 0; }
      html.cloudphone a { text-underline-offset:2px; }
      html.cloudphone input, html.cloudphone select, html.cloudphone button {
        font:inherit;
        min-height:28px;
        box-sizing:border-box;
      }
      html.cloudphone input[type="text"], html.cloudphone select { max-width:100%; }
      html.cloudphone input[type="submit"], html.cloudphone button {
        padding:3px 8px;
        margin:1px 2px 1px 0;
      }
      html.cloudphone form { margin:3px 0; }
      html.cloudphone .cp-board-wrap {
        overflow:hidden;
        margin:3px auto 5px;
        position:relative;
      }
      html.cloudphone #board {
        display:block;
        transform-origin:top left !important;
        margin:0 !important;
      }
      html.cloudphone #board td.cp-focused {
        outline:2px solid #1565c0;
        outline-offset:-2px;
      }
      html.cloudphone #cp-live-status {
        margin:2px 0 4px;
        padding:3px 5px;
        border:1px solid #888;
        font-size:12px;
        line-height:1.2;
      }
      html.cloudphone #cp-live-status strong { letter-spacing:.2px; }
      html.cloudphone .cp-game-hint { opacity:.8; margin-left:5px; }
      html.cloudphone .cp-nav-tight { margin-bottom:3px; }
      @media (min-width: 300px) {
        html.cloudphone body { font-size:14px; padding-left:7px; padding-right:7px; }
        html.cloudphone h3 { font-size:18px; }
      }
    `;
    document.head.appendChild(style);
  }

  function removeMetaRefresh() {
    document.querySelectorAll('meta[http-equiv]').forEach((meta) => {
      if (String(meta.getAttribute('http-equiv') || '').toLowerCase() === 'refresh') meta.remove();
    });
  }

  function isGamePage() {
    return GAME_PATH_RE.test(window.location.pathname) && !!document.getElementById('board');
  }

  function compactNavigation() {
    const first = document.body && document.body.querySelector('p');
    if (first && !first.id) first.classList.add('cp-nav-tight');
  }

  function boardCells(rootNode = document) {
    const board = rootNode.getElementById ? rootNode.getElementById('board') : rootNode.querySelector('#board');
    if (!board) return [];
    return Array.from(board.querySelectorAll('td[id^="sq-"]'));
  }

  function wrapAndFitBoard() {
    const board = document.getElementById('board');
    if (!board) return;
    let wrap = board.parentElement;
    if (!wrap || !wrap.classList.contains('cp-board-wrap')) {
      wrap = document.createElement('div');
      wrap.className = 'cp-board-wrap';
      board.parentNode.insertBefore(wrap, board);
      wrap.appendChild(board);
    }

    const viewportWidth = Math.max(96, Math.floor(Math.min(
      window.innerWidth || 240,
      document.documentElement.clientWidth || window.innerWidth || 240,
      window.screen && window.screen.width || window.innerWidth || 240,
    ) - 8));
    board.style.transform = 'none';
    const naturalWidth = Math.max(1, board.getBoundingClientRect().width);
    const naturalHeight = Math.max(1, board.getBoundingClientRect().height);
    const scale = Math.min(1, viewportWidth / naturalWidth);
    board.style.transformOrigin = 'top left';
    board.style.transform = `scale(${scale})`;
    wrap.style.width = `${Math.ceil(naturalWidth * scale)}px`;
    wrap.style.height = `${Math.ceil(naturalHeight * scale)}px`;
  }

  function clearFocus() {
    boardCells().forEach((cell) => cell.classList.remove('cp-focused'));
  }

  function focusCell(index) {
    const cells = boardCells();
    if (!cells.length) return;
    focusedIndex = Math.max(0, Math.min(cells.length - 1, index));
    clearFocus();
    const cell = cells[focusedIndex];
    cell.classList.add('cp-focused');
    try { cell.scrollIntoView({ block:'nearest', inline:'nearest' }); } catch {}
  }

  function firstUsefulCell() {
    const cells = boardCells();
    if (!cells.length) return 0;
    const firstLink = cells.findIndex((cell) => cell.querySelector('a[href]'));
    return firstLink >= 0 ? firstLink : 0;
  }

  function showStatus(message, busy = false) {
    let el = document.getElementById('cp-live-status');
    if (!el) {
      el = document.createElement('div');
      el.id = 'cp-live-status';
      const board = document.getElementById('board');
      if (board && board.parentNode) board.parentNode.before(el);
      else if (document.body) document.body.prepend(el);
    }
    el.innerHTML = `<strong>${busy ? '◌ ' : '● '}${escapeText(message)}</strong><span class="cp-game-hint">D-pad: move · Enter: select</span>`;
  }

  function escapeText(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
      '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;',
    })[ch]);
  }

  function extractClockBars(rootNode) {
    const paragraphs = Array.from(rootNode.querySelectorAll('p'));
    return paragraphs.filter((p) => /\b\d{1,4}:\d{2}\b/.test(p.textContent || ''));
  }

  function parseClock(text) {
    const m = String(text || '').match(/\b(\d{1,4}):(\d{2})\b/);
    if (!m) return null;
    return Number(m[1]) * 60 + Number(m[2]);
  }

  function updateClockText(el, seconds) {
    if (!el) return;
    const safe = Math.max(0, Math.floor(seconds));
    const mm = Math.floor(safe / 60);
    const ss = String(safe % 60).padStart(2, '0');
    el.innerHTML = el.innerHTML.replace(/\b\d{1,4}:\d{2}\b/, `${mm}:${ss}`);
  }

  function refreshLocalClocks() {
    if (!liveState) return;
    const elapsed = (performance.now() - liveState.anchorMs) / 1000;
    liveState.bars.forEach((bar) => {
      const now = bar.baseSeconds - (bar.running ? elapsed : 0);
      updateClockText(bar.el, now);
    });
  }

  function syncClocksFromDocument(doc) {
    const newBars = extractClockBars(doc);
    const currentBars = extractClockBars(document);
    if (!newBars.length || !currentBars.length) {
      liveState = null;
      return;
    }
    const n = Math.min(newBars.length, currentBars.length, 4);
    const bars = [];
    for (let i = 0; i < n; i++) {
      const secs = parseClock(newBars[i].textContent);
      if (secs === null) continue;
      bars.push({
        el: currentBars[i],
        baseSeconds: secs,
        running: /\bto move\b/i.test(newBars[i].textContent || ''),
      });
    }
    if (bars.length) {
      liveState = { bars, anchorMs: performance.now() };
      refreshLocalClocks();
    }
  }

  async function parseResponseDocument(response) {
    const text = await response.text();
    return new DOMParser().parseFromString(text, 'text/html');
  }

  function updateUrl(responseUrl) {
    try {
      const u = new URL(responseUrl, window.location.href);
      const next = u.pathname + u.search + '#board';
      history.replaceState({}, '', next);
    } catch {}
  }

  function replaceBodyFromDocument(doc, responseUrl) {
    const freshBody = doc.body;
    if (!freshBody) return false;
    document.body.innerHTML = freshBody.innerHTML;
    updateUrl(responseUrl);
    removeMetaRefresh();
    compactNavigation();
    showStatus('Live');
    wrapAndFitBoard();
    focusedIndex = firstUsefulCell();
    focusCell(focusedIndex);
    bindBoardLinks();
    bindGameState();
    return true;
  }

  async function navigateInPlace(url) {
    if (pollBusy) return;
    pollBusy = true;
    showStatus('Updating…', true);
    try {
      const response = await fetch(url, {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'X-CloudPhone-Live': '1' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const doc = await parseResponseDocument(response);
      if (!replaceBodyFromDocument(doc, response.url)) window.location.href = url;
      else showStatus('Live');
    } catch {
      // Never leave a move stranded in enhanced mode. Fall back to the
      // original navigation path when an asynchronous fetch fails.
      window.location.href = url;
    } finally {
      pollBusy = false;
    }
  }

  function bindBoardLinks() {
    const board = document.getElementById('board');
    if (!board || board.dataset.cpBound === '1') return;
    board.dataset.cpBound = '1';
    board.querySelectorAll('a[href]').forEach((link) => {
      link.addEventListener('click', (event) => {
        event.preventDefault();
        navigateInPlace(link.href);
      });
    });
  }

  async function pollGame() {
    if (pollBusy || document.hidden) return;
    const board = document.getElementById('board');
    if (!board || !isGamePage()) return;
    pollBusy = true;
    try {
      const url = window.location.pathname;
      const response = await fetch(url, {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'X-CloudPhone-Live': '1' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const doc = await parseResponseDocument(response);
      const newBoard = doc.getElementById('board');
      const currentBoard = document.getElementById('board');
      if (!newBoard || !currentBoard) return;

      // Keep focus and scroll stable while the clock ticks. Replace only the
      // board when the server has actually produced a new position/selection.
      if (newBoard.outerHTML !== currentBoard.outerHTML) {
        currentBoard.replaceWith(newBoard);
        wrapAndFitBoard();
        bindBoardLinks();
        focusCell(Math.min(focusedIndex, boardCells().length - 1));
        showStatus('Live · board updated');
      }
      syncClocksFromDocument(doc);
      refreshLocalClocks();
      removeMetaRefresh();
    } catch {
      // Polling is best-effort. The existing links and Refresh action remain
      // available if the live-enhancement request can't be completed.
    } finally {
      pollBusy = false;
    }
  }

  function moveFocus(delta) {
    const cells = boardCells();
    if (!cells.length) return;
    let next = focusedIndex;
    if (delta === 'left') next -= 1;
    else if (delta === 'right') next += 1;
    else if (delta === 'up') next -= 8;
    else if (delta === 'down') next += 8;
    focusCell(Math.max(0, Math.min(cells.length - 1, next)));
  }

  function activateFocusedCell() {
    const cells = boardCells();
    const cell = cells[focusedIndex];
    if (!cell) return;
    const link = cell.querySelector('a[href]');
    if (link) {
      link.click();
      return;
    }
    // Empty/non-link squares are intentionally no-op: the server only emits
    // links for selectable pieces and legal destinations.
    showStatus('Choose a highlighted square');
  }

  function bindKeyboard() {
    if (document.documentElement.dataset.cpKeysBound === '1') return;
    document.documentElement.dataset.cpKeysBound = '1';
    window.addEventListener('keydown', (event) => {
      if (!isGamePage()) return;
      const tag = (event.target && event.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault();
        moveFocus(event.key.slice(5).toLowerCase());
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        activateFocusedCell();
      }
    });
  }

  function bindGameState() {
    if (!isGamePage()) return;
    removeMetaRefresh();
    wrapAndFitBoard();
    bindBoardLinks();
    if (!document.querySelector('#cp-live-status')) showStatus('Live');
    if (pollTimer === null) pollTimer = window.setInterval(pollGame, 1000);
    if (clockTimer === null) clockTimer = window.setInterval(refreshLocalClocks, 250);
    if (!liveState) {
      const bars = extractClockBars(document);
      if (bars.length) syncClocksFromDocument(document);
    }
    focusCell(Math.min(focusedIndex, Math.max(0, boardCells().length - 1)));
  }

  function scheduleFit() {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(wrapAndFitBoard, 50);
  }

  function init() {
    injectStyles();
    removeMetaRefresh();
    compactNavigation();
    bindKeyboard();
    bindGameState();
    window.addEventListener('resize', scheduleFit);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once:true });
  else init();
})();
