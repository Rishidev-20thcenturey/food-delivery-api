import type { DiscoveryPlaceSummary } from './types';
import {
  EXTERNAL_LINK_PROPS,
  cuisineSummary,
  fallbackArt,
  freshness,
  locationLine,
  menuNote,
  officialLinks,
  orderableLabel,
  verificationBadge,
} from './format';

/**
 * One discovery listing.
 *
 * The card is an `<article>` with a real heading and real anchors, not one big button: a card that both opens
 * a detail view and contains external links cannot be a single `<button>` (nested interactive content is
 * invalid HTML and unreadable to screen readers).
 *
 * It shows no rating, no price range, and no open/closed state, because the sources do not provide them.
 * What it does show is where the data came from and whether anyone has confirmed it.
 */
export default function DiscoveryCard({
  place,
  onOpen,
}: {
  place: DiscoveryPlaceSummary;
  onOpen: (placeId: string) => void;
}) {
  const art = fallbackArt(place);
  const badge = verificationBadge(place);
  const links = officialLinks(place);
  const source = freshness(place.source);
  const cuisines = cuisineSummary(place);
  const orderable = orderableLabel(place);
  const matched = place.menu.matchedDishes;
  const headingId = `discovery-place-${place.id}`;

  return (
    <article className="discovery-card" aria-labelledby={headingId}>
      <div className={`discovery-art art-${art.index}`}>
        <span className="art-orb" aria-hidden="true" />
        <span className="art-food" aria-hidden="true">{art.glyph}</span>
        <span className="art-line" aria-hidden="true">{art.label}</span>
        <span className={`discovery-flag ${orderable ? 'flag-orderable' : 'flag-discover'}`}>
          {orderable ? 'ORDER ON CRAVEDIRECT' : 'DISCOVER'}
        </span>
        <span className={`trust-chip trust-${badge.tone}`} title={badge.detail}>{badge.label}</span>
      </div>

      <div className="discovery-body">
        <h3 className="discovery-name" id={headingId}>
          <button type="button" onClick={() => onOpen(place.id)} aria-label={`View details for ${place.name}, ${locationLine(place)}`}>
            {place.name}
          </button>
        </h3>
        <p className="discovery-where">
          <span className="pin" aria-hidden="true">⌖</span>
          {locationLine(place)}
        </p>
        {cuisines && <p className="discovery-cuisines">{cuisines}</p>}

        {matched.length > 0 && (
          <p className="discovery-match">
            <span aria-hidden="true">✦</span> Dishes found: {matched.join(', ')}
          </p>
        )}

        <p className="discovery-menu" data-available={place.menu.available ? 'yes' : 'no'}>
          <span aria-hidden="true">{place.menu.available ? '🍽' : '⌁'}</span> {menuNote(place)}
        </p>

        {links.length > 0 && (
          <div className="discovery-links">
            {links.map((link) => (
              <a key={link.key} href={link.href} {...EXTERNAL_LINK_PROPS} title={link.hint}>
                {link.label.replace('Official ', '')} <span aria-hidden="true">↗</span>
                <span className="sr-only"> ({link.hint})</span>
              </a>
            ))}
          </div>
        )}

        <div className="discovery-source">
          <span className="source-line">
            {badge.tone === 'verified' ? 'Restaurant verified' : `Source-listed · ${place.source.name}`}
            {source.added && ` · added ${source.added}`}
          </span>
          <span className="attribution-line">{source.attribution}</span>
        </div>
      </div>
    </article>
  );
}
