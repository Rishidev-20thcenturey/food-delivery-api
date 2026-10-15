import { query } from '../../db/pool.js';
import { notFound } from '../../utils/errors.js';
import { countryName, currencyMinorUnits, isValidTimezone } from './reference-data.js';
import type { DiscoveryListQuery } from './validators.js';

/**
 * Read-only access to the discovery directory.
 *
 * Everything here is public by design: discovery listings are external restaurant facts, never account
 * data. No query in this module joins `users`, `refresh_tokens`, `addresses`, `carts`, or `orders`, so the
 * public endpoints cannot leak customer or owner information even by accident.
 *
 * Every statement is parameterised, filtered to `publication_status = 'PUBLISHED'`, and bounded by an
 * explicit LIMIT/OFFSET. Search uses a stored tsvector plus its GIN index rather than an `ILIKE '%…%'`
 * table scan, and list rows fetch their menu summary in one bounded lateral join (no N+1).
 */

export type VerificationStatus = 'SOURCE_LISTED' | 'NEEDS_REVIEW' | 'VERIFIED';
export type MenuPermission = 'NONE' | 'OWNER_SUBMITTED' | 'SOURCE_PERMITTED';

interface PlaceRow {
  id: string;
  name: string;
  country_code: string;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  address_line: string | null;
  latitude: string | null;
  longitude: string | null;
  timezone: string | null;
  cuisines: string[];
  website_url: string | null;
  menu_url: string | null;
  ordering_url: string | null;
  opening_hours_raw: string | null;
  menu_permission: MenuPermission;
  data_origin: string;
  verification_status: VerificationStatus;
  verified_at: Date | null;
  cravedirect_restaurant_id: string | null;
  orderable_restaurant_name?: string | null;
  orderable_accepting_orders?: boolean | null;
  source_name: string;
  source_url: string | null;
  source_record_url: string | null;
  source_licence: string | null;
  source_attribution: string;
  source_updated_at: Date | null;
  imported_at: Date;
  menu_item_count?: number | null;
  sample_dishes?: string[] | null;
  matched_dishes?: string[] | null;
}

const PLACE_COLUMNS = `
  dp.id, dp.name, dp.country_code, dp.city, dp.region, dp.postal_code, dp.address_line,
  dp.latitude, dp.longitude, dp.timezone, dp.cuisines,
  dp.website_url, dp.menu_url, dp.ordering_url, dp.opening_hours_raw,
  dp.menu_permission, dp.data_origin, dp.verification_status, dp.verified_at,
  dp.cravedirect_restaurant_id,
  dp.source_name, dp.source_url, dp.source_record_url, dp.source_licence, dp.source_attribution,
  dp.source_updated_at, dp.imported_at`;

const PUBLISHED = `dp.publication_status = 'PUBLISHED'`;

/**
 * A discovery listing is orderable through CraveDirect only when an operator has explicitly linked it to
 * an ACTIVE restaurant in the transactional catalogue. An external website or ordering link never makes a
 * listing orderable, and never creates a restaurant row.
 */
const ORDERABLE_SQL = `(dp.cravedirect_restaurant_id IS NOT NULL
   AND EXISTS (SELECT 1 FROM restaurants ar
               WHERE ar.id = dp.cravedirect_restaurant_id AND ar.status = 'ACTIVE'))`;

/**
 * Structured dish names are only searchable when the listing is actually allowed to publish a menu, so a
 * dish query can never surface a place whose menu data is not permitted for display.
 */
const MENU_BASE_SQL = `SELECT 1 FROM discovery_menu_items dmi
       WHERE dmi.place_id = dp.id AND dmi.is_published AND dp.menu_permission <> 'NONE'`;
const HAS_MENU_SQL = `EXISTS (${MENU_BASE_SQL})`;
const dishMatchSql = (tsParam: string): string =>
  `EXISTS (${MENU_BASE_SQL} AND dmi.search_vector @@ ${tsParam}::tsquery)`;

