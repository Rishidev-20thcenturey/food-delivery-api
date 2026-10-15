/**
 * Static reference data for the discovery directory.
 *
 * Deliberately dependency-free: the discovery endpoints run on a free-tier Node process, and this data
 * changes a few times a decade. It is reference data only — it never invents restaurant facts. Missing
 * country, currency, or timezone information stays missing rather than being guessed.
 */

export interface CountryReference {
  /** ISO 3166-1 alpha-2. */
  readonly code: string;
  /** Common English short name. */
  readonly name: string;
  /**
   * The ISO 4217 code normally used in this country, when unambiguous. This is a convenience for the
   * importer and the UI only. It is never written to a price row on its own: a stored price always
   * carries the currency that the source actually reported.
   */
  readonly currency?: string;
}

const COUNTRY_TABLE: ReadonlyArray<readonly [string, string, string?]> = [
  ['AD', 'Andorra', 'EUR'], ['AE', 'United Arab Emirates', 'AED'], ['AF', 'Afghanistan', 'AFN'],
  ['AG', 'Antigua & Barbuda', 'XCD'], ['AI', 'Anguilla', 'XCD'], ['AL', 'Albania', 'ALL'],
  ['AM', 'Armenia', 'AMD'], ['AO', 'Angola', 'AOA'], ['AQ', 'Antarctica'],
  ['AR', 'Argentina', 'ARS'], ['AS', 'American Samoa', 'USD'], ['AT', 'Austria', 'EUR'],
  ['AU', 'Australia', 'AUD'], ['AW', 'Aruba', 'AWG'], ['AX', 'Åland Islands', 'EUR'],
  ['AZ', 'Azerbaijan', 'AZN'], ['BA', 'Bosnia & Herzegovina', 'BAM'], ['BB', 'Barbados', 'BBD'],
  ['BD', 'Bangladesh', 'BDT'], ['BE', 'Belgium', 'EUR'], ['BF', 'Burkina Faso', 'XOF'],
  ['BG', 'Bulgaria', 'BGN'], ['BH', 'Bahrain', 'BHD'], ['BI', 'Burundi', 'BIF'],
  ['BJ', 'Benin', 'XOF'], ['BL', 'Saint Barthélemy', 'EUR'], ['BM', 'Bermuda', 'BMD'],
  ['BN', 'Brunei', 'BND'], ['BO', 'Bolivia', 'BOB'], ['BQ', 'Caribbean Netherlands', 'USD'],
  ['BR', 'Brazil', 'BRL'], ['BS', 'Bahamas', 'BSD'], ['BT', 'Bhutan', 'BTN'],
  ['BV', 'Bouvet Island', 'NOK'], ['BW', 'Botswana', 'BWP'], ['BY', 'Belarus', 'BYN'],
  ['BZ', 'Belize', 'BZD'], ['CA', 'Canada', 'CAD'], ['CC', 'Cocos (Keeling) Islands', 'AUD'],
  ['CD', 'Congo - Kinshasa', 'CDF'], ['CF', 'Central African Republic', 'XAF'], ['CG', 'Congo - Brazzaville', 'XAF'],
  ['CH', 'Switzerland', 'CHF'], ['CI', "Côte d'Ivoire", 'XOF'], ['CK', 'Cook Islands', 'NZD'],
  ['CL', 'Chile', 'CLP'], ['CM', 'Cameroon', 'XAF'], ['CN', 'China', 'CNY'],
  ['CO', 'Colombia', 'COP'], ['CR', 'Costa Rica', 'CRC'], ['CU', 'Cuba', 'CUP'],
  ['CV', 'Cape Verde', 'CVE'], ['CW', 'Curaçao', 'ANG'], ['CX', 'Christmas Island', 'AUD'],
  ['CY', 'Cyprus', 'EUR'], ['CZ', 'Czechia', 'CZK'], ['DE', 'Germany', 'EUR'],
  ['DJ', 'Djibouti', 'DJF'], ['DK', 'Denmark', 'DKK'], ['DM', 'Dominica', 'XCD'],
  ['DO', 'Dominican Republic', 'DOP'], ['DZ', 'Algeria', 'DZD'], ['EC', 'Ecuador', 'USD'],
  ['EE', 'Estonia', 'EUR'], ['EG', 'Egypt', 'EGP'], ['EH', 'Western Sahara', 'MAD'],
  ['ER', 'Eritrea', 'ERN'], ['ES', 'Spain', 'EUR'], ['ET', 'Ethiopia', 'ETB'],
  ['FI', 'Finland', 'EUR'], ['FJ', 'Fiji', 'FJD'], ['FK', 'Falkland Islands', 'FKP'],
  ['FM', 'Micronesia', 'USD'], ['FO', 'Faroe Islands', 'DKK'], ['FR', 'France', 'EUR'],
  ['GA', 'Gabon', 'XAF'], ['GB', 'United Kingdom', 'GBP'], ['GD', 'Grenada', 'XCD'],
  ['GE', 'Georgia', 'GEL'], ['GF', 'French Guiana', 'EUR'], ['GG', 'Guernsey', 'GBP'],
  ['GH', 'Ghana', 'GHS'], ['GI', 'Gibraltar', 'GIP'], ['GL', 'Greenland', 'DKK'],
  ['GM', 'Gambia', 'GMD'], ['GN', 'Guinea', 'GNF'], ['GP', 'Guadeloupe', 'EUR'],
  ['GQ', 'Equatorial Guinea', 'XAF'], ['GR', 'Greece', 'EUR'], ['GS', 'South Georgia & South Sandwich Islands', 'GBP'],
  ['GT', 'Guatemala', 'GTQ'], ['GU', 'Guam', 'USD'], ['GW', 'Guinea-Bissau', 'XOF'],
  ['GY', 'Guyana', 'GYD'], ['HK', 'Hong Kong', 'HKD'], ['HM', 'Heard & McDonald Islands', 'AUD'],
  ['HN', 'Honduras', 'HNL'], ['HR', 'Croatia', 'EUR'], ['HT', 'Haiti', 'HTG'],
  ['HU', 'Hungary', 'HUF'], ['ID', 'Indonesia', 'IDR'], ['IE', 'Ireland', 'EUR'],
  ['IL', 'Israel', 'ILS'], ['IM', 'Isle of Man', 'GBP'], ['IN', 'India', 'INR'],
  ['IO', 'British Indian Ocean Territory', 'USD'], ['IQ', 'Iraq', 'IQD'], ['IR', 'Iran', 'IRR'],
  ['IS', 'Iceland', 'ISK'], ['IT', 'Italy', 'EUR'], ['JE', 'Jersey', 'GBP'],
  ['JM', 'Jamaica', 'JMD'], ['JO', 'Jordan', 'JOD'], ['JP', 'Japan', 'JPY'],
  ['KE', 'Kenya', 'KES'], ['KG', 'Kyrgyzstan', 'KGS'], ['KH', 'Cambodia', 'KHR'],
  ['KI', 'Kiribati', 'AUD'], ['KM', 'Comoros', 'KMF'], ['KN', 'Saint Kitts & Nevis', 'XCD'],
  ['KP', 'North Korea', 'KPW'], ['KR', 'South Korea', 'KRW'], ['KW', 'Kuwait', 'KWD'],
  ['KY', 'Cayman Islands', 'KYD'], ['KZ', 'Kazakhstan', 'KZT'], ['LA', 'Laos', 'LAK'],
  ['LB', 'Lebanon', 'LBP'], ['LC', 'Saint Lucia', 'XCD'], ['LI', 'Liechtenstein', 'CHF'],
  ['LK', 'Sri Lanka', 'LKR'], ['LR', 'Liberia', 'LRD'], ['LS', 'Lesotho', 'LSL'],
  ['LT', 'Lithuania', 'EUR'], ['LU', 'Luxembourg', 'EUR'], ['LV', 'Latvia', 'EUR'],
  ['LY', 'Libya', 'LYD'], ['MA', 'Morocco', 'MAD'], ['MC', 'Monaco', 'EUR'],
  ['MD', 'Moldova', 'MDL'], ['ME', 'Montenegro', 'EUR'], ['MF', 'Saint Martin', 'EUR'],
  ['MG', 'Madagascar', 'MGA'], ['MH', 'Marshall Islands', 'USD'], ['MK', 'North Macedonia', 'MKD'],
  ['ML', 'Mali', 'XOF'], ['MM', 'Myanmar (Burma)', 'MMK'], ['MN', 'Mongolia', 'MNT'],
  ['MO', 'Macao', 'MOP'], ['MP', 'Northern Mariana Islands', 'USD'], ['MQ', 'Martinique', 'EUR'],
  ['MR', 'Mauritania', 'MRU'], ['MS', 'Montserrat', 'XCD'], ['MT', 'Malta', 'EUR'],
  ['MU', 'Mauritius', 'MUR'], ['MV', 'Maldives', 'MVR'], ['MW', 'Malawi', 'MWK'],
  ['MX', 'Mexico', 'MXN'], ['MY', 'Malaysia', 'MYR'], ['MZ', 'Mozambique', 'MZN'],
  ['NA', 'Namibia', 'NAD'], ['NC', 'New Caledonia', 'XPF'], ['NE', 'Niger', 'XOF'],
  ['NF', 'Norfolk Island', 'AUD'], ['NG', 'Nigeria', 'NGN'], ['NI', 'Nicaragua', 'NIO'],
  ['NL', 'Netherlands', 'EUR'], ['NO', 'Norway', 'NOK'], ['NP', 'Nepal', 'NPR'],
  ['NR', 'Nauru', 'AUD'], ['NU', 'Niue', 'NZD'], ['NZ', 'New Zealand', 'NZD'],
  ['OM', 'Oman', 'OMR'], ['PA', 'Panama', 'PAB'], ['PE', 'Peru', 'PEN'],
  ['PF', 'French Polynesia', 'XPF'], ['PG', 'Papua New Guinea', 'PGK'], ['PH', 'Philippines', 'PHP'],
  ['PK', 'Pakistan', 'PKR'], ['PL', 'Poland', 'PLN'], ['PM', 'Saint Pierre & Miquelon', 'EUR'],
  ['PN', 'Pitcairn Islands', 'NZD'], ['PR', 'Puerto Rico', 'USD'], ['PS', 'Palestine', 'ILS'],
  ['PT', 'Portugal', 'EUR'], ['PW', 'Palau', 'USD'], ['PY', 'Paraguay', 'PYG'],
  ['QA', 'Qatar', 'QAR'], ['RE', 'Réunion', 'EUR'], ['RO', 'Romania', 'RON'],
  ['RS', 'Serbia', 'RSD'], ['RU', 'Russia', 'RUB'], ['RW', 'Rwanda', 'RWF'],
  ['SA', 'Saudi Arabia', 'SAR'], ['SB', 'Solomon Islands', 'SBD'], ['SC', 'Seychelles', 'SCR'],
  ['SD', 'Sudan', 'SDG'], ['SE', 'Sweden', 'SEK'], ['SG', 'Singapore', 'SGD'],
  ['SH', 'Saint Helena', 'SHP'], ['SI', 'Slovenia', 'EUR'], ['SJ', 'Svalbard & Jan Mayen', 'NOK'],
  ['SK', 'Slovakia', 'EUR'], ['SL', 'Sierra Leone', 'SLE'], ['SM', 'San Marino', 'EUR'],
  ['SN', 'Senegal', 'XOF'], ['SO', 'Somalia', 'SOS'], ['SR', 'Suriname', 'SRD'],
  ['SS', 'South Sudan', 'SSP'], ['ST', 'São Tomé & Príncipe', 'STN'], ['SV', 'El Salvador', 'USD'],
  ['SX', 'Sint Maarten', 'ANG'], ['SY', 'Syria', 'SYP'], ['SZ', 'Eswatini', 'SZL'],
  ['TC', 'Turks & Caicos Islands', 'USD'], ['TD', 'Chad', 'XAF'], ['TF', 'French Southern Territories', 'EUR'],
  ['TG', 'Togo', 'XOF'], ['TH', 'Thailand', 'THB'], ['TJ', 'Tajikistan', 'TJS'],
  ['TK', 'Tokelau', 'NZD'], ['TL', 'Timor-Leste', 'USD'], ['TM', 'Turkmenistan', 'TMT'],
  ['TN', 'Tunisia', 'TND'], ['TO', 'Tonga', 'TOP'], ['TR', 'Türkiye', 'TRY'],
  ['TT', 'Trinidad & Tobago', 'TTD'], ['TV', 'Tuvalu', 'AUD'], ['TW', 'Taiwan', 'TWD'],
  ['TZ', 'Tanzania', 'TZS'], ['UA', 'Ukraine', 'UAH'], ['UG', 'Uganda', 'UGX'],
  ['UM', 'U.S. Outlying Islands', 'USD'], ['US', 'United States', 'USD'], ['UY', 'Uruguay', 'UYU'],
  ['UZ', 'Uzbekistan', 'UZS'], ['VA', 'Vatican City', 'EUR'], ['VC', 'Saint Vincent & Grenadines', 'XCD'],
  ['VE', 'Venezuela', 'VES'], ['VG', 'British Virgin Islands', 'USD'], ['VI', 'U.S. Virgin Islands', 'USD'],
  ['VN', 'Vietnam', 'VND'], ['VU', 'Vanuatu', 'VUV'], ['WF', 'Wallis & Futuna', 'XPF'],
  ['WS', 'Samoa', 'WST'], ['YE', 'Yemen', 'YER'], ['YT', 'Mayotte', 'EUR'],
  ['ZA', 'South Africa', 'ZAR'], ['ZM', 'Zambia', 'ZMW'], ['ZW', 'Zimbabwe'],
];

