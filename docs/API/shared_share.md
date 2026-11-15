**Share API**
----
  Endpoints for creating, listing, revoking and opening shared playlist links.

---

### Create a Share Link

* **URL**

  `/api/v1/share`

* **Method:**

  `POST`

* **Headers**

  | Header | Required | Description |
  |---|---|---|
  | `x-access-token` | Yes | User authentication token. |
  | `Content-Type` | Yes | `application/json` |

* **JSON Body**

  | Field | Type | Required | Description |
  |---|---|---|---|
  | `playlist` | `string[]` | Yes | Array of virtual file paths to include in the shared playlist. |
  | `time` | `integer` | No | Expiry in days from now (positive integer). Omit for a permanent (non-expiring) link. |

  ```json
  {
    "playlist": ["Music/Artist/01 Track.flac", "Music/Artist/02 Track.flac"],
    "time": 14
  }
  ```

* **Success Response:**

  * **Code:** 200

  ```json
  {
    "playlistId": "aBcDeFgHiJ",
    "playlist": ["Music/Artist/01 Track.flac", "Music/Artist/02 Track.flac"],
    "user": "alice",
    "expires": 1742000000,
    "token": "eyJhbGciOi..."
  }
  ```

  | Field | Description |
  |---|---|
  | `playlistId` | 10-character nanoid. Use to build the share URL: `/shared/<playlistId>`. |
  | `expires` | Unix timestamp of expiry, or `null` for permanent links. |
  | `token` | JWT used by remote clients to access the shared files. It only grants access to the files in this playlist (plus `/api/v1/db/metadata`, `/api/v1/download/shared` and album art). |

---

### Get a Shared Playlist (public)

* **URL**

  `/api/v1/shared/:playlistId`

* **Method:**

  `GET`

* **Auth required:** No

* **Success Response:**

  * **Code:** 200

  ```json
  {
    "token": "eyJhbGciOi...",
    "playlist": ["Music/Artist/01 Track.flac", "Music/Artist/02 Track.flac"]
  }
  ```

* **Error Response:**

  * **Code:** 404 — `{ "error": "Playlist Not Found" }`
  * **Code:** 410 — `{ "error": "Share Link Expired" }`
  * **Code:** 401 — `{ "error": "Invalid Share Link" }` (the stored token does not verify)

---

### List User's Share Links

* **URL**

  `/api/v1/share/list`

* **Method:**

  `GET`

* **Headers**

  | Header | Required | Description |
  |---|---|---|
  | `x-access-token` | Yes | User authentication token. |

* **Success Response:**

  * **Code:** 200

  ```json
  [
    { "playlistId": "aBcDeFgHiJ", "songCount": 12, "expires": 1742000000 },
    { "playlistId": "kLmNoPqRsT", "songCount": 3,  "expires": null }
  ]
  ```

  Returns only the authenticated user's own share links. `expires: null` means permanent.

---

### Revoke (Delete) a Share Link

* **URL**

  `/api/v1/share/:playlistId`

* **Method:**

  `DELETE`

* **Headers**

  | Header | Required | Description |
  |---|---|---|
  | `x-access-token` | Yes | User authentication token. |

* **URL Params**

  | Param | Description |
  |---|---|
  | `playlistId` | The 10-character share ID returned by `POST /api/v1/share`. |

* **Success Response:**

  * **Code:** 200
  * **Content:** `{ "success": true }`

* **Error Response:**

  * **Code:** 404 — link not found.
  * **Code:** 403 — link belongs to a different user.

---

### Shared Playlist Page — Error States

* **URL**

  `GET /shared/:playlistId`

* **Behaviour**

  | Condition | HTTP Status | Response |
  |---|---|---|
  | Valid, non-expired link | 200 | `shared/index.html` with `{ token, playlist }` injected as a JSON data block (`<script type="application/json" id="sh-data">`). |
  | Expired JWT | **410 Gone** | Styled HTML error page: *"This link has expired"* |
  | Unknown / revoked ID | **404 Not Found** | Styled HTML error page: *"Playlist not found"* |

  Both error states return the normal `shared/index.html` page with
  `{ "error": "expired" }` or `{ "error": "not-found" }` in the `sh-data` block
  instead of playlist data; `shared/app.js` then shows the message in the
  visitor's language (`shared-page.*` keys). A link whose stored token does not
  verify also shows *"Playlist not found"* (404). A trailing slash redirects (301)
  to the URL without it.
