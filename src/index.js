#!/usr/bin/env node
'use strict';

/**
 * index.js
 *
 * Standalone webhook handler. It mirrors workflow.json step for step:
 *
 *   raw body -> Calendly signature check -> parse & validate
 *     -> HubSpot portal gate -> roster -> ledger (cancel / duplicate handling)
 *     -> contact lookup (existing owner) -> PTO freeBusy -> open-deal load per rep
 *     -> decideAssignment() -> [dry run: return decision]
 *     -> HubSpot contact owner -> HubSpot meeting -> optional calendar hand-off
 *
 * Usage:
 *   node --env-file=.env src/index.js --serve
 *   REQUIRE_SIGNATURE=false node src/index.js --fixture test/fixtures/calendly-webhook.mock.json --event 0
 *
 * Zero runtime dependencies: global fetch (Node 18+), node:http, node:crypto, node:fs.
 */

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

const { loadConfig, evaluateHubSpotTarget, describeConfig } = require('./config');
const b = require('./balancer');

const WEBHOOK_PATH = '/webhook/calendly-workload-balancer';
const MAX_BODY_BYTES = 256 * 1024;
const EXAMPLE_ROSTER = path.join(__dirname, '..', 'config', 'rep-roster.example.json');
const GOOGLE_CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3';
const RECORDED_STATUSES = ['assigned', 'existing_owner', 'fallback', 'kept_calendly_host'];

function hmacHex(secret, data) {
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

function createLogger(options) {
  const silent = Boolean(options && options.silent);
  const write = function (level, message, fields) {
    if (silent) return;
    process.stderr.write(JSON.stringify(Object.assign({ level: level, time: new Date().toISOString(), message: message }, fields || {})) + '\n');
  };
  return { info: function (m, f) { write('info', m, f); }, warn: function (m, f) { write('warn', m, f); }, error: function (m, f) { write('error', m, f); } };
}

/** JSON-over-HTTPS client with 429 / 5xx retries and timeouts. */
class JsonClient {
  constructor(options) {
    this.baseUrl = String(options.baseUrl || '').replace(/\/+$/, '');
    this.headers = options.headers || {};
    this.fetch = options.fetchImpl || globalThis.fetch;
    this.maxRetries = options.maxRetries === undefined ? 3 : options.maxRetries;
    this.baseDelayMs = options.baseDelayMs === undefined ? 400 : options.baseDelayMs;
    this.timeoutMs = options.timeoutMs || 20000;
    this.sleep = options.sleep || function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    if (typeof this.fetch !== 'function') throw new Error('No fetch implementation available (Node 18+ required).');
  }

  async request(method, urlOrPath, body) {
    const url = /^https?:\/\//.test(urlOrPath) ? urlOrPath : this.baseUrl + urlOrPath;
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(function () { controller.abort(); }, this.timeoutMs);
      let response;
      try {
        response = await this.fetch(url, {
          method: method,
          headers: Object.assign({ Accept: 'application/json' }, body === undefined || body === null ? {} : { 'Content-Type': 'application/json' }, this.headers),
          body: body === undefined || body === null ? undefined : JSON.stringify(body),
          signal: controller.signal
        });
      } catch (error) {
        clearTimeout(timer);
        if (attempt < this.maxRetries) { await this.sleep(this.baseDelayMs * Math.pow(2, attempt)); continue; }
        return { statusCode: 0, body: { message: error.message } };
      }
      clearTimeout(timer);
      const text = await response.text();
      let parsed = null;
      if (text) { try { parsed = JSON.parse(text); } catch (error) { parsed = { raw: text.slice(0, 2000) }; } }
      if ((response.status === 429 || response.status >= 500) && attempt < this.maxRetries) {
        const retryAfter = Number(response.headers && response.headers.get ? response.headers.get('retry-after') : NaN);
        await this.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : this.baseDelayMs * Math.pow(2, attempt));
        continue;
      }
      return { statusCode: response.status, body: parsed };
    }
  }
}

function expectOk(result, context) {
  if (result.statusCode >= 200 && result.statusCode < 300) return result.body;
  const detail = result.body && result.body.message ? ': ' + result.body.message : '';
  const error = new Error(context + ' failed with status ' + result.statusCode + detail);
  error.statusCode = result.statusCode;
  throw error;
}

