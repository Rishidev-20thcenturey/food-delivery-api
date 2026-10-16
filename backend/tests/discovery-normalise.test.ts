import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { normaliseCuisines, normalisePlace } from '../src/db/discovery-import/normalise.js';
import { decodeXmlEntities, isFoodPlace, parseAttributes } from '../src/db/discovery-import/adapters/osm-xml.js';
import {
  COUNTRIES,
  canonicalCuisineLabel,
  countryName,
  currencyMinorUnits,
  isValidCountryCode,
  isValidTimezone,
  normaliseHttpUrl,
} from '../src/modules/discovery/reference-data.js';
import { toPrefixTsQuery } from '../src/modules/discovery/service.js';
import { discoveryListQuery } from '../src/modules/discovery/validators.js';
import type { RawDiscoveryRecord, SourceDescriptor } from '../src/db/discovery-import/types.js';

/**
 * Unit coverage for the discovery rules that decide what data is allowed to exist at all.
 *
 * These are pure functions, so they are tested directly and without fixtures: a bad value must be rejected
 * or dropped here, before it can ever reach a database row or a visitor's screen.
 */

const SOURCE: SourceDescriptor = {
  provider: 'unit-test',
  sourceName: 'Unit Test Source',
  sourceUrl: 'https://unit-test.example.test/source',
  sourceLicence: 'TEST-ONLY',
  sourceAttribution: 'Synthetic unit-test data. Not a real restaurant.',
};

const record = (overrides: Partial<RawDiscoveryRecord> = {}): RawDiscoveryRecord => ({
  providerRecordId: 'unit/1',
  name: 'Synthetic Unit Diner',
  countryCode: 'IN',
  ...overrides,
});

const value = (overrides: Partial<RawDiscoveryRecord> = {}) => {
  const result = normalisePlace(record(overrides), { source: SOURCE });
  if (!result.ok) throw new Error(`expected a valid record, got: ${result.reason}`);
  return result.value;
};

