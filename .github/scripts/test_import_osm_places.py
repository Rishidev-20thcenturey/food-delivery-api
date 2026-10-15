import tempfile
import unittest
import xml.etree.ElementTree as ET
from collections import Counter
from pathlib import Path

from import_osm_places import (
    ATTRIBUTION,
    LICENCE,
    UPSERT_SQL,
    build_record,
    is_food_place,
    iter_records,
    safe_http_url,
    target_description,
)

class FoodPlaceTests(unittest.TestCase):
    def test_food_tag_rules_and_retired_features(self):
        self.assertTrue(is_food_place({"amenity": "restaurant"}))
        self.assertTrue(is_food_place({"amenity": "cafe"}))
        self.assertTrue(is_food_place({"amenity": "pub", "cuisine": "Indian"}))
        self.assertFalse(is_food_place({"amenity": "pub"}))
        self.assertTrue(is_food_place({"shop": "bakery"}))
        self.assertFalse(is_food_place({"amenity": "restaurant", "disused:amenity": "restaurant"}))
        self.assertFalse(is_food_place({"amenity": "parking"}))

    def test_url_sanitization_only_keeps_plain_http_urls(self):
        self.assertEqual(safe_http_url("javascript:alert(1)", "https://example.org/menu"), "https://example.org/menu")
        self.assertIsNone(safe_http_url("javascript:alert(1)"))
        self.assertIsNone(safe_http_url("https://user:password@example.org/"))
        self.assertIsNone(safe_http_url("https://example.org/a path"))

    def test_target_descriptor_is_redacted_and_restricted_to_neon(self):
        target, host = target_description(
            "postgresql://dbuser:secret@ep-example-pooler.us-east-2.aws.neon.tech:5432/neondb?sslmode=require"
        )
        self.assertEqual(target, "neondb@ep-example-pooler.us-east-2.aws.neon.tech:5432")
        self.assertEqual(host, "ep-example-pooler.us-east-2.aws.neon.tech")
        self.assertNotIn("secret", target)
        with self.assertRaisesRegex(ValueError, "not a Neon host"):
            target_description("postgresql://user:pw@db.example.org:5432/neondb")

    def test_record_normalization_keeps_provenance_and_never_claims_a_menu(self):
        elem = ET.fromstring(
            '<node id="123" lat="52.53" lon="13.4" timestamp="2026-10-15T10:00:00Z">'
            '<tag k="amenity" v="restaurant"/><tag k="name" v="Test Restaurant"/>'
            '<tag k="addr:city" v="Berlin"/><tag k="cuisine" v="German; Curry"/>'
            '<tag k="website" v="https://example.org"/>'
            '</node>'
        )
        tags = {child.attrib["k"]: child.attrib["v"] for child in elem if child.tag == "tag"}
        row = build_record(elem, tags, "DE", "https://download.geofabrik.de/europe/germany.html", Counter())
        self.assertIsNotNone(row)
        assert row is not None
        self.assertEqual(row[0:6], ("openstreetmap", "node/123", "Test Restaurant", "DE", "Berlin", None))
        self.assertEqual(row[8:10], (52.53, 13.4))
        self.assertEqual(row[11], ["German", "Curry"])
        self.assertEqual(row[13], "https://example.org")
        self.assertEqual(row[16:21], (
            "OpenStreetMap",
            "https://download.geofabrik.de/europe/germany.html",
            "https://www.openstreetmap.org/node/123",
            LICENCE,
            ATTRIBUTION,
        ))
        self.assertIn("'NONE'", UPSERT_SQL)
        self.assertIn("discovery_places.data_origin = 'IMPORTED'", UPSERT_SQL)
        self.assertIn("discovery_places.verification_status <> 'VERIFIED'", UPSERT_SQL)
        self.assertNotIn("DELETE FROM", UPSERT_SQL.upper())

    def test_streaming_xml_keeps_multiple_records_and_skips_non_food(self):
        xml = (
            '<osm version="0.6">'
            '<node id="1" lat="10" lon="20"><tag k="amenity" v="restaurant"/><tag k="name" v="One"/></node>'
            '<node id="2" lat="11" lon="21"><tag k="amenity" v="parking"/><tag k="name" v="Car park"/></node>'
            '<node id="3" lat="12" lon="22"><tag k="shop" v="bakery"/><tag k="name" v="Three"/></node>'
            '</osm>'
        )
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "places.osm"
            path.write_text(xml, encoding="utf-8")
            stats = Counter()
            records = list(iter_records(str(path), "IN", "https://download.geofabrik.de/asia/india.html", stats))
        self.assertEqual([record[2] for record in records], ["One", "Three"])
        self.assertEqual(stats["not_food_or_lifecycle"], 1)
        self.assertEqual(stats["records_yielded"], 2)

if __name__ == "__main__":
    unittest.main()
