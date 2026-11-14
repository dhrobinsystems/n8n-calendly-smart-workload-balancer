'use strict';

/**
 * config.js
 *
 * Environment loader and safety gates for the workload balancer.
 *
 * Every value in .env.example ships blank. Blank means "use the fail-safe
 * default", and the defaults are:
 *
 *   DRY_RUN=true       Decide and return the assignment, but write nothing:
 *                      no HubSpot owner change, no meeting record, no calendar
 *                      event, and no assignment recorded in the fairness ledger.
 *   SANDBOX_MODE=true  HubSpot is used only after the portal is verified as a
 *                      SANDBOX or DEVELOPER_TEST account, and calendar hand-off
 *                      events go to SANDBOX_CALENDAR_ID instead of a rep calendar.
 *   REQUIRE_SIGNATURE=true  Unsigned or badly signed webhooks are rejected.
 *
 * SANDBOX_MODE=false additionally requires ALLOW_PRODUCTION_MODE=true. Only the
 * literal string "false" turns a safety flag off.
 *
 * The n8n-core:config region is embedded verbatim into the n8n Code nodes by
 * scripts/build-workflow.js, so it stays dependency-free.
 */

// <n8n-core:config>
const CONFIG_KEYS = [
  'DRY_RUN',
  'SANDBOX_MODE',
  'ALLOW_PRODUCTION_MODE',
  'REQUIRE_SIGNATURE',
  'SIGNATURE_TOLERANCE_SECONDS',
  'HUBSPOT_BASE_URL',
  'HUBSPOT_SANDBOX_PORTAL_ID',
  'TIMEZONE_DEFAULT',
  'PTO_CHECK_ENABLED',
  'STRICT_WORKING_HOURS',
  'ASSIGNMENT_WINDOW_DAYS',
  'WEIGHT_FAIRNESS',
  'WEIGHT_LOAD',
  'WEIGHT_TIMEZONE',
  'MAX_ACTIVE_DEALS_DEFAULT',
  'FALLBACK_REP_ID',
  'BOOKING_MODE',
  'SANDBOX_CALENDAR_ID',
  'CREATE_HUBSPOT_MEETING'
];

const SANDBOX_ACCOUNT_TYPES = ['SANDBOX', 'DEVELOPER_TEST'];

function cfgBlank(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

function safetyFlag(value) {
  if (cfgBlank(value)) return true;
  return String(value).trim().toLowerCase() !== 'false';
}

function optInFlag(value) {
  if (cfgBlank(value)) return false;
  return String(value).trim().toLowerCase() === 'true';
}

function boundedInt(value, fallback, min, max, name) {
  if (cfgBlank(value)) return fallback;
  const parsed = Number(String(value).trim());
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(name + ' must be an integer between ' + min + ' and ' + max + ' (received "' + value + '").');
  }
  return parsed;
}

function boundedNumber(value, fallback, min, max, name) {
  if (cfgBlank(value)) return fallback;
  const parsed = Number(String(value).trim());
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(name + ' must be a number between ' + min + ' and ' + max + ' (received "' + value + '").');
  }
  return parsed;
}

function validTimeZone(zone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch (error) {
    return false;
  }
}

