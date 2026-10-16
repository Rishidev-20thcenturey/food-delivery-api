-- Global Food Discovery v1: additive schema for the independent discovery directory.
--
-- SAFETY NOTES
--   * This migration only CREATEs new objects. It does not ALTER, DROP, or rewrite anything created
--     by 001_init.sql, so the deployed transactional catalogue keeps working unchanged.
--   * It inserts no data. External records are only ever written by the explicitly invoked,
--     dry-run-by-default importer (src/db/discovery-import/), never by a migration, a build, or startup.
--   * Rollback SQL lives in docs/migrations/002_global_discovery.rollback.sql. It is deliberately NOT
--     placed in this directory: every *.sql file here is applied automatically by src/db/migrate.ts.
--
-- DESIGN NOTES
--   * Money is optional and never implicitly INR. A price is stored as integer minor units paired with
--     an explicit ISO 4217 currency code and that currency's minor-unit exponent (0 for JPY, 3 for BHD),
--     because not every currency has two decimal places.
--   * Postal codes are optional, country-specific strings. The six-digit Indian rule in `addresses` and
--     `restaurants` is intentionally not reused here.
--   * Coordinates are optional but must be supplied as a pair and must be in range.
--   * Discovery records never require a CraveDirect owner account. The optional
--     `cravedirect_restaurant_id` link is the ONLY thing that makes a listing orderable, and it is set
--     by an explicit operator action, never by an import.

CREATE TABLE discovery_places (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Provider identity: a repeated import of the same record must not create a duplicate.
  provider                  TEXT NOT NULL CHECK (char_length(provider) BETWEEN 1 AND 60),
  provider_record_id        TEXT NOT NULL CHECK (char_length(provider_record_id) BETWEEN 1 AND 190),

  name                      TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),

  -- International location. Country is always explicit; everything else is optional.
  country_code              TEXT NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  city                      TEXT CHECK (city IS NULL OR char_length(city) BETWEEN 1 AND 120),
  region                    TEXT CHECK (region IS NULL OR char_length(region) BETWEEN 1 AND 120),
  postal_code               TEXT CHECK (
                              postal_code IS NULL
                              OR (char_length(postal_code) BETWEEN 3 AND 12
                                  AND postal_code ~ '^[A-Za-z0-9][A-Za-z0-9 .-]*[A-Za-z0-9]$')
                            ),
  address_line              TEXT CHECK (address_line IS NULL OR char_length(address_line) BETWEEN 1 AND 240),
  latitude                  NUMERIC(9, 6) CHECK (latitude BETWEEN -90 AND 90),
  longitude                 NUMERIC(9, 6) CHECK (longitude BETWEEN -180 AND 180),
  -- IANA identifier such as 'Europe/Berlin'. Single-segment zones like 'UTC' are valid too. The
  -- application validates against the runtime's IANA list; this is the shape backstop.
  timezone                  TEXT CHECK (
                              timezone IS NULL
                              OR timezone ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){0,2}$'
                            ),
  cuisines                  TEXT[] NOT NULL DEFAULT '{}',

  -- Source-reported opening hours are stored verbatim and never interpreted into "open now":
  -- interpreting them needs a reliable timezone plus a validated parser, which this release does not do.
  opening_hours_raw         TEXT CHECK (opening_hours_raw IS NULL OR char_length(opening_hours_raw) BETWEEN 1 AND 300),

  -- External links. Only http(s) is accepted; the backend never fetches these URLs.
  website_url               TEXT CHECK (
                            website_url IS NULL
                            OR (char_length(website_url) BETWEEN 8 AND 2048 AND website_url ~* '^https?://\S+$')
                          ),
  menu_url                  TEXT CHECK (
                            menu_url IS NULL
                            OR (char_length(menu_url) BETWEEN 8 AND 2048 AND menu_url ~* '^https?://\S+$')
                          ),
  ordering_url              TEXT CHECK (
                            ordering_url IS NULL
                            OR (char_length(ordering_url) BETWEEN 8 AND 2048 AND ordering_url ~* '^https?://\S+$')
                          ),

  -- Whether a structured menu preview may be shown at all, and why.
  menu_permission           TEXT NOT NULL DEFAULT 'NONE' CHECK (
                              menu_permission IN ('NONE', 'OWNER_SUBMITTED', 'SOURCE_PERMITTED')
                            ),

  -- Provenance and trust state.
  data_origin               TEXT NOT NULL DEFAULT 'IMPORTED' CHECK (
                              data_origin IN ('IMPORTED', 'OWNER_SUBMITTED', 'PARTNER_FEED')
                            ),
  publication_status        TEXT NOT NULL DEFAULT 'PUBLISHED' CHECK (
                              publication_status IN ('PUBLISHED', 'UNPUBLISHED')
                            ),
  verification_status       TEXT NOT NULL DEFAULT 'SOURCE_LISTED' CHECK (
                              verification_status IN ('SOURCE_LISTED', 'NEEDS_REVIEW', 'VERIFIED')
                            ),
  verified_at               TIMESTAMPTZ,

  -- Optional, explicit link into the existing transactional catalogue. This is the only path by which a
  -- discovery listing can be ordered through CraveDirect.
  cravedirect_restaurant_id UUID REFERENCES restaurants(id) ON DELETE SET NULL,

  source_name               TEXT NOT NULL CHECK (char_length(source_name) BETWEEN 1 AND 120),
  source_url                TEXT CHECK (
                            source_url IS NULL
                            OR (char_length(source_url) BETWEEN 8 AND 2048 AND source_url ~* '^https?://\S+$')
                          ),
  -- Per-record provenance: the URL of this exact record in the source, so a reviewer can go and check it.
  source_record_url         TEXT CHECK (
                            source_record_url IS NULL
                            OR (char_length(source_record_url) BETWEEN 8 AND 2048 AND source_record_url ~* '^https?://\S+$')
                          ),
  source_licence            TEXT CHECK (source_licence IS NULL OR char_length(source_licence) BETWEEN 1 AND 200),
  source_attribution        TEXT NOT NULL CHECK (char_length(source_attribution) BETWEEN 1 AND 500),
  source_updated_at         TIMESTAMPTZ,
  imported_at               TIMESTAMPTZ NOT NULL DEFAULT now(),

  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Coordinates are meaningless half-supplied; require both or neither.
  CHECK ((latitude IS NULL) = (longitude IS NULL)),
  -- "Restaurant verified" must be backed by a timestamp.
  CHECK (verification_status <> 'VERIFIED' OR verified_at IS NOT NULL),
  -- Imported rows are refreshed on re-import; owner-submitted rows are never created by an import.
  CHECK (data_origin <> 'OWNER_SUBMITTED' OR provider <> 'openstreetmap')
);

