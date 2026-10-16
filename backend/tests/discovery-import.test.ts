import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app, closeDb, createDiscoveryPlace, createRestaurant, createUser, request, resetDatabase } from './helpers.js';
import { query } from '../src/db/pool.js';
import { assertSafeToWrite, describeTarget, runDiscoveryImport } from '../src/db/discovery-import/importer.js';

/**
 * The discovery import pipeline.
 *
 * The fixtures in `tests/fixtures/discovery/` are SYNTHETIC: invented places with `example.test` URLs. They
 * are not real restaurants and are never presented as such. These tests run only against the embedded test
 * database created by `tests/global-setup.ts`; nothing here touches a shared or production database.
 */

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'discovery');
const OSM_FIXTURE = path.join(FIXTURES, 'synthetic-places.osm');
const NDJSON_FIXTURE = path.join(FIXTURES, 'synthetic-partner.ndjson');

/** The test database, as the importer would print it. No credentials are ever part of this string. */
const TARGET = describeTarget();

const countPlaces = async (provider: string): Promise<number> => {
  const result = await query<{ count: number }>('SELECT count(*)::int AS count FROM discovery_places WHERE provider = $1', [provider]);
  return result.rows[0].count;
};

const placeByName = async (name: string) => {
  const result = await query<{
    id: string;
    name: string;
    country_code: string;
    city: string | null;
    postal_code: string | null;
    latitude: string | null;
    longitude: string | null;
    timezone: string | null;
    cuisines: string[];
    website_url: string | null;
    menu_url: string | null;
    ordering_url: string | null;
    opening_hours_raw: string | null;
    source_name: string;
    source_licence: string | null;
    source_attribution: string;
    source_record_url: string | null;
    source_updated_at: Date | null;
    menu_permission: string;
    data_origin: string;
    verification_status: string;
    cravedirect_restaurant_id: string | null;
  }>('SELECT * FROM discovery_places WHERE name = $1', [name]);
  return result.rows[0];
};

