# CraveDirect frontend

React + TypeScript + Vite customer storefront integrated with the repository API.

## Local development
1. Start the PostgreSQL database and backend per `../backend/docs/FRONTEND_INTEGRATION.md`.
2. Run `npm install`.
3. Run `npm run dev` and open the Vite URL (normally `http://localhost:5173`). The Vite dev server proxies `/api` to `http://localhost:4000`.

## Supported customer flow
- Public restaurant catalogue and menu browsing
- Customer register/login and refresh-cookie restoration
- Cart add, quantity changes and removal
- Delivery address management
- Server checkout preview, COD order placement and order history

Prices are read from API integer minor units (paise) and displayed in INR. Public registration creates only customer accounts. Owner/courier/admin access is granted through separate secure workflows.

## Netlify
The root `netlify.toml` publishes `frontend/dist`; a root Edge Function proxies `/api/v1/*` to the configured backend. Set `BACKEND_API_ORIGIN` as a Netlify runtime/Functions variable to the origin only. The API and PostgreSQL database must be deployed separately. See [the deployment checklist](../DEPLOYMENT_CHECKLIST.md).
