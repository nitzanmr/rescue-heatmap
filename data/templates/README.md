# Data Templates

Import/export templates for interoperability with SAR tools.

## Files

- `missing-person-report.csv` — CSV template for bulk import of missing person reports
- `export-sample.kml` — KML template for GIS visualization (Google Earth, QGIS)
- `export-sample.geojson` — GeoJSON template for web map integration

## CSV Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `full_name` | string | ✅ | Full name of missing person |
| `age` | integer | | Approximate age |
| `gender` | string | | M/F/Other |
| `last_seen_lat` | float | ✅ | Latitude of last known location |
| `last_seen_lng` | float | ✅ | Longitude of last known location |
| `last_seen_address` | string | | Human-readable address or landmark |
| `last_seen_time` | ISO 8601 | | When last seen/contacted |
| `reporter_name` | string | ✅ | Who is reporting |
| `reporter_phone` | string | | Phone/WhatsApp for follow-up |
| `reporter_relation` | string | | Relationship to missing person |
| `status` | enum | | missing / found / deceased |
| `photo_url` | URL | | Link to photo if available |
| `notes` | string | | Additional information |
| `submitted_at` | ISO 8601 | auto | Timestamp of submission |

## INSARAG Compatibility

Data exports should be compatible with INSARAG Coordination & Management System (ICMS). Field mapping documentation TBD.
