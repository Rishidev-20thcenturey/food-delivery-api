import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../../db/pool.js';
import { currencyMinorUnits, isValidCountryCode } from '../../modules/discovery/reference-data.js';
import { createNdjsonAdapter } from './adapters/ndjson.js';
import { createOsmXmlAdapter, OPENSTREETMAP_SOURCE } from './adapters/osm-xml.js';
import { normalisePlace, type NormalisedPlace } from './normalise.js';
import type {
  AdapterId,
  DiscoveryAdapter,
  DiscoveryImportSummary,
  ImportError,
  RawDiscoveryMenu,
  RawDiscoveryMenuItem,
  RawDiscoveryRecord,
  SourceDescriptor,
} from './types.js';

/**
 * The discovery import pipeline.
 *
 * Safety properties, all covered by tests:
 *  * Dry run is the DEFAULT. Writing needs `dryRun: false` plus an exact `--confirm-target`.
 *  * It refuses outright when NODE_ENV=production.
 *  * It never deletes, and never overwrites a row an operator verified or submitted themselves.
 *  * It streams: records are read one at a time and written in bounded batches.
 *  * It is idempotent: importing the same file twice yields the same rows, because provider identity is a
 *    unique key.
 *  * The target description it prints and compares never contains credentials.
 */

export const DEFAULT_BATCH_SIZE = 200;
export const MAX_BATCH_SIZE = 500;
export const MAX_REPORTED_ERRORS = 25;
export const MAX_TRACKED_PROVIDER_IDS = 250_000;
export const MAX_MENU_ITEMS_PER_PLACE = 400;
export const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;

export interface DiscoveryImportOptions {
  filePath: string;
  adapter: AdapterId;
  source?: SourceDescriptor;
  /** Country used when a record does not carry one. In practice required for OSM extracts. */
  defaultCountryCode?: string;
  batchSize?: number;
  /** Stop after reading this many records. */
  limit?: number;
  /** Defaults to true. A commit has to be asked for explicitly. */
  dryRun?: boolean;
  /** Must equal `describeTarget()` for a write to proceed. */
  confirmTarget?: string;
  /** Structured menus are imported only when the operator opts in AND each record declares permission. */
  allowMenu?: boolean;
}

/** `database@host:port` for the configured DATABASE_URL. Deliberately excludes user and password. */
export function describeTarget(databaseUrl: string | undefined = process.env.DATABASE_URL): string {
  if (!databaseUrl) return 'unset';
  try {
    const url = new URL(databaseUrl);
    const host = url.hostname || 'localhost';
    const port = url.port || '5432';
    const database = url.pathname.replace(/^\/+/, '') || 'postgres';
    return `${database}@${host}:${port}`;
  } catch {
    return 'unparseable';
  }
}

/** Blocks the two worst mistakes: writing in production, and writing to the wrong database. */
export function assertSafeToWrite(confirmTarget: string | undefined, target: string): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'Refusing to run a committing discovery import with NODE_ENV=production. ' +
        'Imports are an operator task against a development or test database.',
    );
  }
  if (confirmTarget !== target) {
    throw new Error(
      `Refusing to write to ${target}. Re-run with --confirm-target="${target}" to commit, ` +
        'or drop --commit to stay in dry-run mode.',
    );
  }
}

