# Reverse-Proxy Login (Trusted-Header Auth / SSO)

Velvet can let a reverse proxy — or an auth layer sitting in front of it —
sign users in, instead of typing a username and password into Velvet's own
login form. This is the same mechanism Navidrome calls `ExtAuth`. Velvet's own
login form and password auth **stay live** the whole time; this is an
additional way in, not a replacement.

Configure it under **Admin → Settings → Reverse-Proxy Login (SSO)**, or via
`GET`/`POST /api/v1/admin/ext-auth` (see `docs/API.md`).

## How it works

1. Something in front of Velvet authenticates the visitor (a login page, an
   SSO provider, HTTP basic auth — anything) and, once it has approved the
   request, adds a header naming the logged-in user — e.g. `Remote-User: alice`.
2. That request reaches Velvet. Velvet checks two things before trusting the
   header at all:
   - The request's **actual TCP connection** came from an IP/CIDR in the
     configured **Trusted proxy IPs / CIDR ranges** list.
   - If a **shared-secret header** is configured (recommended), its value
     matches exactly.
3. If both checks pass, Velvet reads the configured header as a username. If
   a Velvet user with that name exists, the browser gets signed in — same
   session cookie as a normal password login.

Velvet deliberately checks the raw socket's source IP, not `X-Forwarded-For`
— a header any client can set for itself. That means **the trusted-proxy
entry must be the address Velvet's own TCP connection sees**, which, in a
typical Docker Compose setup, is the reverse proxy container's address on the
shared Docker network.

## Why the shared secret matters

IP-allowlisting alone is weak inside a Docker network: any other container
sharing that network can reach Velvet directly on its published/internal port
and could try to spoof the header itself. The shared-secret header closes
that gap — even if the IP allowlist is too broad (e.g. a whole Compose subnet
CIDR), a request must also carry a secret value only your reverse-proxy
config knows. Generate one from the admin card and configure your proxy to
send it.

## Nginx Proxy Manager

Nginx Proxy Manager (NPM) has no authentication of its own — it's a plain
reverse proxy. You need something in front that actually authenticates
users, e.g. [Authelia](https://www.authelia.com/) or
[Authentik](https://goauthentik.io/), and NPM forwards the header it sets.

In the NPM proxy host for your Velvet host, open the **Advanced** tab (raw
nginx config is allowed there) and add:

```nginx
# Forward the authenticated username from your auth layer (adjust the
# variable/header name to whatever your auth service sets) and Velvet's
# shared secret.
proxy_set_header Remote-User $upstream_http_remote_user;
proxy_set_header X-Velvet-ExtAuth-Secret "your-generated-secret-here";
```

If you're chaining through Authelia/Authentik's `auth_request` pattern in
NPM, follow their standard NPM integration guide for the `auth_request`
block first — the snippet above only needs to run *after* that block has
already set `$upstream_http_remote_user` (or whatever variable your auth
service exposes the username as).

Then in Velvet's admin card:
- **Trusted proxy IPs / CIDR ranges**: the IP or subnet NPM's container
  connects from. On a shared Docker Compose network this is usually the
  network's subnet, e.g. `172.18.0.0/16` — check `docker network inspect`
  for the actual subnet, or pin NPM to a static IP in `docker-compose.yml`.
- **Shared-secret header name**: `X-Velvet-ExtAuth-Secret` (default).
- **Shared-secret value**: paste the same value you put in the `nginx`
  snippet above.

## Traefik (forward-auth)

If you already run an `auth_request`/forward-auth middleware (Authelia,
Authentik, tinyauth, ...), add the same two headers to the middleware's
response-header pass-through, or add a second middleware that sets them:

```yaml
http:
  middlewares:
    velvet-extauth-secret:
      headers:
        customRequestHeaders:
          X-Velvet-ExtAuth-Secret: "your-generated-secret-here"
```

Chain it after your forward-auth middleware in the router for Velvet's host.
Trusted-proxy IP: Traefik's container/service IP on its Docker network.

## Caddy (forward_auth)

```caddyfile
music.example.com {
  forward_auth auth-service:9091 {
    uri /api/verify
    copy_headers Remote-User
  }
  reverse_proxy velvet:3000 {
    header_up X-Velvet-ExtAuth-Secret "your-generated-secret-here"
  }
}
```

## Auto-creating accounts

**Automatically create Velvet accounts for new header usernames** is off by
default — the recommended setup is to pre-create matching Velvet usernames
under **Admin → Users** so access (which libraries, admin rights) is
deliberate. Turning it on creates a Velvet account for any first-seen header
username, with access to every non-excluded library and no admin rights; the
account's Velvet password is a random value nobody knows, since sign-in
always goes through the proxy for that account from then on.

## Checking your setup is safe

If **Reverse-proxy login** is on but no trusted proxies are configured, or
Velvet is listening on `0.0.0.0`/`::` (all interfaces) rather than only where
your reverse proxy can reach it, the admin card shows a warning. In that
situation, confirm Velvet is not reachable directly on its port from outside
your reverse proxy — otherwise anyone who can reach Velvet's port directly
could set the header themselves and sign in as anyone.

---

See also: [docs/login-pairing.md](login-pairing.md) for **Pair a Device** — a
different, self-service passwordless option for individual devices like a
Samsung TV, with nothing for an admin to configure.
