import type { DiscoveryPlaceDetail, DiscoveryPlaceSummary, DiscoveryPrice, DiscoverySource } from './types';

/**
 * Presentation helpers for the discovery directory.
 *
 * Every function here is deliberately conservative: when the data does not support a claim, it returns
 * nothing rather than something plausible. That is why there is no `isOpen()`, no `rating()`, and no
 * `priceRange()` — the sources in this release do not provide them reliably, and inventing them would mislead
 * visitors about restaurants that have never heard of CraveDirect.
 */

const MAX_VISIBLE_CUISINES = 4;

/**
 * Only `http` and `https` may ever be rendered as a link. The API already rejects everything else, and the
 * database constrains it too; this is the last line of defence before a value reaches an `href`, so a
 * `javascript:` or `data:` URL can never be handed to the browser.
 */
export function safeExternalUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Shared props for every outbound link: new tab, no reverse-tab-nabbing, no referrer leakage. */
export const EXTERNAL_LINK_PROPS = { target: '_blank', rel: 'noopener noreferrer' } as const;

export type OfficialLink = {
  key: 'website' | 'menu' | 'ordering';
  label: string;
  href: string;
  /** Short honest description of what the visitor is leaving CraveDirect for. */
  hint: string;
};

/** Official links only — never a directory listing, never a search-engine result, never an invented URL. */
export function officialLinks(place: DiscoveryPlaceSummary): OfficialLink[] {
  const candidates: Array<[OfficialLink['key'], string, string]> = [
    ['website', 'Official website', "Opens the restaurant's own website in a new tab."],
    ['menu', 'Official menu', "Opens the restaurant's own menu page in a new tab."],
    ['ordering', 'Official ordering page', "Opens the restaurant's own ordering page. This is not a CraveDirect order."],
  ];
  const links: OfficialLink[] = [];
  for (const [key, label, hint] of candidates) {
    const href = safeExternalUrl(place.links[key]);
    if (href) links.push({ key, label, href, hint });
  }
  return links;
}

export type VerificationBadge = {
  tone: 'verified' | 'review' | 'listed';
  label: string;
  /** Full explanation for a tooltip / detail view. */
  detail: string;
};

/**
 * Source-listed data is never labelled owner-verified. `VERIFIED` is the only state that may claim
 * confirmation, and it always carries the date it was confirmed.
 */
export function verificationBadge(place: DiscoveryPlaceSummary): VerificationBadge {
  if (place.status.verification === 'VERIFIED') {
    return {
      tone: 'verified',
      label: 'Restaurant verified',
      detail: `Confirmed for CraveDirect${place.status.verifiedAt ? ` on ${absoluteDate(place.status.verifiedAt)}` : ''}.`,
    };
  }
  if (place.status.verification === 'NEEDS_REVIEW') {
    return {
      tone: 'review',
      label: 'Information needs verification',
      detail: `Listed from ${place.source.name} and flagged for review by our team.`,
    };
  }
  return {
    tone: 'listed',
    label: 'Source-listed information',
    detail: `Published as reported by ${place.source.name}. The restaurant has not confirmed it, so details may be out of date.`,
  };
}

/** City, region, and country — skipping whatever is missing rather than padding with placeholders. */
export function locationLine(place: DiscoveryPlaceSummary | DiscoveryPlaceDetail): string {
  const parts: string[] = [];
  if (place.city) parts.push(place.city);
  if (place.region && place.region !== place.city) parts.push(place.region);
  const local = parts.join(', ');
  return local ? `${local} · ${place.country.name}` : place.country.name;
}

export function cuisineSummary(place: DiscoveryPlaceSummary): string | null {
  if (!place.cuisines.length) return null;
  const visible = place.cuisines.slice(0, MAX_VISIBLE_CUISINES).join(' · ');
  const extra = place.cuisines.length - MAX_VISIBLE_CUISINES;
  return extra > 0 ? `${visible} +${extra}` : visible;
}

/**
 * Formats a discovery price in the currency the source reported, using that currency's own exponent.
 * `980/JPY/0` is ¥980, `850/EUR/2` is €8.50, `4500/BHD/3` is BD 4.500.
 * Nothing is ever converted to INR: these prices play no part in cart or checkout pricing.
 */
