import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  DiscoveryFacets,
  DiscoveryFilters,
  DiscoveryPlaceDetail,
  DiscoveryPlaceSummary,
  PageMeta,
  SortOption,
} from './types';
import { SORT_LABELS } from './types';
import { fetchFacets, fetchPlace, fetchPlaces } from './api';
import DiscoveryCard from './DiscoveryCard';
import DiscoveryDetail from './DiscoveryDetail';

/**
 * The global discovery section of the homepage.
 *
 * It sits alongside — never inside — the orderable catalogue. Everything here is public and read-only, and
 * the UI keeps the boundary obvious: a listing can only be ordered when an operator has linked it to a real
 * CraveDirect restaurant, which renders the orange "Order on CraveDirect" flag instead of the green
 * "Discover" one.
 */

const EMPTY_FILTERS: DiscoveryFilters = { q: '', dish: '', country: '', city: '', cuisine: [], sort: 'name' };
const MAX_CUISINE_FILTERS = 3;
const DEBOUNCE_MS = 320;

const messageOf = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

function isUntouched(filters: DiscoveryFilters): boolean {
  return (
    !filters.q.trim() &&
    !filters.dish.trim() &&
    !filters.country &&
    !filters.city.trim() &&
    filters.cuisine.length === 0 &&
    filters.sort === 'name'
  );
}

