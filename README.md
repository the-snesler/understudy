# server-rpc

Show what you're doing on self-hosted services as your Discord presence, with no Discord client
running. It collects "now playing" activity from **sources** and sends it to **outputs**. Today
there's one output: Discord, which sets your presence through Discord's (undocumented) headless
sessions API.

Status: early. Sources so far: **Plex** (via Tautulli) and **Manual** (set an activity from the
web UI). Nintendo Switch (via nxapi) is next.

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
| `PUBLIC_URL` | request origin | The URL you open the UI at, if that differs from what the server sees (e.g. behind a reverse proxy). Used for the OAuth redirect URI, and, if it's public HTTPS, for the optional artwork proxy. |
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
  Discord output picks one: by its source priority list, then the most recent.
- Paused activities are hidden by default, like Spotify's integration. The Discord settings can
  rank them last or show them instead.
- By default the activity is shown only while one of your real Discord clients (desktop, web or
  mobile) is online, idle or dnd ("Only while you are on Discord"). This keeps one extra Discord
  connection open with your login.
  - That connection carries the activity, with the same status as your real clients.
  - It's invisible whenever there's nothing to show, so others see exactly the status they would
    without this app.
- With that turned off, the activity is published as a **headless session** instead, which works
  with Discord closed. The catches:
  - a headless session makes you appear online, even while Invisible;
  - Discord doesn't really delete one when asked: it lingers, holding you online with no activity,
    for a few minutes afterwards.

## Plex (Tautulli) setup

On the Plex (Tautulli) page, set:
- the **Tautulli URL** and **API key** (Tautulli → Settings → Web Interface → API);
- **Users**: your Plex username. Otherwise anyone streaming from your server shows up as you.

Discord loads artwork itself, so images must be public HTTPS URLs. In order:
1. **TMDB posters** for movies and shows, if you add a TMDB API key or read access token.
2. **iTunes album art** for music (no key needed).
3. Optionally, **Plex artwork served through this app**. This needs `PUBLIC_URL` to be an HTTPS
   address Discord can reach. Only signed image URLs under `/public/` work without the UI password.
4. A **fallback image**: a URL, or the key of an image uploaded to your Discord app (Developer
   Portal → Rich Presence → Art Assets).

The text lines are templates, e.g. `S{seasonPadded}E{episodePadded}[ · {episodeTitle}]`. Text in
`[brackets]` is dropped when a variable inside is empty. The settings page lists every variable.

## Architecture

```
src/
  core/        activity model, hub, plugin interfaces, registry, JSON stores, logger
  plugins/     sources and outputs; register new ones in plugins/index.ts
    discord/   OAuth (PKCE), REST client, headless session, activity mapping, publisher
    tautulli/  Plex via Tautulli: polling, filters, templates, artwork (TMDB, iTunes, signed proxy)
    manual/    the hand-driven test source
  web/         Hono + JSX server-rendered UI with htmx, and settings forms built from zod schemas
```

A **source** calls `ctx.publish(nowPlaying | null)`. An **output** gets `onState(hubState)` with
every source's current activity. A plugin declares its settings as a zod schema, which also
generates its settings form. Plugins can add their own routes (under `/plugins/<instance>/`,
behind the UI password), public routes (under `/public/<instance>/`, for images and webhooks; they
must authenticate requests themselves) and UI panels. Each configured instance is restarted when its settings are saved.
