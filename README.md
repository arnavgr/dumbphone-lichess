# Lichess Dumbphone

A real Lichess client built to run on feature-phone browsers (Opera Mini on
Nokia/OEM devices, CloudPhone, etc). No JavaScript anywhere - every page is
plain HTML (`<table>`, `<form>`, `<a>`) rendered on the server by a Cloudflare
Worker, using your real Lichess account via OAuth.

## Features

- **Login with Lichess** (OAuth2 + PKCE, no password ever touches this app)
- **All Lichess variants**: Standard, Chess960, Crazyhouse, Antichess, Atomic,
  Horde, King of the Hill, Racing Kings, Three-check
- **Play vs the Lichess AI** (levels 1-8)
- **Multiplayer**, three ways:
  1. Direct challenge to a Lichess username
  2. Open/shareable challenge link (send it to a friend outside Lichess)
  3. "Quick pair" - joins the real matchmaking pool for up to 20 seconds
- **Puzzles** (daily puzzle, or personalized "next puzzle" once logged in)
- A "Refresh board" link on every game/puzzle page, and, on the home page, a
  plain clickable link straight into your active match (in addition to a
  best-effort meta-refresh) - because some phone browsers don't follow HTTP
  redirects automatically, every redirect in this app is a real HTML page
  with a manual "Continue" link, not just a 302.

## How it's built

- Cloudflare Worker, single `src/index.js` entry using [Hono](https://hono.dev)
  for routing (same stack as your other Worker projects)
- Cloudflare KV for OAuth login sessions (`KV` binding)
- [`chess.js`](https://github.com/jhlywa/chess.js) is used **only inside the
  Worker**, to replay puzzle PGNs into FEN positions - it never ships to the
  phone
- Talks directly to `https://lichess.org/api` - see
  [lichess.org/api](https://lichess.org/api) for the full reference

### A note on the Board API's limits (not a limitation of this app)

Lichess's Board API - which this whole site is built on, since it's the API
designed for third-party clients like this one - has two hard restrictions:

- The real matchmaking pool (`/api/board/seek`, used by "Quick pair") only
  works for **Rapid, Classical, and Correspondence**.
- AI games and direct/open challenges also allow **Blitz**.
- **Bullet is not available at all** through the Board API, in any mode.

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
     register on Lichess's side.
   - You'll fix `REDIRECT_URI` in step 5, after your first deploy (you need
     to know your `workers.dev` URL first).

4. **Add repo secrets** for GitHub Actions: repo Settings → Secrets and
   variables → Actions:
   - `CLOUDFLARE_API_TOKEN` - create one at
     https://dash.cloudflare.com/profile/api-tokens ("Edit Cloudflare
     Workers" template is enough)
   - `CLOUDFLARE_ACCOUNT_ID` - found on the right-hand side of any page in
     the Cloudflare dashboard

5. **Push to `main`.** GitHub Actions (`.github/workflows/deploy.yml`) runs
   `wrangler deploy` automatically. Once it succeeds, find your Worker's URL
   in the Cloudflare dashboard (something like
   `https://lichess-dumbphone.<your-subdomain>.workers.dev`).

6. **Set `REDIRECT_URI`** in `wrangler.toml` to
   `https://<that-url>/callback`, commit, and let Actions redeploy. This
   step matters: Lichess checks that the `redirect_uri` used at login time
   exactly matches the one used when exchanging the code for a token, and
   this app uses the `REDIRECT_URI` var for both.

7. Visit your Worker URL on your phone and tap **Login with Lichess**.

## Playing

- Moves are typed as **from-square + to-square** (UCI format), e.g. `e2e4`.
  For a promotion, add the piece letter: `e7e8q`.
- Board orientation always shows your own pieces at the bottom.
- Every game page has a **Refresh board** link - since there's no
  JavaScript, nothing updates automatically; reload to see the opponent's
  move.

## Known limitations / things worth testing after deploy

I built and unit-tested the board rendering, puzzle-replay, and PKCE logic
locally, but couldn't make live calls to `lichess.org` from the sandbox this
was built in - so it's worth double-checking these against the real API
once deployed, and opening an issue/adjusting `src/lichessApi.js` if any
field name has drifted from what's documented at lichess.org/api:

- Exact JSON field names in `/api/account/playing`, `/api/challenge/ai`,
  `/api/challenge/open`, and `/api/puzzle/*` responses
- Chess960 castling is entered as a normal king move (e.g. `e1g1`); some
  positions may need the "king takes own rook" square instead - not
  special-cased here
- "Quick pair" is a best-effort bridge over an API designed for a
  streaming client, not a click-and-wait phone page - it may occasionally
  report "no opponent found" even when one was actually found a moment
  after the 20s window closed. If that happens, refresh the home page.