export function formatDiscoveryPrice(price: DiscoveryPrice): string {
  const exponent = Math.max(0, Math.min(4, Math.trunc(price.minorUnits)));
  const amount = price.amountMinor / 10 ** exponent;
  const suffix = price.isEstimated ? ' (estimated)' : '';
  try {
    const formatted = new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: price.currency,
      minimumFractionDigits: exponent,
      maximumFractionDigits: exponent,
    }).format(amount);
    return `${formatted}${suffix}`;
  } catch {
    // An unknown ISO code makes Intl throw. Show the raw figures rather than a wrong-looking number.
    return `${price.currency} ${amount.toFixed(exponent)}${suffix}`;
  }
}

export function absoluteDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'date not reported';
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Coarse relative time. Never claims a precision the source data does not have. */
export function relativeTime(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const minutes = Math.round((Date.now() - date.getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.round(hours / 24);
  if (days < 31) return `${days} ${days === 1 ? 'day' : 'days'} ago`;
  const months = Math.round(days / 30.44);
  if (months < 12) return `${months} ${months === 1 ? 'month' : 'months'} ago`;
  return absoluteDate(iso);
}

export type Freshness = { added: string | null; updated: string | null; attribution: string; licence: string | null };

/** Provenance and freshness, which must be shown wherever source data is displayed. */
export function freshness(source: DiscoverySource): Freshness {
  return {
    added: relativeTime(source.importedAt),
    updated: source.updatedAt ? relativeTime(source.updatedAt) : null,
    attribution: source.attribution || source.name,
    licence: source.licence,
  };
}

/**
 * Opening hours are the source's own string, shown verbatim with an explicit caveat. Without a trustworthy
 * timezone we never say whether a place is open, because a visitor acting on a wrong "open now" is worse
 * than being told we do not know.
 */
export function openingHoursNote(place: DiscoveryPlaceDetail): { raw: string; caveat: string } | null {
  if (!place.openingHoursRaw) return null;
  const caveat = place.location.timezoneKnown
    ? `Reported hours, unverified. Local timezone: ${place.location.timezone}.`
    : 'Reported hours, unverified. The timezone for this place is not known, so we cannot tell you whether it is open right now.';
  return { raw: place.openingHoursRaw, caveat };
}

/** What the menu area may honestly say. */
export function menuNote(place: DiscoveryPlaceSummary): string {
  if (place.menu.permission === 'NONE') return 'Menu not available';
  if (!place.menu.available) return 'Menu details are being checked';
  return `Menu preview · ${place.menu.itemCount} ${place.menu.itemCount === 1 ? 'dish' : 'dishes'}`;
}

/** Deterministic fallback art: the API stores URLs, not images, so cards use a tasteful generated pattern. */
export function fallbackArt(place: DiscoveryPlaceSummary): { index: number; glyph: string; label: string } {
  const glyphs = ['🍜', '🥘', '🍞', '🍣', '🥗', '🍰'];
  let hash = 0;
  for (const char of `${place.country.code}:${place.name}`) hash = (hash * 31 + char.codePointAt(0)!) % 100_003;
  const index = hash % glyphs.length;
  return { index, glyph: glyphs[index], label: (place.cuisines[0] ?? 'Discovered kitchen').toUpperCase() };
}

export function addressLines(place: DiscoveryPlaceDetail): string[] {
  const lines: string[] = [];
  if (place.addressLine) lines.push(place.addressLine);
  const locality = [place.city, place.region].filter((part): part is string => Boolean(part)).join(', ');
  if (locality) lines.push(locality);
  // Country-specific postal strings. Not a six-digit Indian PIN — those belong to the order flow.
  if (place.postalCode) lines.push(place.postalCode);
  lines.push(place.country.name);
  return lines;
}

/** Whether this listing can take a CraveDirect order. Only an explicit operator link makes this true. */
export function orderableLabel(place: DiscoveryPlaceSummary): string | null {
  if (!place.ordering.available || !place.ordering.restaurantId) return null;
  if (place.ordering.acceptingOrders === false) return 'On CraveDirect · not accepting orders right now';
  return 'Orderable on CraveDirect';
}