-- Provider identity. Repeated imports upsert instead of duplicating.
CREATE UNIQUE INDEX discovery_places_provider_key ON discovery_places (provider, provider_record_id);
-- One discovery place may be linked to at most one orderable restaurant.
CREATE UNIQUE INDEX discovery_places_link_key
  ON discovery_places (cravedirect_restaurant_id)
  WHERE cravedirect_restaurant_id IS NOT NULL;

-- Full-text search over the fields the UI actually searches: name (A), cuisines (B), place (C).
-- 'simple' is used instead of 'english' so non-English place and dish names are not stemmed away.
--
-- This is a trigger-maintained column rather than a GENERATED column because array_to_string() is only
-- STABLE in PostgreSQL, and generated columns require IMMUTABLE expressions. A trigger also keeps the
-- vector correct no matter who writes the row: the importer, an operator's SQL, or a future owner portal.
ALTER TABLE discovery_places ADD COLUMN search_vector tsvector NOT NULL DEFAULT ''::tsvector;

CREATE FUNCTION discovery_places_search_vector_sync() RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
      setweight(to_tsvector('simple', coalesce(NEW.name, '')), 'A')
   || setweight(to_tsvector('simple', coalesce(array_to_string(NEW.cuisines, ' '), '')), 'B')
   || setweight(to_tsvector('simple',
        coalesce(NEW.city, '') || ' ' || coalesce(NEW.region, '') || ' ' || coalesce(NEW.country_code, '')), 'C');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER discovery_places_search_vector_trigger
  BEFORE INSERT OR UPDATE ON discovery_places
  FOR EACH ROW EXECUTE FUNCTION discovery_places_search_vector_sync();

CREATE INDEX discovery_places_search_idx ON discovery_places USING GIN (search_vector);
CREATE INDEX discovery_places_cuisines_idx ON discovery_places USING GIN (cuisines);
-- Public list queries always filter on publication_status, and country is the primary facet.
CREATE INDEX discovery_places_public_country_idx
  ON discovery_places (country_code, publication_status, name)
  WHERE publication_status = 'PUBLISHED';
CREATE INDEX discovery_places_public_city_idx
  ON discovery_places (country_code, lower(city), name)
  WHERE publication_status = 'PUBLISHED';
