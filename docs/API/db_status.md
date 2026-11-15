**DB Status**
----
  Checks if a scan is in progress.

* **URL**

  `/api/v1/db/status`

* **Method:**

  `GET`

* **Success Response:**

  * **Code:** 200 <br />
    **Content:**

    ```json
    {
      "totalFileCount": 150,
      "locked": false,
      "vpaths": ["Music"],
      "scanningVpaths": []
    }
    ```

    - `totalFileCount` — number of files in the user's vpaths
    - `locked` — `true` while a scan is in progress
    - `vpaths` — the user's vpaths
    - `scanningVpaths` — the scans in progress for the user's vpaths