function createLedgerStore(filePath) {
  let memory = b.emptyLedger();
  return {
    load: function () {
      if (filePath && fs.existsSync(filePath)) {
        try { memory = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (error) { memory = b.emptyLedger(); }
      }
      return JSON.parse(JSON.stringify(memory));
    },
    save: function (ledger) {
      memory = JSON.parse(JSON.stringify(ledger));
      if (filePath) fs.writeFileSync(filePath, JSON.stringify(memory, null, 2));
    }
  };
}

function seededLedgerStore(ledger) {
  const store = createLedgerStore(null);
  store.save(ledger || b.emptyLedger());
  return store;
}

function loadRosterList(cfg) {
  if (cfg.repRosterFile) return JSON.parse(fs.readFileSync(path.resolve(cfg.repRosterFile), 'utf8'));
  if (cfg.writesEnabled) throw new Error('REP_ROSTER_FILE is blank. The example roster may only be used in dry run.');
  return JSON.parse(fs.readFileSync(EXAMPLE_ROSTER, 'utf8'));
}

/** Offline clients answering from recorded responses, for tests and `npm run dry-run`. */
function createFixtureClients(fixture) {
  const responses = fixture.mock_responses;
  return {
    hubspot: {
      request: async function (method, apiPath, body) {
        if (method === 'GET' && apiPath === '/account-info/v3/details') return JSON.parse(JSON.stringify(responses.account));
        if (method === 'POST' && apiPath === '/crm/v3/objects/contacts/search') {
          const email = body.filterGroups[0].filters[0].value;
          const hit = responses.contacts[email];
          return { statusCode: 200, body: { total: hit ? 1 : 0, results: hit ? [hit] : [] } };
        }
        if (method === 'POST' && apiPath === '/crm/v3/objects/deals/search') {
          const owner = body.filterGroups[0].filters[0].value;
          const total = responses.open_deals_by_owner[owner];
          return total === undefined ? { statusCode: 500, body: { message: 'no fixture' } } : { statusCode: 200, body: { total: total, results: [] } };
        }
        return { statusCode: 404, body: { message: 'No fixture for ' + method + ' ' + apiPath } };
      }
    },
    google: {
      request: async function (method, url) {
        if (method === 'POST' && /\/freeBusy$/.test(url)) return JSON.parse(JSON.stringify(responses.freebusy));
        return { statusCode: 404, body: {} };
      }
    }
  };
}

async function handleWebhook(rawBody, headers, deps) {
  const cfg = deps.config;
  const logger = deps.logger || createLogger({ silent: true });
  const nowMs = deps.now ? deps.now().getTime() : Date.now();
  const raw = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);

  if (cfg.requireSignature) {
    const verdict = b.verifyCalendlySignature(raw, headers['calendly-webhook-signature'], cfg.calendlyWebhookSecret, nowMs, cfg.signatureToleranceSeconds, hmacHex);
    if (!verdict.ok) return { httpStatus: 401, body: { status: 'rejected', reason: verdict.reason } };
  }

  let payload;
  try { payload = JSON.parse(raw); } catch (error) { return { httpStatus: 400, body: { status: 'rejected', reason: 'invalid_json' } }; }
  const parsed = b.parseCalendlyEvent(payload);
  if (!parsed.ok) return { httpStatus: 422, body: { status: 'rejected', reason: 'invalid_payload', errors: parsed.errors } };
  const event = parsed.event;

  const hubspot = deps.hubspotClient || (cfg.hubspotApiKey
    ? new JsonClient({ baseUrl: cfg.hubspotBaseUrl, headers: { Authorization: 'Bearer ' + cfg.hubspotApiKey }, fetchImpl: deps.fetchImpl })
    : null);
  if (!hubspot) throw new Error('HUBSPOT_API_KEY is blank. Use a sandbox private app token, or --fixture for an offline dry run.');

  const account = expectOk(await hubspot.request('GET', '/account-info/v3/details'), 'HubSpot account details');
  const gate = evaluateHubSpotTarget(cfg, account);
  if (!gate.allowed) throw new Error('HubSpot access blocked by gate: ' + gate.reason);

  const roster = b.normalizeRoster(deps.roster || loadRosterList(cfg), cfg);
  if (roster.errors.length) throw new Error('Rep roster is invalid: ' + roster.errors.join('; '));
  const store = deps.ledgerStore || createLedgerStore(cfg.ledgerFile);
  let ledger = b.pruneLedger(store.load(), nowMs, cfg.assignmentWindowDays);

  if (event.type === 'invitee.canceled') {
    const out = b.releaseAssignment(ledger, event.inviteeUri);
    if (cfg.writesEnabled) store.save(out.ledger);
    return { httpStatus: 200, body: { status: 'released', writeMode: cfg.writeMode, released: out.released } };
  }

  const existing = b.findAssignment(ledger, event.inviteeUri);
  if (existing) return { httpStatus: 200, body: { status: 'duplicate', writeMode: cfg.writeMode, assignment: existing } };

  const lookupRequest = b.buildContactLookupRequest(event);
  const contact = b.readContactLookup(await hubspot.request(lookupRequest.method, lookupRequest.path, lookupRequest.body));
  const warnings = contact.ok ? [] : ['contact_lookup_failed'];

  let freeBusyResponse = null;
  const freeBusyRequest = b.buildFreeBusyRequest(roster.reps, event);
  if (cfg.ptoCheckEnabled && freeBusyRequest) {
    const google = deps.googleClient || (cfg.googleCalendarAccessToken
      ? new JsonClient({ headers: { Authorization: 'Bearer ' + cfg.googleCalendarAccessToken }, fetchImpl: deps.fetchImpl })
      : null);
    if (google) freeBusyResponse = await google.request('POST', GOOGLE_CALENDAR_BASE + '/freeBusy', freeBusyRequest);
    else warnings.push('pto_check_skipped_no_google_token');
  }
  const availability = b.applyFreeBusy(roster.reps, event, freeBusyResponse);

  const loads = {};
  for (let i = 0; i < roster.reps.length; i++) {
    const rep = roster.reps[i];
    const req = b.buildDealLoadRequest(rep);
    loads[rep.id] = b.readDealLoad(await hubspot.request(req.method, req.path, req.body));
  }

  const decision = b.decideAssignment(event, roster.reps, { event: event, availability: availability, loads: loads, ledger: ledger, contact: contact, cfg: cfg, nowMs: nowMs });
  decision.warnings = warnings.concat(decision.warnings);
  const actions = b.buildActions(decision, event, contact, roster.reps, cfg);
  logger.info('assignment_decided', { status: decision.status, rep: decision.rep && decision.rep.id, writeMode: cfg.writeMode });

  if (!cfg.writesEnabled) {
    return { httpStatus: 200, body: { status: 'dry_run', writeMode: cfg.writeMode, decision: decision, actions: actions } };
  }

  if (decision.rep && RECORDED_STATUSES.indexOf(decision.status) !== -1) {
    ledger = b.recordAssignment(ledger, { inviteeUri: event.inviteeUri, repId: decision.rep.id, assignedAt: new Date(nowMs).toISOString(), eventStart: event.startTime, status: decision.status });
    store.save(ledger); // recorded before the CRM writes, so retries never double-assign
  }

  const results = { contact: null, meeting: null, calendarEvent: null };
  let contactId = contact.contactId;
  if (actions.contact.action === 'create') {
    const created = await hubspot.request('POST', '/crm/v3/objects/contacts', { properties: actions.contact.properties });
    if (created.statusCode === 201 || created.statusCode === 200) { contactId = String(created.body.id); results.contact = 'created'; }
    else if (created.statusCode === 409) { contactId = b.parseExistingContactId(created.body); results.contact = 'exists_owner_left_unchanged'; }
    else expectOk(created, 'HubSpot contact create');
  } else if (actions.contact.action === 'set_owner') {
    expectOk(await hubspot.request('PATCH', '/crm/v3/objects/contacts/' + encodeURIComponent(actions.contact.contactId), { properties: actions.contact.properties }), 'HubSpot contact owner update');
    results.contact = 'owner_set';
  } else {
    results.contact = actions.contact.reason || 'unchanged';
  }

  if (actions.meeting) {
    const body = { properties: actions.meeting.properties };
    if (contactId) body.associations = [{ to: { id: contactId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: actions.meeting.associationTypeId }] }];
    const meeting = expectOk(await hubspot.request('POST', '/crm/v3/objects/meetings', body), 'HubSpot meeting create');
    results.meeting = meeting && meeting.id ? String(meeting.id) : 'created';
  }

  if (actions.calendarEvent) {
    const google = deps.googleClient || new JsonClient({ headers: { Authorization: 'Bearer ' + cfg.googleCalendarAccessToken }, fetchImpl: deps.fetchImpl });
    const url = GOOGLE_CALENDAR_BASE + '/calendars/' + encodeURIComponent(actions.calendarEvent.calendarId) + '/events?sendUpdates=none';
    const inserted = expectOk(await google.request('POST', url, actions.calendarEvent.body), 'Google Calendar event insert');
    results.calendarEvent = inserted && inserted.id ? 'created' : 'created_without_id';
  }

  return { httpStatus: 200, body: { status: 'written', writeMode: cfg.writeMode, decision: decision, results: results } };
}

