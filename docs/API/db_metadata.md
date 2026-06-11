**Get Metadata From DB**
----
  Retrieves albums and artists that match a given string

* **URL**

  /db/metadata

* **Method:**

  `POST`

* **JSON Params**

   **Required:**

   `filepath` - filepath of song

* **JSON Example**

  ```
  {
    'filepath': '/path/to/file'
  }
  ```

* **Success Response:**

  * **Code:** 200 <br />
    **Content:**

    ```
    {
      "filepath":"/path/to/file.mp3",
      "metadata":{
        "artist": "Artist",
        "album": "Album",
        "track": 3,
        "track-of": 12,
        "title": "Song Title",
        "year": 1990,
        "album-art": "hash.jpg",
        "hash": "md5 hash",
        "duration": 237.431
      }
    }
    ```