const SORT_SQL: Record<DiscoveryListQuery['sort'], string> = {
  name: 'dp.name ASC, dp.id',
  newest: 'dp.imported_at DESC, dp.id',
  updated: 'dp.source_updated_at DESC NULLS LAST, dp.imported_at DESC, dp.id',
  country: 'dp.country_code ASC, dp.city ASC NULLS LAST, dp.name ASC, dp.id',
};

/**
 * Builds a prefix-matching `tsquery` string from user input. Only letters and digits survive, so no
 * tsquery operator can be injected, and at most six tokens are kept so the query stays cheap.
 * Returns null when nothing searchable is left, which means "do not filter on text".
 */
export function toPrefixTsQuery(text: string | undefined): string | null {
  if (!text) return null;
  const tokens = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}\p{M}]+/u)
    .filter((token) => token.length > 0)
    .slice(0, 6);
  if (!tokens.length) return null;
  return tokens.map((token) => `${token}:*`).join(' & ');
}

const iso = (value: Date | null | undefined): string | null => (value ? new Date(value).toISOString() : null);
const numeric = (value: string | null): number | null => (value === null ? null : Number(value));
const dishes = (value: string[] | null | undefined): string[] => (value ?? []).slice(0, 3);

export interface DiscoveryPlaceSummary {
  id: string;
  name: string;
  country: { code: string; name: string };
  city: string | null;
  region: string | null;
  cuisines: string[];
  links: { website: string | null; menu: string | null; ordering: string | null };
  status: { verification: VerificationStatus; verifiedAt: string | null; sourceListed: boolean };
  menu: {
    available: boolean;
    permission: MenuPermission;
    itemCount: number;
    sampleDishes: string[];
    matchedDishes: string[];
  };
  ordering: {
    available: boolean;
    restaurantId: string | null;
    restaurantName: string | null;
    acceptingOrders: boolean | null;
  };
  source: {
    name: string;
    url: string | null;
    recordUrl: string | null;
    licence: string | null;
    attribution: string;
    updatedAt: string | null;
    importedAt: string;
  };
}

export function toPlaceSummary(row: PlaceRow): DiscoveryPlaceSummary {
  const menuAllowed = row.menu_permission !== 'NONE';
  const itemCount = menuAllowed ? Number(row.menu_item_count ?? 0) : 0;
  return {
    id: row.id,
    name: row.name,
    country: { code: row.country_code, name: countryName(row.country_code) },
    city: row.city,
    region: row.region,
    cuisines: row.cuisines ?? [],
    links: { website: row.website_url, menu: row.menu_url, ordering: row.ordering_url },
    status: {
      verification: row.verification_status,
      verifiedAt: iso(row.verified_at),
      // Source-listed data is published as-is; it is never presented as owner-verified.
      sourceListed: row.data_origin === 'IMPORTED' && row.verification_status !== 'VERIFIED',
    },
    menu: {
      available: itemCount > 0,
      permission: row.menu_permission,
      itemCount,
      sampleDishes: dishes(row.sample_dishes),
      matchedDishes: dishes(row.matched_dishes),
    },
    ordering: {
      available: Boolean(row.cravedirect_restaurant_id && row.orderable_restaurant_name),
      restaurantId: row.cravedirect_restaurant_id,
      restaurantName: row.orderable_restaurant_name ?? null,
      acceptingOrders: row.orderable_accepting_orders ?? null,
    },
    source: {
      name: row.source_name,
      url: row.source_url,
      recordUrl: row.source_record_url,
      licence: row.source_licence,
      attribution: row.source_attribution,
      updatedAt: iso(row.source_updated_at),
      importedAt: iso(row.imported_at) ?? new Date().toISOString(),
    },
  };
}

export interface DiscoveryMenuSection {
  id: string;
  name: string;
  description: string | null;
  items: Array<{
    id: string;
    name: string;
    description: string | null;
    dietaryLabels: string[];
    price: { amountMinor: number; currency: string; minorUnits: number; isEstimated: boolean } | null;
    sourceAttribution: string | null;
  }>;
}