describe('discovery import: OpenStreetMap XML', () => {
  beforeAll(async () => {
    await resetDatabase();
  });
  beforeEach(async () => {
    await resetDatabase();
  });
  afterAll(async () => {
    await closeDb();
  });

  it('is a dry run unless --commit is given, and a dry run writes nothing', async () => {
    const summary = await runDiscoveryImport({ filePath: OSM_FIXTURE, adapter: 'osm-xml', defaultCountryCode: 'DE' });

    expect(summary.dryRun).toBe(true);
    expect(summary.target).toBe(TARGET);
    expect(summary.recordsRead).toBe(13);
    expect(summary.recordsValid).toBe(11);
    expect(summary.recordsInvalid).toBe(1);
    expect(summary.inserted).toBe(11);
    expect(summary.updated).toBe(0);
    expect(await countPlaces('openstreetmap')).toBe(0);
  });

  it('describes its target without credentials', () => {
    expect(TARGET).toMatch(/^[\w-]+@[\w.-]+:\d+$/);
    expect(TARGET).not.toContain('postgres:postgres');
    expect(describeTarget('postgres://user:secret@db.example.com:5432/food')).toBe('food@db.example.com:5432');
    expect(describeTarget('not a url')).toBe('unparseable');
    expect(describeTarget('')).toBe('unset');
    // The default comes from the environment, which is what the CLI prints before it asks for confirmation.
    expect(describeTarget()).toBe(TARGET);
  });

  it('refuses to commit without an exact --confirm-target, and in production', async () => {
    await expect(
      runDiscoveryImport({ filePath: OSM_FIXTURE, adapter: 'osm-xml', defaultCountryCode: 'DE', dryRun: false }),
    ).rejects.toThrow(/Refusing to write to/);

    await expect(
      runDiscoveryImport({
        filePath: OSM_FIXTURE,
        adapter: 'osm-xml',
        defaultCountryCode: 'DE',
        dryRun: false,
        confirmTarget: 'some_other_database@elsewhere:5432',
      }),
    ).rejects.toThrow(/Refusing to write to/);

    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await expect(
        runDiscoveryImport({ filePath: OSM_FIXTURE, adapter: 'osm-xml', defaultCountryCode: 'DE', dryRun: false, confirmTarget: TARGET }),
      ).rejects.toThrow(/NODE_ENV=production/);
      expect(() => assertSafeToWrite(TARGET, TARGET)).toThrow(/NODE_ENV=production/);
    } finally {
      process.env.NODE_ENV = previous;
    }
    expect(() => assertSafeToWrite(TARGET, TARGET)).not.toThrow();
    expect(await countPlaces('openstreetmap')).toBe(0);
  });

  it('rejects a missing input file and an invalid --country', async () => {
    await expect(
      runDiscoveryImport({ filePath: path.join(FIXTURES, 'does-not-exist.osm'), adapter: 'osm-xml' }),
    ).rejects.toThrow(/Input file not found/);
    await expect(
      runDiscoveryImport({ filePath: OSM_FIXTURE, adapter: 'osm-xml', defaultCountryCode: 'ZZ' }),
    ).rejects.toThrow(/not an ISO 3166-1 alpha-2 code/);
  });

  it('commits valid records with provenance, and reports what it skipped and why', async () => {
    const summary = await runDiscoveryImport({
      filePath: OSM_FIXTURE,
      adapter: 'osm-xml',
      defaultCountryCode: 'DE',
      dryRun: false,
      confirmTarget: TARGET,
      batchSize: 3,
    });

    expect(summary.dryRun).toBe(false);
    expect(summary.inserted).toBe(11);
    expect(await countPlaces('openstreetmap')).toBe(11);
    expect(summary.batches).toBeGreaterThanOrEqual(4);

    // Adapter counters explain the difference between elements in the file and records imported.
    expect(summary.adapterStats).toMatchObject({
      elementsScanned: 18,
      notFoodPlaces: 3, // a pub with no cuisine, a lifecycle-tagged place, a car park
      unnamed: 1,
      outsideCountryFilter: 1, // the Tokyo ramen bar
      yielded: 13,
    });
    expect(summary.duplicatesInFile).toBe(1); // node/9001 appears twice in the fixture
    expect(summary.recordsInvalid).toBe(1);
    expect(summary.errors).toEqual([{ providerRecordId: 'node/9011', reason: 'coordinates are not finite numbers within range' }]);

    // Invalid optional fields are dropped, but the record is still imported.
    expect(summary.droppedFields).toEqual({ websiteUrl: 1, postalCode: 1, timezone: 1 });

    const diner = await placeByName('Synthetic Bad Link Diner');
    expect(diner.website_url).toBeNull(); // javascript: is never stored
    expect(diner.ordering_url).toBe('https://synthetic-order.example.test/9009');

    const postcode = await placeByName('Synthetic Bad Postcode Diner');
    expect(postcode.postal_code).toBeNull();

    const zoned = await placeByName('Synthetic Bad Timezone Diner');
    expect(zoned.timezone).toBeNull();

    const berlin = await placeByName('Synthetic Berlin Curry House');
    expect(berlin.country_code).toBe('DE');
    expect(berlin.city).toBe('Berlin');
    expect(berlin.postal_code).toBe('10115');
    expect(berlin.cuisines).toEqual(['German', 'Curry']);
    expect(berlin.website_url).toBe('https://synthetic-berlin-curry.example.test');
    expect(berlin.menu_url).toBe('https://synthetic-berlin-curry.example.test/menu');
    expect(berlin.opening_hours_raw).toBe('Mo-Fr 11:00-22:00');
    expect(berlin.source_name).toBe('OpenStreetMap');
    expect(berlin.source_licence).toBe('ODbL-1.0');
    expect(berlin.source_attribution).toBe('© OpenStreetMap contributors');
    expect(berlin.source_record_url).toBe('https://www.openstreetmap.org/node/9001');
    expect(berlin.source_updated_at?.toISOString()).toBe('2026-08-01T10:00:00.000Z');
    expect(berlin.latitude).toBe('52.530000');

    // A record with no country of its own takes the operator's --country default.
    const stateless = await placeByName('Synthetic No Country Cafe');
    expect(stateless.country_code).toBe('DE');
    expect(stateless.city).toBe('Potsdam');

    // Ways: coordinates come from <center> when present, and stay NULL when it is not.
    const withCentre = await placeByName('Synthetic Way Restaurant');
    expect(withCentre.latitude).toBe('50.940000');
    expect(withCentre.longitude).toBe('6.960000');
    const centreless = await placeByName('Synthetic Centreless Cafe');
    expect(centreless.latitude).toBeNull();
    expect(centreless.longitude).toBeNull();
    // A node with only a latitude yields no coordinates at all: half a position is never stored.
    const halfCoordinate = await placeByName('Synthetic Half Coordinate Diner');
    expect(halfCoordinate.latitude).toBeNull();
    expect(halfCoordinate.longitude).toBeNull();

    // Imported listings are never orderable and never claim a menu they do not have.
    expect(berlin.menu_permission).toBe('NONE');
    expect(berlin.cravedirect_restaurant_id).toBeNull();
    expect(berlin.data_origin).toBe('IMPORTED');
    expect(berlin.verification_status).toBe('SOURCE_LISTED');
  });

  it('is idempotent: a second import updates in place and creates no duplicates', async () => {
    const options = { filePath: OSM_FIXTURE, adapter: 'osm-xml' as const, defaultCountryCode: 'DE', dryRun: false, confirmTarget: TARGET };
    const first = await runDiscoveryImport(options);
    expect(first.inserted).toBe(11);

    const second = await runDiscoveryImport(options);
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(11);
    expect(await countPlaces('openstreetmap')).toBe(11);

    const rows = await query<{ count: number }>(
      `SELECT count(*)::int AS count FROM discovery_places
       WHERE provider = 'openstreetmap' AND provider_record_id = 'node/9001'`,
    );
    expect(rows.rows[0].count).toBe(1);
  });

  it('never overwrites a verified row, and keeps an operator’s catalogue link across re-imports', async () => {
    const owner = await createUser('RESTAURANT_OWNER');
    const restaurant = await createRestaurant(owner.id, { name: 'Synthetic Linked Kitchen' });

    // An operator verified this record and linked it to the orderable catalogue.
    await createDiscoveryPlace({
      provider: 'openstreetmap',
      providerRecordId: 'node/9001',
      name: 'Synthetic Operator Verified Name',
      countryCode: 'DE',
      city: 'Berlin',
      verificationStatus: 'VERIFIED',
      cravedirectRestaurantId: restaurant.restaurantId,
      websiteUrl: 'https://operator-confirmed.example.test',
    });

    const summary = await runDiscoveryImport({
      filePath: OSM_FIXTURE,
      adapter: 'osm-xml',
      defaultCountryCode: 'DE',
      dryRun: false,
      confirmTarget: TARGET,
    });

    expect(summary.skippedProtected).toBe(1);
    expect(summary.inserted).toBe(10);
    expect(summary.updated).toBe(0);

    const verified = await placeByName('Synthetic Operator Verified Name');
    expect(verified).toBeDefined();
    expect(verified.verification_status).toBe('VERIFIED');
    expect(verified.website_url).toBe('https://operator-confirmed.example.test');
    expect(verified.cravedirect_restaurant_id).toBe(restaurant.restaurantId);
    expect(await placeByName('Synthetic Berlin Curry House')).toBeUndefined();
  });

  it('never overwrites an owner-submitted listing with weaker imported data', async () => {
    await createDiscoveryPlace({
      provider: 'ndjson',
      providerRecordId: 'synthetic-partner/6',
      name: 'Synthetic Owner Submitted Manchester',
      countryCode: 'GB',
      city: 'Manchester',
      dataOrigin: 'OWNER_SUBMITTED',
      websiteUrl: 'https://owner-submitted.example.test',
    });

    const summary = await runDiscoveryImport({
      filePath: NDJSON_FIXTURE,
      adapter: 'ndjson',
      dryRun: false,
      confirmTarget: TARGET,
    });

    expect(summary.skippedProtected).toBe(1);
    const owner = await placeByName('Synthetic Owner Submitted Manchester');
    expect(owner.website_url).toBe('https://owner-submitted.example.test');
    expect(owner.data_origin).toBe('OWNER_SUBMITTED');
  });

  it('bounds the work with --limit and --batch-size', async () => {
    const summary = await runDiscoveryImport({
      filePath: OSM_FIXTURE,
      adapter: 'osm-xml',
      defaultCountryCode: 'DE',
      limit: 4,
      batchSize: 2,
      dryRun: false,
      confirmTarget: TARGET,
    });
    expect(summary.recordsRead).toBeLessThanOrEqual(4);
    expect(summary.batches).toBeLessThanOrEqual(2);
    expect(await countPlaces('openstreetmap')).toBeLessThanOrEqual(4);
  });

  it('makes imported data searchable through the public API without touching the orderable catalogue', async () => {
    const owner = await createUser('RESTAURANT_OWNER');
    await createRestaurant(owner.id, { name: 'Synthetic Real Restaurant' });

    await runDiscoveryImport({
      filePath: OSM_FIXTURE,
      adapter: 'osm-xml',
      defaultCountryCode: 'DE',
      dryRun: false,
      confirmTarget: TARGET,
    });

    const byName = await request(app).get('/api/v1/discovery/places?q=curry');
    expect(byName.status).toBe(200);
    expect(byName.body.meta.total).toBe(1);
    expect(byName.body.data[0].name).toBe('Synthetic Berlin Curry House');
    expect(byName.body.data[0].source.attribution).toBe('© OpenStreetMap contributors');

    const byCuisine = await request(app).get('/api/v1/discovery/places?cuisine=german');
    expect(byCuisine.body.meta.total).toBe(1);

    const byCountry = await request(app).get('/api/v1/discovery/places?country=DE&limit=24');
    expect(byCountry.body.meta.total).toBe(11);

    // The transactional catalogue is untouched: still exactly the one real restaurant.
    const catalogue = await request(app).get('/api/v1/restaurants');
    expect(catalogue.body.meta.total).toBe(1);
    expect(catalogue.body.data[0].name).toBe('Synthetic Real Restaurant');
    expect(await request(app).get('/api/v1/discovery/places?orderable=true')).toMatchObject({
      body: { meta: { total: 0 } },
    });
  });
});