export default function DiscoveryPanel({
  onOrderRestaurant,
}: {
  /** Opens the existing CraveDirect menu modal for a linked restaurant id. */
  onOrderRestaurant: (restaurantId: string) => Promise<void> | void;
}) {
  const [draft, setDraft] = useState<DiscoveryFilters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<DiscoveryFilters>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [places, setPlaces] = useState<DiscoveryPlaceSummary[]>([]);
  const [meta, setMeta] = useState<PageMeta | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'loading-more' | 'error'>('loading');
  const [error, setError] = useState('');
  const [facets, setFacets] = useState<DiscoveryFacets | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DiscoveryPlaceDetail | null>(null);
  const [detailError, setDetailError] = useState('');
  const [retryToken, setRetryToken] = useState(0);
  const [detailRetry, setDetailRetry] = useState(0);
  const resultsRef = useRef<HTMLDivElement>(null);
  const firstDraftRun = useRef(true);

  /* ---- bounded filter values that actually have coverage ---- */
  useEffect(() => {
    const controller = new AbortController();
    fetchFacets(controller.signal)
      .then((result) => setFacets(result))
      .catch(() => setFacets(null)); // Without facets the inputs stay free-text; the section still works.
    return () => controller.abort();
  }, [retryToken]);

  /* ---- debounce text inputs, apply everything else immediately ---- */
  useEffect(() => {
    // The first run must not refetch: `applied` already equals the untouched draft, and a duplicate request
    // against a sleeping free-tier backend would double the cold-start wait.
    if (firstDraftRun.current) {
      firstDraftRun.current = false;
      return;
    }
    const timer = window.setTimeout(() => {
      setApplied(draft);
      setPage(1);
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [draft]);

  /* ---- one request per filter/page change, cancelled when it is superseded ---- */
  useEffect(() => {
    const controller = new AbortController();
    setStatus(page === 1 ? 'loading' : 'loading-more');
    setError('');
    fetchPlaces(applied, page, controller.signal)
      .then((result) => {
        setMeta(result.meta);
        setPlaces((previous) => {
          if (page === 1) return result.data;
          const seen = new Set(previous.map((place) => place.id));
          return [...previous, ...result.data.filter((place) => !seen.has(place.id))];
        });
        setStatus('idle');
      })
      .catch((requestError) => {
        if (controller.signal.aborted) return;
        setError(messageOf(requestError, 'Could not load the discovery directory.'));
        setStatus('error');
      });
    return () => controller.abort();
  }, [applied, page, retryToken]);

  /* ---- detail view ---- */
  useEffect(() => {
    if (!detailId) {
      setDetail(null);
      return;
    }
    const controller = new AbortController();
    setDetail(null);
    setDetailError('');
    fetchPlace(detailId, controller.signal)
      .then((result) => setDetail(result))
      .catch((requestError) => {
        if (controller.signal.aborted) return;
        setDetailError(messageOf(requestError, 'This listing could not be loaded.'));
      });
    return () => controller.abort();
  }, [detailId, detailRetry]);

  const update = useCallback((patch: Partial<DiscoveryFilters>) => {
    setDraft((previous) => ({ ...previous, ...patch }));
  }, []);

  const toggleCuisine = useCallback((cuisine: string) => {
    setDraft((previous) => {
      const selected = previous.cuisine.includes(cuisine)
        ? previous.cuisine.filter((item) => item !== cuisine)
        : [...previous.cuisine, cuisine].slice(0, MAX_CUISINE_FILTERS);
      return { ...previous, cuisine: selected };
    });
  }, []);

  const reset = useCallback(() => {
    setDraft(EMPTY_FILTERS);
    setApplied(EMPTY_FILTERS);
    setPage(1);
  }, []);

  const reload = useCallback(() => setRetryToken((token) => token + 1), []);

  const cityOptions = useMemo(() => {
    const cities = facets?.cities ?? [];
    return cities
      .filter((entry) => !draft.country || entry.country.code === draft.country)
      .slice(0, 40)
      .map((entry) => (draft.country ? entry.city : `${entry.city} (${entry.country.name})`));
  }, [facets, draft.country]);

  const cuisineOptions = useMemo(() => (facets?.cuisines ?? []).slice(0, 14), [facets]);
  const untouched = isUntouched(draft);
  const loading = status === 'loading';
  const total = meta?.total ?? 0;
  const canLoadMore = Boolean(meta) && page < Math.min(meta!.totalPages, 500);
  const noCoverageYet = total === 0 && untouched && (facets?.totals.places ?? 0) === 0;

  /* Aggregate attribution for whatever is on screen — required by ODbL and by plain fairness. */
  const attributions = useMemo(() => {
    const seen = new Map<string, { attribution: string; licence: string | null; url: string | null }>();
    for (const place of places) {
      if (!seen.has(place.source.name)) {
        seen.set(place.source.name, {
          attribution: place.source.attribution,
          licence: place.source.licence,
          url: place.source.url,
        });
      }
    }
    return [...seen.entries()];
  }, [places]);

  const announce = loading
    ? 'Searching the global directory…'
    : status === 'error'
      ? 'Search failed.'
      : `${total} ${total === 1 ? 'place' : 'places'} found`;

  return (
    <section className="catalogue discovery" id="discover" aria-labelledby="discovery-heading">
      <div className="section-heading">
        <div>
          <div className="eyebrow small-eyebrow">AROUND THE WORLD, ON YOUR SCREEN</div>
          <h2 id="discovery-heading">Discover food<span>, everywhere</span></h2>
          <p>
            A public directory of restaurants and cuisines worldwide, published from open data with its
            sources credited. Discovering a place and ordering from it are two different things: only listings
            marked <strong>Order on CraveDirect</strong> can be ordered here.
          </p>
        </div>
        <div className="result-count" role="status" aria-live="polite">
          {announce} <span aria-hidden="true">↘</span>
        </div>
      </div>

      <div className="discovery-modes">
        <span className="mode mode-discover"><b>Discover</b><small>Browse restaurants anywhere in the world, with links to their own sites</small></span>
        <span className="mode mode-order"><b>Order</b><small>Only CraveDirect-linked restaurants, delivered in India and paid cash on delivery</small></span>
      </div>

      <form
        className="discovery-controls"
        onSubmit={(event) => {
          event.preventDefault();
          setApplied(draft);
          setPage(1);
          resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }}
      >
        <label className="control control-grow">
          <span>Search places or cuisines</span>
          <input
            value={draft.q}
            onChange={(event) => update({ q: event.target.value })}
            placeholder="Ramen, tacos, a bakery in Lisbon…"
            maxLength={80}
            autoComplete="off"
          />
        </label>
        <label className="control">
          <span>Country</span>
          <select value={draft.country} onChange={(event) => update({ country: event.target.value, city: '' })}>
            <option value="">Everywhere</option>
            {(facets?.countries ?? []).map((country) => (
              <option key={country.code} value={country.code}>
                {country.name} ({country.count})
              </option>
            ))}
          </select>
        </label>
        <label className="control">
          <span>City</span>
          <input
            value={draft.city}
            onChange={(event) => update({ city: event.target.value })}
            placeholder={draft.country ? 'Exact city name' : 'Any city'}
            maxLength={120}
            autoComplete="off"
            list="discovery-city-options"
          />
        </label>
        <label className="control">
          <span>Dish</span>
          <input
            value={draft.dish}
            onChange={(event) => update({ dish: event.target.value })}
            placeholder="Search published menus"
            maxLength={80}
            autoComplete="off"
          />
        </label>
        <label className="control">
          <span>Sort by</span>
          <select value={draft.sort} onChange={(event) => update({ sort: event.target.value as SortOption })}>
            {(Object.keys(SORT_LABELS) as SortOption[]).map((option) => (
              <option key={option} value={option}>{SORT_LABELS[option]}</option>
            ))}
          </select>
        </label>
        <datalist id="discovery-city-options">
          {cityOptions.map((city) => <option key={city} value={city} />)}
        </datalist>
        <div className="control-actions">
          <button className="primary-button" type="submit">Search <span aria-hidden="true">↗</span></button>
          <button className="secondary-button" type="button" onClick={reset} disabled={untouched && page === 1}>
            Reset filters
          </button>
        </div>
      </form>

      {cuisineOptions.length > 0 && (
        <div className="filters discovery-cuisine-row">
          <div className="category-tabs" role="group" aria-label="Filter by cuisine">
            {cuisineOptions.map((entry) => {
              const active = draft.cuisine.includes(entry.cuisine);
              return (
                <button
                  key={entry.cuisine}
                  type="button"
                  className={active ? 'category active' : 'category'}
                  aria-pressed={active}
                  disabled={!active && draft.cuisine.length >= MAX_CUISINE_FILTERS}
                  onClick={() => toggleCuisine(entry.cuisine)}
                >
                  {entry.cuisine}
                </button>
              );
            })}
          </div>
          {draft.cuisine.length >= MAX_CUISINE_FILTERS && (
            <span className="cuisine-hint">Up to three cuisines at a time.</span>
          )}
        </div>
      )}

      <div ref={resultsRef}>
        {status === 'error' && (
          <div className="empty-state discovery-error" role="alert">
            <span aria-hidden="true">⌁</span>
            <h3>We could not load the directory</h3>
            <p>{error}</p>
            <button className="primary-button" type="button" onClick={reload}>Try again <span aria-hidden="true">↗</span></button>
          </div>
        )}

        {loading && (
          <div className="restaurant-grid discovery-grid" aria-hidden="true">
            {[1, 2, 3, 4, 5, 6].map((n) => (
              <div className="restaurant-skeleton" key={n}><div /><span /><span /></div>
            ))}
          </div>
        )}

        {!loading && status !== 'error' && places.length > 0 && (
          <>
            <div className="restaurant-grid discovery-grid">
              {places.map((place) => <DiscoveryCard key={place.id} place={place} onOpen={setDetailId} />)}
            </div>
            <div className="discovery-pager">
              {canLoadMore ? (
                <button
                  className="secondary-button"
                  type="button"
                  disabled={status === 'loading-more'}
                  onClick={() => setPage((current) => current + 1)}
                >
                  {status === 'loading-more' ? 'Loading more…' : `Show more places (${places.length} of ${total})`}
                </button>
              ) : (
                <p className="pager-end">
                  {places.length >= total
                    ? `That is every place matching your search (${total}).`
                    : 'Showing the first pages of this search. Narrow your filters to see more.'}
                </p>
              )}
            </div>
          </>
        )}

        {!loading && status !== 'error' && places.length === 0 && (
          <div className="empty-state">
            <span aria-hidden="true">{noCoverageYet ? '✳' : '⌕'}</span>
            {noCoverageYet ? (
              <>
                <h3>No global listings yet</h3>
                <p>
                  The discovery directory is empty because no open-data region has been imported into it yet.
                  We will not invent restaurants to fill the space. Meanwhile, the orderable catalogue above
                  has real CraveDirect restaurants, and you can pick a different country or city here to check
                  again later.
                </p>
                <div className="empty-actions">
                  <button className="primary-button" type="button" onClick={() => document.getElementById('restaurants')?.scrollIntoView({ behavior: 'smooth' })}>
                    Browse CraveDirect restaurants <span aria-hidden="true">↗</span>
                  </button>
                  <button className="secondary-button" type="button" onClick={reload}>Check the directory again</button>
                </div>
              </>
            ) : (
              <>
                <h3>Nothing matches those filters</h3>
                <p>
                  We found {total} {total === 1 ? 'place' : 'places'} for that combination. Try a broader
                  search, clear the country or city, or pick another location — coverage varies by region
                  because it depends on the open data available there.
                </p>
                <div className="empty-actions">
                  <button className="secondary-button" type="button" onClick={reset}>Clear all filters</button>
                  <button className="secondary-button" type="button" onClick={() => document.getElementById('restaurants')?.scrollIntoView({ behavior: 'smooth' })}>
                    Order on CraveDirect instead
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {attributions.length > 0 && (
        <div className="discovery-attribution">
          <span className="attribution-heading">Data and attribution</span>
          {attributions.map(([name, source]) => (
            <span key={name} className="attribution-entry">
              {source.url ? (
                <a href={source.url} target="_blank" rel="noopener noreferrer">{source.attribution}</a>
              ) : (
                source.attribution
              )}
              {source.licence && <em>{source.licence}</em>}
            </span>
          ))}
          <span className="attribution-note">
            Listings are published as reported by their sources and are not confirmed by the restaurants.
            Nothing here is fetched, scraped, or rewritten by CraveDirect at request time.
          </span>
        </div>
      )}

      {detailId && (
        detailError ? (
          <div className="overlay" onClick={() => setDetailId(null)}>
            <section className="modal discovery-modal" role="dialog" aria-modal="true" aria-label="Listing unavailable" onClick={(event) => event.stopPropagation()}>
              <div className="empty-state">
                <span aria-hidden="true">⌁</span>
                <h3>This listing could not be opened</h3>
                <p>{detailError}</p>
                <button className="primary-button" type="button" onClick={() => setDetailRetry((token) => token + 1)}>Try again</button>
                <button className="secondary-button" type="button" onClick={() => setDetailId(null)}>Back to results</button>
              </div>
            </section>
          </div>
        ) : detail ? (
          <DiscoveryDetail
            place={detail}
            onClose={() => setDetailId(null)}
            onOrder={async (restaurantId) => {
              setDetailId(null);
              await onOrderRestaurant(restaurantId);
            }}
          />
        ) : (
          <div className="overlay">
            <section className="modal discovery-modal" role="dialog" aria-modal="true" aria-label="Loading listing">
              <div className="empty-menu"><span aria-hidden="true">✳</span><p>Loading this listing…</p></div>
            </section>
          </div>
        )
      )}
    </section>
  );
}