export interface DiscoveryPlaceDetail extends DiscoveryPlaceSummary {
  postalCode: string | null;
  addressLine: string | null;
  location: { latitude: number | null; longitude: number | null; timezone: string | null; timezoneKnown: boolean };
  /** Source-reported opening hours, verbatim. Never interpreted into an "open now" answer. */
  openingHoursRaw: string | null;
  dataOrigin: string;
  menuPreview: { available: boolean; permission: MenuPermission; reason: string | null; sections: DiscoveryMenuSection[] };
}

export function toPlaceDetail(row: PlaceRow): DiscoveryPlaceDetail {
  return {
    ...toPlaceSummary(row),
    postalCode: row.postal_code,
    addressLine: row.address_line,
    location: {
      latitude: numeric(row.latitude),
      longitude: numeric(row.longitude),
      timezone: row.timezone,
      // Without a trustworthy timezone we never claim a place is open.
      timezoneKnown: row.timezone ? isValidTimezone(row.timezone) : false,
    },
    openingHoursRaw: row.opening_hours_raw,
    dataOrigin: row.data_origin,
    menuPreview: { available: false, permission: row.menu_permission, reason: null, sections: [] },
  };
}

export interface ListPlacesParams {
  q?: string;
  dish?: string;
  country?: string;
  city?: string;
  region?: string;
  cuisines?: string[];
  hasMenu?: boolean;
  orderable?: boolean;
  sort: DiscoveryListQuery['sort'];
  page: number;
  limit: number;
}

export async function listPlaces(params: ListPlacesParams) {
  const conditions: string[] = [PUBLISHED];
  const values: unknown[] = [];
  const add = (value: unknown): string => {
    values.push(value);
    return `$${values.length}`;
  };

  // `q` searches name, cuisines, and place text; permitted structured dish names are searched too.
  const placeTsQuery = toPrefixTsQuery(params.q);
  const menuTsQuery = toPrefixTsQuery(params.dish ?? params.q);
  const menuTsParam = menuTsQuery ? add(menuTsQuery) : null;

  if (placeTsQuery) {
    const placeTsParam = add(placeTsQuery);
    const dishClause = menuTsParam ? ` OR ${dishMatchSql(menuTsParam)}` : '';
    conditions.push(`(dp.search_vector @@ ${placeTsParam}::tsquery${dishClause})`);
  } else if (menuTsParam) {
    conditions.push(dishMatchSql(menuTsParam));
  } else if (params.q?.trim() || params.dish?.trim()) {
    // The search text held nothing searchable (punctuation or symbols only). Matching everything would be
    // a lie, so match nothing: the UI shows its empty state and offers a reset.
    conditions.push('false');
  }

  if (params.country) conditions.push(`dp.country_code = ${add(params.country)}`);
  // Exact, case-insensitive: this is what the `discovery_places_public_city_idx` expression index answers.
  // Partial city text is covered by `q`, whose tsvector includes city and region.
  if (params.city) conditions.push(`lower(dp.city) = lower(${add(params.city)})`);
  if (params.region) conditions.push(`lower(dp.region) = lower(${add(params.region)})`);
  if (params.cuisines?.length) conditions.push(`dp.cuisines && ${add(params.cuisines)}::text[]`);
  if (params.hasMenu !== undefined) conditions.push(`${params.hasMenu ? '' : 'NOT '}(${HAS_MENU_SQL})`);
  if (params.orderable !== undefined) conditions.push(params.orderable ? ORDERABLE_SQL : `NOT ${ORDERABLE_SQL}`);

  const where = conditions.join('\n   AND ');
  const limitParam = add(params.limit);
  const offsetParam = add((params.page - 1) * params.limit);

  // One bounded lateral per returned row supplies the menu count and dish names without a second round trip.
  // The dish-match aggregate has to live INSIDE the lateral: `mi` only exists there.
  const matchedDishesInner = menuTsParam
    ? `,
                (array_agg(mi.name ORDER BY mi.name)
                  FILTER (WHERE mi.search_vector @@ ${menuTsParam}::tsquery))[1:3] AS matched_dishes`
    : '';
  const matchedDishesOuter = menuTsParam ? ', m.matched_dishes' : '';

  const [rows, count] = await Promise.all([
    query<PlaceRow>(
      `SELECT ${PLACE_COLUMNS},
              ar.name AS orderable_restaurant_name,
              ar.is_accepting_orders AS orderable_accepting_orders,
              m.menu_item_count, m.sample_dishes${matchedDishesOuter}
       FROM discovery_places dp
       LEFT JOIN restaurants ar ON ar.id = dp.cravedirect_restaurant_id AND ar.status = 'ACTIVE'
       LEFT JOIN LATERAL (
         SELECT count(*)::int AS menu_item_count,
                (array_agg(mi.name ORDER BY mi.name))[1:3] AS sample_dishes${matchedDishesInner}
         FROM discovery_menu_items mi
         WHERE mi.place_id = dp.id AND mi.is_published AND dp.menu_permission <> 'NONE'
       ) m ON true
       WHERE ${where}
       ORDER BY ${SORT_SQL[params.sort]}
       LIMIT ${limitParam} OFFSET ${offsetParam}`,
      values,
    ),
    query<{ total: number }>(
      `SELECT count(*)::int AS total FROM discovery_places dp WHERE ${where}`,
      values.slice(0, -2),
    ),
  ]);

  return { rows: rows.rows.map(toPlaceSummary), total: Number(count.rows[0]?.total ?? 0) };
}

