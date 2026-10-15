import { z } from 'zod';
import { idParams } from '../../validators/common.js';
import { canonicalCuisineLabel, isValidCountryCode } from './reference-data.js';

/**
 * Conservative page bounds for the public discovery endpoints. The directory is read by anonymous
 * visitors on a free-tier Node process in front of a small PostgreSQL database, so the maximum page is
 * smaller than the transactional catalogue's and deep offsets are rejected outright.
 */
export const DISCOVERY_DEFAULT_PAGE_SIZE = 12;
export const DISCOVERY_MAX_PAGE_SIZE = 24;
export const DISCOVERY_MAX_PAGE = 500;

export const discoveryPageQuery = z.object({
  page: z.coerce
    .number()
    .int('page must be a whole number.')
    .min(1)
    .max(DISCOVERY_MAX_PAGE, `page must be ${DISCOVERY_MAX_PAGE} or less.`)
    .default(1),
  limit: z.coerce
    .number()
    .int('limit must be a whole number.')
    .min(1)
    .max(DISCOVERY_MAX_PAGE_SIZE, `limit must be ${DISCOVERY_MAX_PAGE_SIZE} or less.`)
    .default(DISCOVERY_DEFAULT_PAGE_SIZE),
});

const countryCode = z
  .string()
  .trim()
  .length(2, 'country must be an ISO 3166-1 alpha-2 code, for example "JP".')
  .transform((value) => value.toUpperCase())
  .refine(isValidCountryCode, { message: 'country is not a recognised ISO 3166-1 alpha-2 code.' });

const freeText = (max: number, label: string) =>
  z.string().trim().min(1, `${label} must not be empty.`).max(max, `${label} is too long.`);

const booleanFlag = z.enum(['true', 'false']).transform((value) => value === 'true');

/**
 * Up to three cuisines, comma separated. Values are canonicalised the same way the importer canonicalises
 * them, so the filter can be answered from the GIN index instead of scanning and folding case per row.
 */
const cuisineFilter = freeText(180, 'cuisine').transform((value) =>
  [...new Set(value.split(',').map((part) => part.trim()).filter(Boolean).map(canonicalCuisineLabel))]
    .filter(Boolean)
    .slice(0, 3),
);

export const discoveryListQuery = discoveryPageQuery.extend({
  q: freeText(80, 'q').optional(),
  dish: freeText(80, 'dish').optional(),
  country: countryCode.optional(),
  city: freeText(120, 'city').optional(),
  region: freeText(120, 'region').optional(),
  cuisine: cuisineFilter.optional(),
  hasMenu: booleanFlag.optional(),
  orderable: booleanFlag.optional(),
  sort: z.enum(['name', 'newest', 'updated', 'country']).default('name'),
});

export const discoveryPlaceParams = idParams('placeId');

export type DiscoveryListQuery = z.infer<typeof discoveryListQuery>;
