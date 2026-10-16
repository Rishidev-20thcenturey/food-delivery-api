import { createReadStream } from 'node:fs';
import type { DiscoveryAdapter, RawDiscoveryRecord } from '../types.js';
import { isValidCountryCode } from '../../../modules/discovery/reference-data.js';

/**
 * OpenStreetMap adapter: streams food places out of an OSM XML file.
 *
 * WHY OSM XML
 *   OSM data is available at $0 under the Open Database Licence (ODbL) 1.0 — see
 *   https://www.openstreetmap.org/copyright. Both of the free ways to obtain a bounded extract produce
 *   this format:
 *     * a regional extract from a mirror such as Geofabrik (`.osm`, usually bzip2-compressed), and
 *     * an Overpass API query written as `[out:xml]` (Overpass's default output).
 *   Neither is contacted by this code. The operator downloads the file themselves and passes a local path.
 *
 * MEMORY
 *   The file is streamed in 64 KiB chunks and one element is materialised at a time, so a large regional
 *   extract never has to fit in RAM. Only a single unfinished element is buffered, with a hard cap.
 *
 * HONESTY
 *   Coordinates are taken from `node` elements and from `<center>` on ways/relations when the extract
 *   provides one. Way geometry is never resolved from node references, because that would require holding
 *   every node in memory. A way without a centre is imported with NULL coordinates rather than a guess.
 *   Opening hours are stored verbatim and never parsed into "open now".
 */

const CHUNK_BYTES = 64 * 1024;
/** Largest amount of unfinished element data we are willing to buffer before calling the file malformed. */
const MAX_PENDING_BYTES = 8 * 1024 * 1024;

const FOOD_AMENITIES = new Set(['restaurant', 'cafe', 'fast_food', 'food_court', 'ice_cream']);
/** Drinking venues count as food places only when the source says they serve food. */
const DRINKING_AMENITIES = new Set(['pub', 'bar', 'biergarten']);
const FOOD_SHOPS = new Set(['bakery', 'pastry', 'confectionery', 'deli', 'cheese', 'chocolate']);
/** Prefixes OSM uses for features that no longer exist. They must never appear in a live directory. */
const GONE_PREFIXES = ['disused:', 'abandoned:', 'demolished:', 'razed:', 'removed:', 'historic:'];

export interface OsmXmlElement {
  type: 'node' | 'way' | 'relation';
  id: string;
  lat: number | null;
  lon: number | null;
  timestamp: string | null;
  tags: Record<string, string>;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeXmlEntities(value: string): string {
  return value.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);/g, (match, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[body.toLowerCase()] ?? match;
  });
}

const ATTRIBUTE = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*"([^"]*)"/g;

export function parseAttributes(fragment: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  ATTRIBUTE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTRIBUTE.exec(fragment)) !== null) {
    attributes[match[1]] = decodeXmlEntities(match[2]);
  }
  return attributes;
}

const OPEN_ELEMENT = /<(node|way|relation)\b([^>]*?)(\/?)>/g;
const CLOSE_ELEMENT: Record<OsmXmlElement['type'], RegExp> = {
  node: /<\/node\s*>/g,
  way: /<\/way\s*>/g,
  relation: /<\/relation\s*>/g,
};
const TAG_ELEMENT = /<tag\b[^>]*>/g;
const CENTER_ELEMENT = /<center\b([^>]*?)\/?>/;

function elementFrom(type: OsmXmlElement['type'], attributeFragment: string, inner: string): OsmXmlElement {
  const attributes = parseAttributes(attributeFragment);
  const tags: Record<string, string> = {};
  TAG_ELEMENT.lastIndex = 0;
  let tagMatch: RegExpExecArray | null;
  while ((tagMatch = TAG_ELEMENT.exec(inner)) !== null) {
    const tagAttributes = parseAttributes(tagMatch[0]);
    if (tagAttributes.k) tags[tagAttributes.k] = tagAttributes.v ?? '';
  }

  // `node` carries its own lat/lon. Ways and relations only have coordinates when the extract was
  // produced with centres (Overpass `[out:xml][out:center]`, or an extract that includes them).
  let lat: number | null = null;
  let lon: number | null = null;
  const centerMatch = CENTER_ELEMENT.exec(inner);
  const coordinates =
    attributes.lat !== undefined && attributes.lon !== undefined
      ? attributes
      : centerMatch
        ? parseAttributes(centerMatch[1])
        : null;
  if (coordinates) {
    const parsedLat = Number(coordinates.lat);
    const parsedLon = Number(coordinates.lon);
    if (Number.isFinite(parsedLat) && Number.isFinite(parsedLon)) {
      lat = parsedLat;
      lon = parsedLon;
    }
  }

  return { type, id: attributes.id ?? '', lat, lon, timestamp: attributes.timestamp ?? null, tags };
}

/**
 * Streams complete OSM elements from a file without loading it into memory. Throws if the file contains an
 * element so large that buffering it would be unreasonable (which in practice means it is not OSM XML).
 */
