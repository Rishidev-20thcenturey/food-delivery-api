import type {
  DiscoveryFacets,
  DiscoveryFilters,
  DiscoveryPlaceDetail,
  DiscoveryPlaceSummary,
  PageMeta,
} from './types';
import { PAGE_SIZE } from './types';

/**
 * Read-only client for the public discovery directory.
 *
 * Requests are relative (`/api/v1/...`) so the same code works behind the Vite dev proxy, the Netlify Edge
 * Function, and any other host — the browser never talks to `localhost` or to the API origin directly.
 * No discovery endpoint needs an account, so nothing here sends credentials or an Authorization header.
 *
 * `api<T>()` in `App.tsx` is module-private and is tied to the authenticated order flow, so this file keeps
 * its own small helper rather than changing existing code.
 */

const API = '/api/v1';

/** Render's free tier sleeps when idle, so the first request can take a while. Fail with a retryable message. */
const REQUEST_TIMEOUT_MS = 25_000;

export type DiscoveryListResult = { data: DiscoveryPlaceSummary[]; meta: PageMeta };

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });

  let response: Response;
  try {
    response = await fetch(`${API}${path}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(
      error instanceof DOMException && error.name === 'AbortError'
        ? 'The directory took too long to answer. It may be waking up — please try again.'
        : 'Could not reach the discovery directory. Check your connection and try again.',
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }

  const body = (await response.json().catch(() => null)) as
    | { data?: unknown; meta?: PageMeta; error?: { message?: string; code?: string } }
    | null;

  if (!response.ok) {
    if (response.status === 503) {
      throw new Error('The discovery service is waking up. Please try again in a moment.');
    }
    throw new Error(
      body?.error?.message ?? `The directory could not answer this request (${response.status}).`,
    );
  }

  return { data: body?.data, meta: body?.meta } as unknown as T;
}

function toQuery(filters: DiscoveryFilters, page: number, limit: number): string {
  const params = new URLSearchParams({ page: String(page), limit: String(limit), sort: filters.sort });
  const q = filters.q.trim();
  const dish = filters.dish.trim();
  const city = filters.city.trim();
  if (q) params.set('q', q.slice(0, 80));
  if (dish) params.set('dish', dish.slice(0, 80));
  if (filters.country) params.set('country', filters.country);
  if (city) params.set('city', city.slice(0, 120));
  if (filters.cuisine.length) params.set('cuisine', filters.cuisine.slice(0, 3).join(','));
  return params.toString();
}

export async function fetchPlaces(
  filters: DiscoveryFilters,
  page: number,
  signal?: AbortSignal,
): Promise<DiscoveryListResult> {
  return getJson<DiscoveryListResult>(
    `/discovery/places?${toQuery(filters, page, PAGE_SIZE)}`,
    signal,
  );
}

export async function fetchPlace(placeId: string, signal?: AbortSignal): Promise<DiscoveryPlaceDetail> {
  return getJson<{ data: DiscoveryPlaceDetail }>(
    `/discovery/places/${encodeURIComponent(placeId)}`,
    signal,
  ).then((envelope) => envelope.data);
}

export async function fetchFacets(signal?: AbortSignal): Promise<DiscoveryFacets> {
  return getJson<{ data: DiscoveryFacets }>('/discovery/facets', signal).then(
    (envelope) => envelope.data,
  );
}