describe('discovery reference data', () => {
  it('ships a complete, unique ISO 3166-1 alpha-2 country list with names', () => {
    expect(COUNTRIES.length).toBeGreaterThanOrEqual(249);
    const codes = COUNTRIES.map((country) => country.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const country of COUNTRIES) {
      expect(country.code).toMatch(/^[A-Z]{2}$/);
      expect(country.name.length).toBeGreaterThan(0);
    }
    expect(countryName('IN')).toBe('India');
    expect(countryName('JP')).toBe('Japan');
    // An unknown code falls back to the code itself rather than inventing a country name.
    expect(countryName('ZZ')).toBe('ZZ');
    expect(isValidCountryCode('IN')).toBe(true);
    expect(isValidCountryCode('ZZ')).toBe(false);
    expect(isValidCountryCode('IND')).toBe(false);
    expect(isValidCountryCode(null)).toBe(false);
  });

  it('knows that not every currency has two decimal places, and refuses to guess', () => {
    expect(currencyMinorUnits('JPY')).toBe(0);
    expect(currencyMinorUnits('KRW')).toBe(0);
    expect(currencyMinorUnits('VND')).toBe(0);
    expect(currencyMinorUnits('BHD')).toBe(3);
    expect(currencyMinorUnits('KWD')).toBe(3);
    expect(currencyMinorUnits('EUR')).toBe(2);
    expect(currencyMinorUnits('INR')).toBe(2);
    expect(currencyMinorUnits('usd')).toBe(2);
    // Unknown means unknown: never a silent default that would corrupt an amount.
    expect(currencyMinorUnits('XYZ')).toBeNull();
    expect(currencyMinorUnits('INRU')).toBeNull();
    expect(currencyMinorUnits('')).toBeNull();
    // Every country's advertised default currency must be one we can actually price in.
    for (const country of COUNTRIES) {
      if (country.currency) expect(currencyMinorUnits(country.currency), country.code).not.toBeNull();
    }
  });

  it('accepts only real IANA timezones', () => {
    expect(isValidTimezone('Europe/Berlin')).toBe(true);
    expect(isValidTimezone('Asia/Kolkata')).toBe(true);
    expect(isValidTimezone('America/Argentina/Buenos_Aires')).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
    expect(isValidTimezone('Mars/Olympus')).toBe(false);
    expect(isValidTimezone('Not a zone')).toBe(false);
    expect(isValidTimezone('')).toBe(false);
    expect(isValidTimezone(undefined)).toBe(false);
  });

  it('canonicalises cuisine labels identically for storage and for filtering', () => {
    expect(canonicalCuisineLabel('north indian')).toBe('North Indian');
    expect(canonicalCuisineLabel('NORTH INDIAN')).toBe('North Indian');
    expect(canonicalCuisineLabel('  street   food ')).toBe('Street Food');
    expect(canonicalCuisineLabel('café')).toBe('Café');
    expect(canonicalCuisineLabel('')).toBe('');
    // The request filter and the importer must agree, or an indexed filter would silently miss rows.
    expect(discoveryListQuery.parse({ cuisine: 'ramen, STREET FOOD' }).cuisine).toEqual(['Ramen', 'Street Food']);
    expect(discoveryListQuery.parse({ cuisine: 'RAMEN' }).cuisine).toEqual([canonicalCuisineLabel('ramen')]);
    expect(normaliseCuisines(['german;curry', ' Curry ', 'italian'])).toEqual(['German', 'Curry', 'Italian']);
    expect(normaliseCuisines([])).toEqual([]);
    expect(normaliseCuisines(undefined)).toEqual([]);
    expect(normaliseCuisines(['a'.repeat(60)])).toEqual([]);
    expect(normaliseCuisines(Array.from({ length: 20 }, (_unused, index) => `Cuisine${index}`))).toHaveLength(8);
  });

  it('accepts only http(s) links, with no embedded credentials', () => {
    expect(normaliseHttpUrl('https://example.test/menu')).toBe('https://example.test/menu');
    expect(normaliseHttpUrl('http://example.test/')).toBe('http://example.test');
    expect(normaliseHttpUrl('https://example.test/menu/')).toBe('https://example.test/menu');
    for (const unsafe of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      'ftp://example.test/menu',
      '//example.test/menu',
      'https://user:pass@example.test/menu',
      'https:// example.test/menu',
      'example.test/menu',
      '',
      '   ',
      null,
      undefined,
      42,
      `https://example.test/${'a'.repeat(2100)}`,
    ]) {
      expect(normaliseHttpUrl(unsafe), String(unsafe)).toBeNull();
    }
  });
});

