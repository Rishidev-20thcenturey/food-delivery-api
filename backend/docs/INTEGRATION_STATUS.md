# CraveDirect Integration Status

Last updated: 2026-10-16

This document describes the integrated CraveDirect source: the Express API, the React customer storefront, and the public global-discovery directory.

## 1. Current deployment and source layout

| Component | Current location / role |
| --- | --- |
| Customer storefront | `frontend/` — React 19, TypeScript, Vite |
| Static frontend hosting | Netlify; build and routing settings are in `netlify.toml` |
| API | `backend/` — Node.js, TypeScript, Express 5 |
| API hosting template | `render.yaml` — Render service blueprint configuration |
| Database | PostgreSQL; configured using `DATABASE_URL` in the backend environment |
| API proxy | `netlify/edge-functions/api-proxy.ts` forwards same-origin `/api/v1/*` requests |
| API contract | `backend/docs/openapi.yaml` |
| Discovery data model and operator guide | `backend/docs/DISCOVERY.md` |

Live links: [CraveDirect storefront](https://cravedirect-web.netlify.app/) · [API health endpoint](https://cravedirect-api.onrender.com/api/v1/health).

The source tree and the deployed services are separate concerns. Committing code to GitHub does not automatically change the branch configured in Netlify or Render; confirm those hosting settings before expecting a push to redeploy either service.

## 2. Feature status

| Area | Status |
| --- | --- |
| Customer authentication | Implemented: registration, login, refresh-cookie restoration, logout |
| Orderable restaurant catalogue | Implemented: restaurant search, menus, categories and reviews |
| Cart and checkout | Implemented: server-side pricing, delivery addresses, checkout preview and idempotency protection |
| Payment | Cash on delivery only; online payments are not implemented |
| Customer orders | Implemented: order history and order-status views; status updates are polling-based, not real-time |
| Owner, courier and admin capabilities | Implemented in the API; this is not yet a full owner/courier/admin web dashboard |
| Public discovery directory | Three public, read-only API operations: `GET /discovery/places`, `GET /discovery/places/{id}`, and `GET /discovery/facets` |
| Global discovery interface | Integrated in the storefront with search, place/country/city/cuisine filters, details, attribution and external links |
| Discovery-to-order boundary | A directory listing is orderable through CraveDirect only after an operator explicitly links it to an active CraveDirect restaurant |
| Documentation | OpenAPI 3.1, API contract, frontend integration guide and discovery/import runbook |

The OpenAPI specification records **54 API operations**, including the three public discovery operations.

### Global discovery data rules

- The discovery directory is separate from the orderable catalogue and is public and read-only.
- External listings do not automatically become CraveDirect merchants. An external ordering link leads to the external provider's page; it is not an order placed through CraveDirect.
- Discovery records must retain source/licence/attribution information. Unknown ratings, prices, opening status and other fields must not be invented.
- The directory's coverage depends on the data present in the database and on permitted imports. The implementation does not promise a complete list of restaurants worldwide.
- Discovery prices, when available, remain in the source currency and never enter the existing INR checkout flow.
- The TypeScript import command is `npm run db:import:discovery` from `backend/`. It is a local/operator workflow; importing is not triggered automatically by normal API requests. See [DISCOVERY.md](DISCOVERY.md).

The repository also retains a separate, manual OpenStreetMap import workflow in `.github/workflows/discovery-global-import.yml` with its runbook at [`docs/DISCOVERY_IMPORT_RUNBOOK.md`](../../docs/DISCOVERY_IMPORT_RUNBOOK.md). It is distinct from the application API and must remain an explicit operator action.

## 3. Verification record

The last recorded successful CI run for the integrated feature commit `b65137228694835244dfb2fbf624cd9504b5c03c` completed these checks:

| Check | Recorded result | Run |
| --- | --- | --- |
| Backend CI | Passed | [GitHub Actions run](https://github.com/Rishidev-20thcenturey/food-delivery-api/actions/runs/38737045182) |
| Frontend production build | Passed | [GitHub Actions run](https://github.com/Rishidev-20thcenturey/food-delivery-api/actions/runs/38737045015) |
| Backend test suite | 184 tests across 12 files reported passing | Backend CI run above |
| Type-check, lint and build | Reported successful | Backend CI run above |

The merge candidate (`fade8629ff670415121e4854c1cc79b6c642d988`) passed both workflows before [PR #7](https://github.com/Rishidev-20thcenturey/food-delivery-api/pull/7) was merged into `main` as [merge commit `d60bafd`](https://github.com/Rishidev-20thcenturey/food-delivery-api/commit/d60bafd1c616806f50547b48c07b752b664e304f). Backend CI reported **184 tests across 12 files passing** ([backend run](https://github.com/Rishidev-20thcenturey/food-delivery-api/actions/runs/38849965898)); the frontend production build also passed ([frontend run](https://github.com/Rishidev-20thcenturey/food-delivery-api/actions/runs/38849965925)). This records the CI results used for the merge. Check [all repository Actions runs](https://github.com/Rishidev-20thcenturey/food-delivery-api/actions) for later changes.

## 4. Local development

### Backend

Run from `backend/`:

```bash
cp .env.example .env
npm ci
npm run db:embedded
```

In a second terminal, still inside `backend/`:

```bash
npm run db:migrate
npm run db:seed
npm run dev
```

The backend supports Node.js 20.19 or newer. Required environment values include `DATABASE_URL` and a private `JWT_ACCESS_SECRET` of at least 32 characters. The demo seed also needs `DEV_SEED_PASSWORD`; it refuses to run in production. Never commit real secrets or `.env` files.

### Frontend

See [frontend/README.md](../../frontend/README.md). The Vite development server proxies `/api` to `http://localhost:4000`. Node.js 22 is recommended for the full repository.

## 5. Known limitations and production work

- **Payments:** online payments, refunds and payment-provider integration are not implemented.
- **Live updates:** no WebSockets or push-based order tracking; the UI refreshes/polls status.
- **Promotions and account verification:** coupons, email verification and phone verification are not implemented.
- **Dashboard coverage:** owner, courier and admin flows are API capabilities rather than a complete management UI.
- **Discovery completeness:** imports are operator-controlled; coverage, menu availability and source-reported facts vary. Opening-hour interpretation, full multi-provider deduplication and a global ordering network are not implemented.
- **Operations:** production-grade backups, monitoring, load/performance testing, shared rate-limit storage for multi-instance deployment and an independent security review are still needed.
- **Security review:** passing automated tests do not substitute for an independent audit or penetration test.
- **Restaurant hours:** existing orderable-catalogue hours use same-day windows in IST; overnight schedules and holidays are not fully supported.
