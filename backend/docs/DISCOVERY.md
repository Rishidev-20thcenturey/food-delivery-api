# Global Food Discovery v1

Design, data sourcing, licensing, operation, and known limits of the discovery directory.

Read this before importing real data or enabling anything in production. The endpoints themselves are
documented in [`openapi.yaml`](./openapi.yaml) and summarised in [`API_CONTRACT.md`](./API_CONTRACT.md).

---

## 1. What this is, and what it is not

CraveDirect has two catalogues that must never be confused:

| | Orderable catalogue | Discovery directory |
| --- | --- | --- |
| Tables | `restaurants`, `menu_categories`, `menu_items` | `discovery_places`, `discovery_menu_sections`, `discovery_menu_items` |
| Endpoints | `/restaurants`, `/cart`, `/checkout`, `/orders` | `/discovery/places`, `/discovery/places/{id}`, `/discovery/facets` |
| Auth | Public read, authenticated write | Public read only. No write endpoints exist. |
| Geography | India. Six-digit PIN required. | Any ISO 3166-1 alpha-2 country. Postal code optional and country-specific. |
| Money | INR paise, always server-calculated at checkout | Optional, in the source's own currency and exponent. Never enters checkout. |
| Requires an owner account | Yes (`restaurants.owner_id` is `NOT NULL`) | **No.** Listing an external restaurant needs no CraveDirect account. |
| Can take an order | Yes | Only through an explicit link (see §3) |

A discovery listing is a **record about a restaurant that exists in the world**, with attribution. It is not
a CraveDirect merchant, and it does not become one by being imported.

This release does **not** add international ordering, multi-currency checkout, foreign payment methods, or
global delivery logistics. The existing Indian COD order flow is unchanged.

## 2. Schema

`src/db/migrations/002_global_discovery.sql` is additive. It creates three tables, two trigger functions,
and their indexes. It does not alter anything from `001_init.sql`, inserts no data, and does not run the
importer.

**`discovery_places`** — one row per external restaurant.

- Identity: `provider` + `provider_record_id`, with a unique index. This is what makes imports idempotent.
- Location: `country_code` (always present, validated against ISO 3166-1), optional `city`, `region`,
  `postal_code`, `address_line`, `latitude`/`longitude` (paired, range-checked), `timezone` (IANA).
- `cuisines TEXT[]` with a GIN index, plus a trigger-maintained `search_vector` with its own GIN index.
- Links: `website_url`, `menu_url`, `ordering_url`. All three are constrained to `http(s)`, 8–2048 chars,
  no whitespace. The backend never fetches them.
- Provenance: `source_name`, `source_url`, `source_record_url` (this exact record in the source),
  `source_licence`, `source_attribution`, `source_updated_at`, `imported_at`.
- Trust state: `data_origin` (`IMPORTED`, `OWNER_SUBMITTED`, `PARTNER_FEED`), `publication_status`
  (`PUBLISHED`, `UNPUBLISHED`), `verification_status` (`SOURCE_LISTED`, `NEEDS_REVIEW`, `VERIFIED`) and
  `verified_at`, with a constraint that `VERIFIED` requires a timestamp.
- `opening_hours_raw`: the source's own string, stored verbatim and never parsed. There is no
  `is_open` anywhere in the discovery API, because computing one needs a reliable timezone **and** a
  validated opening-hours parser, and guessing would be worse than saying nothing.
- `cravedirect_restaurant_id`: nullable FK to `restaurants(id)`, `ON DELETE SET NULL`, unique when set.

**`discovery_menu_sections`** and **`discovery_menu_items`** — a structured menu preview, deliberately
separate from `menu_categories`/`menu_items` so international prices are never forced into the INR
checkout schema.

