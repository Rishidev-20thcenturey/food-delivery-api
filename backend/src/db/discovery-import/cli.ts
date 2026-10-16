import 'dotenv/config';
import { closePool } from '../pool.js';
import { defaultSource, describeTarget, runDiscoveryImport, type DiscoveryImportOptions } from './importer.js';
import type { AdapterId, SourceDescriptor } from './types.js';

/**
 * Operator CLI for the discovery import.
 *
 *   npm run db:import:discovery -- --file=./data/berlin.osm --adapter=osm-xml --country=DE
 *   npm run db:import:discovery -- --file=./data/partner.ndjson --adapter=ndjson --commit \
 *       --confirm-target="food_delivery@127.0.0.1:54330"
 *
 * A dry run is the default: without `--commit` nothing is written. With `--commit` the run still refuses
 * unless `--confirm-target` names the exact database it is about to touch, and it always refuses when
 * NODE_ENV=production. See backend/docs/DISCOVERY.md before importing real data.
 */

const USAGE = `
Discovery import (dry run by default)

Required
  --file=<path>              Local OSM XML (.osm) or NDJSON (.ndjson) file. Never fetched for you.

Optional
  --adapter=<id>             osm-xml | ndjson (default: inferred from the file extension)
  --country=<XX>             ISO 3166-1 alpha-2. Fills in records with no country and filters OSM records
                             outside it. Strongly recommended for OSM extracts.
  --provider=<key>           Stable provider key (default: openstreetmap | ndjson)
  --source-name=<text>       Dataset name recorded on every row
  --source-url=<url>         Dataset URL recorded on every row
  --source-licence=<id>      Licence identifier, e.g. ODbL-1.0
  --source-attribution=<t>   Required attribution text, e.g. "© OpenStreetMap contributors"
  --batch-size=<n>           1-500 (default 200)
  --limit=<n>                Stop after reading n records
  --allow-menu               Import structured menus from NDJSON records that declare permission
  --commit                   Actually write. Without it the run is a dry run.
  --confirm-target=<t>       Must equal the printed target for --commit to proceed
  --help
`;

interface ParsedArgs {
  options: DiscoveryImportOptions;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (const arg of argv) {
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument "${arg}". Expected a --flag.`);
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    if (eq === -1) flags.add(body);
    else values.set(body.slice(0, eq), body.slice(eq + 1));
  }
  if (flags.has('help')) return { help: true, options: { filePath: '', adapter: 'ndjson' } };

  const filePath = values.get('file');
  if (!filePath) throw new Error('--file=<path> is required.');

  const explicitAdapter = values.get('adapter');
  const adapter: AdapterId = explicitAdapter === 'osm-xml' || explicitAdapter === 'ndjson'
    ? explicitAdapter
    : explicitAdapter
      ? throwAdapter(explicitAdapter)
      : /\.osm$/i.test(filePath)
        ? 'osm-xml'
        : /\.ndjson$/i.test(filePath)
          ? 'ndjson'
          : throwAdapter('(inferred)');

  const base = defaultSource(adapter);
  const source: SourceDescriptor = {
    provider: (values.get('provider') ?? base.provider).trim(),
    sourceName: values.get('source-name') ?? base.sourceName,
    sourceUrl: values.get('source-url') ?? base.sourceUrl,
    sourceLicence: values.get('source-licence') ?? base.sourceLicence,
    sourceAttribution: values.get('source-attribution') ?? base.sourceAttribution,
  };

  const options: DiscoveryImportOptions = {
    filePath,
    adapter,
    source,
    dryRun: !flags.has('commit'),
    allowMenu: flags.has('allow-menu'),
  };
  if (values.has('country')) options.defaultCountryCode = values.get('country');
  if (values.has('confirm-target')) options.confirmTarget = values.get('confirm-target');
  if (values.has('batch-size')) options.batchSize = Number(values.get('batch-size'));
  if (values.has('limit')) options.limit = Number(values.get('limit'));
  if (options.batchSize !== undefined && !Number.isFinite(options.batchSize)) throw new Error('--batch-size must be a number.');
  if (options.limit !== undefined && !Number.isFinite(options.limit)) throw new Error('--limit must be a number.');

  return { help: false, options };
}

function throwAdapter(value: string): never {
  throw new Error(`--adapter must be "osm-xml" or "ndjson", got "${value}".`);
}

function report(summary: Awaited<ReturnType<typeof runDiscoveryImport>>): void {
  const mode = summary.dryRun ? 'DRY RUN (nothing written)' : 'COMMITTED';
  const lines = [
    '',
    `Discovery import — ${mode}`,
    `  target            ${summary.target}`,
    `  input             ${summary.filePath}`,
    `  adapter           ${summary.adapter}  provider: ${summary.provider}`,
    `  duration          ${summary.durationMs} ms in ${summary.batches} batch(es)`,
    '',
    `  records read      ${summary.recordsRead}`,
    `  valid             ${summary.recordsValid}`,
    `  invalid           ${summary.recordsInvalid}`,
    `  duplicates in file ${summary.duplicatesInFile}${summary.duplicateTrackingComplete ? '' : ' (tracking capped)'}`,
    '',
    `  ${summary.dryRun ? 'would insert' : 'inserted'}        ${summary.inserted}`,
    `  ${summary.dryRun ? 'would update' : 'updated'}        ${summary.updated}`,
    `  skipped protected ${summary.skippedProtected}`,
    `  menu items +${summary.menuItemsInserted} / ~${summary.menuItemsUpdated} / rejected ${summary.menuItemsRejected}`,
  ];
  const dropped = Object.entries(summary.droppedFields);
  if (dropped.length) {
    lines.push('', '  dropped fields (invalid optional values, record still imported)');
    for (const [field, count] of dropped.sort((a, b) => b[1] - a[1])) lines.push(`    ${field.padEnd(20)} ${count}`);
  }
  const adapterStats = Object.entries(summary.adapterStats);
  if (adapterStats.length) {
    lines.push('', '  adapter counters');
    for (const [key, value] of adapterStats) lines.push(`    ${key.padEnd(20)} ${value}`);
  }
  if (summary.errorCount) {
    lines.push('', `  errors (${summary.errorCount} total, showing ${summary.errors.length})`);
    for (const error of summary.errors) lines.push(`    ${error.providerRecordId ?? '(no id)'}: ${error.reason}`);
  }
  lines.push('');
  console.log(lines.join('\n'));
}

async function main(): Promise<void> {
  const { options, help } = parseArgs(process.argv.slice(2));
  if (help) {
    console.log(USAGE);
    return;
  }
  console.log(`Discovery import target: ${describeTarget()} (NODE_ENV=${process.env.NODE_ENV ?? 'development'})`);
  report(await runDiscoveryImport(options));
}

main()
  .catch((error: unknown) => {
    console.error(`Import failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(() => closePool());
