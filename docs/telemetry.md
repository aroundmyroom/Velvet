# Anonymous Telemetry

Velvet includes an optional anonymous ping that helps track how many instances are running and which versions are in use. No personal data is ever collected or stored.

---

## What is sent

Once at startup (after a 60-second delay) and then once every 24 hours, Velvet sends this JSON payload to a Cloudflare Worker:

```json
{
  "id": "a3b4c5d6-e7f8-...",
  "version": "5.16.29-velvet",
  "platform": "linux",
  "runtime": "docker",
  "lastSeen": "2026-04-04T12:34:49.943Z"
}
```

| Field | Description |
|---|---|
| `id` | A random UUID generated once on first boot and stored in `save/conf/instance-id`. Not linked to any user or system identity. |
| `version` | The Velvet version string from `package.json`. |
| `platform` | The result of `os.platform()` — e.g. `linux`, `darwin`, `win32`. |
| `runtime` | `"docker"` if running inside a Docker container (detected via `/.dockerenv`), otherwise `"node"`. |
| `lastSeen` | ISO 8601 timestamp of the ping time, added server-side by the Cloudflare Worker. |

**Nothing else is collected.** No IP addresses, no usernames, no file paths, no media library contents, no playback history.

---

## Privacy

- The UUID is generated locally (`crypto.randomUUID()`) and is not derived from any hardware ID, username, or network address.
- The UUID is only stored in `save/conf/instance-id`. Deleting this file causes a new UUID to be generated on the next boot.
- The Cloudflare Worker discards the raw IP — only the fields above are persisted.
- Data is stored in a Cloudflare KV namespace. Aggregate counts (total pings, version distribution) are the only meaningful output.

---

## Opting out

Add `"telemetry": false` to your `save/conf/default.json` and restart Velvet:

```json
{
  "telemetry": false
}
```

When opt-out is active, `telemetry.js` returns immediately at setup and no pings are ever sent. The instance-id file is not created.

The About page in the admin panel also describes this setting.

---

## Implementation

| File | Role |
|---|---|
| `src/api/telemetry.js` | UUID management, ping logic, 24 h interval |
| `save/conf/instance-id` | Persisted UUID (one line, plain text) |

The ping uses the native `fetch()` API with a 10-second `AbortSignal.timeout`. Network failures are silently ignored — a failed ping does not cause any error log entries or retries.
