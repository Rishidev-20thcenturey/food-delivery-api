# CraveDirect discovery import (manual, bounded, auditable)

This tool imports **publicly mapped food-place listings** from one Geofabrik OpenStreetMap regional extract per run. It is intentionally separate from app deployments and runs only when an operator selects **Actions → Import public food places from OpenStreetMap → Run workflow**.

## First-time setup

1. Merge the pull request that adds this workflow.
2. In the repository, open **Settings → Secrets and variables → Actions → New repository secret**.
3. Add a repository secret named \`DISCOVERY_DATABASE_URL\`. Its value must be the PostgreSQL connection string for the **same Neon project/branch used by the existing Render API**, not a new empty test database. Choose the Neon connection string in Neon Console; do not paste it into a GitHub issue, commit, workflow input, or chat.
4. Run the workflow with \`mode=dry-run\` first. It downloads the chosen regional extract, filters for food-place features, and streams the resulting XML. Dry-run does not open a database connection or write any rows. It prints a credential-free target such as \`database@host:5432\`.

## Commit a region

After reviewing the dry-run summary, run the same region again with:
- \`mode=commit\`
- \`confirm_production=true\`
- \`confirm_target\` set to the exact credential-free target printed by the dry run

The importer also refuses non-Neon hosts. A mismatched target or missing confirmation stops the run before any database write. The import writes in bounded batches and is safe to repeat: the unique OpenStreetMap object ID prevents duplicates.

## What it changes (and what it does not)

It inserts or refreshes only \`discovery_places\` records for source-listed OpenStreetMap food places. It:
- records the OpenStreetMap object URL, dataset page, ODbL 1.0 licence, and \`© OpenStreetMap contributors\` attribution;
- marks imported records as source-listed, with no structured menu and no CraveDirect restaurant link;
- never deletes rows, never links a discovery place to the orderable catalogue, and never overwrites verified or owner-submitted rows;
- never writes to restaurants, users, carts, checkout, or orders.

The schema/migration must already be applied by the backend deployment. This repository's current live API has that discovery schema.

## Coverage and licensing

Choose one bounded region per run, then repeat for other regions to grow geographic coverage across Asia, Europe, Africa, and the Americas. There is no single small, free extract that guarantees every restaurant on Earth. OpenStreetMap coverage varies by locality; missing restaurants, menus, prices, opening states, and delivery availability must not be invented.

OpenStreetMap data is licensed under the Open Database Licence 1.0 (ODbL). Keep the source attribution visible in the UI and make the licence available to users: https://www.openstreetmap.org/copyright. Source-listed data is not the same as restaurant-verified data.

This workflow does not import menus, ratings, photos, or commercial delivery information. It does not scrape delivery applications. The regional dataset is downloaded from fixed, allow-listed Geofabrik URLs; arbitrary user-supplied download URLs are not accepted.
