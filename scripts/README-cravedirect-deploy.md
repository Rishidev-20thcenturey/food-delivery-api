# CraveDirect deployment notes

## Deployment topology
- Netlify serves the Vite/React frontend and proxies `/api/v1/*` through an Edge Function.
- The Express API and PostgreSQL database must be deployed separately. A static Netlify site cannot run the backend/database.
- The Edge Function passes the request through the Netlify origin, preserving first-party refresh-cookie behavior.

## Netlify site settings
The repository-root `netlify.toml` is intended to build `frontend/` and publish `frontend/dist`.
Set `BACKEND_API_ORIGIN` in Netlify's runtime/Functions environment variable scope to the backend origin only, e.g. `https://your-api.onrender.com`. Do not include `/api/v1`.
Do not set `VITE_API_URL` to the API host for this deployment: the browser should call `/api/v1` on the Netlify site.

## Backend settings
Set `DATABASE_URL`, a strong private `JWT_ACCESS_SECRET`, `NODE_ENV=production`, `COOKIE_SECURE=true`, `COOKIE_SAMESITE=lax`, `TRUST_PROXY=true` when behind a trusted reverse proxy, and `CORS_ORIGINS` to the exact public Netlify site origin (no trailing slash). Keep every secret in the backend host's secret manager, never Git.
Run migrations before enabling the site, then add active restaurants/menu items using authorized owner/admin workflows.

## Acceptance checks
1. `GET /api/v1/health` returns healthy.
2. `GET /api/v1/ready` succeeds only when PostgreSQL is connected.
3. `GET /api/v1/restaurants?page=1&limit=50` returns the catalogue.
4. Customer registration/login and refresh cookie survive browser navigation.
5. Cart, address, checkout preview, and COD order creation work.
6. Verify that privileged routes reject customer/unauthenticated requests.

Only COD is implemented: online payments and coupons are not supported. Do not accept real orders until database, catalogue, delivery workflows, monitoring, and production settings are ready.