describe('discovery record normalisation', () => {
  it('rejects records it cannot identify or name', () => {
    expect(normalisePlace(record({ providerRecordId: '' }), { source: SOURCE })).toMatchObject({
      ok: false,
      reason: 'missing or oversized providerRecordId',
    });
    expect(normalisePlace(record({ name: '   ' }), { source: SOURCE })).toMatchObject({ ok: false, reason: 'missing or oversized name' });
    expect(normalisePlace(record({ name: 'x'.repeat(201) }), { source: SOURCE })).toMatchObject({ ok: false });
  });

  it('needs a real country, from the record or from the operator default', () => {
    expect(normalisePlace(record({ countryCode: null }), { source: SOURCE })).toMatchObject({ ok: false });
    expect(normalisePlace(record({ countryCode: null }), { source: SOURCE, defaultCountryCode: 'DE' })).toMatchObject({
      ok: true,
      value: { countryCode: 'DE' },
    });
    expect(normalisePlace(record({ countryCode: 'de' }), { source: SOURCE })).toMatchObject({
      ok: true,
      value: { countryCode: 'DE' },
    });
    expect(normalisePlace(record({ countryCode: 'XYZ' }), { source: SOURCE, defaultCountryCode: 'DE' })).toMatchObject({
      ok: true,
      value: { countryCode: 'DE' },
    });
  });

  it('refuses half a coordinate pair and out-of-range coordinates', () => {
    expect(normalisePlace(record({ latitude: 25.1, longitude: null }), { source: SOURCE })).toMatchObject({
      ok: false,
      reason: 'latitude and longitude must be supplied together',
    });
    expect(normalisePlace(record({ latitude: null, longitude: 77.5 }), { source: SOURCE })).toMatchObject({
      ok: false,
      reason: 'latitude and longitude must be supplied together',
    });
    expect(normalisePlace(record({ latitude: 95.1, longitude: 13.4 }), { source: SOURCE })).toMatchObject({
      ok: false,
      reason: 'coordinates are not finite numbers within range',
    });
    expect(normalisePlace(record({ latitude: 52.5, longitude: -181 }), { source: SOURCE })).toMatchObject({ ok: false });
    // NUMERIC(9,6): the importer rounds to the precision the column can actually store.
    expect(value({ latitude: 52.5, longitude: 13.4 })).toMatchObject({ latitude: '52.500000', longitude: '13.400000' });
    expect(value({ latitude: 52.1234567, longitude: 13.1234567 })).toMatchObject({
      latitude: '52.123457',
      longitude: '13.123457',
    });
    expect(value({ latitude: null, longitude: null })).toMatchObject({ latitude: null, longitude: null });
  });

  it('drops invalid optional fields but keeps the record', () => {
    const result = normalisePlace(
      record({
        websiteUrl: 'javascript:alert(document.cookie)',
        menuUrl: 'https://unit-test.example.test/menu',
        postalCode: '!',
        timezone: 'Mars/Olympus',
        openingHoursRaw: 'x'.repeat(301),
        sourceUpdatedAt: 'not a date',
        city: 'x'.repeat(121),
      }),
      { source: SOURCE },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.drops.sort()).toEqual(
      ['city', 'openingHoursRaw', 'postalCode', 'sourceUpdatedAt', 'timezone', 'websiteUrl'].sort(),
    );
    expect(result.value.websiteUrl).toBeNull();
    expect(result.value.menuUrl).toBe('https://unit-test.example.test/menu');
    expect(result.value.postalCode).toBeNull();
    expect(result.value.timezone).toBeNull();
    expect(result.value.openingHoursRaw).toBeNull();
    expect(result.value.sourceUpdatedAt).toBeNull();
    expect(result.value.city).toBeNull();
  });

  it('accepts country-specific postal codes and rejects a six-digit-only assumption', () => {
    expect(value({ countryCode: 'GB', postalCode: 'M1 1AA' }).postalCode).toBe('M1 1AA');
    expect(value({ countryCode: 'JP', postalCode: '100-0001' }).postalCode).toBe('100-0001');
    expect(value({ countryCode: 'IN', postalCode: '800001' }).postalCode).toBe('800001');
    expect(value({ countryCode: 'AE', postalCode: null }).postalCode).toBeNull();
    expect(value({ countryCode: 'NL', postalCode: '1234 AB' }).postalCode).toBe('1234 AB');
  });

  it('rejects a source timestamp in the future but keeps a real one', () => {
    expect(value({ sourceUpdatedAt: '2026-08-01T10:00:00Z' }).sourceUpdatedAt).toBe('2026-08-01T10:00:00.000Z');
    const farFuture = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
    const result = normalisePlace(record({ sourceUpdatedAt: farFuture }), { source: SOURCE });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.sourceUpdatedAt).toBeNull();
      expect(result.drops).toContain('sourceUpdatedAt');
    }
  });

  it('copies provenance and attribution onto every row it produces', () => {
    const normalised = value();
    expect(normalised.provider).toBe('unit-test');
    expect(normalised.sourceName).toBe('Unit Test Source');
    expect(normalised.sourceUrl).toBe('https://unit-test.example.test/source');
    expect(normalised.sourceLicence).toBe('TEST-ONLY');
    expect(normalised.sourceAttribution).toContain('Not a real restaurant');
  });
});

describe('search query building', () => {
  it('builds a bounded prefix tsquery and cannot be given tsquery operators', () => {
    expect(toPrefixTsQuery('Paneer Roll')).toBe('paneer:* & roll:*');
    expect(toPrefixTsQuery('  north   indian  ')).toBe('north:* & indian:*');
    expect(toPrefixTsQuery('seven eight nine ten eleven twelve thirteen')).toBe(
      'seven:* & eight:* & nine:* & ten:* & eleven:* & twelve:*',
    );
    // Operators and punctuation are stripped, so nothing can be injected into to_tsquery.
    expect(toPrefixTsQuery('%')).toBeNull();
    expect(toPrefixTsQuery("!&|():*<>'")).toBeNull();
    expect(toPrefixTsQuery('a!b')).toBe('a:* & b:*');
    expect(toPrefixTsQuery('')).toBeNull();
    expect(toPrefixTsQuery(undefined)).toBeNull();
    // Non-Latin scripts survive, because the directory is global.
    expect(toPrefixTsQuery('राजमा')).toBe('राजमा:*');
    expect(toPrefixTsQuery('ラーメン')).toBe('ラーメン:*');
  });
});

