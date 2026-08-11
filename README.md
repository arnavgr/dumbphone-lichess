# Lichess Dumbphone

A real Lichess client built to run on feature-phone browsers (Opera Mini on
Nokia/OEM devices, CloudPhone, etc). No JavaScript anywhere - every page is
plain HTML rendered on the server by a Cloudflare Worker.

## Features

- **Two ways to log in**, for real Lichess games:
  1. Standard OAuth2 + PKCE redirect to lichess.org
  2. Paste a personal API token you create yourself on any browser - avoids
     ever loading lichess.org's own pages on the dumbphone at all
- **Play vs a computer with no login and no Lichess account** - a fully
  local mode using `chess.js` for legality/checkmate detection and a free
  remote engine for the AI's moves (falls back to random legal moves if
  that service is unavailable)
- **Puzzles**, also with no login needed (daily puzzle; personalized "next
  puzzle" once logged in)
- **Login-required features** (need *some* Lichess account, because they're
  built on Lichess's Board API, which requires an authenticated token for
  every operation - there's no anonymous mode for these, by design of the
  API itself):
  - Play vs the real Lichess AI (levels 1-8, recorded on your profile)
  - Multiplayer: direct challenge, shareable open-challenge link, or "quick
    pair" into the real matchmaking pool
  - All Lichess variants: Standard, Chess960, Crazyhouse, Antichess, Atomic,
    Horde, King of the Hill, Racing Kings, Three-check
- **Tap-to-move board** everywhere a board appears: pieces render as real
  icons, not font glyphs. Tap a piece to select it - legal destinations
  light up green - then tap one to play the move. A small typed-move
  fallback field stays available for underpromotion (e.g. `e7e8n`), which
  isn't reachable by tapping.
- A "Refresh board" link on every game/puzzle page, and, on the home page, a
  plain clickable link straight into your active match (in addition to a
  best-effort meta-refresh) - because some phone browsers don't follow HTTP
  redirects automatically, every redirect in this app is a real HTML page
  with a manual "Continue" link, not just a 302.

## How it's built

- Cloudflare Worker, single `src/index.js` entry using [Hono](https://hono.dev)
  for routing
- Cloudflare KV for OAuth/token login sessions (`KV` binding)
- Cloudflare Workers static assets (`[assets]` in `wrangler.toml`) serve the
  chess piece icons from `public/images/*.png`
- [`chess.js`](https://github.com/jhlywa/chess.js) is used **only inside the
  Worker**, never shipped to the phone:
  - `src/puzzle.js` - replays puzzle PGNs into FEN positions
  - `src/board.js` - computes legal destination squares for the tap-to-move
    board's highlighting (best-effort on non-standard variants - the real
    legality check always happens server-side, either by chess.js itself
    for the anonymous AI mode, or by Lichess when a move is submitted to a
    real game, so an imperfect highlight never lets an illegal move through)
  - `src/localAi.js` - runs the entire anonymous vs-AI mode: legality,
    check/checkmate/draw detection, all local, no Lichess API call anywhere
    in that file
- Talks directly to `https://lichess.org/api` for everything login-required
  - see [lichess.org/api](https://lichess.org/api) for the full reference
- Talks to `https://chess-api.com` (a free third-party service, not
  affiliated with Lichess or this project) for the anonymous AI mode's
  moves at difficulty 1-4

### A note on the Board API's limits (not a limitation of this app)

Lichess's Board API - which every *login-required* feature here is built on,
since it's the API designed for third-party clients like this one - has two
hard restrictions:

- The real matchmaking pool (`/api/board/seek`, used by "Quick pair") only
  works for **Rapid, Classical, and Correspondence**.
- AI games and direct/open challenges also allow **Blitz**.
- **Bullet is not available at all** through the Board API, in any mode.
- **Nothing in the Board API works without an authenticated token** - this
  is why real multiplayer can't be made anonymous in this app; it's a
  property of the API itself, not a setting this app could relax.

The app's forms only offer the time controls Lichess actually allows in each
context, and explains why Bullet/Blitz are missing where relevant.

## Deploy it (Cloudflare + GitHub, no desktop needed)

1. **Push this folder to a GitHub repo** (via the GitHub mobile app or
   github.com's web file editor/upload).

2. **Create a KV namespace** in the Cloudflare dashboard: Workers & Pages →
   KV → Create a namespace → name it anything (e.g. `lichess-dumbphone-kv`).
   Copy its ID.

3. **Edit `wrangler.toml`** (directly in GitHub's file editor):
   - Paste the KV namespace ID into the `kv_namespaces` entry.
   - Leave `LICHESS_CLIENT_ID` as-is, or change it to any string you like -
     Lichess allows unregistered public OAuth clients, so there's no app to
     register on Lichess's side. This only matters for the OAuth login
     path; the paste-a-token login path doesn't use it.
   - You'll fix `REDIRECT_URI` in step 6, after your first deploy (you need
     to know your `workers.dev` URL first).

4. **Add your piece icons.** Put 12 PNGs in `public/images/`, named exactly
   `wK.png`, `wQ.png`, `wR.png`, `wB.png`, `wN.png`, `wP.png`, `bK.png`,
   `bQ.png`, `bR.png`, `bB.png`, `bN.png`, `bP.png` (white/black + piece
   letter). `public/` sits at the repo root, as a sibling of `src/`. The
   `[assets]` block already in `wrangler.toml` points at this folder, so
   nothing else needs configuring - Cloudflare will serve them at
   `/images/wK.png` etc. automatically.

5. **Add repo secrets** for GitHub Actions: repo Settings → Secrets and
   variables → Actions:
   - `CLOUDFLARE_API_TOKEN` - create one at
     https://dash.cloudflare.com/profile/api-tokens ("Edit Cloudflare
     Workers" template is enough)
   - `CLOUDFLARE_ACCOUNT_ID` - found on the right-hand side of any page in
     the Cloudflare dashboard

6. **Push to `main`.** GitHub Actions (`.github/workflows/deploy.yml`) runs
   `wrangler deploy` automatically. Once it succeeds, find your Worker's URL
   in the Cloudflare dashboard (something like
   `https://lichess-dumbphone.<your-subdomain>.workers.dev`).

7. **Set `REDIRECT_URI`** in `wrangler.toml` to
   `https://<that-url>/callback`, commit, and let Actions redeploy. This
   only matters for the OAuth login path - Lichess checks that the
   `redirect_uri` used at login time exactly matches the one used when
   exchanging the code for a token, and this app uses the `REDIRECT_URI`
   var for both. The paste-a-token login path has no redirect_uri at all,
   so it works even before this step.

8. Visit your Worker URL. **Puzzles** and **vs AI (local)** work
   immediately, no login. For real multiplayer, tap **Login** and pick
   whichever of the two options renders better on your phone.

## Logging in

There are two ways, both reachable from `/login`:

- **Via Lichess** - the standard OAuth redirect. If lichess.org's own site
  doesn't render well on your phone's browser, this may not work - use the
  option below instead.
- **Paste a personal API token** - tap the "Create a token on lichess.org"
  link (works from *any* browser, not necessarily the dumbphone - a
  computer or a different phone is fine), which opens Lichess's token page
  with the right permissions already checked (`board:play`,
  `challenge:read`, `challenge:write`, `puzzle:read`). Copy the token it
  gives you, then paste it into the form on `/login` on your dumbphone.
  No redirect happens on the dumbphone at all with this method.

Either way, once you're in, the KV-backed session cookie keeps you logged in
for about a year (same lifetime as a Lichess access token).

## Playing

- Tap a piece to select it - legal destinations highlight green - then tap
  one to play the move.
- For underpromotion (anything other than queen, e.g. `e7e8n`), use the
  small typed-move field below the board instead of tapping.
- Board orientation always shows your own pieces at the bottom.
- Every game page has a **Refresh board** link - since there's no
  JavaScript, nothing updates automatically; reload to see the opponent's
  move.
- In the local vs-AI mode, moves may take a couple of seconds while the
  remote engine "thinks" (up to ~8s at the higher difficulties before it
  gives up and just moves randomly) - the page simply won't finish loading
  until that resolves, since there's no way to show a spinner without JS.

## Known limitations / things worth testing after deploy

I built and unit-tested the board rendering, puzzle-replay, local AI game
logic, and PKCE logic locally, but couldn't make live calls to
`lichess.org` or `chess-api.com` from the sandbox this was built in - so
it's worth double-checking these against the real APIs once deployed:

- Exact JSON field names in `/api/account/playing`, `/api/challenge/ai`,
  `/api/challenge/open`, and `/api/puzzle/*` responses (see
  `src/lichessApi.js` if anything's drifted from lichess.org/api)
- Exact response shape from `chess-api.com`'s `/v1` endpoint (see
  `src/localAi.js`'s `fetchRemoteAiMove` if the AI seems to always be
  falling back to random moves - that means the response parsing needs
  adjusting, not that anything is broken)
- Whether `https://lichess.org/account/oauth/token/create?scopes[]=...`
  actually pre-checks the boxes as expected - if Lichess changes that
  page's query-param handling, the link in `/login` will just open a blank
  token form instead (still fully functional, just requires manually
  checking "Play games with the board API" and the challenge/puzzle scopes)
- Chess960 castling is entered as a normal king move (e.g. `e1g1`); some
  positions may need the "king takes own rook" square instead - not
  special-cased here
- "Quick pair" is a best-effort bridge over an API designed for a
  streaming client, not a click-and-wait phone page - it may occasionally
  report "no opponent found" even when one was actually found a moment
  after the 20s window closed. If that happens, refresh the home page.
- The tap-to-move board (both the Lichess-backed boards and the local AI
  mode) submits moves via a GET link's querystring - the only way to get a
  clickable action with zero JavaScript. Those responses are sent with
  `Cache-Control: no-store` to discourage Opera Mini's proxy or any CDN
  from caching/replaying them, but if your phone's browser does something
  unusual with back-navigation on a played move, that's the mechanism to
  look at first.