describe('discovery import: NDJSON partner feed', () => {
  beforeAll(async () => {
    await resetDatabase();
  });
  beforeEach(async () => {
    await resetDatabase();
  });
  afterAll(async () => {
    await closeDb();
  });

  it('reports malformed lines, wrong shapes, and duplicates instead of failing the whole run', async () => {
    const summary = await runDiscoveryImport({ filePath: NDJSON_FIXTURE, adapter: 'ndjson' });

    expect(summary.adapterStats).toMatchObject({ linesRead: 23, blankOrComment: 10, malformedJson: 1, wrongShape: 1, yielded: 11 });
    expect(summary.recordsRead).toBe(11);
    expect(summary.duplicatesInFile).toBe(1);
    expect(summary.recordsValid).toBe(9);
    expect(summary.recordsInvalid).toBe(1);
    expect(summary.errors).toContainEqual({
      providerRecordId: 'synthetic-partner/9',
      reason: 'no country code on the record and no valid --country default',
    });
    expect(await countPlaces('ndjson')).toBe(0);
  });

  it('imports nothing for a menu unless the operator passes --allow-menu', async () => {
    const summary = await runDiscoveryImport({
      filePath: NDJSON_FIXTURE,
      adapter: 'ndjson',
      dryRun: false,
      confirmTarget: TARGET,
    });

    expect(summary.inserted).toBe(9);
    expect(summary.menuItemsInserted).toBe(0);
    const menuless = await query<{ count: number }>('SELECT count(*)::int AS count FROM discovery_menu_items');
    expect(menuless.rows[0].count).toBe(0);
    const permissions = await query<{ menu_permission: string }>(
      `SELECT DISTINCT menu_permission FROM discovery_places WHERE provider = 'ndjson'`,
    );
    expect(permissions.rows.map((row) => row.menu_permission)).toEqual(['NONE']);
  });

  it('stores each price in its own currency and exponent, and never converts to INR', async () => {
    const summary = await runDiscoveryImport({
      filePath: NDJSON_FIXTURE,
      adapter: 'ndjson',
      dryRun: false,
      confirmTarget: TARGET,
      allowMenu: true,
    });

    expect(summary.menuItemsInserted).toBe(6);
    expect(summary.menuItemsRejected).toBe(5);
    expect(summary.errors.map((error) => error.reason).sort()).toEqual([
      'menu item "Synthetic Dish With No Id" has no stable id, so it cannot be upserted',
      'menu item synthetic-partner/12/udon states 2 minor units but JPY has 0',
      'menu item synthetic-partner/2/tea must supply amountMinor and currency together',
      'menu item synthetic-partner/3/tapas currency "XYZ" is not recognised',
      'menu item synthetic-partner/4/tortilla must supply amountMinor and currency together',
      'no country code on the record and no valid --country default',
    ].sort());

    const prices = await query<{ name: string; price_minor: number; currency: string; currency_minor_units: number }>(
      `SELECT name, price_minor, currency, currency_minor_units FROM discovery_menu_items ORDER BY name`,
    );
    const byName = Object.fromEntries(prices.rows.map((row) => [row.name, row]));

    expect(byName['Synthetic Onion Soup']).toMatchObject({ price_minor: 850, currency: 'EUR', currency_minor_units: 2 });
    // Zero-decimal currency: 980 is ¥980, not ¥9.80.
    expect(byName['Synthetic Shoyu Ramen']).toMatchObject({ price_minor: 980, currency: 'JPY', currency_minor_units: 0 });
    // Three-decimal currency: 4500 is BD 4.500.
    expect(byName['Synthetic Chicken Machboos']).toMatchObject({ price_minor: 4500, currency: 'BHD', currency_minor_units: 3 });
    expect(byName['Synthetic Sunday Roast']).toMatchObject({ price_minor: 1650, currency: 'GBP', currency_minor_units: 2 });
    expect(byName['Synthetic Steak Tartare']).toMatchObject({ price_minor: 1890, currency: 'EUR', currency_minor_units: 2 });
    expect(byName['Synthetic Duck Confit']).toMatchObject({ price_minor: 2450, currency: 'EUR', currency_minor_units: 2 });
    // Nothing was quietly turned into paise.
    const currencies = await query<{ currency: string }>(`SELECT DISTINCT currency FROM discovery_menu_items ORDER BY currency`);
    expect(currencies.rows.map((row) => row.currency)).toEqual(['BHD', 'EUR', 'GBP', 'JPY']);
    const estimated = await query<{ count: number }>(
      `SELECT count(*)::int AS count FROM discovery_menu_items WHERE price_is_estimated`,
    );
    expect(estimated.rows[0].count).toBe(1);

    // Only records that declared a permission can publish a menu; the rest stay NONE.
    const permissions = await query<{ name: string; menu_permission: string }>(
      `SELECT name, menu_permission FROM discovery_places WHERE provider = 'ndjson' ORDER BY name`,
    );
    const byPlace = Object.fromEntries(permissions.rows.map((row) => [row.name, row.menu_permission]));
    expect(byPlace['Synthetic Paris Bistro']).toBe('OWNER_SUBMITTED');
    expect(byPlace['Synthetic Tokyo Teishoku']).toBe('SOURCE_PERMITTED');
    expect(byPlace['Synthetic Unpermitted Menu Diner']).toBe('NONE');
    expect(byPlace['Synthetic Valid No Menu']).toBe('NONE');
  });

  it('serves an imported menu preview through the public API, grouped into sections', async () => {
    await runDiscoveryImport({
      filePath: NDJSON_FIXTURE,
      adapter: 'ndjson',
      dryRun: false,
      confirmTarget: TARGET,
      allowMenu: true,
    });

    const list = await request(app).get('/api/v1/discovery/places?q=paris%20bistro');
    expect(list.body.meta.total).toBe(1);
    const place = list.body.data[0];
    expect(place.menu.available).toBe(true);
    expect(place.menu.itemCount).toBe(3);

    const detail = (await request(app).get(`/api/v1/discovery/places/${place.id}`)).body.data;
    expect(detail.menuPreview.sections.map((section: { name: string }) => section.name)).toEqual(['Entrées', 'Plats']);
    expect(detail.menuPreview.sections[0].items).toHaveLength(2);
    expect(detail.country).toEqual({ code: 'FR', name: 'France' });
    expect(detail.location.timezone).toBe('Europe/Paris');
    expect(detail.location.timezoneKnown).toBe(true);
    expect(detail.postalCode).toBe('75011');

    // Dish search finds a permitted menu item.
    const byDish = await request(app).get('/api/v1/discovery/places?dish=confit');
    expect(byDish.body.meta.total).toBe(1);
    expect(byDish.body.data[0].menu.matchedDishes).toEqual(['Synthetic Duck Confit']);
  });

  it('is idempotent for menus too', async () => {
    const options = {
      filePath: NDJSON_FIXTURE,
      adapter: 'ndjson' as const,
      dryRun: false,
      confirmTarget: TARGET,
      allowMenu: true,
    };
    const first = await runDiscoveryImport(options);
    expect(first.menuItemsInserted).toBe(6);

    const second = await runDiscoveryImport(options);
    expect(second.menuItemsInserted).toBe(0);
    expect(second.menuItemsUpdated).toBe(6);
    expect(second.updated).toBe(9);

    const counts = await query<{ places: number; items: number }>(
      `SELECT (SELECT count(*)::int FROM discovery_places WHERE provider = 'ndjson') AS places,
              (SELECT count(*)::int FROM discovery_menu_items) AS items`,
    );
    expect(counts.rows[0]).toEqual({ places: 9, items: 6 });
  });
});
