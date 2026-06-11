# Deployment & Reverse-Proxy Guide

## nginx Reverse-Proxy Configuration

When serving Velvet behind nginx you **must** set generous timeouts and disable proxy buffering for audio streams. Without this, large FLAC files will stall on idle connections.

Create `/etc/nginx/sites-available/velvet` (adjust `server_name` and `proxy_pass` port to match your setup):

```nginx
server {
    listen 80;
    server_name your.domain.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name your.domain.com;

    ssl_certificate     /etc/letsencrypt/live/your.domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your.domain.com/privkey.pem;

    # --- key settings for large FLAC / audio streaming ---
    proxy_buffering          off;          # stream bytes straight to client
    proxy_read_timeout       3600s;        # keep idle streams alive
    proxy_send_timeout       3600s;
    proxy_connect_timeout    10s;
    client_max_body_size     0;            # no upload-size limit (album art)

    # WebSocket support (waveform + scan-progress events)
    proxy_http_version       1.1;
    proxy_set_header Upgrade    $http_upgrade;
    proxy_set_header Connection "upgrade";

    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    location / {
        proxy_pass http://127.0.0.1:3000;
    }
}
```

Enable and reload:

```bash
ln -s /etc/nginx/sites-available/velvet /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

---

## Nginx Proxy Manager (NPM)

If you use [Nginx Proxy Manager](https://nginxproxymanager.com/) instead of a manual nginx config, apply all of the following — **every item is needed**; omitting any one of them can cause audio dropouts, `ERR_CONTENT_LENGTH_MISMATCH` on large FLAC files, or broken WebSocket connections (scan progress, waveform).

### 1 — Enable WebSockets Support (UI toggle)

On your proxy host's **Details tab**, turn on **"Websockets Support"**. This injects the correct `Upgrade` and `Connection` headers for Velvet's WebSocket events.

### 2 — Custom Nginx Configuration (Advanced tab)

Paste all four lines into the **Advanced tab → Custom Nginx Configuration** box:

```nginx
proxy_set_header Connection "";
proxy_read_timeout 3600s;
proxy_buffering off;
```

> **Important:** do NOT add `proxy_http_version 1.1;` here. When WebSockets Support is enabled (step 1 above), NPM already injects that directive into its generated config. Adding it a second time causes a duplicate-directive error, nginx fails to reload, and the domain becomes unreachable with `ERR_SSL_UNRECOGNIZED_NAME_ALERT`.

| Directive | Why it is required |
|---|---|
| `proxy_set_header Connection ""` | Clears the `Connection: close` header that would otherwise be forwarded, ensuring the upstream connection to Velvet stays persistent (works in tandem with the HTTP/1.1 that NPM sets via the WebSockets toggle). |
| `proxy_read_timeout 3600s` | Prevents NPM from killing idle audio streams (e.g. a paused FLAC after 60 s — the nginx default). |
| `proxy_buffering off` | Forces NPM to stream bytes directly to the browser instead of buffering the entire file. Without this, large FLACs hit the buffer limit and the connection is dropped mid-transfer, causing `ERR_CONTENT_LENGTH_MISMATCH 206`. |

### 3 — Save and verify

Save the proxy host — NPM reloads nginx automatically. No Velvet restart is needed. The FLAC errors should disappear immediately.

---

## Running as a systemd Service

See [install.md](install.md) for full instructions including PM2 and the `music.service` systemd unit.

---

## Release Process

- Bump the version in `package.json`
- Commit with message `vX.X.X`
- Tag: `git tag vX.X.X`
- Push: `git push && git push --tags`