const PLACE_UPSERT_SQL = `
  INSERT INTO discovery_places (
    provider, provider_record_id, name, country_code, city, region, postal_code, address_line,
    latitude, longitude, timezone, cuisines, website_url, menu_url, ordering_url, opening_hours_raw,
    source_name, source_url, source_record_url, source_licence, source_attribution, source_updated_at,
    data_origin, menu_permission, publication_status, verification_status, imported_at, updated_at
  )
  SELECT
    p->>'provider', p->>'providerRecordId', p->>'name', p->>'countryCode', p->>'city', p->>'region',
    p->>'postalCode', p->>'addressLine',
    NULLIF(p->>'latitude', '')::numeric, NULLIF(p->>'longitude', '')::numeric,
    p->>'timezone',
    coalesce((SELECT array_agg(c) FROM jsonb_array_elements_text(p->'cuisines') AS c), '{}'::text[]),
    p->>'websiteUrl', p->>'menuUrl', p->>'orderingUrl', p->>'openingHoursRaw',
    p->>'sourceName', p->>'sourceUrl', p->>'sourceRecordUrl', p->>'sourceLicence', p->>'sourceAttribution',
    NULLIF(p->>'sourceUpdatedAt', '')::timestamptz,
    'IMPORTED', 'NONE', 'PUBLISHED', 'SOURCE_LISTED', now(), now()
  FROM jsonb_array_elements($1::jsonb) AS p
  ON CONFLICT (provider, provider_record_id) DO UPDATE SET
    name = EXCLUDED.name,
    country_code = EXCLUDED.country_code,
    city = EXCLUDED.city,
    region = EXCLUDED.region,
    postal_code = EXCLUDED.postal_code,
    address_line = EXCLUDED.address_line,
    latitude = EXCLUDED.latitude,
    longitude = EXCLUDED.longitude,
    timezone = EXCLUDED.timezone,
    cuisines = EXCLUDED.cuisines,
    website_url = EXCLUDED.website_url,
    menu_url = EXCLUDED.menu_url,
    ordering_url = EXCLUDED.ordering_url,
    opening_hours_raw = EXCLUDED.opening_hours_raw,
    source_name = EXCLUDED.source_name,
    source_url = EXCLUDED.source_url,
    source_record_url = EXCLUDED.source_record_url,
    source_licence = EXCLUDED.source_licence,
    source_attribution = EXCLUDED.source_attribution,
    source_updated_at = EXCLUDED.source_updated_at,
    imported_at = now(),
    updated_at = now()
  -- Imported data may refresh imported data only. Verified and owner-submitted rows are untouched, and an
  -- operator's catalogue link, publication state, and verification state are never rewritten by an import.
  WHERE discovery_places.data_origin = 'IMPORTED'
    AND discovery_places.verification_status <> 'VERIFIED'`;

const SECTION_UPSERT_SQL = `
  INSERT INTO discovery_menu_sections (place_id, name, description, display_order)
  SELECT $1::uuid, s->>'name', s->>'description', coalesce((s->>'displayOrder')::int, 0)
  FROM jsonb_array_elements($2::jsonb) AS s
  ON CONFLICT (place_id, lower(name)) DO UPDATE SET
    description = EXCLUDED.description,
    display_order = EXCLUDED.display_order,
    updated_at = now()`;

const ITEM_UPSERT_SQL = `
  INSERT INTO discovery_menu_items (
    place_id, section_id, provider, provider_record_id, name, description, dietary_labels,
    price_minor, currency, currency_minor_units, price_is_estimated,
    source_url, source_attribution, source_updated_at, imported_at, updated_at
  )
  SELECT
    $1::uuid, s.id, i->>'provider', i->>'providerRecordId', i->>'name', i->>'description',
    coalesce((SELECT array_agg(c) FROM jsonb_array_elements_text(i->'dietaryLabels') AS c), '{}'::text[]),
    NULLIF(i->>'amountMinor', '')::int,
    NULLIF(i->>'currency', '')::text,
    NULLIF(i->>'currencyMinorUnits', '')::smallint,
    coalesce((i->>'isEstimated')::boolean, false),
    i->>'sourceRecordUrl', i->>'sourceAttribution',
    NULLIF(i->>'sourceUpdatedAt', '')::timestamptz,
    now(), now()
  FROM jsonb_array_elements($2::jsonb) AS i
  LEFT JOIN discovery_menu_sections s ON s.place_id = $1::uuid AND lower(s.name) = lower(i->>'sectionName')
  ON CONFLICT (provider, provider_record_id) WHERE provider_record_id IS NOT NULL DO UPDATE SET
    place_id = EXCLUDED.place_id,
    section_id = EXCLUDED.section_id,
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    dietary_labels = EXCLUDED.dietary_labels,
    price_minor = EXCLUDED.price_minor,
    currency = EXCLUDED.currency,
    currency_minor_units = EXCLUDED.currency_minor_units,
    price_is_estimated = EXCLUDED.price_is_estimated,
    source_url = EXCLUDED.source_url,
    source_attribution = EXCLUDED.source_attribution,
    source_updated_at = EXCLUDED.source_updated_at,
    imported_at = now(),
    updated_at = now()
  -- A dish identifier belonging to another place must not be able to hijack this place's menu.
  WHERE discovery_menu_items.place_id = $1::uuid`;

export function createAdapter(options: DiscoveryImportOptions): DiscoveryAdapter {
  return options.adapter === 'osm-xml'
    ? createOsmXmlAdapter({ countryFilter: options.defaultCountryCode, maxElements: options.limit })
    : createNdjsonAdapter({ maxRecords: options.limit });
}

