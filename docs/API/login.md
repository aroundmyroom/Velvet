**Login**
----
  Get a token that can be used to access the rest of the API.

* **URL**

  `/api/v1/auth/login`

* **Method:**

  `POST`

* **Auth required:** No

*  **JSON Params**

   **Required:**

   `username`<br />
   `password`

* **JSON Example**

  ```json
  {
    "username": "root",
    "password": "qwerty"
  }
  ```

* **Success Response:**

  * **Code:** 200

  ```json
  {
    "vpaths": ["Music", "Audiobooks"],
    "token": "REALLY LONG STRING"
  }
  ```

  The server also sets an `x-access-token` cookie (30 days, `SameSite=Strict`, not `httpOnly`) with the same token.

* **Error Response:**

  * **Code:** 401 — `{ "error": "Login Failed" }` (unknown user, wrong password or missing fields). The response is delayed by 800 ms.

* **Notes:**

  - Send the token on later requests in the `x-access-token` header (or as the `token` query parameter / cookie).
  - The old `/login` page redirects to `/` (301).
