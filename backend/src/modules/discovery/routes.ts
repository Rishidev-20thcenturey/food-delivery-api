import { Router } from 'express';
import { input, validate } from '../../middleware/validate.js';
import { pageMeta, sendData, sendList } from '../../utils/http.js';
import * as service from './service.js';
import { discoveryListQuery, discoveryPlaceParams } from './validators.js';

/**
 * Global food discovery: public, read-only.
 *
 * These endpoints intentionally require no authentication. Visitors must be able to explore restaurants,
 * cuisines, and locations without an account. They expose discovery directory data only — never user,
 * cart, address, or order information — and there are no write operations, so there is no authorisation
 * surface to get wrong. Ordering still happens exclusively through the existing `/restaurants`, `/cart`,
 * and `/checkout` endpoints against the transactional catalogue.
 */
export const discoveryRouter = Router();

discoveryRouter.get('/places', validate('query', discoveryListQuery), async (req, res) => {
  const q = input<typeof discoveryListQuery>(req, 'query');
  const { rows, total } = await service.listPlaces({
    q: q.q,
    dish: q.dish,
    country: q.country,
    city: q.city,
    region: q.region,
    cuisines: q.cuisine,
    hasMenu: q.hasMenu,
    orderable: q.orderable,
    sort: q.sort,
    page: q.page,
    limit: q.limit,
  });
  sendList(res, rows, pageMeta(q.page, q.limit, total));
});

discoveryRouter.get('/places/:placeId', validate('params', discoveryPlaceParams), async (req, res) => {
  const { placeId } = input<typeof discoveryPlaceParams>(req, 'params');
  sendData(res, await service.getPlace(placeId));
});

discoveryRouter.get('/facets', async (_req, res) => {
  sendData(res, await service.getFacets());
});
