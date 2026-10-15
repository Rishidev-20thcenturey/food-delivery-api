#!/usr/bin/env python3
"""Controlled, streaming OpenStreetMap food-place import for CraveDirect.

This operational script writes ONLY to discovery_places. It never creates or edits
orderable restaurants, orders, customers, menus, verification status, or catalogue links.
"""
from __future__ import annotations

import argparse
import os
import re
import sys
import xml.etree.ElementTree as ET
from collections import Counter
from datetime import datetime
from typing import Any
from urllib.parse import unquote, urlsplit
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import psycopg

FOOD_AMENITIES = {"restaurant", "cafe", "fast_food", "food_court", "ice_cream"}
DRINKING_AMENITIES = {"pub", "bar", "biergarten"}
FOOD_SHOPS = {"bakery", "pastry", "confectionery", "deli", "cheese", "chocolate"}
GONE_PREFIXES = ("disused:", "abandoned:", "demolished:", "razed:", "removed:", "historic:")
COUNTRY_RE = re.compile(r"^[A-Z]{2}$")
POSTCODE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 .-]*[A-Za-z0-9]$")
MAX_SEEN_IDS = 250_000
BATCH_SIZE = 200
ATTRIBUTION = "© OpenStreetMap contributors"
LICENCE = "ODbL-1.0"
PROVIDER = "openstreetmap"

UPSERT_SQL = """
INSERT INTO discovery_places (
  provider, provider_record_id, name, country_code, city, region, postal_code, address_line,
  latitude, longitude, timezone, cuisines, opening_hours_raw, website_url, menu_url, ordering_url,
  source_name, source_url, source_record_url, source_licence, source_attribution, source_updated_at,
  data_origin, menu_permission, publication_status, verification_status, imported_at, updated_at
)
VALUES (
  %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
  'IMPORTED', 'NONE', 'PUBLISHED', 'SOURCE_LISTED', now(), now()
)
ON CONFLICT (provider, provider_record_id) DO UPDATE SET
  name = EXCLUDED.name,
  country_code = EXCLUDED.country_code,
  city = EXCLUDED.city,
  region = EXCLUDED.region,
  postal_code = EXCLUDED.postal_code,
  address_line = EXCLUDED.address_line,
  latitude = EXCLUDED.latitude,
  longitude = EXCLUDED.longitude,
  timezone = EXCLUDED.timezone,
  cuisines = EXCLUDED.cuisines,
  opening_hours_raw = EXCLUDED.opening_hours_raw,
  website_url = EXCLUDED.website_url,
  menu_url = EXCLUDED.menu_url,
  ordering_url = EXCLUDED.ordering_url,
  source_name = EXCLUDED.source_name,
  source_url = EXCLUDED.source_url,
  source_record_url = EXCLUDED.source_record_url,
  source_licence = EXCLUDED.source_licence,
  source_attribution = EXCLUDED.source_attribution,
  source_updated_at = EXCLUDED.source_updated_at,
  imported_at = now(),
  updated_at = now()
WHERE discovery_places.data_origin = 'IMPORTED'
  AND discovery_places.verification_status <> 'VERIFIED'
"""

def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]

def clean_text(value: str | None, limit: int) -> str | None:
    if not value:
        return None
    value = " ".join(value.split()).strip()
    if not value:
        return None
    return value[:limit]

def first_tag(tags: dict[str, str], *keys: str, limit: int = 120) -> str | None:
    for key in keys:
        value = clean_text(tags.get(key), limit)
        if value:
            return value
    return None

def safe_http_url(*values: str | None) -> str | None:
    for value in values:
        candidate = (value or "").strip()
        if not candidate or len(candidate) > 2048 or any(ch.isspace() for ch in candidate):
            continue
        try:
            parsed = urlsplit(candidate)
            if (
                parsed.scheme.lower() in {"http", "https"}
                and parsed.netloc
                and parsed.hostname
                and parsed.username is None
                and parsed.password is None
            ):
                return candidate
        except ValueError:
            continue
    return None

def is_food_place(tags: dict[str, str]) -> bool:
    if any(key.startswith(GONE_PREFIXES) for key in tags):
        return False
    amenity = tags.get("amenity", "").strip().lower()
    shop = tags.get("shop", "").strip().lower()
    cuisine = tags.get("cuisine", "").strip()
    return (
        amenity in FOOD_AMENITIES
        or (amenity in DRINKING_AMENITIES and bool(cuisine))
        or shop in FOOD_SHOPS
    )

