import bcrypt from 'bcryptjs';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { closePool, query } from '../src/db/pool.js';

export const env = loadEnv();
export const app = createApp(env);
export const PASSWORD = 'correct-horse-battery';

/** Clears all business data between test files. Migrations stay applied. */
export async function resetDatabase() {
  await query(`
    TRUNCATE audit_logs, reviews, deliveries, order_status_history, order_items, orders,
             cart_items, carts, menu_items, menu_categories,
             discovery_menu_items, discovery_menu_sections, discovery_places,
             restaurants, addresses, refresh_tokens, users RESTART IDENTITY CASCADE`);
}

export async function closeDb() {
  await closePool();
}

let counter = 0;
const unique = () => `${Date.now()}-${++counter}`;

/** Creates a user directly in the database with a given role. Used for owners, couriers, and admins. */
export async function createUser(role: 'CUSTOMER' | 'RESTAURANT_OWNER' | 'COURIER' | 'ADMIN', overrides: { name?: string; status?: string } = {}) {
  const email = `${role.toLowerCase()}-${unique()}@example.test`;
  const hash = await bcrypt.hash(PASSWORD, 4);
  const result = await query<{ id: string }>(
    'INSERT INTO users (name, email, password_hash, role, status) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [overrides.name ?? `${role} Test`, email, hash, role, overrides.status ?? 'ACTIVE'],
  );
  const login = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  return { id: result.rows[0].id, email, token: login.body.data.accessToken as string };
}

export async function registerCustomer(name = 'Asha Customer') {
  const email = `customer-${unique()}@example.test`;
  const res = await request(app).post('/api/v1/auth/register').send({ name, email, password: PASSWORD });
  return { id: res.body.data.user.id as string, email, token: res.body.data.accessToken as string, res };
}

