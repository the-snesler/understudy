# Spike: Discord headless sessions (go/no-go)

`headless-test.mjs` checks whether Discord's undocumented headless-sessions presence API
(`POST /users/@me/headless-sessions`) works with our own Discord app, and which activity
features it supports. It has no dependencies and needs Node 18 or newer.

## 1. Discord Developer Portal setup

1. Go to <https://discord.com/developers/applications> → **New Application**. Name it, e.g. "Plex".
   The app name may end up as the displayed activity name; that is one of the things we test.
   Our app ID: `1557839419422285984`.
2. **OAuth2** page:
   - Turn on **Public Client**. This allows PKCE login without a client secret. If you leave it off,
     set `DISCORD_CLIENT_SECRET` instead.
   - Under **Redirects**, add `http://localhost:8787/callback`. It must match `REDIRECT_URI` exactly.
   - Save.
3. Optional: create a second application (e.g. "Nintendo Switch") and note its ID as
   `DISCORD_CLIENT_ID_2`. The `two-sessions` test uses it to see whether an activity's
   `application_id` has to match the app you logged in with. The second app needs no redirect setup.

## 2. Configure

```sh
cd spike/discord-headless
cp .env.example .env          # holds DISCORD_CLIENT_ID=1557839419422285984; .env is gitignored
# or: export DISCORD_CLIENT_ID=1557839419422285984
```

## 3. Log in

```sh
node headless-test.mjs login
```

This prints an authorize URL. Open it in a browser that is logged in to the Discord account whose
presence you want to set, and approve. Discord then redirects to `http://localhost:8787/callback?code=...`.

- **Browser on the same machine:** the script's callback server receives the redirect automatically.
- **Script on a remote server, browser on your PC.** Pick one:
  - **SSH port-forward:** connect with `ssh -L 8787:localhost:8787 user@server`, then run `login` in
    that session. The redirect in your local browser reaches the script through the tunnel.
  - **Paste fallback:** the redirect page fails to load ("can't connect"). That's fine. Copy the
    **full URL** from the address bar and paste it at the script's prompt. The bare `code` value
    also works. If the script was already stopped, run
    `node headless-test.mjs login --code '<url>'` within about 10 minutes.

Tokens are saved to `state.json`, which is gitignored and created with mode 600. The script then
calls `/oauth2/@me` and `/users/@me` and prints the granted scopes. You want to see
`activities.write` or `sdk.social_layer_presence`. If `/users/@me` fails, that is not a blocker.
That endpoint probably needs `identify`. You can add it with
`DISCORD_SCOPES="openid sdk.social_layer_presence identify"`.

## 4. Quick manual check

```sh
node headless-test.mjs create --type 3 --name Plex --details "The Matrix (1999)" --state "Sci-Fi" \
  --large-image https://image.tmdb.org/t/p/w500/qJ2tW6WMUDux911r6m7haRef0WH.jpg --start now-10m --end +20m
node headless-test.mjs update --details "changed"      # updates the most recent session using its token
node headless-test.mjs sessions                        # list known session tokens
node headless-test.mjs delete                          # or: delete-all
node headless-test.mjs refresh-token
node headless-test.mjs --help                          # every flag: buttons, status_display_type, --app-id, --extra JSON...
```

Every call prints the request, the status, all `X-RateLimit-*` and `Retry-After` headers, and the
full response body. OAuth tokens are redacted unless you pass `--show-secrets`.

## 5. Guided experiments

Have a **second Discord account**, or a friend, ready to look at your profile. Your own client may hide
or cache things. Buttons in particular are usually invisible to yourself.

```sh
node headless-test.mjs experiments --list
node headless-test.mjs experiments                    # all tests, in order
node headless-test.mjs experiments --only baseline,external-image --image https://example.com/poster.jpg
```

| id | what it checks |
|---|---|
| `baseline` | type 0 with name "Plex": shown at all? Does the name stick, or is it replaced by the app name? |
| `type-watching` / `type-listening` | types 3 and 2: accepted? Shown as "Watching Plex" / "Listening to Plex"? |
| `status-display-type` | values 0/1/2: what the member list / DM list status line shows |
| `external-image` | external HTTPS `large_image` / `small_image` (default: a TMDB poster) |
| `timestamps-end` | future `timestamps.end`: progress bar, countdown, or nothing |
| `buttons` | `["label"]` + `metadata.button_urls`, then `[{label,url}]` |
| `update-token` | update via `token`: same session or a new one? Error codes for bogus or deleted tokens |
| `two-sessions` | "Plex" + "Nintendo Switch" at once; then B with `DISCORD_CLIENT_ID_2` |
| `invisible` | visible while your status is Invisible? |
| `rate-limit` | 5 updates 2 s apart (`--burst-count`, `--burst-interval`); stops on the first 429 |

For each test, the script describes what it will do. Press Enter to run it, `s` to skip, or `q`
to quit. It sends the requests, prints automatic observations (HTTP status, and how the activity
Discord echoed back differs from what was sent, e.g. image URLs rewritten to `mp:external/...`),
then asks what you see. Answer with y/n or free text. Each test deletes its sessions when it finishes.
**Ctrl+C** deletes the sessions from the current test and saves the partial results.

## 6. Keepalive and expiry

```sh
node headless-test.mjs keepalive --type 3 --name Plex     # refresh every 14 min; logs whether the token stays the same
node headless-test.mjs keepalive --no-refresh             # create once, then send nothing more
```

- **Refresh mode** re-sends the same activity with the session token every `--interval-min` (default
  14). If the session has disappeared (400/404), it recreates it. Run it for 30-60 minutes to confirm
  the session survives past 20 minutes. Stop it with Ctrl+C, which deletes the session.
- **No-refresh mode** prints the creation time and the expected expiry (about 20 minutes). Press Enter
  when the activity disappears from your profile. The script records the real lifetime, then
  optionally sends one update with the old token to show what the API says about it.

## 7. Results

All experiment answers, automatic observations, and raw API calls (request/response JSON, status,
rate-limit headers) are appended to **`results.md`** in this folder, with a summary table per run.
Keepalive runs also append a table there, one row per refresh. Session tokens are shortened in the
report, and OAuth tokens never appear in it. Paths can be overridden with `RESULTS_FILE` and `STATE_FILE`.

## Offline testing against the mock

`mock-discord.mjs` is a fake of these endpoints, with behaviour guessed from the docs. It exists only
to test the script itself:

```sh
node mock-discord.mjs &   # 127.0.0.1:8799; MOCK_RL_LIMIT, MOCK_EXPIRES_IN, MOCK_SESSION_TTL_MS tune it
export DISCORD_API_BASE=http://127.0.0.1:8799/api/v10 DISCORD_AUTHORIZE_URL=http://127.0.0.1:8799/oauth2/authorize \
       DISCORD_CLIENT_ID=111111111111111111 STATE_FILE=/tmp/mock-state.json RESULTS_FILE=/tmp/mock-results.md
node headless-test.mjs login   # open the URL; the mock auto-approves and redirects to the callback
```

`node headless-test.mjs pkce-selftest` checks PKCE generation against the RFC 7636 test vector.
