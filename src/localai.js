// Local, Lichess-account-free chess engine used by the anonymous "vs AI"
// mode (/ai, /ai/play). Move legality, check/checkmate/draw detection, etc.
// all run through chess.js (already a dependency elsewhere in this app) -
// no Lichess API call, no OAuth token, involved anywhere in this file.
//
// The opponent's moves come from a free third-party remote engine
// (chess-api.com) when possible, falling back to a uniformly-random legal
// move if that call fails, times out, or is skipped at difficulty 0 - so a
// flaky/unavailable third-party service never leaves a game stuck, it just
// makes the AI weaker.

// Difficulty -> search depth sent to the remote engine. 0 skips the remote
// call entirely and always plays randomly.
const REMOTE_DEPTH = { 1: 2, 2: 5, 3: 10, 4: 18 };
const REMOTE_TIMEOUT_MS = 8000;

export function randomLegalMove(chess) {
  const moves = chess.moves({ verbose: true });
  if (!moves.length) return null;
  const m = moves[Math.floor(Math.random() * moves.length)];
  return { from: m.from, to: m.to, promotion: m.promotion };
}

async function fetchRemoteAiMove(fen, depth) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REMOTE_TIMEOUT_MS);
  try {
    const res = await fetch('https://chess-api.com/v1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fen, depth }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data && data.from && data.to) {
      return {
        from: String(data.from).toLowerCase(),
        to: String(data.to).toLowerCase(),
        promotion: data.promotion ? String(data.promotion).toLowerCase() : undefined,
      };
    }
  } catch {
    // network error, timeout, or bad JSON - fall through to a random move
  } finally {
    clearTimeout(timer);
  }
  return null;
}

// Picks the AI's next move for the given difficulty (0-4). Resolves to a
// legal move object ({from, to, promotion?}), or null if there genuinely
// are no legal moves (checkmate/stalemate - caller should have already
// checked chess.isGameOver() before calling this).
export async function pickAiMove(chess, diff) {
  if (diff > 0) {
    const remote = await fetchRemoteAiMove(chess.fen(), REMOTE_DEPTH[diff] || 10);
    if (remote) return remote;
  }
  return randomLegalMove(chess);
}

// Applies an AI-picked move to a chess.js instance, falling back to a
// random legal move on the rare chance the remote engine suggested
// something chess.js considers illegal - so a bad response never leaves
// the position stuck mid-turn.
export function applyAiMove(chess, move) {
  if (!move) return;
  try {
    chess.move(move);
  } catch {
    const fallback = randomLegalMove(chess);
    if (fallback) {
      try {
        chess.move(fallback);
      } catch {
        // Nothing legal could be applied - leave the position as-is.
      }
    }
  }
}
