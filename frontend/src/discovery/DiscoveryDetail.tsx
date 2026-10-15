import { useEffect, useRef } from 'react';
import type { DiscoveryPlaceDetail } from './types';
import {
  EXTERNAL_LINK_PROPS,
  absoluteDate,
  addressLines,
  cuisineSummary,
  formatDiscoveryPrice,
  freshness,
  locationLine,
  officialLinks,
  openingHoursNote,
  orderableLabel,
  safeExternalUrl,
  verificationBadge,
} from './format';

/**
 * Detail view for one discovery listing.
 *
 * The point of this modal is honesty about the boundary between CraveDirect and the rest of the world:
 * what we know, who told us, when they told us, and what the visitor has to do to actually get food
 * (which, unless the listing is orderable, is to leave this site).
 */
export default function DiscoveryDetail({
  place,
  onClose,
  onOrder,
}: {
  place: DiscoveryPlaceDetail;
  onClose: () => void;
  /** Opens the existing CraveDirect menu modal for the linked restaurant. */
  onOrder: (restaurantId: string) => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const badge = verificationBadge(place);
  const links = officialLinks(place);
  const source = freshness(place.source);
  const hours = openingHoursNote(place);
  const orderable = orderableLabel(place);
  const accepting = place.ordering.acceptingOrders !== false;
  const cuisines = cuisineSummary(place);
  const preview = place.menuPreview;

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const sourceUrl = safeExternalUrl(place.source.url);
  const recordUrl = safeExternalUrl(place.source.recordUrl);
  const mapUrl = mapLink(place);

  return (
    <div className="overlay" onClick={onClose}>
      <section
        className="modal discovery-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="discovery-detail-title"
        onClick={(event) => event.stopPropagation()}
      >
        <button className="close-button" ref={closeRef} aria-label="Close listing" onClick={onClose}>×</button>

        <div className="modal-cover">
          <div className="modal-cover-art discovery-cover-art" aria-hidden="true"><span>⌖</span></div>
          <div>
            <div className="eyebrow small-eyebrow">GLOBAL DISCOVERY · {place.country.code}</div>
            <h2 id="discovery-detail-title">{place.name}</h2>
            <p>{cuisines ?? 'Cuisine not reported'} — {locationLine(place)}</p>
            <div className="modal-stats">
              <span className={`trust-chip trust-${badge.tone}`} title={badge.detail}>{badge.label}</span>
              {orderable && <span className="trust-chip trust-orderable">{orderable}</span>}
            </div>
          </div>
        </div>

        <div className="menu-content discovery-content">
          <p className={`discovery-notice ${orderable ? 'is-orderable' : ''}`}>
            {orderable
              ? `This listing is linked to a CraveDirect restaurant${place.ordering.restaurantName ? ` (${place.ordering.restaurantName})` : ''}, so you can order here.`
              : `This listing comes from ${place.source.name} and is published for discovery. It is not a CraveDirect merchant, so you cannot order through this app. Use the restaurant's own links below.`}
          </p>

          {orderable && (
            <button
              className="primary-button checkout-cta"
              disabled={!accepting || !place.ordering.restaurantId}
              onClick={() => place.ordering.restaurantId && onOrder(place.ordering.restaurantId)}
            >
              {accepting ? 'Open the CraveDirect menu' : 'Not accepting orders right now'} <span aria-hidden="true">↗</span>
            </button>
          )}

          {links.length > 0 && (
            <div className="discovery-link-list">
              <h3>Official links</h3>
              {links.map((link) => (
                <a key={link.key} className="discovery-link-row" href={link.href} {...EXTERNAL_LINK_PROPS}>
                  <span className="link-glyph" aria-hidden="true">↗</span>
                  <span className="link-copy">
                    <strong>{link.label}</strong>
                    <small>{link.hint}</small>
                    <em className="link-host">{hostOf(link.href)}</em>
                  </span>
                </a>
              ))}
              <p className="discovery-link-note">
                These are the restaurant's own pages, not CraveDirect pages. Nothing is embedded here — you
                leave this site in a new tab.
              </p>
            </div>
          )}

          <div className="discovery-menu-block">
            <div className="menu-heading">
              <h3>Menu</h3>
              <span>{preview.available ? 'Preview only — not orderable' : 'No preview'}</span>
            </div>

            {preview.available && preview.sections.length > 0 ? (
              <>
                <p className="discovery-currency-note">
                  Prices are shown in the restaurant's own currency, exactly as the source reported them. They
                  are not converted to INR and cannot be added to a CraveDirect cart.
                </p>
                {preview.sections.map((section) => (
                  <div className="menu-category" key={section.id}>
                    <h4>{section.name}</h4>
                    {section.items.map((item) => (
                      <div className="menu-item" key={item.id}>
                        <div className="menu-item-copy">
                          <strong>{item.name}</strong>
                          <p>{item.description || item.dietaryLabels.join(' · ') || 'No description reported.'}</p>
                          {item.sourceAttribution && <small className="item-attribution">{item.sourceAttribution}</small>}
                        </div>
                        {item.price ? <b>{formatDiscoveryPrice(item.price)}</b> : <b className="price-unknown">Price not reported</b>}
                      </div>
                    ))}
                  </div>
                ))}
              </>
            ) : (
              <div className="empty-menu discovery-empty-menu">
                <span aria-hidden="true">🍽</span>
                <p>
                  {preview.permission === 'NONE'
                    ? 'Menu not available. We are not allowed to publish this restaurant’s menu, and we will not guess at one.'
                    : preview.reason ?? 'No menu details have been published for this listing yet.'}
                </p>
                {safeExternalUrl(place.links.menu) && (
                  <a className="secondary-button" href={safeExternalUrl(place.links.menu)!} {...EXTERNAL_LINK_PROPS}>
                    Open the official menu <span aria-hidden="true">↗</span>
                  </a>
                )}
              </div>
            )}
          </div>

          <div className="discovery-facts">
            <h3>What we know</h3>
            <dl>
              <div><dt>Location</dt><dd>{addressLines(place).join(', ')}</dd></div>
              <div><dt>Country</dt><dd>{place.country.name} ({place.country.code})</dd></div>
              <div>
                <dt>Opening hours</dt>
                <dd>{hours ? <><code>{hours.raw}</code><small>{hours.caveat}</small></> : 'Not reported. We never guess whether a place is open.'}</dd>
              </div>
              <div>
                <dt>Timezone</dt>
                <dd>{place.location.timezoneKnown ? place.location.timezone : 'Not known, so no local time is shown.'}</dd>
              </div>
              <div>
                <dt>Coordinates</dt>
                <dd>
                  {place.location.latitude !== null && place.location.longitude !== null ? (
                    <>
                      {place.location.latitude.toFixed(5)}, {place.location.longitude.toFixed(5)}
                      {mapUrl && <a href={mapUrl} {...EXTERNAL_LINK_PROPS}>View on OpenStreetMap <span aria-hidden="true">↗</span></a>}
                    </>
                  ) : 'Not reported by the source.'}
                </dd>
              </div>
              <div><dt>Listed as</dt><dd>{dataOriginLabel(place.dataOrigin)}</dd></div>
            </dl>
          </div>

          <div className="discovery-provenance">
            <h3>Where this came from</h3>
            <p className="attribution-line">
              {sourceUrl ? <a href={sourceUrl} {...EXTERNAL_LINK_PROPS}>{source.attribution} <span aria-hidden="true">↗</span></a> : source.attribution}
              {source.licence && <span className="licence-chip">{source.licence}</span>}
            </p>
            <p className="freshness-line">
              Imported into CraveDirect {source.added ? source.added : absoluteDate(place.source.importedAt)}
              {' · '}
              {source.updated ? `source record updated ${source.updated}` : 'source update time not reported'}
            </p>
            {recordUrl && (
              <p className="freshness-line">
                <a href={recordUrl} {...EXTERNAL_LINK_PROPS}>Check this record at the source <span aria-hidden="true">↗</span></a>
              </p>
            )}
            <p className="provenance-note">
              Discovery listings are published from open data and are not confirmed by the restaurants
              themselves unless they are marked verified. If something is wrong, the source record above is
              the place to fix it.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}

function dataOriginLabel(origin: string): string {
  if (origin === 'OWNER_SUBMITTED') return 'Submitted by the restaurant';
  if (origin === 'PARTNER_FEED') return 'Supplied by an authorised partner feed';
  return 'Imported from an open data source';
}

function hostOf(href: string): string {
  try {
    return new URL(href).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Built from range-checked coordinates. Never from a URL the source supplied. */
function mapLink(place: DiscoveryPlaceDetail): string | null {
  const { latitude, longitude } = place.location;
  if (latitude === null || longitude === null) return null;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  return `https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=17/${latitude}/${longitude}`;
}