/** Attribution and licence recorded on every row when the operator does not state a source explicitly. */
export function defaultSource(adapter: AdapterId): SourceDescriptor {
  return adapter === 'osm-xml'
    ? { ...OPENSTREETMAP_SOURCE }
    : {
        provider: 'ndjson',
        sourceName: 'Local NDJSON feed',
        sourceUrl: null,
        sourceLicence: null,
        sourceAttribution: 'Imported from an operator-supplied NDJSON file.',
      };
}

interface ExistingPlace {
  provider_record_id: string;
  data_origin: string;
  verification_status: string;
}

const isProtected = (row: ExistingPlace): boolean =>
  row.data_origin !== 'IMPORTED' || row.verification_status === 'VERIFIED';

interface PendingRecord {
  place: NormalisedPlace;
  raw: RawDiscoveryRecord;
}

function* menuEntries(menu: RawDiscoveryMenu): Generator<{ sectionName: string; item: RawDiscoveryMenuItem }> {
  for (const section of menu.sections ?? []) {
    const sectionName = typeof section?.name === 'string' && section.name.trim() ? section.name.trim() : 'Menu';
    for (const item of section?.items ?? []) {
      yield { sectionName, item };
    }
  }
}

interface ValidatedMenuItem {
  provider: string;
  providerRecordId: string;
  sectionName: string;
  name: string;
  description: string | null;
  dietaryLabels: string[];
  amountMinor: string | null;
  currency: string | null;
  currencyMinorUnits: string | null;
  isEstimated: boolean;
  sourceRecordUrl: string | null;
  sourceAttribution: string | null;
  sourceUpdatedAt: string | null;
}

/**
 * A discovery price is stored only as integer minor units plus an explicit currency plus that currency's
 * own exponent. Unknown currencies are rejected rather than assumed to have two decimal places, and an
 * amount without a currency (or the reverse) is rejected outright.
 */
function validateMenuItem(
  entry: { sectionName: string; item: RawDiscoveryMenuItem },
  placeProviderRecordId: string,
  provider: string,
): { ok: true; value: ValidatedMenuItem } | { ok: false; reason: string } {
  const item = entry.item;
  if (!item || typeof item !== 'object') {
    return { ok: false, reason: `menu item for ${placeProviderRecordId} is not an object` };
  }
  const id = typeof item.id === 'string' ? item.id.trim() : '';
  const name = typeof item.name === 'string' ? item.name.replace(/\s+/g, ' ').trim() : '';
  if (!id) {
    return { ok: false, reason: `menu item "${name || placeProviderRecordId}" has no stable id, so it cannot be upserted` };
  }
  if (!name || name.length > 200) return { ok: false, reason: `menu item ${id} has no usable name` };

  const hasAmount = typeof item.amountMinor === 'number' && Number.isFinite(item.amountMinor);
  const currency = typeof item.currency === 'string' ? item.currency.trim().toUpperCase() : '';
  let minorUnits: number | null = null;

  if (hasAmount !== Boolean(currency)) {
    return { ok: false, reason: `menu item ${id} must supply amountMinor and currency together` };
  }
  if (hasAmount) {
    if (!Number.isInteger(item.amountMinor) || (item.amountMinor as number) < 0) {
      return { ok: false, reason: `menu item ${id} amountMinor must be a non-negative integer` };
    }
    const derived = currencyMinorUnits(currency);
    if (derived === null) return { ok: false, reason: `menu item ${id} currency "${currency}" is not recognised` };
    if (typeof item.currencyMinorUnits === 'number' && item.currencyMinorUnits !== derived) {
      return {
        ok: false,
        reason: `menu item ${id} states ${item.currencyMinorUnits} minor units but ${currency} has ${derived}`,
      };
    }
    minorUnits = derived;
  }

  return {
    ok: true,
    value: {
      provider,
      providerRecordId: id,
      sectionName: entry.sectionName.slice(0, 120),
      name,
      description:
        typeof item.description === 'string' && item.description.trim() ? item.description.trim().slice(0, 600) : null,
      dietaryLabels: Array.isArray(item.dietaryLabels)
        ? item.dietaryLabels.filter((label): label is string => typeof label === 'string').slice(0, 8)
        : [],
      amountMinor: hasAmount ? String(item.amountMinor) : null,
      currency: hasAmount ? currency : null,
      currencyMinorUnits: minorUnits === null ? null : String(minorUnits),
      isEstimated: item.isEstimated === true,
      sourceRecordUrl: null,
      sourceAttribution: typeof item.sourceAttribution === 'string' ? item.sourceAttribution.slice(0, 500) : null,
      sourceUpdatedAt:
        typeof item.sourceUpdatedAt === 'string' && !Number.isNaN(new Date(item.sourceUpdatedAt).getTime())
          ? new Date(item.sourceUpdatedAt).toISOString()
          : null,
    },
  };
}

