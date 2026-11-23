# multi-scrobbler

Velvet can send your plays to [multi-scrobbler](https://github.com/FoxxMD/multi-scrobbler), a self-hosted app that forwards plays to many scrobble services at once: ListenBrainz, Last.fm, Libre.fm, Maloja, Koito, teal.fm, Rocksky, Discord, Tuneshine and any webhook. You set those services up once in multi-scrobbler; Velvet only needs its address and a token.

Documentation of multi-scrobbler itself: <https://docs.multi-scrobbler.app/>.

## Why

- **One place for all services.** Velvet talks to Last.fm and ListenBrainz directly. Everything else (Maloja, Koito, Libre.fm, teal.fm, Rocksky, …) goes through multi-scrobbler.
- **Last.fm Pro.** From 1 December 2026 a Last.fm API key only works when its owner has Last.fm Pro. Velvet's own Last.fm scrobbling uses the admin's API key, and so does multi-scrobbler's Last.fm client, so both need Pro for Last.fm. multi-scrobbler does not get around that, but every other service keeps working without it.

## How it works

```
 Velvet player / Subsonic app / Velvet Room
          │  song starts      → "playing now"
          │  after 30 s       → listen
          ▼
 Velvet server ── POST <url>/1/submit-listens ──▶ multi-scrobbler
                  Authorization: Token <token>      "ListenBrainz endpoint" source
                                                       │
                                                       ▼
                                   clients: ListenBrainz, Maloja, Koito,
                                            Libre.fm, Last.fm, teal.fm, …
```

Velvet sends exactly what it sends to ListenBrainz, to multi-scrobbler's **ListenBrainz endpoint** source (type `endpointlz`):

- A **playing now** ping when a song starts. multi-scrobbler shows it as now playing.
- A **listen** after 30 seconds of playback. multi-scrobbler trusts that decision and forwards it to its clients.

Each listen carries artist, title, album, album artist, track number, duration, the MusicBrainz recording ID when the file has one, and `Velvet` with its version as the submitting client. Radio streams and podcast episodes are not sent.

Last.fm, ListenBrainz and multi-scrobbler work side by side. If a service is set up both in Velvet and in multi-scrobbler, it receives every play twice, so pick one route per service.

## Admin setup

multi-scrobbler has a web dashboard, but **you cannot configure it there**. Sources (where plays come from) and clients (where plays go) are set with environment variables or JSON files, and multi-scrobbler reads them only when it starts. The dashboard shows status, recent plays and logs, and has buttons for login flows and restarts.

The setup has five parts:

| # | Where | What |
|---|---|---|
| 1 | Docker host | A config folder that the container may write to |
| 2 | Docker | The multi-scrobbler container |
| 3 | multi-scrobbler | A **ListenBrainz endpoint source** with a token: Velvet posts its plays here |
| 4 | multi-scrobbler | One or more **clients**: the services the plays are forwarded to |
| 5 | Velvet | The URL and token in the admin panel, then each user opts in |

### 1. Prepare the config folder

multi-scrobbler stores its state (play history, queues, login sessions) in `/config` inside the container. Bind it to a folder on the host. Use an **absolute** path: with a relative `./config` it depends on where your Docker manager keeps the stack.

The container runs as user **65532:65532**, not as root. The folder must belong to that user, or multi-scrobbler stops at boot with `'/config' is not writeable. multi-scrobbler is running as user 65532:65532` and restarts in a loop:

```bash
sudo mkdir -p /opt/multi-scrobbler/config
sudo chown -R 65532:65532 /opt/multi-scrobbler/config
```

Run these where the Docker engine runs. If Docker lives in an unprivileged Proxmox LXC, run them **inside** the LXC, not on the Proxmox host.

Instead of `chown` you can run the container as the folder's owner: add `user: "1000:1000"` (the output of `id -u` and `id -g` of that owner) to the service in the compose file.

### 2. Run the container

The quickest setup uses only environment variables, so no JSON files are needed:

```yaml
services:
  multi-scrobbler:
    image: foxxmd/multi-scrobbler:0.21.1
    container_name: multi-scrobbler
    environment:
      - TZ=Europe/Amsterdam
      - BASE_URL=http://192.168.1.10:9078      # how your browser reaches multi-scrobbler
      # 3. the source Velvet sends to
      - LZE_TOKEN=<long random token>
      # 4. at least one client, for example Maloja:
      - MALOJA_URL=http://192.168.1.10:42010
      - MALOJA_API_KEY=<Maloja API key>
    volumes:
      - /opt/multi-scrobbler/config:/config
    ports:
      - "9078:9078"
    restart: unless-stopped
```

Make a token with, for example, `openssl rand -hex 24`. It is a shared secret between Velvet and multi-scrobbler, not an account password of any service.

Deploy the stack and watch its log. A good start ends with the web server listening on port 9078 and the source `velvet` (or the name you gave it) being ready. Then open `http://<host>:9078`.

**Secure the dashboard.** On first start multi-scrobbler creates the user `admin` without a password: until you set one, anyone on the network can use the dashboard. Click **Set an admin password** in the dashboard banner (or open `/setup`). The endpoints Velvet uses (`/1/submit-listens`, `/api/health`, `/api/version`) stay open, so this does not affect Velvet; the token protects those.

### 3. The ListenBrainz endpoint source

This is the part Velvet talks to. It is a fake ListenBrainz server inside multi-scrobbler: Velvet posts listens to `<url>/1/submit-listens` with `Authorization: Token <token>`, and the token decides which source receives them.

With environment variables: `LZE_TOKEN` (as above).

With a file instead, `/config/endpointlz.json`:

```json
[
  {
    "id": "velvet",
    "name": "velvet",
    "enable": true,
    "data": { "token": "<long random token>" }
  }
]
```

Do not set a `slug` (`LZE_SLUG`): Velvet always posts to `/1/submit-listens` at the root.

### 4. Clients: where your plays go

Without a client, multi-scrobbler accepts the plays and shows them on the dashboard, but forwards them nowhere. Add at least one. The most common ones:

| Service | Environment variables | File |
|---|---|---|
| Maloja | `MALOJA_URL`, `MALOJA_API_KEY` | `maloja.json` |
| Koito | `KOITO_URL`, `KOITO_TOKEN`, `KOITO_USER` | `koito.json` |
| ListenBrainz (or a self-hosted compatible server) | `LZ_TOKEN`, `LZ_USER`, optional `LZ_URL` | `listenbrainz.json` |
| Last.fm | `LASTFM_API_KEY`, `LASTFM_SECRET`, `LASTFM_REDIRECT_URI` | `lastfm.json` |

File example, `/config/maloja.json`:

```json
[
  {
    "id": "maloja",
    "name": "Maloja",
    "enable": true,
    "configureAs": "client",
    "data": { "url": "http://192.168.1.10:42010", "apiKey": "<Maloja API key>" }
  }
]
```

Notes per service:

- **Maloja**: create the API key in Maloja's admin panel under *API Keys*.
- **Koito**: the token is under *Settings → API Keys* in Koito. Give only Koito's base URL; multi-scrobbler adds the API path itself.
- **ListenBrainz**: the user token is on your ListenBrainz profile page. In the file the user field is `username`, in the environment `LZ_USER`.
- **Last.fm**: after starting, authorise the client from multi-scrobbler's dashboard; Last.fm redirects back to `LASTFM_REDIRECT_URI` (`http://<host>:9078/lastfm/callback`). From 1 December 2026 this needs a Last.fm Pro account, the same as Velvet's own Last.fm scrobbling.

The full list of clients and their options is in the [multi-scrobbler documentation](https://docs.multi-scrobbler.app/configuration/). Restart the container after every config change.

> **Avoid double scrobbles.** Velvet already scrobbles to Last.fm and ListenBrainz itself (player sidebar → *Last.fm* / *ListenBrainz*). If a user has a service connected in Velvet **and** multi-scrobbler forwards to the same account, every play arrives twice. Pick one route per service: usually keep Last.fm and ListenBrainz in Velvet, and use multi-scrobbler for the services Velvet does not support.

### 5. Connect Velvet

1. Go to **Admin panel → multi-scrobbler**.
2. **Server URL**: the address of multi-scrobbler itself, for example `http://192.168.1.10:9078`. `http` and `https` both work, and so does a reverse-proxy subpath (`https://example.com/scrobbler`). Do not add `/1/submit-listens` or a source path: Velvet adds the path itself.
3. **Server token**: the token from step 3. Users without a personal token send with this one. You may leave it empty when every user enters their own.
4. Click **Test connection**. All three lines should be green (see the table below).
5. Tick **Let users send their plays to multi-scrobbler** and click **Save**. Without this tick nothing is sent, even with a correct URL and token.

The token is never shown again after saving. Leave the field empty to keep it, or use **Remove token**.

Then every user who wants it switches it on (see [User setup](#user-setup)).

### 6. Check that it works

1. Play a song in Velvet for more than 30 seconds.
2. In the player, open **multi-scrobbler** under *Connectors*. It should say **Last play accepted**.
3. In multi-scrobbler's dashboard the `velvet` source changes from *Awaiting Data* to *Received Data* and lists the play, and each client shows it as scrobbled.

If step 2 is fine but a client did not receive the play, the problem is between multi-scrobbler and that service: check the client's status and the log in multi-scrobbler's dashboard.

### Test connection

| Result | Meaning |
|---|---|
| Reachable: multi-scrobbler *version* | Velvet reached the server at this URL. |
| All sources and clients are healthy | multi-scrobbler's health check answered OK. |
| multi-scrobbler reports a problem with a source or client (status 500) | A source or client in multi-scrobbler has an error, for example a client with a wrong API key. Check multi-scrobbler's own dashboard. Status 503 means it runs in safe mode. |
| ListenBrainz endpoint source found | multi-scrobbler has an `endpointlz` source. |
| No ListenBrainz endpoint source found | Add one (step 2) and restart multi-scrobbler. |
| Could not reach multi-scrobbler at this URL | Wrong address or port, a firewall, or `https` on a server that only speaks `http` (or the other way round). |

The test does not check the token: multi-scrobbler's token check answers OK as soon as any endpoint source exists. A wrong token only shows when a play is sent (see the status messages below).

## User setup

1. In the player sidebar, under **Connectors**, open **multi-scrobbler**. The page only shows when the admin has enabled it.
2. Tick **Send my plays to multi-scrobbler**.
3. Optional: enter a **personal token** when the admin set up a source just for you (see [One source per person](#one-source-per-person)). Leave it empty to use the server token.
4. Click **Save**.

Without user accounts (no-auth mode) every play goes to multi-scrobbler with the server token as soon as the admin enables it.

### Subsonic apps

Plays from Subsonic apps are forwarded only when you also tick **Forward to multi-scrobbler** on the player's **Subsonic** page. The Subsonic app's "now playing" report is forwarded too.

### Velvet Rooms

When a song plays in a [Velvet Room](rooms.md), the server sends the playing-now ping and the listen itself, for the user who last controlled the room, so they arrive without a browser open. The Playing Now view shows a multi-scrobbler badge next to Last.fm and ListenBrainz.

## Status messages

The player's multi-scrobbler page shows the result of your last listen (it resets when Velvet restarts):

| Message | What to do |
|---|---|
| Last play accepted *time* | Nothing, it works. |
| multi-scrobbler did not accept the token | multi-scrobbler answered 409: the token matches no ListenBrainz endpoint source. Compare the token in Velvet with `data.token` in `endpointlz.json` (or `LZE_TOKEN`). |
| multi-scrobbler could not be reached | The server is down, or the URL, port or `http`/`https` is wrong. Run **Test connection** in the admin panel. |
| Last play failed: *status and message* | Any other answer from multi-scrobbler. A 404 usually means the URL points at a subpath instead of multi-scrobbler's root. |

When multi-scrobbler accepts a play but a service does not receive it, the problem is on the multi-scrobbler side: check its dashboard and logs.

## Common setup problems

| Symptom | Cause and fix |
|---|---|
| Container restarts in a loop; log says `'/config' is not writeable ... running as user 65532:65532` | The host folder belongs to another user. `chown -R 65532:65532` it, or set `user:` in the compose file ([step 1](#1-prepare-the-config-folder)). |
| Dashboard opens but shows no `velvet` source | No `LZE_TOKEN` and no `endpointlz.json`, a JSON syntax error in the file, or the file is not in the folder mounted on `/config`. Check the log right after start. |
| Test connection says *No ListenBrainz endpoint source found* | Same as above; restart multi-scrobbler after adding the source. |
| Player says *multi-scrobbler did not accept the token* | The token in Velvet differs from `LZE_TOKEN` / `data.token`. Tokens are compared without regard to case. |
| Test connection is green, but nothing is sent | **Let users send their plays to multi-scrobbler** is not ticked in the admin panel, or the user has not switched it on on their multi-scrobbler page. |
| Source shows *Received Data*, but no service gets the play | No client is set up, a client has an error (see its status in the dashboard), or the source's `clients` list does not contain that client's `id`. |
| Every play arrives twice on a service | That service is connected both in Velvet and as a multi-scrobbler client. Remove one of the two. |

## Privacy: shared token or one source per person

With only the server token, **everyone's plays go to the same multi-scrobbler source and therefore to the same accounts**. That suits a household that shares one Maloja, but not separate people with their own profiles.

### One source per person

Give every person an endpoint source with their own token, and restrict that source to that person's clients with the top-level `clients` option, a list of client `id`s:

```json
[
  {
    "id": "velvet-anna",
    "name": "velvet-anna",
    "enable": true,
    "clients": ["anna-listenbrainz"],
    "data": { "token": "anna-secret" }
  },
  {
    "id": "velvet-ben",
    "name": "velvet-ben",
    "enable": true,
    "clients": ["ben-maloja"],
    "data": { "token": "ben-secret" }
  }
]
```

`anna-listenbrainz` and `ben-maloja` are the `id`s of clients defined in `listenbrainz.json` and `maloja.json`. The `clients` option exists only in the JSON files, not as an environment variable. Without `clients`, a source sends to every client.

Each person then enters their own token on the player's multi-scrobbler page.

## Configuration

Stored in `save/conf/default.json`. See [json_config.md](json_config.md#multi-scrobbler-server-level).

```json
{
  "multiScrobbler": { "enabled": true, "url": "http://192.168.1.10:9078", "token": "velvet-secret" }
}
```

Per user: `ms-enabled`, `ms-token` and `subsonic-scrobble-ms` in the `users` object.

## API

| Method | Path | Access |
|---|---|---|
| `GET` | `/api/v1/admin/multi-scrobbler/config` | Admin — `{ enabled, url, hasToken }` |
| `POST` | `/api/v1/admin/multi-scrobbler/config` | Admin — `{ enabled, url, msToken? }` |
| `POST` | `/api/v1/admin/multi-scrobbler/test` | Admin — `{ url? }` → `{ reachable, version, healthy, healthStatus, endpointSource }` |
| `GET` | `/api/v1/multi-scrobbler/status` | User — `{ serverEnabled, enabled, ownToken, serverToken, canEdit, last }` |
| `POST` | `/api/v1/multi-scrobbler/settings` | User — `{ enabled, msToken? }` |
| `POST` | `/api/v1/multi-scrobbler/playing-now` | User — `{ filePath }` → `{ sent }` |
| `POST` | `/api/v1/multi-scrobbler/scrobble-by-filepath` | User — `{ filePath }` → `{ scrobbled }` |

Details in [API.md](API.md#scrobbling--multi-scrobbler-velvet).

## multi-scrobbler endpoints Velvet uses

- `POST /1/submit-listens` with `Authorization: Token <token>` — playing now and listens. `200 {"status":"ok"}` = accepted, `409` = token matches no endpoint source.
- `GET /api/version`, `GET /api/health` (200 OK, 500 a source or client has issues, 503 safe mode) and `GET /1/validate-token` — only for **Test connection**.

Requests time out after 8 seconds (6 seconds for the test).