function parseConfig(env) {
  const e = env || {};
  const dryRun = safetyFlag(e.DRY_RUN);
  const sandboxMode = safetyFlag(e.SANDBOX_MODE);
  const allowProductionMode = optInFlag(e.ALLOW_PRODUCTION_MODE);
  if (!sandboxMode && !allowProductionMode) {
    throw new Error(
      'Refusing to start: SANDBOX_MODE=false changes deal ownership in a production CRM. ' +
      'Set ALLOW_PRODUCTION_MODE=true only after validating assignments in a HubSpot sandbox.'
    );
  }

  const baseUrl = (cfgBlank(e.HUBSPOT_BASE_URL) ? 'https://api.hubapi.com' : String(e.HUBSPOT_BASE_URL).trim()).replace(/\/+$/, '');
  if (!/^https:\/\//i.test(baseUrl)) throw new Error('HUBSPOT_BASE_URL must use https://.');

  const portal = cfgBlank(e.HUBSPOT_SANDBOX_PORTAL_ID) ? null : String(e.HUBSPOT_SANDBOX_PORTAL_ID).trim();
  if (portal && !/^\d+$/.test(portal)) throw new Error('HUBSPOT_SANDBOX_PORTAL_ID must be numeric.');

  const defaultZone = cfgBlank(e.TIMEZONE_DEFAULT) ? 'UTC' : String(e.TIMEZONE_DEFAULT).trim();
  if (!validTimeZone(defaultZone)) throw new Error('TIMEZONE_DEFAULT must be a valid IANA time zone (received "' + defaultZone + '").');

  const bookingMode = cfgBlank(e.BOOKING_MODE) ? 'crm_only' : String(e.BOOKING_MODE).trim().toLowerCase();
  if (bookingMode !== 'crm_only' && bookingMode !== 'calendar_handoff') throw new Error('BOOKING_MODE must be "crm_only" or "calendar_handoff".');

  const weights = {
    fairness: boundedNumber(e.WEIGHT_FAIRNESS, 0.5, 0, 1, 'WEIGHT_FAIRNESS'),
    load: boundedNumber(e.WEIGHT_LOAD, 0.3, 0, 1, 'WEIGHT_LOAD'),
    timezone: boundedNumber(e.WEIGHT_TIMEZONE, 0.2, 0, 1, 'WEIGHT_TIMEZONE')
  };
  if (weights.fairness + weights.load + weights.timezone <= 0) throw new Error('At least one of WEIGHT_FAIRNESS, WEIGHT_LOAD, WEIGHT_TIMEZONE must be above 0.');

  const fallbackRep = cfgBlank(e.FALLBACK_REP_ID) ? null : String(e.FALLBACK_REP_ID).trim();
  if (fallbackRep && !/^[A-Za-z0-9_-]{1,64}$/.test(fallbackRep)) throw new Error('FALLBACK_REP_ID may only contain letters, digits, "-" and "_".');

  const sandboxCalendar = cfgBlank(e.SANDBOX_CALENDAR_ID) ? null : String(e.SANDBOX_CALENDAR_ID).trim();
  const writeMode = dryRun ? 'dry_run' : (sandboxMode ? 'sandbox' : 'production');
  if (writeMode === 'sandbox' && bookingMode === 'calendar_handoff' && !sandboxCalendar) {
    throw new Error('BOOKING_MODE=calendar_handoff in sandbox mode requires SANDBOX_CALENDAR_ID (a test calendar).');
  }

  return {
    dryRun: dryRun,
    sandboxMode: sandboxMode,
    allowProductionMode: allowProductionMode,
    writeMode: writeMode,
    writesEnabled: writeMode !== 'dry_run',
    requireSignature: safetyFlag(e.REQUIRE_SIGNATURE),
    signatureToleranceSeconds: boundedInt(e.SIGNATURE_TOLERANCE_SECONDS, 180, 30, 900, 'SIGNATURE_TOLERANCE_SECONDS'),
    hubspotBaseUrl: baseUrl,
    sandboxPortalId: portal,
    timezoneDefault: defaultZone,
    ptoCheckEnabled: safetyFlag(e.PTO_CHECK_ENABLED),
    strictWorkingHours: safetyFlag(e.STRICT_WORKING_HOURS),
    assignmentWindowDays: boundedInt(e.ASSIGNMENT_WINDOW_DAYS, 14, 1, 180, 'ASSIGNMENT_WINDOW_DAYS'),
    weights: weights,
    maxActiveDealsDefault: boundedInt(e.MAX_ACTIVE_DEALS_DEFAULT, 40, 1, 10000, 'MAX_ACTIVE_DEALS_DEFAULT'),
    fallbackRepId: fallbackRep,
    bookingMode: bookingMode,
    sandboxCalendarId: sandboxCalendar,
    createHubspotMeeting: safetyFlag(e.CREATE_HUBSPOT_MEETING)
  };
}

function evaluateHubSpotTarget(cfg, account) {
  if (!cfg) return { allowed: false, reason: 'missing_config' };
  if (!cfg.sandboxMode) {
    return cfg.allowProductionMode
      ? { allowed: true, reason: 'production_mode_explicitly_allowed' }
      : { allowed: false, reason: 'production_mode_not_allowed' };
  }
  const type = String((account && account.accountType) || '').toUpperCase();
  if (SANDBOX_ACCOUNT_TYPES.indexOf(type) === -1) {
    return { allowed: false, reason: 'sandbox_mode_requires_sandbox_or_developer_test_portal (received "' + (type || 'unknown') + '")' };
  }
  if (cfg.sandboxPortalId && String(account.portalId) !== cfg.sandboxPortalId) {
    return { allowed: false, reason: 'sandbox_portal_id_mismatch' };
  }
  return { allowed: true, reason: 'sandbox_portal_verified' };
}
// </n8n-core:config>

/** Full runtime config for the standalone engine, including secrets. */
function loadConfig(env) {
  const source = env || process.env;
  const settings = parseConfig(source);
  const secret = function (name) { return cfgBlank(source[name]) ? null : String(source[name]).trim(); };
  const cfg = Object.assign({}, settings, {
    calendlyWebhookSecret: secret('CALENDLY_WEBHOOK_SECRET'),
    hubspotApiKey: secret('HUBSPOT_API_KEY'),
    googleCalendarAccessToken: secret('GOOGLE_CALENDAR_ACCESS_TOKEN'),
    repRosterFile: secret('REP_ROSTER_FILE'),
    ledgerFile: secret('LEDGER_FILE'),
    host: secret('HOST') || '127.0.0.1',
    port: boundedInt(source.PORT, 8790, 1, 65535, 'PORT')
  });
  if (cfg.requireSignature && !cfg.calendlyWebhookSecret) {
    throw new Error('REQUIRE_SIGNATURE is on (the default) but CALENDLY_WEBHOOK_SECRET is blank.');
  }
  return Object.freeze(cfg);
}

function describeConfig(cfg) {
  const view = Object.assign({}, cfg);
  ['calendlyWebhookSecret', 'hubspotApiKey', 'googleCalendarAccessToken'].forEach(function (key) {
    if (key in view) view[key] = view[key] ? '[redacted]' : null;
  });
  return view;
}

module.exports = {
  CONFIG_KEYS,
  SANDBOX_ACCOUNT_TYPES,
  safetyFlag,
  optInFlag,
  validTimeZone,
  parseConfig,
  evaluateHubSpotTarget,
  loadConfig,
  describeConfig
};
