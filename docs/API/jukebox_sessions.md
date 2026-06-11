**List Active Jukebox Sessions**
----
  Returns all currently connected Jukebox sessions.  
  Each entry includes the session code, the JWT token the remote client uses to
  authenticate, the session start time, and a ready-to-use `/remote/` URL.

  This endpoint is intended for server-side automation such as Caddy/nginx
  redirect rules that always forward to the most recently started session.

* **URL**

  `/api/v1/jukebox/sessions`

* **Method:**

  `GET`

* **Auth required:** Yes — admin token  
  Returns `405` when `lockAdmin` is enabled, `403` when the caller is not an admin.

* **URL / Body Params**

  None

* **Success Response:**

  * **Code:** 200  
    **Content:**

    ```json
    {
      "sessions": [
        {
          "code":      "aB3xYz9p",
          "token":     "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
          "startTime": 1741018432000,
          "url":       "/remote/aB3xYz9p"
        }
      ]
    }
    ```

* **Field reference**

  | Field | Type | Description |
  |---|---|---|
  | `code` | string | 8-character nanoid used as the Jukebox room identifier |
  | `token` | string \| null | JWT the remote client uses to authenticate WebSocket/API calls. `null` on no-auth servers |
  | `startTime` | number \| null | Unix epoch in **milliseconds** (`Date.now()`) when the WebSocket connection was accepted |
  | `url` | string | Relative path to the remote control page for this session |

* **Empty response (no active sessions):**

  ```json
  { "sessions": [] }
  ```

* **Error responses:**

  | Code | Body | Cause |
  |---|---|---|
  | 401 | `{ "error": "Authentication Error" }` | Missing or invalid token |
  | 403 | `{ "error": "Forbidden" }` | Valid token but not an admin user |
  | 405 | `{ "error": "Admin API Disabled" }` | Server started with `lockAdmin: true` |

* **Usage example — most-recent session redirect (shell)**

  ```sh
  CODE=$(curl -s -H "x-access-token: $ADMIN_TOKEN" \
    https://velvet.local:3000/api/v1/jukebox/sessions \
    | jq -r '.sessions | sort_by(.startTime) | last | .url')
  # $CODE is now e.g. /remote/aB3xYz9p
  ```

* **Usage example — Caddy dynamic redirect via API**

  A small Caddy plugin or external service can poll this endpoint and write the
  `Location` header dynamically.  Simpler: a reverse-proxy passthrough to a
  tiny redirect shim that calls the endpoint on each request:

  ```
  jukebox.home.lan {
    reverse_proxy localhost:3001   # shim that polls /api/v1/jukebox/sessions
  }
  ```

* **Notes:**

  - Sessions exist only in memory.  A server restart clears all sessions.
  - The list order is insertion order (WebSocket connect order).  Sort by
    `startTime` descending to get the most recently started session.
  - The token in each session entry is a **Jukebox-scoped JWT** (`{ jukebox: true }`),
    not the admin's own token.  It should not be shared beyond the remote client.