export const COUNTRIES: readonly CountryReference[] = COUNTRY_TABLE.map(([code, name, currency]) =>
  currency ? { code, name, currency } : { code, name },
);

const COUNTRY_BY_CODE = new Map(COUNTRIES.map((country) => [country.code, country]));

export const isValidCountryCode = (value: unknown): value is string =>
  typeof value === 'string' && COUNTRY_BY_CODE.has(value);

export const countryName = (code: string): string => COUNTRY_BY_CODE.get(code)?.name ?? code;

/**
 * ISO 4217 minor-unit exponents that are NOT the common default of 2. Currencies absent from this table
 * and from `TWO_DECIMAL_CURRENCIES` are unknown to us, and unknown currencies are rejected rather than
 * assumed: guessing an exponent silently corrupts prices.
 */
const ZERO_DECIMAL_CURRENCIES = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KPW', 'KRW', 'MGA', 'PYG', 'RWF',
  'UGX', 'UYI', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);
const THREE_DECIMAL_CURRENCIES = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);
const TWO_DECIMAL_CURRENCIES = new Set([
  'AED', 'AFN', 'ALL', 'AMD', 'ANG', 'AOA', 'ARS', 'AUD', 'AWG', 'AZN', 'BAM', 'BBD', 'BDT', 'BGN',
  'BMD', 'BND', 'BOB', 'BRL', 'BSD', 'BTN', 'BWP', 'BYN', 'BZD', 'CAD', 'CDF', 'CHF', 'CNY', 'COP',
  'CRC', 'CUP', 'CVE', 'CZK', 'DKK', 'DOP', 'DZD', 'EGP', 'ERN', 'ETB', 'EUR', 'FJD', 'FKP', 'GBP',
  'GEL', 'GHS', 'GIP', 'GMD', 'GTQ', 'GYD', 'HKD', 'HNL', 'HTG', 'HUF', 'IDR', 'ILS', 'INR', 'IRR',
  'JMD', 'KES', 'KGS', 'KHR', 'KYD', 'KZT', 'LAK', 'LBP', 'LKR', 'LRD', 'LSL', 'MAD', 'MDL', 'MKD',
  'MMK', 'MNT', 'MOP', 'MRU', 'MUR', 'MVR', 'MWK', 'MXN', 'MYR', 'MZN', 'NAD', 'NGN', 'NIO', 'NOK',
  'NPR', 'NZD', 'PAB', 'PEN', 'PGK', 'PHP', 'PKR', 'PLN', 'QAR', 'RON', 'RSD', 'RUB', 'SAR', 'SBD',
  'SCR', 'SDG', 'SEK', 'SGD', 'SHP', 'SLE', 'SOS', 'SRD', 'SSP', 'STN', 'SVC', 'SYP', 'SZL', 'THB',
  'TJS', 'TMT', 'TOP', 'TRY', 'TTD', 'TWD', 'TZS', 'UAH', 'USD', 'UYU', 'UZS', 'VES', 'WST', 'XCD',
  'YER', 'ZAR', 'ZMW',
]);