export async function getPlace(id: string): Promise<DiscoveryPlaceDetail> {
  const result = await query<PlaceRow>(
    `SELECT ${PLACE_COLUMNS},
            ar.name AS orderable_restaurant_name,
            ar.is_accepting_orders AS orderable_accepting_orders
     FROM discovery_places dp
     LEFT JOIN restaurants ar ON ar.id = dp.cravedirect_restaurant_id AND ar.status = 'ACTIVE'
     WHERE dp.id = $1 AND ${PUBLISHED}`,
    [id],
  );
  const row = result.rows[0];
  if (!row) throw notFound('Discovery place');

  const detail = toPlaceDetail(row);
  detail.menuPreview = await loadMenuPreview(row);
  return detail;
}

interface MenuRow {
  section_id: string | null;
  section_name: string | null;
  section_description: string | null;
  item_id: string;
  item_name: string;
  item_description: string | null;
  dietary_labels: string[] | null;
  price_minor: number | null;
  currency: string | null;
  currency_minor_units: number | null;
  price_is_estimated: boolean;
  source_attribution: string | null;
}

const UNSECTIONED = 'unsectioned';

/**
 * A menu preview is only returned when the record says the data may be shown: submitted by an authorised
 * restaurant, or from a source that permits this use. Otherwise the UI falls back to the official menu link.
 */
async function loadMenuPreview(row: PlaceRow): Promise<DiscoveryPlaceDetail['menuPreview']> {
  if (row.menu_permission === 'NONE') {
    return {
      available: false,
      permission: 'NONE',
      reason: row.menu_url
        ? 'No structured menu is available for this listing. Use the official menu link.'
        : 'No structured menu is available for this listing, and the source does not provide a menu link.',
      sections: [],
    };
  }

  const result = await query<MenuRow>(
    `SELECT s.id AS section_id, s.name AS section_name, s.description AS section_description,
            i.id AS item_id, i.name AS item_name, i.description AS item_description, i.dietary_labels,
            i.price_minor, i.currency, i.currency_minor_units, i.price_is_estimated, i.source_attribution
     FROM discovery_menu_items i
     LEFT JOIN discovery_menu_sections s ON s.id = i.section_id AND s.is_published
     WHERE i.place_id = $1 AND i.is_published
     ORDER BY COALESCE(s.display_order, 0), COALESCE(s.name, ''), i.name, i.id
     LIMIT 400`,
    [row.id],
  );

  const sections = new Map<string, DiscoveryMenuSection>();
  for (const item of result.rows) {
    const key = item.section_id ?? UNSECTIONED;
    if (!sections.has(key)) {
      sections.set(key, {
        id: key,
        name: item.section_name ?? 'Menu',
        description: item.section_description ?? null,
        items: [],
      });
    }
    sections.get(key)!.items.push({
      id: item.item_id,
      name: item.item_name,
      description: item.item_description,
      dietaryLabels: item.dietary_labels ?? [],
      // A price is shown only when the amount AND its currency are both known, in that currency's own
      // minor units. Discovery prices are never converted to INR and never enter checkout pricing.
      price:
        item.price_minor !== null && item.currency !== null && item.currency_minor_units !== null
          ? {
              amountMinor: item.price_minor,
              currency: item.currency,
              minorUnits: item.currency_minor_units,
              isEstimated: item.price_is_estimated,
            }
          : null,
      sourceAttribution: item.source_attribution,
    });
  }

  const built = [...sections.values()];
  const itemCount = built.reduce((sum, section) => sum + section.items.length, 0);
  return {
    available: itemCount > 0,
    permission: row.menu_permission,
    reason: itemCount === 0 ? 'This listing may publish a menu but has no dishes recorded yet.' : null,
    sections: built,
  };
}