- `price_minor` (integer), `currency` (ISO 4217), `currency_minor_units` (that currency's exponent) —
  all three set or all three NULL, enforced by constraints. `price_is_estimated` marks approximate prices.
- `discovery_places.menu_permission` (`NONE`, `OWNER_SUBMITTED`, `SOURCE_PERMITTED`) gates whether a menu
  may be published at all. Items can exist in the table and still be invisible: the API refuses to serve a
  preview when permission is `NONE`.

**Why a trigger instead of a generated column.** `array_to_string()` is only `STABLE` in PostgreSQL, and
generated columns require `IMMUTABLE` expressions. The search vectors are therefore maintained by
`BEFORE INSERT OR UPDATE` triggers, which also keeps them correct no matter who writes the row.

### Rollback

`docs/migrations/002_global_discovery.rollback.sql`. It is stored **outside** `src/db/migrations/`
on purpose: every `*.sql` file in that directory is applied automatically by `npm run db:migrate`, which
the Render build command runs on every deploy. Rolling back drops the three discovery tables and their
two functions, deletes the `schema_migrations` row, and touches nothing else. It destroys imported
discovery data, so take a `pg_dump` of those three tables first if any of it matters.

Rollout order: deploy the backend as usual. `render.yaml` already runs `npm run db:migrate` during the
build, so `002` applies before the new code serves traffic. Because the migration is purely additive and
the old code never references the new tables, an old backend keeps working against a migrated database —
the deploy is safe in either order and can be rolled back by redeploying the previous commit.

## 3. Ordering: the only path from discovery to a CraveDirect order

`ordering.available` is true **only** when `cravedirect_restaurant_id` points at a restaurant whose status
is `ACTIVE`. That link is set by an explicit operator action. It is never set by an import: the importer
does not write that column at all, and its upsert deliberately excludes it, along with `menu_permission`,
`publication_status`, `verification_status`, and `data_origin`.

An external `ordering_url` is a link to somebody else's ordering page. It is labelled "Official ordering
link" in the UI and is never described as an order placed through CraveDirect.

To make a listing orderable, an operator creates the real restaurant through the existing owner/admin
flows, then links it:

```sql
UPDATE discovery_places
   SET cravedirect_restaurant_id = '<restaurant uuid>',
       verification_status = 'VERIFIED',
       verified_at = now(),
       updated_at = now()
 WHERE provider = 'openstreetmap' AND provider_record_id = 'node/123456';
```

## 4. API

All three endpoints are public and read-only. They are mounted at `/api/v1/discovery` and reuse the
existing response envelope, `validate()` middleware, `AppError` codes, `X-Request-Id`, rate limiting,
helmet, and CORS configuration. Nothing in `/restaurants`, `/cart`, `/checkout`, `/orders`, `/auth`,
`/owner`, `/courier`, or `/admin` was changed.

- `GET /discovery/places` — `q`, `dish`, `country`, `city`, `region`, `cuisine` (up to 3, comma-separated),
  `hasMenu`, `orderable`, `sort` (`name` | `newest` | `updated` | `country`), `page` (≤ 500),
  `limit` (default 12, max 24).
- `GET /discovery/places/{placeId}` — full detail plus the menu preview when one is permitted.
- `GET /discovery/facets` — bounded countries (≤260), cities (≤80), cuisines (≤60), and totals, so the UI
  never offers a filter with no coverage behind it.

Query behaviour:

- Every statement is parameterised. Search text is converted to a `tsquery` in
  `toPrefixTsQuery()`, which keeps only `\p{L}`, `\p{N}`, and `\p{M}` characters and at most six tokens.
  `%`, `_`, `!`, `&`, `|`, `(`, `)`, `:`, and `*` cannot reach the query parser.
- Text search matches prefixes via the GIN index on `search_vector` (`'simple'` configuration, so
  non-English names are not stemmed away). There is no `ILIKE '%…%'` table scan.
- Search text that contains nothing searchable matches **nothing**, not everything.
- A list request is exactly two queries (page + count) regardless of how many rows come back: menu counts
  and dish names come from one bounded `LEFT JOIN LATERAL`. Verified by
  `tests/discovery.test.ts`.
- `city` and `region` are exact, case-insensitive matches, which is what the expression index answers.
  Partial city text goes through `q`, whose vector includes city and region.
- The cuisine filter is canonicalised with the same `canonicalCuisineLabel()` the importer uses, so it can
  be answered by the GIN index on `cuisines`.
- Unpublished listings return 404 on the detail endpoint, not 403, so IDs cannot be probed.
- No query joins `users`, `refresh_tokens`, `addresses`, `carts`, or `orders`. A test asserts that the
  combined JSON of all three endpoints contains no owner id, customer id, email, token, or password.

## 5. Data sources and licensing

### Source-adapter design

An adapter is one file that streams `RawDiscoveryRecord`s from a local file. Everything downstream —
normalisation, validation, deduplication, batching, safeguards, the schema, and the API — is shared. Adding
a source means writing an adapter and choosing a `SourceDescriptor`; it does not mean touching the database
or the frontend.

| Adapter | Input | Status |
| --- | --- | --- |
| `osm-xml` | OSM XML 0.6 (`.osm`): a Geofabrik-style regional extract or an Overpass `[out:xml]` response | Implemented and tested |
| `ndjson` | One canonical JSON record per line, optionally with a permitted structured menu | Implemented and tested |

### OpenStreetMap (the starting source)

Licence: **Open Database Licence (ODbL) 1.0** — <https://www.openstreetmap.org/copyright>.

ODbL obligations that matter here:

- **Attribution.** Every imported row stores `source_name = 'OpenStreetMap'`,
  `source_licence = 'ODbL-1.0'`, `source_attribution = '© OpenStreetMap contributors'`, and
  `source_record_url` pointing at the exact element. The API returns all of these and the UI displays the
  attribution on every card and detail view.
- **Share-Alike.** If you redistribute this database, or a substantial part of it, to third parties, the
  resulting database must be offered under ODbL. Serving the discovery directory from the CraveDirect API
  to end users is *use*, not redistribution of the database, but if CraveDirect ever publishes bulk
  exports or a public dump of the directory, that export must be ODbL. **This is a legal review item before
  any bulk export feature ships.**
- **No endorsement.** OSM data must not be presented as endorsed by OpenStreetMap, and contributor data
  must not be misrepresented as CraveDirect's own.
- Mixing ODbL data with data under an incompatible licence in one database is the classic ODbL hazard. Keep
  provenance per row (which this schema does) and check each additional source's licence independently
  before combining.

What is mapped from OSM:

| OSM | Discovery |
| --- | --- |
| `node`/`way`/`relation` id | `provider_record_id` as `node/123456` |
| `name` | `name` |
| `cuisine` (`;` or `,` separated) | `cuisines[]`, canonicalised, max 8 |
| `addr:country` | `country_code` (else the operator's `--country`) |
| `addr:city`/`town`/`village`/`hamlet`/`suburb`/`quarter`/`neighbourhood`/`place` | `city` |
| `addr:state`, `addr:province` | `region` |
| `addr:postcode` | `postal_code` |
| `addr:housenumber` + `addr:street` | `address_line` |
| node `lat`/`lon`, or `<center>` on a way/relation | `latitude`/`longitude` |
| `website`, `contact:website` | `website_url` |
| `menu`, `contact:menu`, `website:menu`, `url:menu` | `menu_url` |
| `ordering`, `contact:ordering`, `website:ordering`, `url:ordering` | `ordering_url` |
| `opening_hours` | `opening_hours_raw`, verbatim |
| `timezone` | `timezone`, validated against the runtime IANA list |
| element `timestamp` | `source_updated_at` |

Which elements count as food places: `amenity` in `restaurant`, `cafe`, `fast_food`, `food_court`,
`ice_cream`; `amenity` in `pub`, `bar`, `biergarten` **only** when a `cuisine` tag is present; `shop` in
`bakery`, `pastry`, `confectionery`, `deli`, `cheese`, `chocolate`. Elements with any `disused:`,
`abandoned:`, `demolished:`, `razed:`, `removed:`, or `historic:` key are skipped, as are elements with no
`name`.

Deliberate omissions:

- **No way geometry resolution.** Resolving a way's centroid from its node references would require holding
  every node in memory. Ways are imported with coordinates only when the extract provides `<center>`
  (Overpass `[out:xml][out:center]` does); otherwise coordinates stay NULL. A NULL coordinate is honest;
  a guessed one is not.
- **No `phone`, no images, no descriptions, no ratings, no price ranges.** OSM may carry some of these, but
  collecting third-party photos and descriptions is out of scope, and inventing ratings or price ranges is
  prohibited. Missing fields stay missing.
- **No opening-hours interpretation.** See §2.

### Sources considered and not used in v1

| Source | Decision |
| --- | --- |
| Google Places API | **Rejected.** Requires billing activation. Prohibited by the $0 constraint. |
| Foursquare / Yelp / TripAdvisor | **Rejected.** Commercial terms do not permit this use without a paid agreement. |
| Nominatim (public instance) | **Rejected for bulk use.** Its usage policy explicitly forbids systematic/bulk downloading; it is a search service for individual lookups. |
| Scraping food-delivery apps | **Rejected.** Terms of service, and no permission for the data. |
| Wikidata | **Designed for, not implemented.** Structured facts under CC0 would be a good `ndjson` adapter. Note that a Wikidata *reference* to another source inherits that source's terms, so each property needs checking. |
| Government / municipal open datasets | **Designed for, not implemented.** Check each dataset's licence individually; "publicly downloadable" is not "permitted for this use". |
| Restaurant-submitted listings and authorised menu feeds | **Designed for, not implemented.** The `ndjson` adapter plus `menu_permission` already support this path; see §7. |

Being publicly downloadable does not grant permission for every use. Each source needs its own licence
review before an adapter is written for it.

## 6. Running an import

**Dry run is the default.** Nothing below writes unless you pass both `--commit` and an exact
`--confirm-target`.

```bash
cd backend
npm run db:import:discovery -- --help

# 1. Dry run against the local development database
npm run db:import:discovery -- \
  --file=./data/berlin.osm --adapter=osm-xml --country=DE --limit=2000

# 2. Commit, naming the exact target it printed
npm run db:import:discovery -- \
  --file=./data/berlin.osm --adapter=osm-xml --country=DE \
  --commit --confirm-target="food_delivery@127.0.0.1:54330"

# 3. A partner / owner-submitted NDJSON feed, including its permitted menus
npm run db:import:discovery -- \
  --file=./data/partner.ndjson --adapter=ndjson \
  --source-name="Partner feed" --source-licence="Agreement 2026-04" \
  --source-attribution="Data supplied by the restaurant." \
  --allow-menu --commit --confirm-target="food_delivery@127.0.0.1:54330"
```

Flags: `--file` (required), `--adapter`, `--country`, `--provider`, `--source-name`, `--source-url`,
`--source-licence`, `--source-attribution`, `--batch-size` (1–500, default 200), `--limit`, `--allow-menu`,
`--commit`, `--confirm-target`.

Getting an OSM extract (done by you, never by this code):

1. A small regional extract from a mirror such as Geofabrik, decompressed to `.osm`; or
2. An Overpass query with a bounded area and `[out:xml][out:center]`, saved to a file. Respect Overpass's
   usage policy: one modest, well-bounded query, not a loop.

Then import **in batches by region**, with `--limit` first to inspect the summary. Do not commit a large
extract to the repository: `.osm` files are hundreds of megabytes and belong outside Git.

Safeguards, in the order they fire:

1. Refuses if `NODE_ENV=production`.
2. Refuses to write unless `--confirm-target` equals the `database@host:port` it prints. That string never
   contains a username or password.
3. Refuses if the input file is missing, is not a file, or exceeds 2 GiB.
4. Refuses if `--country` is not a valid ISO code, or if the source has no provider key or attribution.
5. Streams the file: 64 KiB chunks, one element materialised at a time, with an 8 MiB cap on unfinished
   element data (which also catches "this is not OSM XML").
6. Validates every record. Invalid optional fields are **dropped and counted** (`droppedFields`) so a bad
   postcode does not lose a restaurant; invalid identity, name, country, or coordinates reject the record
   with a reason.
7. Deduplicates on `(provider, provider_record_id)`, both within the file and against the database.
8. Writes in bounded batches inside a transaction: one `SELECT` to classify, one multi-row upsert.
9. **Never overwrites protected rows.** The upsert's `WHERE` clause limits updates to
   `data_origin = 'IMPORTED' AND verification_status <> 'VERIFIED'`, and the column list excludes
   `cravedirect_restaurant_id`, `menu_permission`, `publication_status`, `verification_status`, and
   `data_origin`. An operator's verification, publication decision, and catalogue link survive any re-import.
10. Never deletes anything. There is no delete path in the importer.
11. Structured menus require **both** `--allow-menu` and an explicit `menu.permission` of
    `OWNER_SUBMITTED` or `SOURCE_PERMITTED` on the record, and each dish needs a stable `id` so it can be
    upserted rather than duplicated.

The summary reports: records read, valid, invalid, inserted, updated, skipped-because-protected, duplicates
found in the file, batch count, duration, per-field drop counts, adapter counters (for OSM: elements
scanned, non-food places, unnamed, outside the country filter, yielded), menu item counts, and up to 25
sample errors with reasons.

## 7. Verification states and what the UI may say

| State | Meaning | Permitted label |
| --- | --- | --- |
| `SOURCE_LISTED` | Imported and published as the source reported it | "Source-listed information", "Information needs verification" |
| `NEEDS_REVIEW` | Flagged for a human | "Information needs verification" |
| `VERIFIED` + `verified_at` | A human or the restaurant confirmed it | "Restaurant verified" |
| `menu_permission: NONE` | No permitted structured menu | "Menu not available" + the official menu link |
| `menu_permission: OWNER_SUBMITTED` | The restaurant supplied it | Menu preview, labelled as supplied by the restaurant |
| `menu_permission: SOURCE_PERMITTED` | The source permits this use | Menu preview, with source attribution |

Source-listed data is **never** labelled owner-verified. Ratings, price ranges, open/closed states, and
delivery estimates are not shown at all, because no source in this release provides them reliably.

Outbound links: only `http(s)` survives validation (application layer and a database CHECK). The backend
never fetches a supplied URL, so there is no SSRF surface — and any future feature that does fetch
externally must add an allowlist, block private/link-local/loopback ranges and non-standard ports, forbid
redirect following, and cap response size before it ships. The frontend opens links in a new tab with
`rel="noopener noreferrer"` and accessible names. Third-party sites are never embedded in an iframe to
fake an integrated menu.

## 8. Free-tier performance and cost

No paid service is used or required: no geocoding API, no maps SDK, no hosted search, no image host, no
APM. Costs stay at $0.

- The API process gained three read-only routes and no new runtime dependency.
- Storage is URLs and short metadata, not media. No images are stored or served.
- Every list query is bounded by `LIMIT`/`OFFSET` with `page ≤ 500` and `limit ≤ 24`, and every facet query
  has its own `LIMIT`.
- Imports stream and batch; they never load a dataset into memory and never run inside a request handler.
- The Netlify Edge Function is unchanged and does no ingestion. `netlify.toml`, `netlify/`, `render.yaml`,
  `.github/workflows/`, and every environment variable are untouched by this work.
- No background worker, queue, or second service was added.

Realistic expectations: a free-tier Node instance and a small PostgreSQL database do **not** guarantee
always-on availability, unlimited records, global menu coverage, or production-grade reliability. Render's
free tier sleeps when idle, so the first discovery request after a pause can take several seconds; the UI
handles that with a retry state rather than a spinner that never ends.

## 9. Testing

Run from `backend/`:

```bash
npm run typecheck   # tsc -p tsconfig.json --noEmit
npm run lint        # eslint src tests scripts
npm test            # vitest run — embedded PostgreSQL on port 54329, created fresh per run
npm run build       # tsc -p tsconfig.json
```

`tests/global-setup.ts` starts its own embedded PostgreSQL and applies migrations with the same runner
production uses, so `002_global_discovery.sql` is verified on a clean database every run. No test touches a
shared, development, or production database, and no test needs network access.

New test files:

- `tests/discovery.test.ts` (24) — public access, empty catalogue, every filter, invalid filters, prefixes
  and metacharacters, permitted-only dish search, pagination and its maximum, all sort options, unpublished
  hiding, honest verification states, provenance and freshness, timezone honesty, menu previews in EUR and
  zero-decimal JPY, refusal to preview an unpermitted menu, orderability rules, catalogue isolation,
  account-data leakage, unsafe link schemes, international postal codes, coordinate constraints, facets,
  constant query counts, and one-query-per-connection.
- `tests/discovery-import.test.ts` (15) — dry run by default, credential-free target description, the
  production and wrong-target refusals, missing file and bad country, provenance and skip reporting,
  idempotency, protection of verified and owner-submitted rows, `--limit`/`--batch-size` bounds, end-to-end
  searchability after import, NDJSON malformed-line handling, the `--allow-menu` gate, per-currency
  exponents with no INR conversion, sectioned previews through the API, and menu idempotency.
- `tests/discovery-normalise.test.ts` (17) — the country list, currency exponents, IANA validation, cuisine
  canonicalisation, http(s)-only links, record rejection and field dropping, tsquery building including
  non-Latin scripts, XML entity decoding, food-place recognition, and the fixture itself.

Fixtures live in `tests/fixtures/discovery/` and are **synthetic**: invented places named `Synthetic …` with
`example.test` URLs. They are not real restaurants and must never be presented as such or imported into a
production database.

Existing tests were not weakened or deleted. Two were extended: `tests/helpers.ts` truncates the new tables
between files and gained discovery fixture helpers, and `tests/openapi-contract.test.ts` lists the three new
operations so its "documents no paths the API does not implement" rule keeps holding.

## 10. Known limitations

1. **The production directory is empty.** Nothing was imported into any real database as part of this work.
   Coverage exists only after an operator runs an import. The UI says so explicitly and offers a different
   location instead of inventing restaurants.
2. **No structured menus from OSM.** OSM has no dish-level data, so `menu_permission` is `NONE` for every
   OSM import and those listings show the official menu link. Real menu previews need an authorised feed,
   which does not exist yet.
3. **Way centroids are missing without `<center>`.** See §5.
4. **`city` filtering is exact**, case-insensitive. Partial city text only matches through `q`.
5. **Deep pagination is capped at `page ≤ 500`.** At `limit=24` that is 12,000 rows deep, which is beyond
   what a person scrolls and beyond what a free tier should offset-scan. Add keyset pagination before the
   directory grows past that.
6. **No duplicate-place detection across providers.** The same restaurant from two sources produces two
   rows, because there is no reliable free matching key. A `NEEDS_REVIEW` merge workflow is future work.
7. **Opening hours are never interpreted.** Deliberate; see §2.
8. **Timezone validation depends on the runtime's ICU data.** On a Node build without full ICU, validation
   falls back to a shape check. The official Node 20/22 builds ship full ICU.
9. **Currency coverage is a static table.** Unknown codes are rejected rather than guessed. Adding a
   currency means adding it to `reference-data.ts`.
10. **ODbL Share-Alike is a legal review item** before any bulk export or public dump of the directory (§5).
11. **No admin UI.** Verification, publication, and catalogue linking are SQL operations for now.
12. **Frontend CI does not run on a PR based on this branch.** `.github/workflows/frontend.yml` triggers on
    pushes to `feat/cravedirect-netlify-integration` and on pull requests targeting `main` only. The
    frontend build was verified locally instead; changing that workflow is deployment configuration and was
    left untouched.

## 11. Production activation checklist (not done here)

Nothing in this document authorises a production change. Before enabling discovery in production,
separately and explicitly:

- [ ] Review the ODbL obligations in §5, including the Share-Alike question for any export.
- [ ] Apply `002_global_discovery.sql` to a **copy** of the production schema and re-run the backend suite
      against it, then apply it to production through the normal deploy path.
- [ ] Obtain a real regional OSM extract, dry-run it, read the summary and the error list, then commit to a
      development database and inspect the result in the UI.
- [ ] Decide and record the attribution placement required by the licence.
- [ ] Confirm the live frontend build and the Render deploy after the branch is merged — a passing unit
      test and a green build are not production verification.
- [ ] Confirm that no discovery listing is orderable until an operator has linked and verified it.
