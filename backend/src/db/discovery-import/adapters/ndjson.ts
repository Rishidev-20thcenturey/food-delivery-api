import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { DiscoveryAdapter, RawDiscoveryMenu, RawDiscoveryRecord } from '../types.js';

/**
 * NDJSON adapter: one JSON object per line, in the canonical `RawDiscoveryRecord` shape.
 *
 * This is the extension point for every non-OSM source — Wikidata structured facts, a municipal open
 * dataset, restaurant-submitted listings, and authorised menu feeds. Each of those has its own licence and
 * its own terms, so each one gets its own small converter that writes NDJSON plus its own
 * `SourceDescriptor`. The importer, the normaliser, the safeguards, and the API never change.
 *
 * Lines are streamed, so the file size is not bounded by memory. Blank lines and `//` comments are skipped
 * so an operator can annotate a hand-built file.
 */

export const MAX_LINE_BYTES = 256 * 1024;

const isText = (value: unknown): value is string => typeof value === 'string';
const optionalText = (value: unknown): string | null => (isText(value) && value.trim() ? value : null);
const optionalNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

function optionalMenu(value: unknown): RawDiscoveryMenu | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as { permission?: unknown; sections?: unknown };
  if (candidate.permission !== 'OWNER_SUBMITTED' && candidate.permission !== 'SOURCE_PERMITTED') return null;
  if (!Array.isArray(candidate.sections)) return null;
  return { permission: candidate.permission, sections: candidate.sections as RawDiscoveryMenu['sections'] };
}

export interface NdjsonAdapterOptions {
  /** Hard cap on records yielded, so an oversized file cannot run away. */
  maxRecords?: number;
}

export interface NdjsonAdapter extends DiscoveryAdapter {
  readonly id: 'ndjson';
  stats: Record<string, number>;
}

export function createNdjsonAdapter(options: NdjsonAdapterOptions = {}): NdjsonAdapter {
  const stats: Record<string, number> = { linesRead: 0, blankOrComment: 0, malformedJson: 0, wrongShape: 0, yielded: 0 };

  return {
    id: 'ndjson',
    stats,
    async *stream(filePath: string): AsyncGenerator<RawDiscoveryRecord, void, undefined> {
      const lines = createInterface({
        input: createReadStream(filePath, { encoding: 'utf8', highWaterMark: 64 * 1024 }),
        crlfDelay: Number.POSITIVE_INFINITY,
      });

      for await (const line of lines) {
        if (options.maxRecords !== undefined && stats.yielded >= options.maxRecords) {
          lines.close();
          return;
        }
        stats.linesRead += 1;
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('//')) {
          stats.blankOrComment += 1;
          continue;
        }
        if (trimmed.length > MAX_LINE_BYTES) {
          stats.wrongShape += 1;
          continue;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          stats.malformedJson += 1;
          continue;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          stats.wrongShape += 1;
          continue;
        }

        const raw = parsed as Record<string, unknown>;
        if (!isText(raw.providerRecordId) || !isText(raw.name)) {
          stats.wrongShape += 1;
          continue;
        }

        stats.yielded += 1;
        yield {
          providerRecordId: raw.providerRecordId,
          name: raw.name,
          countryCode: optionalText(raw.countryCode),
          city: optionalText(raw.city),
          region: optionalText(raw.region),
          postalCode: optionalText(raw.postalCode),
          addressLine: optionalText(raw.addressLine),
          latitude: optionalNumber(raw.latitude),
          longitude: optionalNumber(raw.longitude),
          timezone: optionalText(raw.timezone),
          cuisines: Array.isArray(raw.cuisines) ? (raw.cuisines.filter(isText) as string[]) : [],
          websiteUrl: optionalText(raw.websiteUrl),
          menuUrl: optionalText(raw.menuUrl),
          orderingUrl: optionalText(raw.orderingUrl),
          openingHoursRaw: optionalText(raw.openingHoursRaw),
          sourceRecordUrl: optionalText(raw.sourceRecordUrl),
          sourceUpdatedAt: optionalText(raw.sourceUpdatedAt),
          menu: optionalMenu(raw.menu),
        };
      }
    },
  };
}
