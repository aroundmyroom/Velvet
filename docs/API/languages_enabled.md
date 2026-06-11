**Languages Configuration and Availability** *(v6.9.0-velvet)*
----
Controls which UI languages are available and exposes the active allowlist to public clients.

## 1) Public enabled-languages list

* **URL**

  `/api/v1/languages/enabled`

* **Method:**

  `GET`

* **Auth:**

  None (public endpoint)

* **Success Response:**

  * **Code:** 200
  * **Content:**

  ```json
  {
    "enabled": ["en", "nl", "de"]
  }
  ```

* **Notes**

  - Used by player and admin language pickers to only render configured languages.
  - Falls back to all supported language codes when no explicit config is set.

---

## 2) Admin language config (read)

* **URL**

  `/api/v1/admin/languages/config`

* **Method:**

  `GET`

* **Headers**

  | Header | Required | Description |
  |---|---|---|
  | `x-access-token` | Yes | Auth token of an admin user. |

* **Success Response:**

  * **Code:** 200
  * **Content:**

  ```json
  {
    "enabled": ["en", "nl", "de"]
  }
  ```

* **Error Response:**

  * **Code:** 403 — `{ "error": "Admin only" }`

---

## 3) Admin language config (write)

* **URL**

  `/api/v1/admin/languages/config`

* **Method:**

  `POST`

* **Headers**

  | Header | Required | Description |
  |---|---|---|
  | `x-access-token` | Yes | Auth token of an admin user. |
  | `Content-Type` | Yes | `application/json` |

* **JSON Body**

  | Field | Type | Required | Description |
  |---|---|---|---|
  | `enabled` | `string[]` | Yes | Allowed language codes. Minimum 1 entry. |

  ```json
  {
    "enabled": ["en", "nl", "de", "fr"]
  }
  ```

* **Success Response:**

  * **Code:** 200
  * **Content:** `{}`

* **Error Response:**

  * **Code:** 400 — Joi validation error.
  * **Code:** 403 — `{ "error": "Admin only" }`

* **Notes**

  - `en` is always forced to remain enabled and first in the stored list.
  - Values outside the supported set are ignored.
  - Changes are persisted to `save/conf/default.json` (`languages.enabled`) and applied immediately.
