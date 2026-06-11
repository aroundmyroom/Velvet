**Share API** *(added by GitHub Copilot, 2026-02-27)*
----
  Three endpoints for creating, listing, and revoking shared playlist links.
  Replaces the legacy `/shared/make-shared` endpoint.

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
  | `time` | `integer` | No | Expiry in days from now. Omit for a permanent (non-expiring) link. |

  ```json
  {
    "playlist": ["/Music/Artist/01 Track.flac", "/Music/Artist/02 Track.flac"],
    "time": 14
  }
  ```

* **Success Response:**

  * **Code:** 200

  ```json
  {
    "playlistId": "aBcDeFgHiJ",
    "playlist": ["/Music/Artist/01 Track.flac"],
    "user": "alice",
    "expires": 1742000000,
    "token": "eyJhbGciOi..."
  }
  ```

  | Field | Description |
  |---|---|
  | `playlistId` | 10-character nanoid. Use to build the share URL: `/shared/<playlistId>`. |
  | `expires` | Unix timestamp of expiry, or `null` for permanent links. |
  | `token` | JWT used by remote clients to access the shared files. |

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
  | Valid, non-expired link | 200 | `shared/index.html` with playlist data injected. |
  | Expired JWT | **410 Gone** | Styled HTML error page: *"This link has expired"* |
  | Unknown / revoked ID | **404 Not Found** | Styled HTML error page: *"Link not found"* |

  Both error states return the `shared/index.html` shell with a full-screen
  overlay injected into `<body>` (dark theme, purple icon, human-readable
  message). `sharedPlaylist` is set to `null` in the page script to prevent
  JS errors. Previously these cases returned a raw `{ "error": "Server Error" }`
  JSON response in the browser.
