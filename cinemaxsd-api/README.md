# CinemaxSD API

Neon Functions API backed by Neon PostgreSQL. Imported content is served from the local database, so catalogue browsing does not depend on MunoPix remaining online.

## Configuration
- `DATABASE_URL`: injected automatically by Neon Functions.
- `MUNOPIX_API_URL`: optional upstream URL; defaults to `https://85.190.254.61/munopix/browse_api.php`.
- `SYNC_TOKEN`: required secret for importing; send as `X-Sync-Token` or `Authorization: Bearer <token>`.

## Endpoints
- `GET /` or `GET /health` — database health and saved content count.
- `GET /api/content?q=batman&type=movie&genre=Action&vj=...&tag=...&page=1&perPage=20` — local catalogue, search and filters.
- `GET /api/content/:id` — one item by local ID or source ID.
- `POST /api/sync` — imports/upserts all upstream pages; requires sync token.
- `GET /api/sync/status` — latest import status.

## Deployment
The workflow `.github/workflows/deploy-cinemaxsd.yml` deploys the function to the configured Neon project/branch. Configure repository Actions secrets `NEON_API_KEY` and `SYNC_TOKEN`, then run **Actions → Deploy CinemaxSD API → Run workflow**. The workflow builds the dependency bundle using the Neon CLI.
