# server-rpc

Show what you're doing on self-hosted services as your Discord presence, with no Discord client
running. It collects "now playing" activity from **sources** and sends it to **outputs**. Today
there's one output: Discord, which sets your presence through Discord's (undocumented) headless
sessions API.

Status: early. Sources so far: **Manual** (set an activity from the web UI). Plex (via Tautulli)
and Nintendo Switch (via nxapi) are next.

## Running

```sh
cp compose.example.yml compose.yml   # set UI_PASSWORD
docker compose up -d --build
```

Then open <http://localhost:8080>. For development:

```sh
pnpm install
pnpm dev        # http://localhost:8080, data in ./data
pnpm test
```

| Env var | Default | |
|---|---|---|
| `PORT` | `8080` | |
| `DATA_DIR` | `./data` (`/data` in Docker) | `config.json` (settings) and `state.json` (tokens). Both are mode 600. |
| `UI_PASSWORD` | unset | Basic-auth password for the web UI (any username). Set it: the UI holds your Discord tokens. |
| `PUBLIC_URL` | request origin | The URL you open the UI at, if that differs from what the server sees (e.g. behind a reverse proxy). Used for the OAuth redirect URI. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` |

## Discord setup

1. In the [Developer Portal](https://discord.com/developers/applications), create an application.
   Its icon doesn't matter; the activity name comes from the source (e.g. "Plex").
2. **Discord Social SDK → Getting Started**: fill in the form and submit. Without this, login fails
   with `invalid_scope`.
3. **OAuth2**: turn on **Public Client**, and under **Redirects** add the URI shown on the Discord
   page of this app (`<your UI URL>/plugins/discord/callback`).
4. In the web UI: Discord → paste the **Application ID** → Save → **Connect Discord**.

If the redirect page can't load (e.g. you registered `localhost` but opened the UI from another
machine), copy the URL from the address bar and paste it into "Redirect page didn't load?".

Things to know:
- Discord shows **one** headless activity per app at a time. When several sources are active, the
  Discord output picks one: by its source priority list, then playing before paused, then the most
  recent.
- While a headless session is active, your account appears **online** even if no Discord client
  is open. An option to publish only while you're online on a real client is planned.
- Activities don't show while you're Invisible. One reappears on the next re-send after you go back
  Online (every 5 minutes by default).

## Architecture

```
src/
  core/        activity model, hub, plugin interfaces, registry, JSON stores, logger
  plugins/     sources and outputs; register new ones in plugins/index.ts
    discord/   OAuth (PKCE), REST client, headless session, activity mapping, publisher
    manual/    the hand-driven test source
  web/         Hono + JSX server-rendered UI with htmx, and settings forms built from zod schemas
```

A **source** calls `ctx.publish(nowPlaying | null)`. An **output** gets `onState(hubState)` with
every source's current activity. A plugin declares its settings as a zod schema, which also
generates its settings form. Plugins can add their own routes (under `/plugins/<instance>/`) and
UI panels. Each configured instance is restarted when its settings are saved.