def parse_timestamp(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None

def parse_coordinates(elem: ET.Element) -> tuple[float | None, float | None, bool]:
    """Return lat, lon, and whether a supplied coordinate pair was malformed."""
    lat_raw, lon_raw = elem.attrib.get("lat"), elem.attrib.get("lon")
    if lat_raw is None or lon_raw is None:
        centre = next((child for child in elem if local_name(child.tag) == "center"), None)
        if centre is not None:
            lat_raw, lon_raw = centre.attrib.get("lat"), centre.attrib.get("lon")
    if lat_raw is None and lon_raw is None:
        return None, None, False
    if lat_raw is None or lon_raw is None:
        return None, None, False
    try:
        lat, lon = float(lat_raw), float(lon_raw)
    except ValueError:
        return None, None, True
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        return None, None, True
    return lat, lon, False

def build_record(
    elem: ET.Element,
    tags: dict[str, str],
    default_country: str,
    source_url: str,
    stats: Counter[str],
) -> tuple[Any, ...] | None:
    if not is_food_place(tags):
        stats["not_food_or_lifecycle"] += 1
        return None

    raw_country = (tags.get("addr:country") or "").strip().upper()
    if COUNTRY_RE.fullmatch(raw_country) and raw_country != default_country:
        stats["outside_region_country"] += 1
        return None
    country = raw_country if COUNTRY_RE.fullmatch(raw_country) else default_country

    name = clean_text(tags.get("name"), 200)
    if not name:
        stats["unnamed"] += 1
        return None
    if not elem.attrib.get("id", "").isdigit():
        stats["invalid_id"] += 1
        return None

    lat, lon, malformed_coords = parse_coordinates(elem)
    if malformed_coords:
        stats["invalid_coordinates"] += 1
        return None

    element_type = local_name(elem.tag)
    element_id = elem.attrib["id"]
    record_id = f"{element_type}/{element_id}"
    city = first_tag(
        tags, "addr:city", "addr:town", "addr:village", "addr:hamlet",
        "addr:suburb", "addr:quarter", "addr:neighbourhood", "addr:place",
    )
    region = first_tag(tags, "addr:state", "addr:province")
    postcode = clean_text(tags.get("addr:postcode"), 12)
    if postcode and (len(postcode) < 3 or not POSTCODE_RE.fullmatch(postcode)):
        postcode = None
        stats["dropped_postcodes"] += 1
    street = clean_text(tags.get("addr:street"), 160)
    house_number = clean_text(tags.get("addr:housenumber"), 60)
    address = first_tag(tags, "addr:full", limit=240)
    if not address and (street or house_number):
        address = clean_text(" ".join(part for part in (house_number, street) if part), 240)

    cuisine_raw = tags.get("cuisine", "")
    cuisines: list[str] = []
    for part in re.split(r"[;,]", cuisine_raw):
        cuisine = clean_text(part, 80)
        if cuisine and cuisine.casefold() not in {item.casefold() for item in cuisines}:
            cuisines.append(cuisine)
        if len(cuisines) >= 8:
            break

    timezone = first_tag(tags, "timezone", limit=80)
    if timezone:
        try:
            ZoneInfo(timezone)
        except (ZoneInfoNotFoundError, ValueError):
            timezone = None

    website = safe_http_url(tags.get("website"), tags.get("contact:website"))
    menu_url = safe_http_url(tags.get("menu"), tags.get("contact:menu"), tags.get("website:menu"), tags.get("url:menu"))
    ordering_url = safe_http_url(tags.get("ordering"), tags.get("contact:ordering"), tags.get("website:ordering"), tags.get("url:ordering"))
    opening_hours = clean_text(tags.get("opening_hours"), 300)
    source_updated_at = parse_timestamp(elem.attrib.get("timestamp"))
    record_url = f"https://www.openstreetmap.org/{element_type}/{element_id}"

    stats["valid_places"] += 1
    return (
        PROVIDER, record_id, name, country, city, region, postcode, address,
        lat, lon, timezone, cuisines, opening_hours, website, menu_url, ordering_url,
        "OpenStreetMap", source_url, record_url, LICENCE, ATTRIBUTION, source_updated_at,
    )

def target_description(database_url: str) -> tuple[str, str]:
    """Return a credential-free database@host:port descriptor and validated host."""
    try:
        parsed = urlsplit(database_url)
        host = parsed.hostname or ""
        port = parsed.port or 5432
    except ValueError as exc:
        raise ValueError("DISCOVERY_DATABASE_URL is not a valid PostgreSQL URL.") from exc
    database = unquote(parsed.path.lstrip("/"))
    if parsed.scheme not in {"postgres", "postgresql"} or not host or not database:
        raise ValueError("DISCOVERY_DATABASE_URL must be a valid PostgreSQL URL.")
    # This runbook targets the existing Neon-backed API database only.
    if not host.endswith(".neon.tech"):
        raise ValueError("Refusing target: the configured database host is not a Neon host.")
    return f"{database}@{host}:{port}", host

def iter_records(xml_path: str, default_country: str, source_url: str, stats: Counter[str]):
    seen: set[str] = set()
    tracking_complete = True
    root: ET.Element | None = None

    for event, elem in ET.iterparse(xml_path, events=("start", "end")):
        if event == "start":
            if root is None:
                root = elem
            continue
        kind = local_name(elem.tag)
        if kind not in {"node", "way", "relation"}:
            continue

        stats["elements_scanned"] += 1
        tags = {
            child.attrib.get("k", ""): child.attrib.get("v", "")
            for child in elem
            if local_name(child.tag) == "tag" and child.attrib.get("k")
        }
        record = build_record(elem, tags, default_country, source_url, stats)
        if record is not None:
            record_id = str(record[1])
            if tracking_complete and record_id in seen:
                stats["duplicates_in_file"] += 1
            else:
                if tracking_complete:
                    if len(seen) < MAX_SEEN_IDS:
                        seen.add(record_id)
                    else:
                        tracking_complete = False
                        stats["duplicate_tracking_capped"] = 1
                stats["records_yielded"] += 1
                yield record

        elem.clear()
        if root is not None:
            root.clear()

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--xml", required=True, help="Filtered OSM XML produced by osmium-tool")
    parser.add_argument("--mode", required=True, choices=("dry-run", "commit"))
    parser.add_argument("--default-country", required=True, help="ISO 3166-1 alpha-2 for this regional extract")
    parser.add_argument("--source-url", required=True, help="Geofabrik page for the source extract")
    parser.add_argument("--batch-size", type=int, default=BATCH_SIZE)
    parser.add_argument("--confirm-production", action="store_true", help="Explicitly authorise writing discovery records to the live Neon database")
    parser.add_argument("--confirm-target", default="", help="Exact database@host:port descriptor from a prior dry run")
    args = parser.parse_args()

    country = args.default_country.strip().upper()
    if not COUNTRY_RE.fullmatch(country):
        parser.error("--default-country must be a two-letter ISO country code")
    if not (1 <= args.batch_size <= 500):
        parser.error("--batch-size must be from 1 to 500")

    database_url = os.environ.get("DISCOVERY_DATABASE_URL", "")
    try:
        target, _host = target_description(database_url)
    except ValueError as exc:
        parser.error(str(exc))
    print(f"Database target: {target}")
    print(f"Source: OpenStreetMap / ODbL-1.0; regional dataset page: {args.source_url}")
    print(f"Mode: {args.mode}")

    if args.mode == "commit":
        if not args.confirm_production:
            print("ERROR: commit requires the explicit --confirm-production flag.", file=sys.stderr)
            return 2
        if args.confirm_target != target:
            print("ERROR: --confirm-target must exactly match the database target printed above.", file=sys.stderr)
            return 2

    stats: Counter[str] = Counter()
    imported_or_updated = 0
    protected_or_skipped = 0
    batch: list[tuple[Any, ...]] = []

    try:
        if args.mode == "commit":
            with psycopg.connect(database_url, connect_timeout=20, autocommit=True) as conn:
                with conn.cursor() as cur:
                    cur.execute("SELECT to_regclass('public.discovery_places')")
                    if cur.fetchone()[0] is None:
                        raise RuntimeError("The discovery_places table is missing. Apply the discovery migration first.")

                for record in iter_records(args.xml, country, args.source_url, stats):
                    batch.append(record)
                    if len(batch) >= args.batch_size:
                        with conn.transaction():
                            with conn.cursor() as cur:
                                cur.executemany(UPSERT_SQL, batch)
                                changed = max(cur.rowcount, 0)
                        imported_or_updated += changed
                        protected_or_skipped += len(batch) - changed
                        batch.clear()
                if batch:
                    with conn.transaction():
                        with conn.cursor() as cur:
                            cur.executemany(UPSERT_SQL, batch)
                            changed = max(cur.rowcount, 0)
                    imported_or_updated += changed
                    protected_or_skipped += len(batch) - changed
                    batch.clear()
        else:
            for _record in iter_records(args.xml, country, args.source_url, stats):
                pass
    except Exception as exc:
        message = str(exc).replace(database_url, "[redacted database URL]") if database_url else str(exc)
        print(f"ERROR: {type(exc).__name__}: {message}", file=sys.stderr)
        return 1

    print("Import summary")
    print(f"  XML elements scanned: {stats['elements_scanned']}")
    print(f"  valid food places:    {stats['valid_places']}")
    print(f"  records yielded:      {stats['records_yielded']}")
    print(f"  skipped non-food/lifecycle: {stats['not_food_or_lifecycle']}")
    print(f"  skipped unnamed:      {stats['unnamed']}")
    print(f"  outside country:      {stats['outside_region_country']}")
    print(f"  invalid coordinates:  {stats['invalid_coordinates']}")
    print(f"  invalid id:           {stats['invalid_id']}")
    print(f"  duplicate IDs:        {stats['duplicates_in_file']}")
    print(f"  invalid postcodes dropped: {stats['dropped_postcodes']}")
    if stats["duplicate_tracking_capped"]:
        print(f"  duplicate tracking stopped after {MAX_SEEN_IDS:,} IDs; database uniqueness still prevents duplicate rows")
    if args.mode == "dry-run":
        print("DRY RUN ONLY: no database connection or write was performed.")
        print("To commit, rerun with mode=commit, --confirm-production, and the exact target shown above.")
    else:
        print(f"  rows inserted or refreshed: {imported_or_updated}")
        print(f"  protected rows skipped:     {protected_or_skipped}")
        print("No rows were deleted. Verified/owner-managed rows and orderable catalogue links were preserved.")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