export async function* streamOsmElements(filePath: string): AsyncGenerator<OsmXmlElement, void, undefined> {
  let buffer = '';
  for await (const chunk of createReadStream(filePath, { encoding: 'utf8', highWaterMark: CHUNK_BYTES })) {
    buffer += chunk as string;
    let cursor = 0;
    for (;;) {
      OPEN_ELEMENT.lastIndex = cursor;
      const open = OPEN_ELEMENT.exec(buffer);
      if (!open) break;

      const type = open[1] as OsmXmlElement['type'];
      const contentStart = open.index + open[0].length;

      if (open[3] === '/') {
        yield elementFrom(type, open[2], '');
        cursor = contentStart;
        continue;
      }

      const close = CLOSE_ELEMENT[type];
      close.lastIndex = contentStart;
      const closeMatch = close.exec(buffer);
      if (!closeMatch) {
        // Element is split across chunks: rewind to its start and wait for more data.
        cursor = open.index;
        break;
      }
      yield elementFrom(type, open[2], buffer.slice(contentStart, closeMatch.index));
      cursor = closeMatch.index + closeMatch[0].length;
    }

    buffer = buffer.slice(cursor);
    if (buffer.length > MAX_PENDING_BYTES) {
      throw new Error(
        `Abandoning ${filePath}: more than ${MAX_PENDING_BYTES} bytes without a complete OSM element. ` +
          'Is this really an OSM XML file?',
      );
    }
  }
}

export function isFoodPlace(tags: Record<string, string>): boolean {
  for (const key of Object.keys(tags)) {
    if (GONE_PREFIXES.some((prefix) => key.startsWith(prefix))) return false;
  }
  const amenity = tags.amenity?.trim().toLowerCase() ?? '';
  const shop = tags.shop?.trim().toLowerCase() ?? '';
  if (amenity && GONE_PREFIXES.some((prefix) => amenity.startsWith(prefix))) return false;
  if (FOOD_AMENITIES.has(amenity)) return true;
  if (DRINKING_AMENITIES.has(amenity)) return Boolean(tags.cuisine?.trim());
  if (FOOD_SHOPS.has(shop)) return true;
  return false;
}

const pick = (tags: Record<string, string>, keys: string[]): string | null => {
  for (const key of keys) {
    const value = tags[key]?.trim();
    if (value) return value;
  }
  return null;
};

const CITY_KEYS = [
  'addr:city', 'addr:town', 'addr:village', 'addr:hamlet', 'addr:suburb',
  'addr:quarter', 'addr:neighbourhood', 'addr:place',
];

export interface OsmAdapterOptions {
  /** Drop elements outside this country. Compared against `addr:country` when the element has one. */
  countryFilter?: string;
  /** Hard cap on elements yielded, so an oversized extract cannot run away. */
  maxElements?: number;
}

export interface OsmAdapter extends DiscoveryAdapter {
  readonly id: 'osm-xml';
  stats: Record<string, number>;
}

export function createOsmXmlAdapter(options: OsmAdapterOptions = {}): OsmAdapter {
  const stats: Record<string, number> = {
    elementsScanned: 0,
    notFoodPlaces: 0,
    unnamed: 0,
    noCountry: 0,
    outsideCountryFilter: 0,
    yielded: 0,
  };

  return {
    id: 'osm-xml',
    stats,
    async *stream(filePath: string): AsyncGenerator<RawDiscoveryRecord, void, undefined> {
      for await (const element of streamOsmElements(filePath)) {
        stats.elementsScanned += 1;
        if (options.maxElements !== undefined && stats.yielded >= options.maxElements) return;
        if (!isFoodPlace(element.tags)) {
          stats.notFoodPlaces += 1;
          continue;
        }
        const name = element.tags.name?.trim();
        if (!name) {
          stats.unnamed += 1;
          continue;
        }

        const rawCountry = element.tags['addr:country']?.trim().toUpperCase() ?? '';
        if (!rawCountry && !options.countryFilter) {
          stats.noCountry += 1;
          continue;
        }
        if (options.countryFilter) {
          const filter = options.countryFilter.toUpperCase();
          const effective = isValidCountryCode(rawCountry) ? rawCountry : filter;
          if (effective !== filter) {
            stats.outsideCountryFilter += 1;
            continue;
          }
        }

        if (!element.id) {
          stats.unnamed += 1;
          continue;
        }

        const houseNumber = element.tags['addr:housenumber']?.trim() ?? '';
        const street = element.tags['addr:street']?.trim() ?? '';
        const addressLine = [houseNumber, street].filter(Boolean).join(' ') || null;

        stats.yielded += 1;
        yield {
          providerRecordId: `${element.type}/${element.id}`,
          name,
          countryCode: rawCountry || null,
          city: pick(element.tags, CITY_KEYS),
          region: pick(element.tags, ['addr:state', 'addr:province']),
          postalCode: element.tags['addr:postcode']?.trim() || null,
          addressLine,
          latitude: element.lat,
          longitude: element.lon,
          timezone: element.tags.timezone?.trim() || null,
          cuisines: element.tags.cuisine ? [element.tags.cuisine] : [],
          websiteUrl: pick(element.tags, ['website', 'contact:website']),
          menuUrl: pick(element.tags, ['menu', 'contact:menu', 'website:menu', 'url:menu']),
          orderingUrl: pick(element.tags, ['ordering', 'contact:ordering', 'website:ordering', 'url:ordering']),
          openingHoursRaw: element.tags.opening_hours?.trim() || null,
          sourceRecordUrl: `https://www.openstreetmap.org/${element.type}/${element.id}`,
          sourceUpdatedAt: element.timestamp,
        };
      }
    },
  };
}

/** The attribution ODbL requires when OSM data is redistributed or used to build another database. */
export const OPENSTREETMAP_SOURCE = {
  provider: 'openstreetmap',
  sourceName: 'OpenStreetMap',
  sourceUrl: 'https://www.openstreetmap.org/copyright',
  sourceLicence: 'ODbL-1.0',
  sourceAttribution: '© OpenStreetMap contributors',
} as const;
