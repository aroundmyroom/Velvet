# Security Headers

Velvet uses Helmet on its Express entry points to set well-known defensive headers.

## Coverage

- Main server: `src/server.js`
- DLNA server: `src/api/dlna.js`

## Notes

- Helmet is applied at the app boundary so all routes inherit the same baseline headers.
- Keep route-specific exceptions narrow if a future endpoint needs to opt out of a particular header.