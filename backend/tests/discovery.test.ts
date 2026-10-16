import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import {
  addDiscoveryMenu,
  app,
  closeDb,
  createDiscoveryPlace,
  createRestaurant,
  createUser,
  request,
  resetDatabase,
} from './helpers.js';
import { query } from '../src/db/pool.js';

/**
 * Global food discovery: the public, read-only directory that sits beside the orderable catalogue.
 *
 * Everything created here is SYNTHETIC test data (names start with "Synthetic"). These tests cover the
 * filters, the pagination bounds, the honest verification and menu-permission rules, the money rules, the
 * outbound-link rules, and the guarantee that discovery data never leaks account information or turns into
 * an orderable restaurant on its own.
 */

const DISCOVERY = '/api/v1/discovery';

describe('discovery directory', () => {
  beforeAll(async () => {
    await resetDatabase();
  });
  beforeEach(async () => {
    await resetDatabase();
  });
  afterAll(async () => {
    await closeDb();
  });

  it('is public: no token is needed to browse discovery places or facets', async () => {
    await createDiscoveryPlace({ name: 'Synthetic Public Diner', countryCode: 'IN', city: 'Patna' });

    const list = await request(app).get(`${DISCOVERY}/places`);
    expect(list.status).toBe(200);
    expect(list.body.meta).toMatchObject({ page: 1, limit: 12, total: 1 });
    expect(list.body.data[0].name).toBe('Synthetic Public Diner');

    const facets = await request(app).get(`${DISCOVERY}/facets`);
    expect(facets.status).toBe(200);
    expect(facets.body.data.totals.places).toBe(1);
  });

  it('returns an empty, well-formed catalogue when there is no coverage yet', async () => {
    const list = await request(app).get(`${DISCOVERY}/places?country=JP`);
    expect(list.status).toBe(200);
    expect(list.body).toEqual({ data: [], meta: { page: 1, limit: 12, total: 0, totalPages: 0 } });

    const facets = await request(app).get(`${DISCOVERY}/facets`);
    expect(facets.body.data).toEqual({
      totals: { places: 0, withMenuPreview: 0, orderableThroughCravedirect: 0 },
      countries: [],
      cities: [],
      cuisines: [],
    });
  });

  it('filters by country, city, region, cuisine, and name', async () => {
    await createDiscoveryPlace({ name: 'Synthetic Tokyo Ramen', countryCode: 'JP', city: 'Tokyo', region: 'Tokyo', cuisines: ['Ramen'] });
    await createDiscoveryPlace({ name: 'Synthetic Osaka Takoyaki', countryCode: 'JP', city: 'Osaka', cuisines: ['Street Food'] });
    await createDiscoveryPlace({ name: 'Synthetic Patna Thali', countryCode: 'IN', city: 'Patna', region: 'Bihar', cuisines: ['Bihari', 'Thali'] });

    expect((await request(app).get(`${DISCOVERY}/places?country=JP`)).body.meta.total).toBe(2);
    expect((await request(app).get(`${DISCOVERY}/places?country=IN`)).body.meta.total).toBe(1);
    expect((await request(app).get(`${DISCOVERY}/places?country=JP&city=Osaka`)).body.meta.total).toBe(1);
    expect((await request(app).get(`${DISCOVERY}/places?country=JP&region=Tokyo`)).body.meta.total).toBe(1);
    expect((await request(app).get(`${DISCOVERY}/places?cuisine=thali`)).body.meta.total).toBe(1);
    expect((await request(app).get(`${DISCOVERY}/places?cuisine=ramen,street%20food`)).body.meta.total).toBe(2);

    const byName = await request(app).get(`${DISCOVERY}/places?q=takoyaki`);
    expect(byName.body.meta.total).toBe(1);
    expect(byName.body.data[0].name).toBe('Synthetic Osaka Takoyaki');
  });

  it('matches prefixes, cuisines, and cities through q, and treats symbols literally', async () => {
    await createDiscoveryPlace({ name: 'Synthetic Paneer Palace', countryCode: 'IN', city: 'Patna', cuisines: ['North Indian'] });
    await createDiscoveryPlace({ name: 'Synthetic Sushi Corner', countryCode: 'JP', city: 'Kyoto', cuisines: ['Sushi'] });

    // Prefix match on the name, the way a person types into a search box.
    expect((await request(app).get(`${DISCOVERY}/places?q=pane`)).body.meta.total).toBe(1);
    // Cuisine text is searchable even when the name does not mention it.
    expect((await request(app).get(`${DISCOVERY}/places?q=sushi`)).body.meta.total).toBe(1);
    // City text is searchable too.
    expect((await request(app).get(`${DISCOVERY}/places?q=kyo`)).body.meta.total).toBe(1);
    // LIKE and tsquery metacharacters are inert: they match nothing rather than everything.
    expect((await request(app).get(`${DISCOVERY}/places?q=%25`)).body.meta.total).toBe(0);
    expect((await request(app).get(`${DISCOVERY}/places?q=!%26|`)).body.meta.total).toBe(0);
  });

  it('searches dishes only in menus that are permitted to be published', async () => {
    const permitted = await createDiscoveryPlace({
      name: 'Synthetic Permitted Kitchen',
      countryCode: 'FR',
      city: 'Paris',
      menuPermission: 'OWNER_SUBMITTED',
    });
    await addDiscoveryMenu(permitted, [
      { name: 'Plats', items: [{ providerRecordId: 'synthetic/dish/1', name: 'Synthetic Duck Confit', amountMinor: 2450, currency: 'EUR', currencyMinorUnits: 2 }] },
    ]);

    // Same dish name on a listing that is NOT allowed to publish a menu: it must stay unsearchable.
    const notPermitted = await createDiscoveryPlace({
      name: 'Synthetic Unpermitted Kitchen',
      countryCode: 'FR',
      city: 'Lyon',
      menuPermission: 'NONE',
    });
    await addDiscoveryMenu(notPermitted, [
      { name: 'Plats', items: [{ providerRecordId: 'synthetic/dish/2', name: 'Synthetic Duck Confit', amountMinor: 2450, currency: 'EUR', currencyMinorUnits: 2 }] },
    ], 'SOURCE_PERMITTED');
    await query(`UPDATE discovery_places SET menu_permission = 'NONE' WHERE id = $1`, [notPermitted]);

    const byDish = await request(app).get(`${DISCOVERY}/places?dish=confit`);
    expect(byDish.body.meta.total).toBe(1);
    expect(byDish.body.data[0].name).toBe('Synthetic Permitted Kitchen');
    expect(byDish.body.data[0].menu.matchedDishes).toEqual(['Synthetic Duck Confit']);

    // q searches dishes as well, and reports which dish matched.
    const byQ = await request(app).get(`${DISCOVERY}/places?q=duck`);
    expect(byQ.body.meta.total).toBe(1);
    expect(byQ.body.data[0].id).toBe(permitted);
  });

  it('paginates, and rejects a page size above the discovery maximum', async () => {
    for (let index = 0; index < 7; index += 1) {
      await createDiscoveryPlace({ name: `Synthetic Paging Place ${index}`, countryCode: 'IN', city: 'Patna' });
    }

    const page1 = await request(app).get(`${DISCOVERY}/places?page=1&limit=3&sort=name`);
    expect(page1.body.meta).toEqual({ page: 1, limit: 3, total: 7, totalPages: 3 });
    expect(page1.body.data.map((place: { name: string }) => place.name)).toEqual([
      'Synthetic Paging Place 0', 'Synthetic Paging Place 1', 'Synthetic Paging Place 2',
    ]);

    const page3 = await request(app).get(`${DISCOVERY}/places?page=3&limit=3&sort=name`);
    expect(page3.body.data).toHaveLength(1);

    // Conservative ceiling: the discovery maximum is smaller than the transactional catalogue's 50.
    expect((await request(app).get(`${DISCOVERY}/places?limit=25`)).status).toBe(400);
    expect((await request(app).get(`${DISCOVERY}/places?limit=0`)).status).toBe(400);
    expect((await request(app).get(`${DISCOVERY}/places?page=0`)).status).toBe(400);
    expect((await request(app).get(`${DISCOVERY}/places?page=501`)).status).toBe(400);
    expect((await request(app).get(`${DISCOVERY}/places?limit=24`)).status).toBe(200);
  });

  it('rejects invalid filters with the documented VALIDATION_ERROR envelope', async () => {
    const badCountry = await request(app).get(`${DISCOVERY}/places?country=XYZ`);
    expect(badCountry.status).toBe(400);
    expect(badCountry.body.error.code).toBe('VALIDATION_ERROR');
    expect(badCountry.body.error.details[0]).toMatchObject({ field: 'country' });
    expect(badCountry.body.error.requestId).toBeTruthy();

    expect((await request(app).get(`${DISCOVERY}/places?country=ZZ`)).status).toBe(400);
    expect((await request(app).get(`${DISCOVERY}/places?sort=price`)).status).toBe(400);
    expect((await request(app).get(`${DISCOVERY}/places?q=`)).status).toBe(400);
    expect((await request(app).get(`${DISCOVERY}/places?hasMenu=maybe`)).status).toBe(400);
    expect((await request(app).get(`${DISCOVERY}/places?q=${'x'.repeat(81)}`)).status).toBe(400);
  });

  it('supports every documented sort option with a stable order', async () => {
    await createDiscoveryPlace({ name: 'Synthetic Beta Place', countryCode: 'IN', city: 'Patna', sourceUpdatedAt: '2026-01-01T00:00:00Z' });
    await createDiscoveryPlace({ name: 'Synthetic Alpha Place', countryCode: 'JP', city: 'Tokyo', sourceUpdatedAt: '2026-06-01T00:00:00Z' });

    const name = await request(app).get(`${DISCOVERY}/places?sort=name`);
    expect(name.body.data.map((p: { name: string }) => p.name)).toEqual(['Synthetic Alpha Place', 'Synthetic Beta Place']);

    const updated = await request(app).get(`${DISCOVERY}/places?sort=updated`);
    expect(updated.body.data.map((p: { name: string }) => p.name)).toEqual(['Synthetic Alpha Place', 'Synthetic Beta Place']);

    const country = await request(app).get(`${DISCOVERY}/places?sort=country`);
    expect(country.body.data.map((p: { country: { code: string } }) => p.country.code)).toEqual(['IN', 'JP']);

    const newest = await request(app).get(`${DISCOVERY}/places?sort=newest`);
    expect(newest.body.data).toHaveLength(2);
  });

  it('hides unpublished listings from both the list and the detail endpoint', async () => {
    const hidden = await createDiscoveryPlace({ name: 'Synthetic Unpublished', publicationStatus: 'UNPUBLISHED' });
    const visible = await createDiscoveryPlace({ name: 'Synthetic Published' });

    const list = await request(app).get(`${DISCOVERY}/places`);
    expect(list.body.meta.total).toBe(1);
    expect(list.body.data[0].id).toBe(visible);

    expect((await request(app).get(`${DISCOVERY}/places/${hidden}`)).status).toBe(404);
    expect((await request(app).get(`${DISCOVERY}/places/${visible}`)).status).toBe(200);
    // 404 rather than 403: unpublished ids cannot be probed.
    const missing = await request(app).get(`${DISCOVERY}/places/00000000-0000-4000-8000-000000000000`);
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('NOT_FOUND');
    expect((await request(app).get(`${DISCOVERY}/places/not-a-uuid`)).status).toBe(400);
  });

  it('reports verification state honestly and never upgrades source data to verified', async () => {
    const sourceListed = await createDiscoveryPlace({ name: 'Synthetic Source Listed', verificationStatus: 'SOURCE_LISTED' });
    const verified = await createDiscoveryPlace({
      name: 'Synthetic Verified',
      verificationStatus: 'VERIFIED',
      verifiedAt: '2026-09-30T08:00:00Z',
      dataOrigin: 'OWNER_SUBMITTED',
      provider: 'owner-submitted',
    });

    const listed = (await request(app).get(`${DISCOVERY}/places/${sourceListed}`)).body.data;
    expect(listed.status).toEqual({ verification: 'SOURCE_LISTED', verifiedAt: null, sourceListed: true });

    const confirmed = (await request(app).get(`${DISCOVERY}/places/${verified}`)).body.data;
    expect(confirmed.status.verification).toBe('VERIFIED');
    expect(confirmed.status.sourceListed).toBe(false);
    expect(confirmed.status.verifiedAt).toBe('2026-09-30T08:00:00.000Z');
  });

  it('requires a VERIFIED row to carry a verification timestamp', async () => {
    await expect(
      query(
        `INSERT INTO discovery_places (provider, provider_record_id, name, country_code, source_name, source_attribution, verification_status)
         VALUES ('test-source', 'synthetic/invalid', 'Synthetic Invalid', 'IN', 'Synthetic', 'Synthetic', 'VERIFIED')`,
      ),
    ).rejects.toThrow(/verification_status_check|check constraint/i);
  });

  it('exposes provenance and freshness on the detail response', async () => {
    const id = await createDiscoveryPlace({
      name: 'Synthetic Provenance Diner',
      countryCode: 'DE',
      city: 'Berlin',
      region: 'Berlin',
      postalCode: '10115',
      addressLine: '12 Synthetic Street',
      latitude: 52.53,
      longitude: 13.4,
      timezone: 'Europe/Berlin',
      cuisines: ['German', 'Curry'],
      websiteUrl: 'https://synthetic-provenance.example.test',
      menuUrl: 'https://synthetic-provenance.example.test/menu',
      openingHoursRaw: 'Mo-Fr 11:00-22:00',
      sourceName: 'Synthetic Test Source',
      sourceUrl: 'https://example.test/synthetic-source',
      sourceLicence: 'TEST-ONLY',
      sourceAttribution: 'Synthetic fixture data. Not a real restaurant.',
      sourceUpdatedAt: '2026-08-01T10:00:00Z',
    });

    const detail = (await request(app).get(`${DISCOVERY}/places/${id}`)).body.data;
    expect(detail.country).toEqual({ code: 'DE', name: 'Germany' });
    expect(detail.postalCode).toBe('10115');
    expect(detail.addressLine).toBe('12 Synthetic Street');
    expect(detail.location).toEqual({ latitude: 52.53, longitude: 13.4, timezone: 'Europe/Berlin', timezoneKnown: true });
    expect(detail.openingHoursRaw).toBe('Mo-Fr 11:00-22:00');
    expect(detail.source.name).toBe('Synthetic Test Source');
    expect(detail.source.licence).toBe('TEST-ONLY');
    expect(detail.source.attribution).toContain('Not a real restaurant');
    expect(detail.source.updatedAt).toBe('2026-08-01T10:00:00.000Z');
    expect(new Date(detail.source.importedAt).getTime()).not.toBeNaN();
    // Raw hours are reported, never interpreted: there is no isOpen anywhere in the payload.
    expect(JSON.stringify(detail)).not.toContain('isOpen');
  });

  it('never claims a place is open without a trustworthy timezone', async () => {
    const noTimezone = await createDiscoveryPlace({ name: 'Synthetic No Timezone', openingHoursRaw: 'Mo-Fr 11:00-22:00' });
    const badTimezone = await createDiscoveryPlace({
      name: 'Synthetic Bad Timezone',
      timezone: 'Mars/Olympus',
      openingHoursRaw: 'Mo-Fr 11:00-22:00',
    });

    const noZone = (await request(app).get(`${DISCOVERY}/places/${noTimezone}`)).body.data;
    expect(noZone.location).toEqual({ latitude: null, longitude: null, timezone: null, timezoneKnown: false });

    // A syntactically plausible but unknown zone is reported as not known, so no local time is implied.
    const badZone = (await request(app).get(`${DISCOVERY}/places/${badTimezone}`)).body.data;
    expect(badZone.location.timezoneKnown).toBe(false);
    expect(badZone.openingHoursRaw).toBe('Mo-Fr 11:00-22:00');
  });

  it('shows a menu preview only for permitted menus, with prices in their own currency', async () => {
    const eurPlace = await createDiscoveryPlace({ name: 'Synthetic Euro Kitchen', countryCode: 'FR', city: 'Paris' });
    await addDiscoveryMenu(eurPlace, [
      {
        name: 'Entrées',
        items: [
          { providerRecordId: 'synthetic/eur/1', name: 'Synthetic Onion Soup', amountMinor: 850, currency: 'EUR', currencyMinorUnits: 2 },
          { providerRecordId: 'synthetic/eur/2', name: 'Synthetic Bread', description: 'No price recorded.' },
        ],
      },
    ]);

    const jpyPlace = await createDiscoveryPlace({ name: 'Synthetic Yen Kitchen', countryCode: 'JP', city: 'Tokyo' });
    await addDiscoveryMenu(jpyPlace, [
      { name: 'Set meals', items: [{ providerRecordId: 'synthetic/jpy/1', name: 'Synthetic Ramen', amountMinor: 980, currency: 'JPY', currencyMinorUnits: 0 }] },
    ], 'SOURCE_PERMITTED');

    const eur = (await request(app).get(`${DISCOVERY}/places/${eurPlace}`)).body.data;
    expect(eur.menuPreview.available).toBe(true);
    expect(eur.menuPreview.permission).toBe('OWNER_SUBMITTED');
    expect(eur.menuPreview.sections[0].name).toBe('Entrées');
    const eurItems = Object.fromEntries(
      eur.menuPreview.sections[0].items.map((item: { name: string; price: unknown }) => [item.name, item.price]),
    );
    expect(eurItems['Synthetic Onion Soup']).toEqual({ amountMinor: 850, currency: 'EUR', minorUnits: 2, isEstimated: false });
    // A dish with no known price reports no price rather than zero, and never a converted INR figure.
    expect(eurItems['Synthetic Bread']).toBeNull();

    const jpy = (await request(app).get(`${DISCOVERY}/places/${jpyPlace}`)).body.data;
    // JPY has zero minor units: 980 is ¥980, not ¥9.80. Nothing is converted to INR.
    expect(jpy.menuPreview.sections[0].items[0].price).toEqual({ amountMinor: 980, currency: 'JPY', minorUnits: 0, isEstimated: false });
  });

  it('refuses a menu preview when permission is NONE, and points at the official menu link instead', async () => {
    const place = await createDiscoveryPlace({
      name: 'Synthetic Link Only',
      menuPermission: 'NONE',
      menuUrl: 'https://synthetic-link-only.example.test/menu',
    });
    // Rows exist but are not permitted for display; they must not be served.
    await query(
      `INSERT INTO discovery_menu_items (place_id, provider, provider_record_id, name, price_minor, currency, currency_minor_units)
       VALUES ($1, 'test-source', 'synthetic/hidden/1', 'Synthetic Hidden Dish', 1000, 'INR', 2)`,
      [place],
    );

    const detail = (await request(app).get(`${DISCOVERY}/places/${place}`)).body.data;
    expect(detail.menuPreview.available).toBe(false);
    expect(detail.menuPreview.sections).toEqual([]);
    expect(detail.menuPreview.reason).toContain('official menu link');
    expect(detail.links.menu).toBe('https://synthetic-link-only.example.test/menu');

    const list = await request(app).get(`${DISCOVERY}/places?hasMenu=true`);
    expect(list.body.meta.total).toBe(0);
    const withoutMenu = await request(app).get(`${DISCOVERY}/places?hasMenu=false`);
    expect(withoutMenu.body.meta.total).toBe(1);
  });

  it('only calls a listing orderable when it is linked to an ACTIVE CraveDirect restaurant', async () => {
    const owner = await createUser('RESTAURANT_OWNER');
    const orderable = await createRestaurant(owner.id, { name: 'Synthetic Orderable Kitchen' });
    const suspended = await createRestaurant(owner.id, { name: 'Synthetic Suspended Kitchen', status: 'SUSPENDED' });

    const linked = await createDiscoveryPlace({
      name: 'Synthetic Linked Listing',
      cravedirectRestaurantId: orderable.restaurantId,
      orderingUrl: 'https://synthetic-external-order.example.test',
    });
    const linkedSuspended = await createDiscoveryPlace({ name: 'Synthetic Suspended Listing', cravedirectRestaurantId: suspended.restaurantId });
    // An external ordering link alone never makes a listing orderable through CraveDirect.
    const externalOnly = await createDiscoveryPlace({
      name: 'Synthetic External Only',
      orderingUrl: 'https://synthetic-external-order.example.test/other',
      websiteUrl: 'https://synthetic-external.example.test',
    });

    const linkedDetail = (await request(app).get(`${DISCOVERY}/places/${linked}`)).body.data;
    expect(linkedDetail.ordering.available).toBe(true);
    expect(linkedDetail.ordering.restaurantId).toBe(orderable.restaurantId);
    expect(linkedDetail.ordering.restaurantName).toBe('Synthetic Orderable Kitchen');
    expect(linkedDetail.ordering.acceptingOrders).toBe(true);

    expect((await request(app).get(`${DISCOVERY}/places/${linkedSuspended}`)).body.data.ordering.available).toBe(false);
    const external = (await request(app).get(`${DISCOVERY}/places/${externalOnly}`)).body.data;
    expect(external.ordering.available).toBe(false);
    expect(external.ordering.restaurantId).toBeNull();
    expect(external.links.ordering).toBe('https://synthetic-external-order.example.test/other');

    expect((await request(app).get(`${DISCOVERY}/places?orderable=true`)).body.meta.total).toBe(1);
    expect((await request(app).get(`${DISCOVERY}/places?orderable=false`)).body.meta.total).toBe(2);
  });

  it('keeps discovery listings out of the orderable catalogue and out of cart and checkout', async () => {
    const owner = await createUser('RESTAURANT_OWNER');
    const real = await createRestaurant(owner.id, { name: 'Synthetic Real Restaurant' });
    await createDiscoveryPlace({ name: 'Synthetic Directory Only Listing', countryCode: 'JP', city: 'Tokyo' });

    const catalogue = await request(app).get('/api/v1/restaurants');
    expect(catalogue.body.meta.total).toBe(1);
    expect(catalogue.body.data[0].id).toBe(real.restaurantId);

    // A discovery place id is not a restaurant id: the orderable endpoints must not accept it.
    const discoveryId = (await request(app).get(`${DISCOVERY}/places`)).body.data[0].id;
    expect((await request(app).get(`/api/v1/restaurants/${discoveryId}`)).status).toBe(404);
    expect((await request(app).get(`/api/v1/restaurants/${discoveryId}/menu`)).status).toBe(404);
  });

  it('never exposes account information through the public discovery endpoints', async () => {
    const owner = await createUser('RESTAURANT_OWNER', { name: 'Synthetic Owner Person' });
    const restaurant = await createRestaurant(owner.id, { name: 'Synthetic Owner Kitchen' });
    const place = await createDiscoveryPlace({
      name: 'Synthetic Linked For Privacy',
      cravedirectRestaurantId: restaurant.restaurantId,
    });

    const list = await request(app).get(`${DISCOVERY}/places`);
    const detail = await request(app).get(`${DISCOVERY}/places/${place}`);
    const facets = await request(app).get(`${DISCOVERY}/facets`);
    const combined = JSON.stringify([list.body, detail.body, facets.body]).toLowerCase();

    for (const forbidden of ['ownerid', 'owner_id', 'customerid', 'password', 'refresh', 'token', 'email', '@example.test']) {
      expect(combined, `leaked "${forbidden}"`).not.toContain(forbidden);
    }
    // The link exposes the restaurant's public name only.
    expect(detail.body.data.ordering.restaurantName).toBe('Synthetic Owner Kitchen');
  });

  it('only ever serves http(s) outbound links, and the database rejects other schemes', async () => {
    for (const column of ['website_url', 'menu_url', 'ordering_url']) {
      await expect(
        query(
          `INSERT INTO discovery_places (provider, provider_record_id, name, country_code, source_name, source_attribution, ${column})
           VALUES ('test-source', $1, 'Synthetic Unsafe Link', 'IN', 'Synthetic', 'Synthetic', $2)`,
          [`synthetic/unsafe/${column}`, 'javascript:alert(document.cookie)'],
        ),
      ).rejects.toThrow(/check constraint/i);
    }

    const place = await createDiscoveryPlace({
      name: 'Synthetic Safe Links',
      websiteUrl: 'https://synthetic-safe.example.test',
      orderingUrl: 'http://synthetic-safe.example.test/order',
    });
    const detail = (await request(app).get(`${DISCOVERY}/places/${place}`)).body.data;
    expect(detail.links.website).toMatch(/^https:\/\//);
    expect(detail.links.ordering).toMatch(/^http:\/\//);
    expect(detail.links.menu).toBeNull();
  });

  it('stores optional, country-specific postal codes instead of requiring six digits', async () => {
    const uk = await createDiscoveryPlace({ name: 'Synthetic Manchester', countryCode: 'GB', city: 'Manchester', postalCode: 'M1 1AA' });
    const jp = await createDiscoveryPlace({ name: 'Synthetic Tokyo', countryCode: 'JP', city: 'Tokyo', postalCode: '100-0001' });
    const none = await createDiscoveryPlace({ name: 'Synthetic No Postcode', countryCode: 'AE', city: 'Dubai', postalCode: null });

    expect((await request(app).get(`${DISCOVERY}/places/${uk}`)).body.data.postalCode).toBe('M1 1AA');
    expect((await request(app).get(`${DISCOVERY}/places/${jp}`)).body.data.postalCode).toBe('100-0001');
    expect((await request(app).get(`${DISCOVERY}/places/${none}`)).body.data.postalCode).toBeNull();

    // The transactional catalogue still requires a six-digit Indian PIN: that contract is unchanged.
    expect((await request(app).get('/api/v1/restaurants?postalCode=M1%201AA')).status).toBe(400);
  });

  it('rejects half a coordinate pair and out-of-range coordinates', async () => {
    await expect(
      query(
        `INSERT INTO discovery_places (provider, provider_record_id, name, country_code, source_name, source_attribution, latitude)
         VALUES ('test-source', 'synthetic/half', 'Synthetic Half Coordinate', 'IN', 'Synthetic', 'Synthetic', 25.1)`,
      ),
    ).rejects.toThrow(/check constraint/i);

    await expect(
      query(
        `INSERT INTO discovery_places (provider, provider_record_id, name, country_code, source_name, source_attribution, latitude, longitude)
         VALUES ('test-source', 'synthetic/range', 'Synthetic Out Of Range', 'IN', 'Synthetic', 'Synthetic', 95.1, 13.4)`,
      ),
    ).rejects.toThrow(/check constraint/i);
  });

  it('returns bounded facets that only describe published data', async () => {
    await createDiscoveryPlace({ name: 'Synthetic Facet A', countryCode: 'JP', city: 'Tokyo', cuisines: ['Ramen', 'Sushi'] });
    await createDiscoveryPlace({ name: 'Synthetic Facet B', countryCode: 'JP', city: 'Tokyo', cuisines: ['Ramen'] });
    await createDiscoveryPlace({ name: 'Synthetic Facet C', countryCode: 'IN', city: 'Patna', cuisines: ['Thali'] });
    await createDiscoveryPlace({ name: 'Synthetic Facet Hidden', countryCode: 'IN', publicationStatus: 'UNPUBLISHED' });

    const facets = (await request(app).get(`${DISCOVERY}/facets`)).body.data;
    expect(facets.totals.places).toBe(3);
    expect(facets.countries).toEqual([
      { code: 'JP', name: 'Japan', count: 2 },
      { code: 'IN', name: 'India', count: 1 },
    ]);
    expect(facets.cities[0]).toEqual({ country: { code: 'JP', name: 'Japan' }, city: 'Tokyo', count: 2 });
    expect(facets.cuisines).toEqual([
      { cuisine: 'Ramen', count: 2 },
      { cuisine: 'Sushi', count: 1 },
      { cuisine: 'Thali', count: 1 },
    ]);
  });
});

describe('discovery query bounds', () => {
  let counting = false;
  let queryCount = 0;
  const inFlight = new WeakMap<object, number>();
  let maxConcurrentPerConnection = 0;

  const originalQuery = pg.Client.prototype.query as unknown as (this: unknown, ...args: unknown[]) => unknown;
  const instrumented = function (this: object, ...args: unknown[]) {
    if (counting) queryCount += 1;
    const depth = (inFlight.get(this) ?? 0) + 1;
    inFlight.set(this, depth);
    if (depth > maxConcurrentPerConnection) maxConcurrentPerConnection = depth;
    const done = () => inFlight.set(this, depth - 1);
    const result = originalQuery.apply(this, args) as Promise<unknown> | undefined;
    if (result && typeof result.then === 'function') result.then(done, done);
    else done();
    return result;
  };

  beforeAll(async () => {
    (pg.Client.prototype as unknown as { query: unknown }).query = instrumented;
    await resetDatabase();
  });
  beforeEach(async () => {
    await resetDatabase();
  });
  afterAll(async () => {
    (pg.Client.prototype as unknown as { query: unknown }).query = originalQuery;
    await closeDb();
  });

  const countQueries = async (fn: () => Promise<unknown>): Promise<number> => {
    queryCount = 0;
    counting = true;
    try {
      await fn();
    } finally {
      counting = false;
    }
    return queryCount;
  };

  it('GET /discovery/places costs the same number of queries for 4 places as for 8', async () => {
    for (let index = 0; index < 4; index += 1) {
      const id = await createDiscoveryPlace({ name: `Synthetic Bounded ${index}`, countryCode: 'IN', city: 'Patna', menuPermission: 'SOURCE_PERMITTED' });
      await addDiscoveryMenu(id, [{ name: 'Menu', items: [{ providerRecordId: `synthetic/bounded/${index}`, name: `Synthetic Dish ${index}` }] }], 'SOURCE_PERMITTED');
    }
    const small = await countQueries(() => request(app).get(`${DISCOVERY}/places?q=synthetic`));

    for (let index = 4; index < 8; index += 1) {
      const id = await createDiscoveryPlace({ name: `Synthetic Bounded ${index}`, countryCode: 'IN', city: 'Patna', menuPermission: 'SOURCE_PERMITTED' });
      await addDiscoveryMenu(id, [{ name: 'Menu', items: [{ providerRecordId: `synthetic/bounded/${index}`, name: `Synthetic Dish ${index}` }] }], 'SOURCE_PERMITTED');
    }
    const large = await countQueries(() => request(app).get(`${DISCOVERY}/places?q=synthetic`));

    // One page query plus one count query, whatever the page holds: no per-row round trips.
    expect(large).toBe(small);
    expect(large).toBe(2);
  });

  it('never has two queries in flight on one connection', async () => {
    maxConcurrentPerConnection = 0;
    await createDiscoveryPlace({ name: 'Synthetic Concurrency', countryCode: 'IN', city: 'Patna' });
    await request(app).get(`${DISCOVERY}/places`);
    await request(app).get(`${DISCOVERY}/facets`);
    expect(maxConcurrentPerConnection).toBe(1);
  });
});
