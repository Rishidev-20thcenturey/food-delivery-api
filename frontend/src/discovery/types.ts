/**
 * Response shapes for the public discovery directory (`/api/v1/discovery/*`).
 *
 * These mirror `backend/src/modules/discovery/service.ts` exactly. They are deliberately separate from the
 * orderable catalogue types in `App.tsx`: a discovery listing is a record about a restaurant in the world,
 * not a CraveDirect merchant, and its optional prices are never INR.
 *
 * Every field the source did not report is `null`. Render `null` as a missing state — never invent a value.
 */

export type VerificationStatus = 'SOURCE_LISTED' | 'NEEDS_REVIEW' | 'VERIFIED';
export type MenuPermission = 'NONE' | 'OWNER_SUBMITTED' | 'SOURCE_PERMITTED';
export type SortOption = 'name' | 'newest' | 'updated' | 'country';

export type DiscoveryCountry = { code: string; name: string };

export type DiscoveryLinks = {
  website: string | null;
  menu: string | null;
  ordering: string | null;
};

export type DiscoveryStatus = {
  verification: VerificationStatus;
  verifiedAt: string | null;
  /** True when the data is imported and not verified. Must be labelled as source-listed, never as verified. */
  sourceListed: boolean;
};

export type DiscoveryMenuState = {
  available: boolean;
  permission: MenuPermission;
  itemCount: number;
  sampleDishes: string[];
  matchedDishes: string[];
};

export type DiscoveryOrdering = {
  /** True only when an operator linked this listing to an ACTIVE CraveDirect restaurant. */
  available: boolean;
  restaurantId: string | null;
  restaurantName: string | null;
  acceptingOrders: boolean | null;
};

export type DiscoverySource = {
  name: string;
  url: string | null;
  recordUrl: string | null;
  licence: string | null;
  attribution: string;
  updatedAt: string | null;
  importedAt: string;
};

/** A price in the source's own currency. `minorUnits` is that currency's exponent: JPY 0, EUR 2, BHD 3. */
export type DiscoveryPrice = {
  amountMinor: number;
  currency: string;
  minorUnits: number;
  isEstimated: boolean;
};

export type DiscoveryMenuItem = {
  id: string;
  name: string;
  description: string | null;
  dietaryLabels: string[];
  price: DiscoveryPrice | null;
  sourceAttribution: string | null;
};

export type DiscoveryMenuSection = {
  id: string;
  name: string;
  description: string | null;
  items: DiscoveryMenuItem[];
};

export type DiscoveryMenuPreview = {
  available: boolean;
  permission: MenuPermission;
  /** What to show instead, when no preview may be served. */
  reason: string | null;
  sections: DiscoveryMenuSection[];
};

export type DiscoveryLocation = {
  latitude: number | null;
  longitude: number | null;
  timezone: string | null;
  /** False means no local time may be implied, so no open/closed claim may be made. */
  timezoneKnown: boolean;
};

export type DiscoveryPlaceSummary = {
  id: string;
  name: string;
  country: DiscoveryCountry;
  city: string | null;
  region: string | null;
  cuisines: string[];
  links: DiscoveryLinks;
  status: DiscoveryStatus;
  menu: DiscoveryMenuState;
  ordering: DiscoveryOrdering;
  source: DiscoverySource;
};

export type DiscoveryPlaceDetail = DiscoveryPlaceSummary & {
  postalCode: string | null;
  addressLine: string | null;
  location: DiscoveryLocation;
  /** Verbatim source value, e.g. `Mo-Fr 11:00-22:00`. Never interpreted into an open/closed state. */
  openingHoursRaw: string | null;
  dataOrigin: string;
  menuPreview: DiscoveryMenuPreview;
};

export type DiscoveryFacets = {
  totals: { places: number; withMenuPreview: number; orderableThroughCravedirect: number };
  countries: Array<DiscoveryCountry & { count: number }>;
  cities: Array<{ country: DiscoveryCountry; city: string; count: number }>;
  cuisines: Array<{ cuisine: string; count: number }>;
};

export type PageMeta = { page: number; limit: number; total: number; totalPages: number };

export type DiscoveryFilters = {
  q: string;
  dish: string;
  country: string;
  city: string;
  cuisine: string[];
  sort: SortOption;
};

export const SORT_LABELS: Record<SortOption, string> = {
  name: 'Name (A–Z)',
  newest: 'Recently added',
  updated: 'Recently updated at the source',
  country: 'Country',
};

/** Kept well below the orderable catalogue's 50 so a page of discovery cards stays cheap on a free tier. */
export const PAGE_SIZE = 12;