export interface DiscoveryFacets {
  totals: { places: number; withMenuPreview: number; orderableThroughCravedirect: number };
  countries: Array<{ code: string; name: string; count: number }>;
  cities: Array<{ country: { code: string; name: string }; city: string; count: number }>;
  cuisines: Array<{ cuisine: string; count: number }>;
}

/** Bounded facets drive the country selector, city suggestions, and cuisine chips. Public, read-only. */
export async function getFacets(): Promise<DiscoveryFacets> {
  const [totals, countries, cities, cuisines] = await Promise.all([
    query<{ places: number; with_menu: number; orderable: number }>(
      `SELECT count(*)::int AS places,
              count(*) FILTER (WHERE dp.menu_permission <> 'NONE' AND EXISTS (
                SELECT 1 FROM discovery_menu_items dmi
                WHERE dmi.place_id = dp.id AND dmi.is_published))::int AS with_menu,
              count(*) FILTER (WHERE ${ORDERABLE_SQL})::int AS orderable
       FROM discovery_places dp
       WHERE ${PUBLISHED}`,
    ),
    query<{ country_code: string; count: number }>(
      `SELECT dp.country_code, count(*)::int AS count FROM discovery_places dp
       WHERE ${PUBLISHED} GROUP BY dp.country_code ORDER BY count DESC, dp.country_code LIMIT 260`,
    ),
    query<{ country_code: string; city: string; count: number }>(
      `SELECT dp.country_code, dp.city, count(*)::int AS count FROM discovery_places dp
       WHERE ${PUBLISHED} AND dp.city IS NOT NULL GROUP BY dp.country_code, dp.city
       ORDER BY count DESC, dp.city LIMIT 80`,
    ),
    query<{ cuisine: string; count: number }>(
      `SELECT c AS cuisine, count(*)::int AS count FROM discovery_places dp, unnest(dp.cuisines) AS c
       WHERE ${PUBLISHED} GROUP BY c ORDER BY count DESC, c LIMIT 60`,
    ),
  ]);

  const totalsRow = totals.rows[0];
  return {
    totals: {
      places: Number(totalsRow?.places ?? 0),
      withMenuPreview: Number(totalsRow?.with_menu ?? 0),
      orderableThroughCravedirect: Number(totalsRow?.orderable ?? 0),
    },
    countries: countries.rows.map((row) => ({
      code: row.country_code,
      name: countryName(row.country_code),
      count: Number(row.count),
    })),
    cities: cities.rows.map((row) => ({
      country: { code: row.country_code, name: countryName(row.country_code) },
      city: row.city,
      count: Number(row.count),
    })),
    cuisines: cuisines.rows.map((row) => ({ cuisine: row.cuisine, count: Number(row.count) })),
  };
}

/** Re-exported so the importer and the API validate money the same way. */
export const minorUnitsFor = currencyMinorUnits;
