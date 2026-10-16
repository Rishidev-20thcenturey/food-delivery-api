import {
  canonicalCuisineLabel,
  isValidCountryCode,
  isValidTimezone,
  normaliseHttpUrl,
} from '../../modules/discovery/reference-data.js';
import type { RawDiscoveryRecord, SourceDescriptor } from './types.js';

/**
 * Turns whatever an adapter produced into a row that satisfies `discovery_places`.
 *
 * Two rules drive everything here:
 *  1. Nothing is invented. A field the source does not supply stays NULL. An invalid optional field is
 *     dropped and counted, so the operator can see data quality without losing the whole record.
 *  2. Nothing unsafe gets through. Country codes, timezones, coordinates, and URLs are all validated
 *     against the same reference data the API uses, and only http(s) links survive.
 */

export const MAX_CUISINES = 8;

/** JSON shape consumed by the importer's `INSERT … SELECT … FROM jsonb_array_elements($1)` statement. */
export interface NormalisedPlace {
  provider: string;
  providerRecordId: string;
  name: string;
  countryCode: string;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  addressLine: string | null;
  latitude: string | null;
  longitude: string | null;
  timezone: string | null;
  cuisines: string[];
  websiteUrl: string | null;
  menuUrl: string | null;
  orderingUrl: string | null;
  openingHoursRaw: string | null;
  sourceName: string;
  sourceUrl: string | null;
  sourceRecordUrl: string | null;
  sourceLicence: string | null;
  sourceAttribution: string;
  sourceUpdatedAt: string | null;
}

export type NormaliseResult =
  | { ok: true; value: NormalisedPlace; drops: string[] }
  | { ok: false; reason: string };

export interface NormaliseContext {
  source: SourceDescriptor;
  /** Used when the record itself carries no usable country. Must be a valid ISO 3166-1 alpha-2 code. */
  defaultCountryCode?: string;
}

const POSTAL_SHAPE = /^[A-Za-z0-9][A-Za-z0-9 .-]*[A-Za-z0-9]$/;

const clampText = (value: unknown, max: number): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (!trimmed || trimmed.length > max) return null;
  return trimmed;
};

const coordinate = (value: unknown, limit: number): number | null => {
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return null;
  if (Math.abs(parsed) > limit) return null;
  // NUMERIC(9,6): six decimal places is roughly 0.11 m, far below anything a food directory needs.
  return Number(parsed.toFixed(6));
};

const timestamp = (value: unknown): string | null => {
  if (typeof value !== 'string' || !value.trim()) return null;
  const date = new Date(value.trim());
  if (Number.isNaN(date.getTime())) return null;
  // A source timestamp in the future is a data error, not a fact worth storing.
  if (date.getTime() > Date.now() + 24 * 60 * 60 * 1000) return null;
  return date.toISOString();
};

export function normaliseCuisines(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of values) {
    if (typeof entry !== 'string') continue;
    // Sources such as OSM separate several cuisines with ';' or ','.
    for (const part of entry.split(/[;,]/)) {
      const label = canonicalCuisineLabel(part);
      if (!label || label.length > 40 || seen.has(label.toLowerCase())) continue;
      seen.add(label.toLowerCase());
      out.push(label);
      if (out.length >= MAX_CUISINES) return out;
    }
  }
  return out;
}

export function normalisePlace(raw: RawDiscoveryRecord, context: NormaliseContext): NormaliseResult {
  const drops: string[] = [];

  const providerRecordId = clampText(raw.providerRecordId, 190);
  if (!providerRecordId) return { ok: false, reason: 'missing or oversized providerRecordId' };

  const name = clampText(raw.name, 200);
  if (!name) return { ok: false, reason: 'missing or oversized name' };

  const rawCountry = typeof raw.countryCode === 'string' ? raw.countryCode.trim().toUpperCase() : '';
  const fallbackCountry = context.defaultCountryCode?.trim().toUpperCase() ?? '';
  const countryCode = isValidCountryCode(rawCountry)
    ? rawCountry
    : isValidCountryCode(fallbackCountry)
      ? fallbackCountry
      : '';
  if (!countryCode) {
    return {
      ok: false,
      reason: rawCountry
        ? `country code "${rawCountry}" is not ISO 3166-1 alpha-2`
        : 'no country code on the record and no valid --country default',
    };
  }
  if (rawCountry && rawCountry !== countryCode) drops.push('countryCode');

  const postalCode = clampText(raw.postalCode, 12);
  const postalOk = postalCode !== null && postalCode.length >= 3 && POSTAL_SHAPE.test(postalCode);
  if (postalCode !== null && !postalOk) drops.push('postalCode');

  const latitude = coordinate(raw.latitude, 90);
  const longitude = coordinate(raw.longitude, 180);
  const hasLatitude = raw.latitude !== null && raw.latitude !== undefined;
  const hasLongitude = raw.longitude !== null && raw.longitude !== undefined;
  if (hasLatitude !== hasLongitude) {
    // Half a coordinate is worse than none: the database rejects it and the UI could not use it anyway.
    return { ok: false, reason: 'latitude and longitude must be supplied together' };
  }
  if (hasLatitude && (latitude === null || longitude === null)) {
    return { ok: false, reason: 'coordinates are not finite numbers within range' };
  }

  const timezone = clampText(raw.timezone, 64);
  const timezoneOk = timezone !== null && isValidTimezone(timezone);
  if (timezone !== null && !timezoneOk) drops.push('timezone');

  const websiteUrl = normaliseHttpUrl(raw.websiteUrl);
  if (raw.websiteUrl && websiteUrl === null) drops.push('websiteUrl');
  const menuUrl = normaliseHttpUrl(raw.menuUrl);
  if (raw.menuUrl && menuUrl === null) drops.push('menuUrl');
  const orderingUrl = normaliseHttpUrl(raw.orderingUrl);
  if (raw.orderingUrl && orderingUrl === null) drops.push('orderingUrl');
  const sourceRecordUrl = normaliseHttpUrl(raw.sourceRecordUrl);
  if (raw.sourceRecordUrl && sourceRecordUrl === null) drops.push('sourceRecordUrl');

  const openingHoursRaw = clampText(raw.openingHoursRaw, 300);
  if (raw.openingHoursRaw && openingHoursRaw === null) drops.push('openingHoursRaw');

  const sourceUpdatedAt = timestamp(raw.sourceUpdatedAt);
  if (raw.sourceUpdatedAt && sourceUpdatedAt === null) drops.push('sourceUpdatedAt');

  const city = clampText(raw.city, 120);
  if (raw.city && city === null) drops.push('city');
  const region = clampText(raw.region, 120);
  if (raw.region && region === null) drops.push('region');
  const addressLine = clampText(raw.addressLine, 240);
  if (raw.addressLine && addressLine === null) drops.push('addressLine');

  return {
    ok: true,
    drops,
    value: {
      provider: context.source.provider,
      providerRecordId,
      name,
      countryCode,
      city,
      region,
      postalCode: postalOk ? postalCode : null,
      addressLine,
      latitude: latitude === null ? null : latitude.toFixed(6),
      longitude: longitude === null ? null : longitude.toFixed(6),
      timezone: timezoneOk ? timezone : null,
      cuisines: normaliseCuisines(raw.cuisines),
      websiteUrl,
      menuUrl,
      orderingUrl,
      openingHoursRaw,
      sourceName: context.source.sourceName,
      sourceUrl: context.source.sourceUrl,
      sourceRecordUrl,
      sourceLicence: context.source.sourceLicence,
      sourceAttribution: context.source.sourceAttribution,
      sourceUpdatedAt,
    },
  };
}
