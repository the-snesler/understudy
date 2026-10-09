# Understudy

Understudy performs your Discord presence when your own client can't. It's a small self-hosted
server that watches what you're doing elsewhere and shows it on your Discord profile:
- "Watching Plex", with the poster and a progress bar;
- "Listening to Plex", with album art;
- "Playing Nintendo Switch", with the game.

<img width="2826" height="2116" alt="image" src="https://github.com/user-attachments/assets/9480dda1-10dc-4b36-897f-82481be4acbb" />
<img width="299" height="408" alt="image" src="https://github.com/user-attachments/assets/fdf98ce1-830b-41c6-9e23-85fe76a8c144" />

It doesn't need the Discord desktop app on the machine doing the playing.

- **Sources:**
  - **Plex** (via Tautulli): movies, episodes and music.
  - **Nintendo Switch** (via [nxapi](https://github.com/samuelthomas2774/nxapi)): Switch and
    Switch 2 games.
  - **Manual**: set an activity from the web UI.
- **Output: Discord.**
  - Only while you're actually on Discord, with your real status.
  - Paused media is hidden.
  - Priority between sources, quiet hours, and a pause switch with an HTTP API.
- **Web UI** for setup, sign-ins and live status. Settings live in `/data`.

Sources and outputs are plugins, so more can be added (see [Architecture](#architecture)).

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
| `TZ` | system zone | Default time zone for quiet hours (e.g. `America/Chicago`). Each Discord output can override it. |
| `NXAPI_AUTH_CLIENT_ID` | unset | Default nxapi-auth client ID for the Nintendo Switch source. |
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
- **One activity at a time.** When several sources are active, the Discord output picks one: by
  its source priority list (source ids, highest first), then the most recent.
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

- **Quiet hours** (Discord settings): daily times when nothing is shown, e.g. `23:00-07:00`, in
  the configured time zone.

## Pausing

The dashboard has a **Pause publishing** switch: 30 minutes, 1 hour, 4 hours, or until you resume.
While paused, the Discord output withdraws the activity. A pause survives restarts and ends by
itself when timed. To stop a single source or output, use its Disable button instead.

The same controls are available as a JSON API, using the UI password (any username). POST requests
must send `Content-Type: application/json`, which keeps them safe from cross-site forgery.

```sh
curl -u :PASSWORD http://localhost:8080/api/status            # pause state and every source/output
curl -u :PASSWORD -X POST -H 'Content-Type: application/json' -d '{"minutes": 60}' http://localhost:8080/api/pause
curl -u :PASSWORD -X POST -H 'Content-Type: application/json' -d '{}' http://localhost:8080/api/resume
curl -u :PASSWORD -X POST -H 'Content-Type: application/json' -d '{}' http://localhost:8080/api/toggle
```

`/api/pause` without `minutes` pauses until resumed. For example, a Home Assistant
`rest_command` that pauses while you're at a lecture:

```yaml
rest_command:
  understudy_pause:
    url: http://understudy.local:8080/api/pause
    method: post
    username: ha
    password: !secret understudy_password
    content_type: application/json
    payload: '{"minutes": 75}'
```

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

## Nintendo Switch setup

Nintendo's API doesn't let you read your own presence, so this reads it from the friend list of a
**secondary Nintendo Account** that is friends with your main one. You need:

1. **A secondary Nintendo Account**, added as a friend of your main account. Your main account must
   share its online status with friends (on the Switch: System Settings → Users → your user →
   friend settings).
2. **An nxapi-auth client ID.** It identifies this app to nxapi's f-token API. Register once at
   <https://nxapi-auth.fancy.org.uk/oauth/clients>:
   - **Type:** Public. You can't change this later.
   - **Allowed grant types:** Client credentials and Refresh token.
   - **Scope:** in the *nxapi-znca-api* section, only f-generation, Request encryption and Response
     decryption (`ca:gf ca:er ca:dr`). Leave every other scope, and the client authentication
     section, alone.
   - **Details:** fill in a description and a contact URL.

   Enter the Client ID on the Nintendo Switch page, or set `NXAPI_AUTH_CLIENT_ID`. It isn't a
   secret.
3. **Sign in** on the Nintendo Switch page:
   - Read and accept the notice.
   - Open the sign-in link and sign in with the secondary account.
   - Right-click **Select this person**, copy the link (`npf71b963c1b7b6d119://auth#…`) and paste
     it back.
   - Pick your main account from the friend list.

> **Privacy:** Nintendo only accepts sign-ins from its own app. To sign in, this uses
> [nxapi-znca-api](https://github.com/samuelthomas2774/nxapi-znca-api), a third-party service.
> Your secondary account's Nintendo Account id_token, its Coral token, and data exchanged with
> Nintendo's Coral API are sent to that service. nxapi also loads its configuration from
> fancy.org.uk. Nothing is contacted until you accept the notice. See
> [what this means for you](https://github.com/samuelthomas2774/nxapi-znca-api/blob/docs/docs/end-user-help.md).
> The integration follows the service's
> [terms for clients](https://github.com/samuelthomas2774/nxapi-znca-api/blob/docs/docs/public-api-terms.md).

Presence is polled every 60 seconds by default. Games show as "Playing Nintendo Switch" (or
"Nintendo Switch 2"), with the game's icon and, if the game provides one, its status text.
After a network error polling backs off and continues, and it waits as long as nxapi-znca-api asks
(`Retry-After`). Any other error stops polling until you choose **Try again** on the Nintendo
Switch page, because the service's terms forbid other automatic retries.

## Troubleshooting

- **The Discord page shows a session list.** Open "Your Discord clients" to see every session
  Discord reports: your clients, this app's connection, and any headless session. It's the quickest
  way to see why something is or isn't shown. Changes are also logged (see Log).
- **Shown as online after closing a browser tab.** Discord keeps a web client's session for a
  while after the tab closes, so Understudy keeps showing your activity until Discord drops it.
  The desktop app disconnects cleanly.
- **Nothing shows while you're Invisible.** That's deliberate: showing an activity would reveal
  that you're online.
- **`invalid_scope` when connecting Discord.** Enable the Social SDK for your app (see Discord
  setup).

## Architecture

```
src/
  core/        activity model, hub, plugin interfaces, registry, JSON stores, logger
  plugins/     sources and outputs; register new ones in plugins/index.ts
    discord/   OAuth (PKCE), REST client, headless session, activity mapping, publisher
    tautulli/  Plex via Tautulli: polling, filters, templates, artwork (TMDB, iTunes, signed proxy)
    nintendo/  Nintendo Switch via nxapi: consent, sign-in, friend picker, presence polling
    manual/    the hand-driven test source
  core/controls.ts   app-wide pause; core/schedule.ts   quiet-hour windows
  web/         Hono + JSX server-rendered UI with htmx, and settings forms built from zod schemas
```

A **source** calls `ctx.publish(nowPlaying | null)`. An **output** gets `onState(hubState)` with
every source's current activity. A plugin declares its settings as a zod schema, which also
generates its settings form. Plugins can add their own routes (under `/plugins/<instance>/`,
behind the UI password), public routes (under `/public/<instance>/`, for images and webhooks; they
must authenticate requests themselves) and UI panels. Each configured instance is restarted when its settings are saved.
