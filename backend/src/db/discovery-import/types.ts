/**
 * Source-adapter contracts for the discovery importer.
 *
 * A new data source (Wikidata, a municipal open dataset, a restaurant-submitted CSV, an authorised menu
 * feed) is added by writing one adapter that yields `RawDiscoveryRecord`s. Nothing else changes: the
 * normaliser, the upsert, the safeguards, and the API all stay as they are.
 */

/** Everything an adapter can honestly report about one place. All optional fields stay missing when the
 * source does not supply them — the importer never fills gaps with invented data. */
/** One dish in a structured menu that an authorised source is allowed to publish. */
export interface RawDiscoveryMenuItem {
  /** Stable per-dish identifier from the source. Required: without it the row cannot be upserted safely. */
  id: string;
  name: string;
  description?: string | null;
  dietaryLabels?: string[] | null;
  /** Integer minor units in `currency`, for example 1250 for EUR 12.50 or 1250 for JPY 1250. */
  amountMinor?: number | null;
  /** ISO 4217 code. Required whenever an amount is given. Never assumed to be two decimal places. */
  currency?: string | null;
  /** ISO 4217 exponent. Optional: derived from `currency` when the source does not state it. */
  currencyMinorUnits?: number | null;
  isEstimated?: boolean | null;
  sourceAttribution?: string | null;
  sourceUpdatedAt?: string | null;
}

export interface RawDiscoveryMenuSection {
  name: string;
  description?: string | null;
  displayOrder?: number | null;
  items: RawDiscoveryMenuItem[];
}

/**
 * A structured menu, present only when the source may publish one. `permission` is never inferred:
 * the record must state OWNER_SUBMITTED or SOURCE_PERMITTED explicitly, and the importer additionally
 * requires the operator to pass --allow-menu.
 */
export interface RawDiscoveryMenu {
  permission: 'OWNER_SUBMITTED' | 'SOURCE_PERMITTED';
  sections: RawDiscoveryMenuSection[];
}

export interface RawDiscoveryRecord {
  /** Stable identifier in the source, for example `node/24681357` for OpenStreetMap. */
  providerRecordId: string;
  name: string;
  countryCode?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
  addressLine?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  /** IANA identifier such as `Europe/Berlin`, when the source states one. */
  timezone?: string | null;
  cuisines?: string[] | null;
  websiteUrl?: string | null;
  menuUrl?: string | null;
  orderingUrl?: string | null;
  /** Verbatim source value. Stored but never interpreted into an "open now" answer. */
  openingHoursRaw?: string | null;
  /** URL of this exact record in the source, for reviewer provenance. */
  sourceRecordUrl?: string | null;
  /** ISO 8601 timestamp reported by the source for this record. */
  sourceUpdatedAt?: string | null;
  /** Present only for feeds that are allowed to publish a structured menu. */
  menu?: RawDiscoveryMenu | null;
}

/** Dataset-level provenance and licensing. Recorded on every row the import writes. */
export interface SourceDescriptor {
  /** Stable provider key, for example `openstreetmap`. Part of the uniqueness constraint. */
  provider: string;
  sourceName: string;
  sourceUrl: string | null;
  sourceLicence: string | null;
  sourceAttribution: string;
}

export type AdapterId = 'osm-xml' | 'ndjson';

export interface DiscoveryAdapter {
  readonly id: AdapterId;
  /** Optional counters the importer reports back, for example elements scanned versus records yielded. */
  stats?: Record<string, number>;
  /** Streams records from a local file. Must not buffer the whole file in memory. */
  stream(filePath: string): AsyncGenerator<RawDiscoveryRecord, void, undefined>;
}

/** One rejected record, kept for the operator's error summary. */
export interface ImportError {
  providerRecordId: string | null;
  reason: string;
}

export interface DiscoveryImportSummary {
  /** True when nothing was written. Dry run is the default. */
  dryRun: boolean;
  adapter: AdapterId;
  provider: string;
  /** `database@host:port` — never includes credentials. */
  target: string;
  filePath: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  recordsRead: number;
  recordsValid: number;
  recordsInvalid: number;
  /** Rows written (dry run: rows that would be written) as new records. */
  inserted: number;
  /** Rows refreshed (dry run: rows that would be refreshed) from the same provider. */
  updated: number;
  /** Existing rows protected from being overwritten by imported data. */
  skippedProtected: number;
  /** Repeated provider IDs inside the input file, collapsed to the first occurrence. */
  duplicatesInFile: number;
  /** True while every provider ID in the run was tracked; false if the run was large enough to stop. */
  duplicateTrackingComplete: boolean;
  batches: number;
  /** Adapter-defined counters, e.g. OSM elements scanned versus food places yielded. */
  adapterStats: Record<string, number>;
  menuItemsInserted: number;
  menuItemsUpdated: number;
  menuItemsRejected: number;
  /** Field-level values dropped because they failed validation, counted per field name. */
  droppedFields: Record<string, number>;
  errors: ImportError[];
  errorCount: number;
}