/** Creates an ACTIVE restaurant with one category and items. Opens 00:00 to 23:59 IST so tests are not time-dependent. */
export async function createRestaurant(ownerId: string, overrides: Record<string, unknown> = {}) {
  const r = await query<{ id: string }>(
    `INSERT INTO restaurants (owner_id, name, cuisines, address_line, city, state, postal_code, opens_at, closes_at,
                              min_order_minor, delivery_fee_minor, tax_bps, status, is_accepting_orders)
     VALUES ($1, $2, $3, '1 Test Road', 'Patna', 'Bihar', '800001', '00:00', '23:59', $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      ownerId,
      (overrides.name as string) ?? `Test Kitchen ${unique()}`,
      (overrides.cuisines as string[]) ?? ['Indian'],
      (overrides.minOrderMinor as number) ?? 0,
      (overrides.deliveryFeeMinor as number) ?? 3000,
      (overrides.taxBps as number) ?? 500,
      (overrides.status as string) ?? 'ACTIVE',
      (overrides.isAcceptingOrders as boolean) ?? true,
    ],
  );
  const restaurantId = r.rows[0].id;
  const c = await query<{ id: string }>(
    `INSERT INTO menu_categories (restaurant_id, name, display_order) VALUES ($1, 'Mains', 1) RETURNING id`,
    [restaurantId],
  );
  const categoryId = c.rows[0].id;
  const items = await query<{ id: string; name: string }>(
    `INSERT INTO menu_items (restaurant_id, category_id, name, price_minor, is_available)
     VALUES ($1, $2, 'Paneer Roll', 19900, true),
            ($1, $2, 'Masala Chai', 4900, true),
            ($1, $2, 'Sold Out Thali', 35000, false)
     RETURNING id, name`,
    [restaurantId, categoryId],
  );
  const byName = Object.fromEntries(items.rows.map((i) => [i.name, i.id]));
  return { restaurantId, categoryId, paneerRoll: byName['Paneer Roll'], chai: byName['Masala Chai'], soldOut: byName['Sold Out Thali'] };
}

export async function createAddress(token: string, overrides: Record<string, unknown> = {}) {
  const res = await request(app)
    .post('/api/v1/me/addresses')
    .set('Authorization', `Bearer ${token}`)
    .send({
      recipientName: 'Asha Customer',
      recipientPhone: '9876543210',
      line1: '12 Station Road',
      city: 'Patna',
      state: 'Bihar',
      postalCode: '800001',
      country: 'IN',
      ...overrides,
    });
  return res.body.data as { id: string };
}

export async function addToCart(token: string, menuItemId: string, quantity = 1, replaceExistingCart = false) {
  return request(app)
    .post('/api/v1/cart/items')
    .set('Authorization', `Bearer ${token}`)
    .send({ menuItemId, quantity, replaceExistingCart });
}

export async function checkoutOrder(token: string, addressId: string, extra: { key?: string; note?: string } = {}) {
  const req = request(app)
    .post('/api/v1/checkout')
    .set('Authorization', `Bearer ${token}`)
    .send({ addressId, paymentMethod: 'COD', customerNote: extra.note ?? null });
  if (extra.key) req.set('Idempotency-Key', extra.key);
  return req;
}

/** Moves an order through the lifecycle using the given actor token. */
export async function patchOwnerStatus(token: string, orderId: string, status: 'PREPARING' | 'READY_FOR_PICKUP') {
  return request(app).patch(`/api/v1/owner/orders/${orderId}/status`).set('Authorization', `Bearer ${token}`).send({ status });
}

export { request };

/* --------------------------------------------------------------------------------------------- *
 * Discovery directory helpers.
 *
 * Every row these create is SYNTHETIC TEST DATA. Names are deliberately fake ("Synthetic Test …") so a
 * fixture can never be mistaken for a real restaurant, and nothing here writes to the orderable catalogue.
 * --------------------------------------------------------------------------------------------- */

export interface DiscoveryPlaceOverrides {
  provider?: string;
  providerRecordId?: string;
  name?: string;
  countryCode?: string;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
  addressLine?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  timezone?: string | null;
  cuisines?: string[];
  websiteUrl?: string | null;
  menuUrl?: string | null;
  orderingUrl?: string | null;
  openingHoursRaw?: string | null;
  menuPermission?: 'NONE' | 'OWNER_SUBMITTED' | 'SOURCE_PERMITTED';
  dataOrigin?: 'IMPORTED' | 'OWNER_SUBMITTED' | 'PARTNER_FEED';
  publicationStatus?: 'PUBLISHED' | 'UNPUBLISHED';
  verificationStatus?: 'SOURCE_LISTED' | 'NEEDS_REVIEW' | 'VERIFIED';
  verifiedAt?: string | null;
  cravedirectRestaurantId?: string | null;
  sourceName?: string;
  sourceUrl?: string | null;
  sourceAttribution?: string;
  sourceLicence?: string | null;
  sourceUpdatedAt?: string | null;
}

let discoveryCounter = 0;

/** Inserts a synthetic discovery listing directly, the way an importer or an operator would. */
export async function createDiscoveryPlace(overrides: DiscoveryPlaceOverrides = {}): Promise<string> {
  discoveryCounter += 1;
  const verificationStatus = overrides.verificationStatus ?? 'SOURCE_LISTED';
  const result = await query<{ id: string }>(
    `INSERT INTO discovery_places (
       provider, provider_record_id, name, country_code, city, region, postal_code, address_line,
       latitude, longitude, timezone, cuisines, website_url, menu_url, ordering_url, opening_hours_raw,
       menu_permission, data_origin, publication_status, verification_status, verified_at,
       cravedirect_restaurant_id, source_name, source_url, source_licence, source_attribution,
       source_updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
     RETURNING id`,
    [
      overrides.provider ?? 'test-source',
      overrides.providerRecordId ?? `synthetic/${discoveryCounter}-${Date.now()}`,
      overrides.name ?? `Synthetic Test Place ${discoveryCounter}`,
      overrides.countryCode ?? 'IN',
      overrides.city === undefined ? 'Patna' : overrides.city,
      overrides.region === undefined ? 'Bihar' : overrides.region,
      overrides.postalCode === undefined ? null : overrides.postalCode,
      overrides.addressLine === undefined ? null : overrides.addressLine,
      overrides.latitude === undefined ? null : overrides.latitude,
      overrides.longitude === undefined ? null : overrides.longitude,
      overrides.timezone === undefined ? null : overrides.timezone,
      overrides.cuisines ?? [],
      overrides.websiteUrl === undefined ? null : overrides.websiteUrl,
      overrides.menuUrl === undefined ? null : overrides.menuUrl,
      overrides.orderingUrl === undefined ? null : overrides.orderingUrl,
      overrides.openingHoursRaw === undefined ? null : overrides.openingHoursRaw,
      overrides.menuPermission ?? 'NONE',
      overrides.dataOrigin ?? 'IMPORTED',
      overrides.publicationStatus ?? 'PUBLISHED',
      verificationStatus,
      overrides.verifiedAt === undefined
        ? verificationStatus === 'VERIFIED'
          ? new Date().toISOString()
          : null
        : overrides.verifiedAt,
      overrides.cravedirectRestaurantId ?? null,
      overrides.sourceName ?? 'Synthetic Test Source',
      overrides.sourceUrl === undefined ? 'https://example.test/synthetic-source' : overrides.sourceUrl,
      overrides.sourceLicence === undefined ? 'TEST-ONLY' : overrides.sourceLicence,
      overrides.sourceAttribution ?? 'Synthetic fixture data. Not a real restaurant.',
      overrides.sourceUpdatedAt === undefined ? null : overrides.sourceUpdatedAt,
    ],
  );
  return result.rows[0].id;
}

/**
 * Adds a synthetic structured menu to a discovery place, and records why it may be published.
 * Prices stay in the currency they were given in: they are never converted to INR.
 */
export async function addDiscoveryMenu(
  placeId: string,
  sections: Array<{
    name: string;
    items: Array<{
      providerRecordId: string;
      name: string;
      description?: string | null;
      amountMinor?: number | null;
      currency?: string | null;
      currencyMinorUnits?: number | null;
      isEstimated?: boolean;
      isPublished?: boolean;
    }>;
  }>,
  permission: 'OWNER_SUBMITTED' | 'SOURCE_PERMITTED' = 'OWNER_SUBMITTED',
): Promise<void> {
  await query(`UPDATE discovery_places SET menu_permission = $2 WHERE id = $1`, [placeId, permission]);
  for (const [index, section] of sections.entries()) {
    const created = await query<{ id: string }>(
      `INSERT INTO discovery_menu_sections (place_id, name, display_order) VALUES ($1, $2, $3)
       ON CONFLICT (place_id, lower(name)) DO UPDATE SET display_order = EXCLUDED.display_order
       RETURNING id`,
      [placeId, section.name, index],
    );
    const sectionId = created.rows[0].id;
    for (const item of section.items) {
      await query(
        `INSERT INTO discovery_menu_items (
           place_id, section_id, provider, provider_record_id, name, description,
           price_minor, currency, currency_minor_units, price_is_estimated, is_published,
           source_attribution
         ) VALUES ($1,$2,'test-source',$3,$4,$5,$6,$7,$8,$9,$10,'Synthetic fixture data.')`,
        [
          placeId,
          sectionId,
          item.providerRecordId,
          item.name,
          item.description ?? null,
          item.amountMinor ?? null,
          item.currency ?? null,
          item.currencyMinorUnits ?? null,
          item.isEstimated ?? false,
          item.isPublished ?? true,
        ],
      );
    }
  }
}