/**
 * Reads (and, when `write` is true, writes) one place's structured menu. The dry run takes exactly the same
 * decisions as a commit would, minus the writes, so the reported counts mean the same thing either way.
 */
async function processMenu(
  record: PendingRecord,
  source: SourceDescriptor,
  options: DiscoveryImportOptions,
  summary: DiscoveryImportSummary,
  pushError: (error: ImportError) => void,
  client: PoolClient,
  write: boolean,
): Promise<void> {
  const menu = record.raw.menu;
  if (!menu || !options.allowMenu) return;

  const entries = [...menuEntries(menu)].slice(0, MAX_MENU_ITEMS_PER_PLACE);
  if (!entries.length) return;

  const validated: ValidatedMenuItem[] = [];
  for (const entry of entries) {
    const outcome = validateMenuItem(entry, record.place.providerRecordId, source.provider);
    if (outcome.ok) validated.push(outcome.value);
    else {
      summary.menuItemsRejected += 1;
      pushError({ providerRecordId: record.place.providerRecordId, reason: outcome.reason });
    }
  }
  if (!validated.length) return;

  const place = await query<{ id: string }>(
    `SELECT id FROM discovery_places
     WHERE provider = $1 AND provider_record_id = $2
       AND data_origin = 'IMPORTED' AND verification_status <> 'VERIFIED'`,
    [source.provider, record.place.providerRecordId],
    client,
  );
  const placeId = place.rows[0]?.id;
  if (!placeId) {
    summary.menuItemsRejected += validated.length;
    pushError({
      providerRecordId: record.place.providerRecordId,
      reason: 'menu not written: the place is verified or owner-submitted and is protected from imports',
    });
    return;
  }

  const existingItems = await query<{ provider_record_id: string }>(
    `SELECT provider_record_id FROM discovery_menu_items
     WHERE place_id = $1 AND provider_record_id = ANY($2::text[])`,
    [placeId, validated.map((item) => item.providerRecordId)],
    client,
  );
  const existingIds = new Set(existingItems.rows.map((row) => row.provider_record_id));
  for (const item of validated) {
    if (existingIds.has(item.providerRecordId)) summary.menuItemsUpdated += 1;
    else summary.menuItemsInserted += 1;
  }

  if (!write) return;

  // The record states why this menu may be published; without that statement nothing is shown.
  await query(
    `UPDATE discovery_places SET menu_permission = $2, updated_at = now() WHERE id = $1 AND menu_permission <> $2`,
    [placeId, menu.permission],
    client,
  );

  const sections = [...new Map(validated.map((item) => [item.sectionName, item.sectionName])).values()].map(
    (name, index) => ({ name, description: null, displayOrder: index }),
  );
  if (sections.length) await query(SECTION_UPSERT_SQL, [placeId, JSON.stringify(sections)], client);
  await query(ITEM_UPSERT_SQL, [placeId, JSON.stringify(validated)], client);
}

