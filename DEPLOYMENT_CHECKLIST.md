# CraveDirect deployment checklist

## Architecture
- **Netlify:** React/Vite frontend plus a same-origin Edge Function proxy for `/api/v1/*).
- **Separate Node host:** Express backend in `backend/`.
- **PostgreSQL:** Required by the backend. Netlify static hosting does not run Express or host this database.

## 1. Deploy the API
1. Provision a PostgreSQL database with persistence and a backup plan.
2. Import this repository into Render using the root `render.yaml` Blueprint (or configure the equivalent Node service manually).
3. Provide `DATABASE_URL` and `CORS_ORIGINS` in the backend host's secret/environment settings. `CORS_ORIGINS` must be the exact Netlify origin once the site exists, without a trailing slash.
4. Keep `JWT_ACCESS_SECRET` generated and private. Use `NODE_ENV=production`, `COOKIE_SECURE=true`, `COOKIE_SAMESITE=lax`, `TRUST_PROXY=true`, and `ENABLE_COD=true`.
5. Wait for migrations and check `GET https://YOUR-API/api/v1/health`, then `GET https://YOUR-API/api/v1/ready` (the latter requires a connected database).
6. Ensure there are active restaurants, categories and menu items. An empty database means the public catalogue is empty; the development seed intentionally refuses to run with `NODE_ENV=production`.

## 2. Connect and automate the frontend deployment
1. Use the existing Netlify site `cravedirect-web`; do not create a second site unless the existing site cannot be linked.
2. In Netlify, confirm the repository is `Rishidev-20thcenturey/food-delivery-api`. Set the **production branch to `main`**. If the site is not linked to GitHub, connect this repository and select `main`.
3. The repository's `netlify.toml` already defines the build command, Node.js version, publish directory, SPA fallback, and same-origin `/api/v1/*` Edge Function proxy. Keep these settings; do not replace them with a backend build command.
4. In Netlify's runtime/Functions environment scope, set `BACKEND_API_ORIGIN` to only the API origin, e.g. `https://cravedirect-api.onrender.com` (no `/api/v1`, no path, no secret).
5. Copy the exact production Netlify origin into the backend's `CORS_ORIGINS`, then redeploy the backend if that value changes. Redeploy the frontend after setting `BACKEND_API_ORIGIN`.
6. Keep `VITE_API_URL` unset; the browser should call the relative `/api/v1` same-origin proxy so the HttpOnly refresh cookie remains first-party.
7. After the site is linked to GitHub and production branch is `main`, future commits merged into `main` should trigger Netlify production builds automatically. The GitHub Frontend build workflow also type-checks and builds frontend changes on `main`; check both Netlify deploy status and GitHub Actions after the first switch.

## 3. Acceptance tests
- [ ] `GET /api/v1/health` returns healthy; `GET /api/v1/ready` reports database readiness.
- [ ] Restaurant catalogue and menu endpoints render in the frontend.
- [ ] Customer registration and login succeed; refresh-cookie login survives a page reload.
- [ ] Cart add/update/remove and address creation work.
- [ ] Checkout preview and COD order creation succeed; order history renders.
- [ ] Confirm customers cannot access owner/admin/courier-only operations.
- [ ] Check production logs for cookie, CORS, database and API errors.

## Scope and limitations
- The current storefront implements customer browsing, registration/login, cart, address entry, cash-on-delivery checkout and order history.
- Online payments and coupon/promotional codes are not implemented by the API.
- Owner, courier and admin API routes exist in the backend; this customer storefront does not provide their dashboards.
- Do not accept real customer orders until the API, database, active catalogue, delivery workflow, monitoring and backups are configured and verified.
- Frontend build status must be confirmed by the frontend CI workflow / Netlify deploy before publishing. The current execution environment could not resolve the npm registry, so a local production build has not been verified here.