function createWebhookServer(deps) {
  const send = function (res, status, payload) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); };
  return http.createServer(function (req, res) {
    if (req.method !== 'POST' || req.url.split('?')[0] !== WEBHOOK_PATH) return send(res, 404, { status: 'not_found' });
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on('data', function (chunk) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { aborted = true; send(res, 413, { status: 'payload_too_large' }); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', async function () {
      if (aborted) return;
      try {
        const out = await handleWebhook(Buffer.concat(chunks), req.headers, deps);
        send(res, out.httpStatus, out.body);
      } catch (error) {
        (deps.logger || createLogger()).error('webhook_failed', { error: error.message });
        send(res, 500, { status: 'error', error: error.message });
      }
    });
  });
}

function parseArgs(argv) {
  const args = { event: 0 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--serve') args.serve = true;
    else if (argv[i] === '--fixture') args.fixture = argv[++i];
    else if (argv[i] === '--event') args.event = Number(argv[++i]);
    else if (argv[i] === '--help' || argv[i] === '-h') args.help = true;
  }
  return args;
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help || (!args.serve && !args.fixture)) {
    process.stdout.write('Usage: node src/index.js --serve | --fixture <file.json> [--event <index>]\n');
    return 0;
  }
  const cfg = loadConfig(process.env);
  const logger = createLogger();
  logger.info('config_loaded', { config: describeConfig(cfg) });

  if (args.fixture) {
    if (cfg.writesEnabled) throw new Error('--fixture is only allowed in dry run.');
    const fixture = JSON.parse(fs.readFileSync(path.resolve(args.fixture), 'utf8'));
    const webhook = fixture.webhooks[args.event];
    if (!webhook) throw new Error('No webhook at index ' + args.event);
    const clients = createFixtureClients(fixture);
    const out = await handleWebhook(JSON.stringify(webhook.body), {}, {
      config: cfg, logger: logger, hubspotClient: clients.hubspot, googleClient: clients.google,
      roster: fixture.roster, ledgerStore: seededLedgerStore(fixture.ledger),
      now: function () { return new Date(fixture._meta.reference_now); }
    });
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return 0;
  }

  const server = createWebhookServer({ config: cfg, logger: logger });
  await new Promise(function (r) { server.listen(cfg.port, cfg.host, r); });
  logger.info('webhook_listening', { url: 'http://' + cfg.host + ':' + cfg.port + WEBHOOK_PATH, writeMode: cfg.writeMode });
  return null;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(function (code) { if (typeof code === 'number') process.exitCode = code; }).catch(function (error) {
    process.stderr.write(JSON.stringify({ level: 'error', message: error.message }) + '\n');
    process.exitCode = 1;
  });
}

module.exports = {
  WEBHOOK_PATH,
  hmacHex,
  JsonClient,
  createLedgerStore,
  seededLedgerStore,
  loadRosterList,
  createFixtureClients,
  handleWebhook,
  createWebhookServer,
  main
};
