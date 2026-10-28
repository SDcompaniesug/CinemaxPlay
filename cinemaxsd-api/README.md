# CinemaxSD API

Persistent media catalogue API backed by Neon PostgreSQL. Imports MunoPix content and serves the saved copy if the upstream API is offline.

Routes:
- GET / or /health — health check
- GET /api/content?page=1&perPage=20 — paginated catalogue
- GET /api/content?q=batman&type=movie&genre=Action&tag=popular — search/filter
- GET /api/content/:id — one item by local ID or upstream source ID
- GET /api/filters — genres, tags and years
- GET /api/stats — catalogue totals and last sync
- POST /api/sync — import/update; requires X-API-Key or Authorization: Bearer

Set DATABASE_URL (Neon injects this on Neon Functions), CINEMAXSD_API_KEY (a long random secret), and optionally MUNOPIX_API_URL and CORS_ORIGIN. The table and index are created automatically. Upserts avoid duplicates. POST /api/sync accepts JSON such as {"perPage":100,"maxPages":100}. It stores metadata and stream URLs, not video files; upstream video links can still expire or stop working if their host goes offline.