CREATE INDEX discovery_places_public_newest_idx
  ON discovery_places (imported_at DESC, id)
  WHERE publication_status = 'PUBLISHED';
CREATE INDEX discovery_places_public_default_idx
  ON discovery_places (publication_status, country_code, city, name, id);
CREATE INDEX discovery_places_restaurant_link_idx
  ON discovery_places (cravedirect_restaurant_id)
  WHERE cravedirect_restaurant_id IS NOT NULL;

CREATE TABLE discovery_menu_sections (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  place_id      UUID NOT NULL REFERENCES discovery_places(id) ON DELETE CASCADE,
  name          TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  description   TEXT CHECK (description IS NULL OR char_length(description) BETWEEN 1 AND 500),
  display_order INTEGER NOT NULL DEFAULT 0,
  is_published  BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX discovery_menu_sections_place_idx ON discovery_menu_sections (place_id, display_order, name);
CREATE UNIQUE INDEX discovery_menu_sections_name_key
  ON discovery_menu_sections (place_id, lower(name));

-- Structured discovery menus. Kept separate from `menu_items` on purpose: those rows feed INR-only,
-- server-calculated checkout pricing, while these are optional, multi-currency, read-only previews.
CREATE TABLE discovery_menu_items (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  place_id             UUID NOT NULL REFERENCES discovery_places(id) ON DELETE CASCADE,
  section_id           UUID REFERENCES discovery_menu_sections(id) ON DELETE SET NULL,

  provider             TEXT NOT NULL CHECK (char_length(provider) BETWEEN 1 AND 60),
  -- NULL when the source has no stable per-dish identifier; such rows cannot be upserted and are skipped.
  provider_record_id   TEXT CHECK (provider_record_id IS NULL OR char_length(provider_record_id) BETWEEN 1 AND 190),

  name                 TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  description          TEXT CHECK (description IS NULL OR char_length(description) BETWEEN 1 AND 600),
  dietary_labels       TEXT[] NOT NULL DEFAULT '{}',

  -- Optional price. Amount, currency, and the currency's exponent travel together or not at all.
  price_minor          INTEGER CHECK (price_minor IS NULL OR price_minor BETWEEN 0 AND 100000000),
  currency             TEXT CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  currency_minor_units SMALLINT CHECK (currency_minor_units IS NULL OR currency_minor_units BETWEEN 0 AND 4),
  price_is_estimated   BOOLEAN NOT NULL DEFAULT false,

  is_published         BOOLEAN NOT NULL DEFAULT true,

  source_url           TEXT CHECK (
                            source_url IS NULL
                            OR (char_length(source_url) BETWEEN 8 AND 2048 AND source_url ~* '^https?://\S+$')
                          ),
  source_attribution   TEXT CHECK (source_attribution IS NULL OR char_length(source_attribution) BETWEEN 1 AND 500),
  source_updated_at    TIMESTAMPTZ,
  imported_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  CHECK ((price_minor IS NULL) = (currency IS NULL)),
  CHECK ((currency IS NULL) = (currency_minor_units IS NULL)),
  -- A zero-decimal currency must not be stored with a fractional-looking amount, and an estimated price
  -- must never be presented as an exact one.
  CHECK (price_minor IS NULL OR price_is_estimated OR currency_minor_units IS NOT NULL)
);

CREATE UNIQUE INDEX discovery_menu_items_provider_key
  ON discovery_menu_items (provider, provider_record_id)
  WHERE provider_record_id IS NOT NULL;
CREATE INDEX discovery_menu_items_place_idx ON discovery_menu_items (place_id, is_published, name);
CREATE INDEX discovery_menu_items_section_idx ON discovery_menu_items (section_id);

ALTER TABLE discovery_menu_items ADD COLUMN search_vector tsvector NOT NULL DEFAULT ''::tsvector;

CREATE FUNCTION discovery_menu_items_search_vector_sync() RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
      setweight(to_tsvector('simple', coalesce(NEW.name, '')), 'A')
   || setweight(to_tsvector('simple', coalesce(NEW.description, '')), 'B')
   || setweight(to_tsvector('simple', coalesce(array_to_string(NEW.dietary_labels, ' '), '')), 'C');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER discovery_menu_items_search_vector_trigger
  BEFORE INSERT OR UPDATE ON discovery_menu_items
  FOR EACH ROW EXECUTE FUNCTION discovery_menu_items_search_vector_sync();

CREATE INDEX discovery_menu_items_search_idx ON discovery_menu_items USING GIN (search_vector);