export async function runDiscoveryImport(options: DiscoveryImportOptions): Promise<DiscoveryImportSummary> {
  const dryRun = options.dryRun !== false; // absent or true => dry run
  const startedAt = new Date();
  const target = describeTarget();

  const info = await stat(options.filePath).catch(() => null);
  if (!info) throw new Error(`Input file not found: ${options.filePath}`);
  if (!info.isFile()) throw new Error(`Input path is not a file: ${options.filePath}`);
  if (info.size > MAX_FILE_BYTES) {
    throw new Error(`Input file is larger than ${MAX_FILE_BYTES} bytes; split the extract into regions.`);
  }

  if (!dryRun) assertSafeToWrite(options.confirmTarget, target);

  const source = options.source ?? defaultSource(options.adapter);
  if (!/^[a-z0-9][a-z0-9_-]{0,59}$/.test(source.provider)) {
    throw new Error('source.provider must be 1-60 lowercase letters, digits, underscores, or hyphens.');
  }
  if (!source.sourceAttribution.trim()) {
    throw new Error('source.sourceAttribution is required: every imported row must carry attribution.');
  }
  if (options.defaultCountryCode && !isValidCountryCode(options.defaultCountryCode.toUpperCase())) {
    throw new Error(`--country "${options.defaultCountryCode}" is not an ISO 3166-1 alpha-2 code.`);
  }

  const batchSize = Math.min(Math.max(Math.trunc(options.batchSize ?? DEFAULT_BATCH_SIZE), 1), MAX_BATCH_SIZE);
  const adapter = createAdapter(options);

  const summary: DiscoveryImportSummary = {
    dryRun,
    adapter: options.adapter,
    provider: source.provider,
    target,
    filePath: path.resolve(options.filePath),
    startedAt: startedAt.toISOString(),
    finishedAt: startedAt.toISOString(),
    durationMs: 0,
    recordsRead: 0,
    recordsValid: 0,
    recordsInvalid: 0,
    inserted: 0,
    updated: 0,
    skippedProtected: 0,
    duplicatesInFile: 0,
    duplicateTrackingComplete: true,
    batches: 0,
    adapterStats: {},
    menuItemsInserted: 0,
    menuItemsUpdated: 0,
    menuItemsRejected: 0,
    droppedFields: {},
    errors: [],
    errorCount: 0,
  };

  const seenProviderIds = new Set<string>();
  const pushError = (error: ImportError): void => {
    summary.errorCount += 1;
    if (summary.errors.length < MAX_REPORTED_ERRORS) summary.errors.push(error);
  };

  let batch: PendingRecord[] = [];

  const flush = async (): Promise<void> => {
    if (!batch.length) return;
    const current = batch;
    batch = [];
    summary.batches += 1;

    await withTransaction(async (client) => {
      const existing = await query<ExistingPlace>(
        `SELECT provider_record_id, data_origin, verification_status
         FROM discovery_places WHERE provider = $1 AND provider_record_id = ANY($2::text[])`,
        [source.provider, current.map((record) => record.place.providerRecordId)],
        client,
      );
      const existingById = new Map(existing.rows.map((row) => [row.provider_record_id, row]));

      const writable: PendingRecord[] = [];
      for (const record of current) {
        const found = existingById.get(record.place.providerRecordId);
        if (!found) summary.inserted += 1;
        else if (isProtected(found)) {
          summary.skippedProtected += 1;
          continue;
        } else summary.updated += 1;
        writable.push(record);
      }

      if (!dryRun && writable.length) {
        await query(PLACE_UPSERT_SQL, [JSON.stringify(writable.map((record) => record.place))], client);
      }

      for (const record of writable) {
        await processMenu(record, source, options, summary, pushError, client, !dryRun);
      }
    });
  };

  for await (const raw of adapter.stream(options.filePath)) {
    if (options.limit !== undefined && summary.recordsRead >= options.limit) break;
    summary.recordsRead += 1;

    const providerRecordId = typeof raw.providerRecordId === 'string' ? raw.providerRecordId.trim() : '';
    if (!providerRecordId) {
      summary.recordsInvalid += 1;
      pushError({ providerRecordId: null, reason: 'missing providerRecordId' });
      continue;
    }
    if (seenProviderIds.size < MAX_TRACKED_PROVIDER_IDS) {
      if (seenProviderIds.has(providerRecordId)) {
        summary.duplicatesInFile += 1;
        continue;
      }
      seenProviderIds.add(providerRecordId);
    } else {
      // Beyond this the database's unique key still deduplicates; we simply stop reporting file duplicates.
      summary.duplicateTrackingComplete = false;
    }

    const result = normalisePlace(raw, { source, defaultCountryCode: options.defaultCountryCode });
    if (!result.ok) {
      summary.recordsInvalid += 1;
      pushError({ providerRecordId, reason: result.reason });
      continue;
    }
    for (const field of result.drops) summary.droppedFields[field] = (summary.droppedFields[field] ?? 0) + 1;
    summary.recordsValid += 1;
    batch.push({ place: result.value, raw });

    if (batch.length >= batchSize) await flush();
  }
  await flush();

  summary.adapterStats = { ...(adapter.stats ?? {}) };
  summary.finishedAt = new Date().toISOString();
  summary.durationMs = new Date(summary.finishedAt).getTime() - startedAt.getTime();
  return summary;
}