describe('OSM XML helpers', () => {
  it('decodes the XML entities OSM uses in names and links', () => {
    expect(decodeXmlEntities('Caf&#233; &amp; Bar')).toBe('Café & Bar');
    expect(decodeXmlEntities('a &lt; b &gt; c &quot;d&quot; &apos;e&apos;')).toBe('a < b > c "d" \'e\'');
    expect(decodeXmlEntities('plain text')).toBe('plain text');
    // An entity we do not know is left alone rather than mangled.
    expect(decodeXmlEntities('&unknownentity;')).toBe('&unknownentity;');
  });

  it('parses attributes out of a fragment', () => {
    expect(parseAttributes(' id="9001" lat="52.530000" lon="13.400000" timestamp="2026-08-01T10:00:00Z"')).toEqual({
      id: '9001',
      lat: '52.530000',
      lon: '13.400000',
      timestamp: '2026-08-01T10:00:00Z',
    });
    expect(parseAttributes(' k="name" v="Caf&#233;"')).toEqual({ k: 'name', v: 'Café' });
  });

  it('recognises food places, and refuses places that no longer exist', () => {
    expect(isFoodPlace({ amenity: 'restaurant' })).toBe(true);
    expect(isFoodPlace({ amenity: 'cafe' })).toBe(true);
    expect(isFoodPlace({ amenity: 'fast_food' })).toBe(true);
    expect(isFoodPlace({ amenity: 'food_court' })).toBe(true);
    expect(isFoodPlace({ amenity: 'ice_cream' })).toBe(true);
    expect(isFoodPlace({ shop: 'bakery' })).toBe(true);
    // A drinking venue only counts when the source says it serves food.
    expect(isFoodPlace({ amenity: 'pub', cuisine: 'burger' })).toBe(true);
    expect(isFoodPlace({ amenity: 'pub' })).toBe(false);
    expect(isFoodPlace({ amenity: 'bar' })).toBe(false);
    expect(isFoodPlace({ amenity: 'parking' })).toBe(false);
    expect(isFoodPlace({ shop: 'car_repair' })).toBe(false);
    // Lifecycle tagging means the place is gone; it must never appear in a live directory.
    expect(isFoodPlace({ 'disused:amenity': 'restaurant', name: 'Gone' })).toBe(false);
    expect(isFoodPlace({ 'abandoned:amenity': 'cafe' })).toBe(false);
    expect(isFoodPlace({ amenity: 'restaurant', 'disused:name': 'Old name' })).toBe(false);
    expect(isFoodPlace({})).toBe(false);
  });

  it('reads the fixture the tests depend on', async () => {
    const fixture = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'discovery', 'synthetic-places.osm');
    const { createOsmXmlAdapter } = await import('../src/db/discovery-import/adapters/osm-xml.js');
    const adapter = createOsmXmlAdapter({ countryFilter: 'DE' });
    const records = [];
    for await (const item of adapter.stream(fixture)) records.push(item);
    expect(records).toHaveLength(13);
    expect(records[0]).toMatchObject({
      providerRecordId: 'node/9001',
      name: 'Synthetic Berlin Curry House',
      countryCode: 'DE',
      city: 'Berlin',
      cuisines: ['german;curry'],
      openingHoursRaw: 'Mo-Fr 11:00-22:00',
      sourceRecordUrl: 'https://www.openstreetmap.org/node/9001',
      sourceUpdatedAt: '2026-08-01T10:00:00Z',
    });
    const wayWithCentre = records.find((item) => item.providerRecordId === 'way/9101');
    expect(wayWithCentre).toMatchObject({ latitude: 50.94, longitude: 6.96 });
    const wayWithout = records.find((item) => item.providerRecordId === 'way/9102');
    expect(wayWithout?.latitude).toBeNull();
    expect(wayWithout?.longitude).toBeNull();
  });
});