/** Returns the ISO 4217 exponent for a currency, or null when we do not know it. */
export function currencyMinorUnits(currency: string): number | null {
  const code = currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) return null;
  if (ZERO_DECIMAL_CURRENCIES.has(code)) return 0;
  if (THREE_DECIMAL_CURRENCIES.has(code)) return 3;
  return TWO_DECIMAL_CURRENCIES.has(code) ? 2 : null;
}

export const isValidCurrency = (value: unknown): value is string =>
  typeof value === 'string' && currencyMinorUnits(value) !== null;

/**
 * Canonical cuisine label: 'north indian' and 'NORTH INDIAN' both become 'North Indian'.
 *
 * The importer stores labels in this form and the API canonicalises incoming cuisine filters the same way,
 * so a cuisine filter can be answered by the GIN index on `cuisines` instead of folding case per row.
 * It tidies labels; it never creates a cuisine a source did not report.
 */
export function canonicalCuisineLabel(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((word) => word.replace(/[^\p{L}\p{N}&'-]/gu, ''))
    .filter((word) => word.length > 0 && word.length <= 40)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

const TIMEZONE_SHAPE = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){0,2}$/;

let ianaTimezones: ReadonlySet<string> | null = null;

/**
 * IANA timezone identifiers, taken from the runtime's ICU data when available so the list stays current
 * without a dependency. Falls back to a shape check on runtimes without `Intl.supportedValuesOf`.
 */
function timezoneSet(): ReadonlySet<string> | null {
  if (ianaTimezones) return ianaTimezones;
  const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
  if (typeof supported !== 'function') return null;
  try {
    ianaTimezones = new Set(supported.call(Intl, 'timeZone'));
    return ianaTimezones;
  } catch {
    return null;
  }
}

export function isValidTimezone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 64 || !TIMEZONE_SHAPE.test(value)) return false;
  const known = timezoneSet();
  if (!known) return true; // Shape-checked only; the runtime has no IANA list to check against.
  if (known.has(value)) return true;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** A link is only accepted as http(s). Anything else (javascript:, data:, file:, …) is rejected. */
export function normaliseHttpUrl(value: unknown, maxLength = 2048): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) return null;
  if (!/^https?:\/\//i.test(trimmed)) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (!parsed.hostname || parsed.hostname.includes(' ')) return null;
  if (parsed.username || parsed.password) return null; // No credentials embedded in an outbound link.
  return parsed.toString().replace(/\/$/, '');
}
