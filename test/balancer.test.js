'use strict';

/**
 * balancer.test.js
 *
 * Run with: npm test   (node --test, zero dependencies)
 *
 *   1. Config fail-safe defaults and gates
 *   2. Signature verification and payload validation
 *   3. Roster, timezone, working hours, PTO, deal load, ledger
 *   4. Scoring and assignment decisions (hand-computed)
 *   5. Long-run fairness simulation (true weighted round robin)
 *   6. Actions: contact owner, meeting, calendar hand-off
 *   7. Engine end-to-end: dry run, sandbox writes, retries, cancellations, server
 *   8. workflow.json validation, gate topology, and Code-node parity
 *   9. Repository security scan
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const config = require('../src/config');
const b = require('../src/balancer');
const engine = require('../src/index');
const builder = require('../scripts/build-workflow');
const validator = require('../scripts/validate-workflow');

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'calendly-webhook.mock.json'), 'utf8'));
const NOW = new Date(FIXTURE._meta.reference_now);
const SECRET = 'mock_signing_key_for_tests';
const N = builder.NODES;

function plain(v) { return JSON.parse(JSON.stringify(v)); }
function cfgFrom(env) { return config.parseConfig(env || {}); }
function hmac(secret, data) { return crypto.createHmac('sha256', secret).update(data).digest('hex'); }
function sign(raw, atMs) {
  const t = String(Math.floor((atMs || NOW.getTime()) / 1000));
  return 't=' + t + ',v1=' + hmac(SECRET, t + '.' + raw);
}
function webhook(i) { return plain(FIXTURE.webhooks[i].body); }
function event(i) { return b.parseCalendlyEvent(webhook(i)).event; }
function roster(cfg) { return b.normalizeRoster(plain(FIXTURE.roster), cfg || cfgFrom()).reps; }
function fixtureAvailability(reps, ev) { return b.applyFreeBusy(reps, ev, plain(FIXTURE.mock_responses.freebusy)); }
function fixtureLoads(reps) {
  const loads = {};
  reps.forEach(function (r) { loads[r.id] = FIXTURE.mock_responses.open_deals_by_owner[r.hubspotOwnerId]; });
  return loads;
}
function ctxFor(ev, overrides) {
  const cfg = (overrides && overrides.cfg) || cfgFrom();
  const reps = (overrides && overrides.reps) || roster(cfg);
  return Object.assign({
    event: ev, availability: fixtureAvailability(reps, ev), loads: fixtureLoads(reps), ledger: plain(FIXTURE.ledger),
    contact: { ok: true, found: false, contactId: null, ownerId: null }, cfg: cfg, nowMs: NOW.getTime()
  }, overrides || {}, { cfg: cfg, reps: undefined });
}

// ---------------------------------------------------------------------------
// 1. Config
// ---------------------------------------------------------------------------

test('config: a blank environment means DRY_RUN, SANDBOX_MODE, and signature checks are all on', function () {
  const cfg = cfgFrom({});
  assert.deepEqual([cfg.dryRun, cfg.sandboxMode, cfg.writeMode, cfg.writesEnabled, cfg.requireSignature], [true, true, 'dry_run', false, true]);
  assert.deepEqual([cfg.timezoneDefault, cfg.assignmentWindowDays, cfg.bookingMode, cfg.ptoCheckEnabled, cfg.strictWorkingHours], ['UTC', 14, 'crm_only', true, true]);
  assert.deepEqual(cfg.weights, { fairness: 0.5, load: 0.3, timezone: 0.2 });
  const blanks = {};
  config.CONFIG_KEYS.forEach(function (k) { blanks[k] = ''; });
  assert.deepEqual(cfgFrom(blanks), cfg, 'explicit blank values behave like unset values');
});

test('config: only the literal string "false" disables a safety flag', function () {
  ['0', 'no', 'off', 'flase', ' '].forEach(function (v) {
    assert.equal(cfgFrom({ DRY_RUN: v }).dryRun, true, 'DRY_RUN=' + JSON.stringify(v));
    assert.equal(cfgFrom({ REQUIRE_SIGNATURE: v }).requireSignature, true);
  });
  assert.equal(cfgFrom({ DRY_RUN: 'FALSE' }).writeMode, 'sandbox');
});

test('config: production needs ALLOW_PRODUCTION_MODE; sandbox hand-off needs a sandbox calendar', function () {
  assert.throws(function () { cfgFrom({ SANDBOX_MODE: 'false' }); }, /ALLOW_PRODUCTION_MODE/);
  assert.equal(cfgFrom({ SANDBOX_MODE: 'false', ALLOW_PRODUCTION_MODE: 'true', DRY_RUN: 'false' }).writeMode, 'production');
  assert.throws(function () { cfgFrom({ DRY_RUN: 'false', BOOKING_MODE: 'calendar_handoff' }); }, /SANDBOX_CALENDAR_ID/);
  assert.doesNotThrow(function () { cfgFrom({ DRY_RUN: 'false', BOOKING_MODE: 'calendar_handoff', SANDBOX_CALENDAR_ID: 'sandbox@calendar.example.com' }); });
});

test('config: values are validated', function () {
  assert.throws(function () { cfgFrom({ TIMEZONE_DEFAULT: 'Mars/Base' }); }, /TIMEZONE_DEFAULT/);
  assert.throws(function () { cfgFrom({ WEIGHT_LOAD: '2' }); }, /WEIGHT_LOAD/);
  assert.throws(function () { cfgFrom({ WEIGHT_FAIRNESS: '0', WEIGHT_LOAD: '0', WEIGHT_TIMEZONE: '0' }); }, /At least one/);
  assert.throws(function () { cfgFrom({ BOOKING_MODE: 'auto' }); }, /BOOKING_MODE/);
  assert.throws(function () { cfgFrom({ FALLBACK_REP_ID: 'rep 1' }); }, /FALLBACK_REP_ID/);
  assert.throws(function () { cfgFrom({ SIGNATURE_TOLERANCE_SECONDS: '5' }); }, /SIGNATURE_TOLERANCE_SECONDS/);
  assert.throws(function () { cfgFrom({ HUBSPOT_BASE_URL: 'http://api.example.com' }); }, /https/);
});

test('config: loadConfig refuses to start without a webhook secret while signatures are required', function () {
  assert.throws(function () { config.loadConfig({}); }, /CALENDLY_WEBHOOK_SECRET/);
  const cfg = config.loadConfig({ CALENDLY_WEBHOOK_SECRET: 'mock_token_here', HUBSPOT_API_KEY: 'mock_token_here' });
  assert.equal(config.describeConfig(cfg).calendlyWebhookSecret, '[redacted]');
  assert.equal(config.describeConfig(cfg).hubspotApiKey, '[redacted]');
});

test('config: HubSpot gate allows only sandbox or developer test portals in sandbox mode', function () {
  const cfg = cfgFrom();
  assert.equal(config.evaluateHubSpotTarget(cfg, { accountType: 'STANDARD' }).allowed, false);
  assert.equal(config.evaluateHubSpotTarget(cfg, { accountType: 'DEVELOPER_TEST', portalId: 1001 }).allowed, true);
  assert.equal(config.evaluateHubSpotTarget(cfgFrom({ HUBSPOT_SANDBOX_PORTAL_ID: '2002' }), { accountType: 'SANDBOX', portalId: 1001 }).reason, 'sandbox_portal_id_mismatch');
});

// ---------------------------------------------------------------------------
// 2. Signature and payload
// ---------------------------------------------------------------------------

test('signature: valid Calendly signatures pass; tampering, replay, and malformed headers fail', function () {
  const raw = JSON.stringify(webhook(0));
  const now = NOW.getTime();
  assert.deepEqual(b.verifyCalendlySignature(raw, sign(raw), SECRET, now, 180, hmac), { ok: true, reason: null });
  assert.equal(b.verifyCalendlySignature(raw + ' ', sign(raw), SECRET, now, 180, hmac).reason, 'signature_mismatch');
  assert.equal(b.verifyCalendlySignature(raw, sign(raw, now - 600000), SECRET, now, 180, hmac).reason, 'signature_timestamp_outside_tolerance');
  assert.equal(b.verifyCalendlySignature(raw, 'v1=abc', SECRET, now, 180, hmac).reason, 'signature_header_malformed');
  assert.equal(b.verifyCalendlySignature(raw, null, SECRET, now, 180, hmac).reason, 'signature_header_missing');
  assert.equal(b.verifyCalendlySignature(raw, sign(raw), '', now, 180, hmac).reason, 'webhook_secret_not_configured');
  assert.equal(b.constantTimeEqual('abc', 'abd'), false);
  assert.equal(b.constantTimeEqual('abc', 'abc'), true);
});

test('payload: invitee.created is normalized into the canonical event', function () {
  const ev = event(0);
  assert.deepEqual([ev.type, ev.inviteeEmail, ev.inviteeTimezone, ev.startTime, ev.endTime, ev.eventName], [
    'invitee.created', 'new.buyer@example.org', 'America/Chicago', '2026-11-17T17:00:00.000Z', '2026-11-17T17:30:00.000Z', 'Discovery Call'
  ]);
  assert.deepEqual(ev.calendlyHostEmails, ['intake@example.com']);
  assert.equal(ev.joinUrl, 'https://meet.example.com/mock-room-101');
});

test('payload: invalid and unsupported webhooks are rejected with reasons', function () {
  assert.deepEqual(b.parseCalendlyEvent(webhook(4)).errors, ['invitee_email_missing_or_invalid']);
  assert.deepEqual(b.parseCalendlyEvent({ event: 'routing_form_submission.created' }).errors, ['unsupported_event:routing_form_submission.created']);
  assert.deepEqual(b.parseCalendlyEvent([]).errors, ['payload_must_be_a_json_object']);
  const flipped = webhook(0);
  flipped.payload.scheduled_event.end_time = flipped.payload.scheduled_event.start_time;
  assert.deepEqual(b.parseCalendlyEvent(flipped).errors, ['end_time_not_after_start_time']);
  const badZone = webhook(0);
  badZone.payload.timezone = 'Not/AZone';
  assert.equal(b.parseCalendlyEvent(badZone).event.inviteeTimezone, null, 'an invalid zone falls back to TIMEZONE_DEFAULT later');
});

// ---------------------------------------------------------------------------
// 3. Roster, time, PTO, load, ledger
// ---------------------------------------------------------------------------

test('roster: the example roster is valid and errors are reported per rep', function () {
  assert.equal(roster().length, 4);
  assert.deepEqual(plain(FIXTURE.roster), JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'rep-roster.example.json'), 'utf8')));
  const bad = b.normalizeRoster([
    { id: 'REP_ID_01', email: 'not-an-email', timezone: 'America/New_York', hubspotOwnerId: '1001' },
    { id: 'REP_ID_01', email: 'rep@example.com', timezone: 'America/New_York', hubspotOwnerId: '1002' },
    { id: 'bad id', email: 'rep@example.com' },
    { id: 'REP_ID_09', email: 'rep09@example.com', timezone: 'Nowhere', hubspotOwnerId: 'abc', weight: 0, workingHours: { start: '18:00', end: '09:00', days: [0] } }
  ], cfgFrom());
  assert.equal(bad.reps.length, 0);
  ['REP_ID_01: email', 'duplicate id REP_ID_01', 'rep[2]: id must match', 'REP_ID_09: timezone', 'REP_ID_09: hubspotOwnerId', 'REP_ID_09: weight', 'REP_ID_09: workingHours start/end', 'REP_ID_09: workingHours.days'].forEach(function (msg) {
    assert.ok(bad.errors.some(function (e) { return e.indexOf(msg) !== -1; }), msg);
  });
  assert.deepEqual(b.normalizeRoster([], cfgFrom()).errors, ['roster_empty_or_not_an_array']);
});

test('time: regions, offsets with DST, and working hours are computed in each zone', function () {
  assert.deepEqual(['America/Chicago', 'Europe/Berlin', 'Asia/Dubai', 'Asia/Singapore', 'Australia/Sydney', 'UTC', 'Etc/GMT+3'].map(b.regionForTimezone), ['AMER', 'EMEA', 'EMEA', 'APAC', 'APAC', 'EMEA', 'UNKNOWN']);
  assert.equal(b.timeZoneOffsetMinutes('America/New_York', Date.parse('2026-11-17T17:00:00Z')), -300);
  assert.equal(b.timeZoneOffsetMinutes('America/New_York', Date.parse('2026-07-01T17:00:00Z')), -240);
  assert.equal(b.timeZoneOffsetMinutes('Asia/Singapore', Date.parse('2026-11-17T17:00:00Z')), 480);
  const reps = roster();
  const s = Date.parse('2026-11-17T17:00:00Z');
  const e = Date.parse('2026-11-17T17:30:00Z');
  assert.deepEqual(reps.map(function (r) { return b.withinWorkingHours(r, s, e); }), [true, true, true, false]);
  assert.equal(b.withinWorkingHours(reps[0], Date.parse('2026-11-21T17:00:00Z'), Date.parse('2026-11-21T17:30:00Z')), false, 'Saturday');
});

test('pto: freeBusy request covers each PTO calendar once and overlaps mark reps unavailable', function () {
  const reps = roster();
  const ev = event(0);
  const req = b.buildFreeBusyRequest(reps, ev);
  assert.deepEqual([req.timeMin, req.timeMax, req.items.length], [ev.startTime, ev.endTime, 4]);
  const availability = fixtureAvailability(reps, ev);
  assert.deepEqual(reps.map(function (r) { return availability[r.id].onPto; }), [true, false, false, false]);
  const failed = b.applyFreeBusy(reps, ev, { statusCode: 403, body: {} });
  assert.equal(failed.REP_ID_01.note, 'pto_check_failed');
  const unreadable = b.applyFreeBusy(reps, ev, { statusCode: 200, body: { calendars: { 'pto-rep01@calendar.example.com': { errors: [{ reason: 'notFound' }] } } } });
  assert.equal(unreadable.REP_ID_01.note, 'pto_calendar_unreadable');
  assert.equal(b.buildFreeBusyRequest(reps.map(function (r) { return Object.assign({}, r, { ptoCalendarId: null }); }), ev), null);
});

test('load: open-deal search filters by owner and open status, and reads the total', function () {
  const req = b.buildDealLoadRequest(roster()[0]);
  assert.equal(req.path, '/crm/v3/objects/deals/search');
  assert.deepEqual(req.body.filterGroups[0].filters, [
    { propertyName: 'hubspot_owner_id', operator: 'EQ', value: '1001' },
    { propertyName: 'hs_is_closed', operator: 'EQ', value: 'false' }
  ]);
  assert.equal(b.readDealLoad({ statusCode: 200, body: { total: 7 } }), 7);
  assert.equal(b.readDealLoad({ statusCode: 429, body: {} }), null);
});

test('ledger: prune, record, find, and release behave idempotently', function () {
  const pruned = b.pruneLedger(plain(FIXTURE.ledger), NOW.getTime(), 14);
  assert.equal(pruned.assignments.length, 7, 'the 2026-10-15 entry is outside the 14-day window');
  const entry = { inviteeUri: 'urn:x', repId: 'REP_ID_01', assignedAt: NOW.toISOString() };
  const once = b.recordAssignment(pruned, entry);
  const twice = b.recordAssignment(once, entry);
  assert.equal(twice.assignments.length, 8);
  assert.equal(b.findAssignment(twice, 'urn:x').repId, 'REP_ID_01');
  const out = b.releaseAssignment(twice, 'urn:x');
  assert.deepEqual([out.released.repId, out.ledger.assignments.length], ['REP_ID_01', 7]);
  assert.equal(b.releaseAssignment(out.ledger, 'urn:x').released, null);
});

// ---------------------------------------------------------------------------
// 4. Scoring and decisions
// ---------------------------------------------------------------------------

test('scoring: fixture scenario matches a hand calculation', function () {
  const ev = event(0);
  const reps = roster();
  const scored = b.scoreCandidates(reps, ctxFor(ev));
  assert.deepEqual(scored.excluded, [{ repId: 'REP_ID_01', reasons: ['on_pto'] }, { repId: 'REP_ID_04', reasons: ['outside_working_hours'] }]);
  assert.deepEqual([scored.inviteeTimezone, scored.inviteeRegion], ['America/Chicago', 'AMER']);
  const byId = {};
  scored.candidates.forEach(function (c) { byId[c.repId] = c; });
  // Eligible: REP_ID_02 (weight 1, 2 recent, 38/40 deals) and REP_ID_03 (weight 1.5, 3 recent, 20/50 deals).
  // Target shares 0.4 / 0.6 equal actual shares 2/5 and 3/5, so fairness is 0 for both.
  assert.deepEqual([byId.REP_ID_02.breakdown.fairness, byId.REP_ID_03.breakdown.fairness], [0, 0]);
  // REP_ID_02: 0.3 * (1 - 38/40) + 0.2 * 1 (AMER) = 0.215
  assert.equal(byId.REP_ID_02.score, 0.215);
  // REP_ID_03: 0.3 * (1 - 20/50) + 0.2 * (1 - 6/12) (London vs Chicago, 6 h) = 0.28
  assert.equal(byId.REP_ID_03.score, 0.28);
  assert.equal(scored.candidates[0].repId, 'REP_ID_03');
});

test('decision: weighted round robin, existing-owner routing, and its PTO override', function () {
  const reps = roster();
  const d0 = b.decideAssignment(event(0), reps, ctxFor(event(0)));
  assert.deepEqual([d0.status, d0.rep.id, d0.reason, d0.hostMatches], ['assigned', 'REP_ID_03', 'weighted_round_robin', false]);

  const owned = { ok: true, found: true, contactId: '5001', ownerId: '1002' };
  const d1 = b.decideAssignment(event(1), reps, ctxFor(event(1), { contact: owned }));
  assert.deepEqual([d1.status, d1.rep.id], ['existing_owner', 'REP_ID_02']);

  const ownedByPto = { ok: true, found: true, contactId: '5001', ownerId: '1001' };
  const d2 = b.decideAssignment(event(1), reps, ctxFor(event(1), { contact: ownedByPto }));
  assert.deepEqual([d2.status, d2.reason], ['assigned', 'existing_owner_unavailable_round_robin']);
  assert.ok(d2.warnings.some(function (w) { return w === 'existing_owner_REP_ID_01_excluded:on_pto'; }));
});

test('decision: capacity, strict hours, fallback, Calendly host, and unassigned paths', function () {
  const reps = roster();
  const ev = event(0);
  const full = {};
  reps.forEach(function (r) { full[r.id] = r.maxActiveDeals; });
  const noOne = ctxFor(ev, { loads: full });
  assert.equal(b.scoreCandidates(reps, noOne).excluded.find(function (x) { return x.repId === 'REP_ID_02'; }).reasons[0], 'at_deal_capacity');
  assert.deepEqual([b.decideAssignment(ev, reps, noOne).status, b.decideAssignment(ev, reps, noOne).rep], ['unassigned', null]);

  const withFallback = ctxFor(ev, { loads: full, cfg: cfgFrom({ FALLBACK_REP_ID: 'REP_ID_04' }) });
  assert.deepEqual([b.decideAssignment(ev, reps, withFallback).status, b.decideAssignment(ev, reps, withFallback).rep.id], ['fallback', 'REP_ID_04']);

  const hosted = plain(ev);
  hosted.calendlyHostEmails = ['rep02@example.com'];
  const keep = b.decideAssignment(hosted, reps, ctxFor(hosted, { loads: full }));
  assert.deepEqual([keep.status, keep.rep.id, keep.hostMatches], ['kept_calendly_host', 'REP_ID_02', true]);

  const relaxed = b.scoreCandidates(reps, ctxFor(ev, { cfg: cfgFrom({ STRICT_WORKING_HOURS: 'false' }) }));
  const sg = relaxed.candidates.find(function (c) { return c.repId === 'REP_ID_04'; });
  assert.ok(sg, 'outside-hours rep becomes a candidate when hours are soft');
  assert.equal(sg.breakdown.workingHoursPenalty, 0.25);
});

test('decision: unknown deal load and PTO failures are warned about, not hidden', function () {
  const reps = roster();
  const ev = event(0);
  const loads = fixtureLoads(reps);
  loads.REP_ID_03 = null;
  const ctx = ctxFor(ev, { loads: loads, availability: b.applyFreeBusy(reps, ev, { statusCode: 500, body: {} }) });
  const d = b.decideAssignment(ev, reps, ctx);
  assert.ok(d.warnings.includes('REP_ID_03:deal_load_unknown'));
  assert.ok(d.warnings.includes('REP_ID_01:pto_check_failed'));
  assert.equal(d.candidates.find(function (c) { return c.repId === 'REP_ID_03'; }).breakdown.loadRatio, 0.5);
});

test('decision: ties break on least recently assigned, then rep ID', function () {
  const cfg = cfgFrom({ WEIGHT_LOAD: '0', WEIGHT_TIMEZONE: '0' });
  const reps = roster(cfg).slice(0, 2).map(function (r) { return Object.assign({}, r, { ptoCalendarId: null }); });
  const ev = event(0);
  const ledger = { assignments: [
    { inviteeUri: 'a', repId: 'REP_ID_01', assignedAt: '2026-11-15T09:00:00.000Z' },
    { inviteeUri: 'b', repId: 'REP_ID_02', assignedAt: '2026-11-14T09:00:00.000Z' }
  ] };
  const ctx = ctxFor(ev, { cfg: cfg, ledger: ledger, availability: {}, loads: { REP_ID_01: 1, REP_ID_02: 1 } });
  assert.equal(b.decideAssignment(ev, reps, ctx).rep.id, 'REP_ID_02', 'REP_ID_02 waited longest');
  const empty = ctxFor(ev, { cfg: cfg, ledger: { assignments: [] }, availability: {}, loads: { REP_ID_01: 1, REP_ID_02: 1 } });
  assert.equal(b.decideAssignment(ev, reps, empty).rep.id, 'REP_ID_01');
});

// ---------------------------------------------------------------------------
// 5. Fairness simulation
// ---------------------------------------------------------------------------

test('fairness: 120 bookings distribute in proportion to rep weights', function () {
  const cfg = cfgFrom({ WEIGHT_LOAD: '0', WEIGHT_TIMEZONE: '0', ASSIGNMENT_WINDOW_DAYS: '180' });
  const reps = b.normalizeRoster([
    { id: 'REP_ID_01', email: 'rep01@example.com', timezone: 'UTC', hubspotOwnerId: '1001', weight: 1, workingHours: { start: '00:00', end: '23:59', days: [1, 2, 3, 4, 5, 6, 7] } },
    { id: 'REP_ID_02', email: 'rep02@example.com', timezone: 'UTC', hubspotOwnerId: '1002', weight: 2, workingHours: { start: '00:00', end: '23:59', days: [1, 2, 3, 4, 5, 6, 7] } },
    { id: 'REP_ID_03', email: 'rep03@example.com', timezone: 'UTC', hubspotOwnerId: '1003', weight: 3, workingHours: { start: '00:00', end: '23:59', days: [1, 2, 3, 4, 5, 6, 7] } }
  ], cfg).reps;
  let ledger = { assignments: [] };
  const counts = { REP_ID_01: 0, REP_ID_02: 0, REP_ID_03: 0 };
  for (let i = 0; i < 120; i++) {
    const ev = Object.assign(event(0), { inviteeUri: 'urn:sim:' + i, calendlyHostEmails: [] });
    const nowMs = NOW.getTime() + i * 60000;
    const d = b.decideAssignment(ev, reps, { event: ev, availability: {}, loads: {}, ledger: ledger, contact: null, cfg: cfg, nowMs: nowMs });
    counts[d.rep.id]++;
    ledger = b.recordAssignment(ledger, { inviteeUri: ev.inviteeUri, repId: d.rep.id, assignedAt: new Date(nowMs).toISOString() });
  }
  assert.ok(Math.abs(counts.REP_ID_01 - 20) <= 1, JSON.stringify(counts));
  assert.ok(Math.abs(counts.REP_ID_02 - 40) <= 1, JSON.stringify(counts));
  assert.ok(Math.abs(counts.REP_ID_03 - 60) <= 1, JSON.stringify(counts));
});

// ---------------------------------------------------------------------------
// 6. Actions
// ---------------------------------------------------------------------------

test('actions: new contacts get the rep as owner; existing owners are never overwritten', function () {
  const reps = roster();
  const ev = event(0);
  const d = b.decideAssignment(ev, reps, ctxFor(ev));
  const create = b.buildActions(d, ev, { found: false }, reps, cfgFrom());
  assert.deepEqual(create.contact, { action: 'create', properties: { email: 'new.buyer@example.org', hubspot_owner_id: '1003', firstname: 'Jordan', lastname: 'Buyer' } });
  assert.deepEqual(b.buildActions(d, ev, { found: true, contactId: '5009', ownerId: null }, reps, cfgFrom()).contact, { action: 'set_owner', contactId: '5009', properties: { hubspot_owner_id: '1003' } });
  assert.equal(b.buildActions(d, ev, { found: true, contactId: '5009', ownerId: '1004' }, reps, cfgFrom()).contact.action, 'none');
  const m = create.meeting;
  assert.deepEqual([m.properties.hubspot_owner_id, m.properties.hs_meeting_start_time, m.properties.hs_meeting_outcome, m.associationTypeId], ['1003', ev.startTime, 'SCHEDULED', 200]);
  assert.equal(create.calendarEvent, null, 'crm_only is the default booking mode');
});

test('actions: calendar hand-off goes to the sandbox calendar without attendees in sandbox mode', function () {
  const reps = roster();
  const ev = event(0);
  const d = b.decideAssignment(ev, reps, ctxFor(ev));
  const sbx = b.buildActions(d, ev, { found: false }, reps, cfgFrom({ BOOKING_MODE: 'calendar_handoff', SANDBOX_CALENDAR_ID: 'sandbox@calendar.example.com' }));
  assert.deepEqual([sbx.calendarEvent.calendarId, sbx.calendarEvent.body.attendees, sbx.calendarEvent.body.summary.indexOf('[SANDBOX]')], ['sandbox@calendar.example.com', [], 0]);
  const prodCfg = cfgFrom({ BOOKING_MODE: 'calendar_handoff', SANDBOX_MODE: 'false', ALLOW_PRODUCTION_MODE: 'true' });
  const prod = b.buildActions(d, ev, { found: false }, reps, prodCfg);
  assert.deepEqual([prod.calendarEvent.calendarId, prod.calendarEvent.body.attendees], ['rep03@example.com', [{ email: 'rep03@example.com' }]]);
  const same = Object.assign({}, d, { hostMatches: true });
  assert.equal(b.buildActions(same, ev, { found: false }, reps, prodCfg).calendarEvent, null, 'no hand-off when Calendly already booked the chosen rep');
  assert.equal(b.parseExistingContactId({ message: 'Contact already exists. Existing ID: 5001' }), '5001');
});

// ---------------------------------------------------------------------------
// 7. Engine end-to-end
// ---------------------------------------------------------------------------

function engineDeps(env, extra) {
  const cfg = config.loadConfig(Object.assign({ CALENDLY_WEBHOOK_SECRET: SECRET, HUBSPOT_API_KEY: 'mock_token_here' }, env || {}));
  const clients = engine.createFixtureClients(plain(FIXTURE));
  return Object.assign({ config: cfg, hubspotClient: clients.hubspot, googleClient: clients.google, roster: plain(FIXTURE.roster), ledgerStore: engine.seededLedgerStore(plain(FIXTURE.ledger)), now: function () { return NOW; } }, extra || {});
}

function signed(i) {
  const raw = JSON.stringify(webhook(i));
  return { raw: raw, headers: { 'calendly-webhook-signature': sign(raw) } };
}

test('engine: every fixture webhook produces its documented dry-run outcome', async function () {
  for (let i = 0; i < FIXTURE.webhooks.length; i++) {
    const w = FIXTURE.webhooks[i];
    const s = signed(i);
    const out = await engine.handleWebhook(s.raw, s.headers, engineDeps());
    assert.equal(out.body.status, w.expected_status, w.label);
    if (w.expected_rep) assert.equal(out.body.decision.rep.id, w.expected_rep, w.label);
  }
});

test('engine: bad signatures and replays are rejected before any API call', async function () {
  const calls = [];
  const spy = { request: async function (m, p) { calls.push(m + ' ' + p); return { statusCode: 500, body: {} }; } };
  const raw = JSON.stringify(webhook(0));
  const bad = await engine.handleWebhook(raw, { 'calendly-webhook-signature': sign(raw + 'x') }, engineDeps({}, { hubspotClient: spy }));
  assert.deepEqual([bad.httpStatus, bad.body.reason], [401, 'signature_mismatch']);
  const replay = await engine.handleWebhook(raw, { 'calendly-webhook-signature': sign(raw, NOW.getTime() - 3600000) }, engineDeps({}, { hubspotClient: spy }));
  assert.equal(replay.body.reason, 'signature_timestamp_outside_tolerance');
  assert.deepEqual(calls, []);
});

test('engine: the portal gate blocks a STANDARD portal in sandbox mode', async function () {
  const fx = plain(FIXTURE);
  fx.mock_responses.account.body.accountType = 'STANDARD';
  const s = signed(0);
  await assert.rejects(engine.handleWebhook(s.raw, s.headers, engineDeps({}, { hubspotClient: engine.createFixtureClients(fx).hubspot })), /blocked by gate/);
});

function recordingHubSpot() {
  const base = engine.createFixtureClients(plain(FIXTURE)).hubspot;
  const writes = [];
  return {
    writes: writes,
    request: async function (method, apiPath, body) {
      if (method === 'POST' && apiPath === '/crm/v3/objects/contacts') { writes.push({ method: method, path: apiPath, body: body }); return { statusCode: 201, body: { id: '7001' } }; }
      if (method === 'PATCH') { writes.push({ method: method, path: apiPath, body: body }); return { statusCode: 200, body: { id: apiPath.split('/').pop() } }; }
      if (method === 'POST' && apiPath === '/crm/v3/objects/meetings') { writes.push({ method: method, path: apiPath, body: body }); return { statusCode: 201, body: { id: '8001' } }; }
      return base.request(method, apiPath, body);
    }
  };
}

test('engine: sandbox writes create the contact with the owner, log the meeting, and make retries duplicates', async function () {
  const hubspot = recordingHubSpot();
  const deps = engineDeps({ DRY_RUN: 'false' }, { hubspotClient: hubspot });
  const s = signed(0);
  const out = await engine.handleWebhook(s.raw, s.headers, deps);
  assert.deepEqual([out.body.status, out.body.writeMode, out.body.results.contact, out.body.results.meeting], ['written', 'sandbox', 'created', '8001']);
  assert.deepEqual(hubspot.writes.map(function (w) { return w.method + ' ' + w.path; }), ['POST /crm/v3/objects/contacts', 'POST /crm/v3/objects/meetings']);
  assert.equal(hubspot.writes[0].body.properties.hubspot_owner_id, '1003');
  assert.deepEqual(hubspot.writes[1].body.associations[0], { to: { id: '7001' }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 200 }] });
  const retry = await engine.handleWebhook(s.raw, s.headers, deps);
  assert.equal(retry.body.status, 'duplicate');
  assert.equal(hubspot.writes.length, 2, 'a retried webhook writes nothing');
});

test('engine: dry run never writes, and never changes the ledger', async function () {
  const hubspot = recordingHubSpot();
  const store = engine.seededLedgerStore(plain(FIXTURE.ledger));
  const s = signed(0);
  await engine.handleWebhook(s.raw, s.headers, engineDeps({}, { hubspotClient: hubspot, ledgerStore: store }));
  const c = signed(2);
  await engine.handleWebhook(c.raw, c.headers, engineDeps({}, { hubspotClient: hubspot, ledgerStore: store }));
  assert.deepEqual(hubspot.writes, []);
  assert.deepEqual(store.load(), plain(FIXTURE.ledger));
});

test('engine: cancellations release the assignment so it stops counting against the rep', async function () {
  const store = engine.seededLedgerStore(plain(FIXTURE.ledger));
  const c = signed(2);
  const out = await engine.handleWebhook(c.raw, c.headers, engineDeps({ DRY_RUN: 'false' }, { hubspotClient: recordingHubSpot(), ledgerStore: store }));
  assert.deepEqual([out.body.status, out.body.released.repId], ['released', 'REP_ID_03']);
  assert.equal(b.findAssignment(store.load(), webhook(2).payload.uri), null);
});

test('engine: calendar hand-off inserts into the sandbox calendar with sendUpdates=none', async function () {
  const inserted = [];
  const google = {
    request: async function (method, url, body) {
      if (/\/freeBusy$/.test(url)) return plain(FIXTURE.mock_responses.freebusy);
      inserted.push({ url: url, body: body });
      return { statusCode: 200, body: { id: 'evt-sandbox-1' } };
    }
  };
  const deps = engineDeps({ DRY_RUN: 'false', BOOKING_MODE: 'calendar_handoff', SANDBOX_CALENDAR_ID: 'sandbox@calendar.example.com' }, { hubspotClient: recordingHubSpot(), googleClient: google });
  const s = signed(0);
  const out = await engine.handleWebhook(s.raw, s.headers, deps);
  assert.equal(out.body.results.calendarEvent, 'created');
  assert.equal(inserted[0].url, 'https://www.googleapis.com/calendar/v3/calendars/sandbox%40calendar.example.com/events?sendUpdates=none');
  assert.deepEqual(inserted[0].body.attendees, []);
});

test('engine: writes require a real roster file; the example roster is dry-run only', function () {
  assert.throws(function () { engine.loadRosterList(cfgFrom({ DRY_RUN: 'false' })); }, /REP_ROSTER_FILE/);
  assert.equal(engine.loadRosterList(cfgFrom()).length, 4);
});

test('engine: the HTTP server verifies signatures on the raw body', async function () {
  const server = engine.createWebhookServer(engineDeps());
  await new Promise(function (r) { server.listen(0, '127.0.0.1', r); });
  try {
    const url = 'http://127.0.0.1:' + server.address().port + engine.WEBHOOK_PATH;
    const s = signed(0);
    const ok = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Calendly-Webhook-Signature': s.headers['calendly-webhook-signature'] }, body: s.raw });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).decision.rep.id, 'REP_ID_03');
    const bad = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: s.raw });
    assert.equal(bad.status, 401);
    const missing = await fetch(url.replace('balancer', 'other'), { method: 'POST', body: '{}' });
    assert.equal(missing.status, 404);
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// 8. workflow.json
// ---------------------------------------------------------------------------

const WORKFLOW_TEXT = fs.readFileSync(path.join(ROOT, 'workflow.json'), 'utf8');
const WORKFLOW = JSON.parse(WORKFLOW_TEXT);

class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : [NOW.getTime()])); }
  static now() { return NOW.getTime(); }
}

function nodeCode(name) {
  const node = WORKFLOW.nodes.find(function (n) { return n.name === name; });
  assert.ok(node, 'missing node ' + name);
  return node.parameters.jsCode;
}

async function runCodeNode(name, context, self) {
  const sandbox = Object.assign({ console: console, Intl: Intl, Date: FixedDate, require: require }, context);
  vm.createContext(sandbox);
  const fn = vm.runInContext('(async function () {\n' + nodeCode(name) + '\n})', sandbox);
  return plain(await fn.call(self || { helpers: {} }));
}

function itemsOf(list) {
  return { first: function () { return { json: list[0] }; }, all: function () { return list.map(function (j) { return { json: j }; }); } };
}
function refs(outputs) {
  return function (name) {
    if (!(name in outputs)) throw new Error('Unexpected node reference ' + name);
    return itemsOf(Array.isArray(outputs[name]) ? outputs[name] : [outputs[name]]);
  };
}
function binaryHelpers(raw) {
  return { helpers: { getBinaryDataBuffer: async function () { return Buffer.from(raw, 'utf8'); } } };
}

test('workflow: passes the validator and is in sync with src/', function () {
  const result = validator.validateWorkflow(WORKFLOW, { text: WORKFLOW_TEXT });
  assert.deepEqual(result.errors, []);
  assert.equal(WORKFLOW_TEXT, builder.render());
});

test('workflow: the validator catches a gate bypass, credentials, and a missing raw body', function () {
  const bypass = plain(WORKFLOW);
  bypass.connections[N.score].main[0].push({ node: N.meeting, type: 'main', index: 0 });
  assert.ok(validator.validateWorkflow(bypass, {}).errors.some(function (e) { return /reachable without "Writes Enabled\?"/.test(e); }));
  const creds = plain(WORKFLOW);
  creds.nodes[4].credentials = { hubspotAppToken: { id: '1', name: 'x' } };
  assert.ok(validator.validateWorkflow(creds, {}).errors.some(function (e) { return /credential references/.test(e); }));
  const noRaw = plain(WORKFLOW);
  noRaw.nodes[0].parameters.options = {};
  assert.ok(validator.validateWorkflow(noRaw, {}).errors.some(function (e) { return /raw body/.test(e); }));
});

test('workflow: verify node accepts a signed raw body and rejects everything else', async function () {
  const raw = JSON.stringify(webhook(0));
  const env = { CALENDLY_WEBHOOK_SECRET: SECRET };
  const ok = await runCodeNode(N.verify, { $env: env, $input: itemsOf([{ headers: { 'calendly-webhook-signature': sign(raw) } }]) }, binaryHelpers(raw));
  assert.equal(ok[0].json.accepted, true);
  assert.deepEqual(ok[0].json.event, plain(event(0)));
  assert.equal(ok[0].json.config.writeMode, 'dry_run');
  const tampered = await runCodeNode(N.verify, { $env: env, $input: itemsOf([{ headers: { 'calendly-webhook-signature': sign(raw + ' ') } }]) }, binaryHelpers(raw));
  assert.deepEqual([tampered[0].json.httpStatus, tampered[0].json.reason], [401, 'signature_mismatch']);
  const blocked = new Proxy({}, { get: function () { throw new Error('access to env vars denied'); } });
  const locked = await runCodeNode(N.verify, { $env: blocked, $input: itemsOf([{ headers: {} }]) }, binaryHelpers(raw));
  assert.deepEqual([locked[0].json.accepted, locked[0].json.httpStatus, locked[0].json.reason], [false, 401, 'webhook_secret_not_configured'], 'with env blocked, signatures stay required and the request fails closed');
  const noRaw = await runCodeNode(N.verify, { $env: env, $input: itemsOf([{ headers: {} }]) }, { helpers: { getBinaryDataBuffer: async function () { throw new Error('no binary'); } } });
  assert.equal(noRaw[0].json.reason, 'raw_body_unavailable_enable_webhook_raw_body_option');
});

test('workflow: the n8n node chain makes the same decision as the Node engine', async function () {
  for (const index of [0, 1]) {
    const raw = JSON.stringify(webhook(index));
    const env = { CALENDLY_WEBHOOK_SECRET: SECRET };
    const staticData = { ledger: plain(FIXTURE.ledger) };
    const getStatic = function () { return staticData; };
    const verified = (await runCodeNode(N.verify, { $env: env, $input: itemsOf([{ headers: { 'calendly-webhook-signature': sign(raw) } }]) }, binaryHelpers(raw)))[0].json;
    const gated = (await runCodeNode(N.gate, { $env: env, $: refs({ [N.verify]: verified }), $input: itemsOf([FIXTURE.mock_responses.account.body]), $getWorkflowStaticData: getStatic }))[0].json;
    assert.deepEqual([gated.route, gated.rosterSource], ['assign', 'example_roster_dry_run_only']);
    const hit = FIXTURE.mock_responses.contacts[gated.event.inviteeEmail];
    const lookup = { statusCode: 200, body: { total: hit ? 1 : 0, results: hit ? [hit] : [] } };
    const plan = (await runCodeNode(N.planPto, { $: refs({ [N.gate]: gated }), $input: itemsOf([lookup]) }))[0].json;
    const fanned = (await runCodeNode(N.fanOut, { $: refs({ [N.planPto]: plan }), $input: itemsOf([plain(FIXTURE.mock_responses.freebusy)]) })).map(function (i) { return i.json; });
    assert.equal(fanned.length, 4);
    const loads = fanned.map(function (f) {
      const owner = f.request.body.filterGroups[0].filters[0].value;
      return { statusCode: 200, body: { total: FIXTURE.mock_responses.open_deals_by_owner[owner] } };
    });
    const scored = (await runCodeNode(N.score, { $: refs({ [N.planPto]: plan, [N.fanOut]: fanned }), $input: itemsOf(loads), $getWorkflowStaticData: getStatic }))[0].json;
    const s = signed(index);
    const node = await engine.handleWebhook(s.raw, s.headers, engineDeps());
    assert.deepEqual(scored.decision, plain(node.body.decision), 'webhook ' + index);
    assert.deepEqual(scored.actions, plain(node.body.actions), 'webhook ' + index);
    assert.equal(scored.writesEnabled, false);
    assert.deepEqual(staticData.ledger, plain(FIXTURE.ledger), 'dry run leaves the n8n ledger untouched');
  }
});

test('workflow: gate node refuses production portals and routes cancellations and duplicates', async function () {
  const env = { CALENDLY_WEBHOOK_SECRET: SECRET };
  const verify = async function (i) {
    const raw = JSON.stringify(webhook(i));
    return (await runCodeNode(N.verify, { $env: env, $input: itemsOf([{ headers: { 'calendly-webhook-signature': sign(raw) } }]) }, binaryHelpers(raw)))[0].json;
  };
  const getStatic = function () { return { ledger: plain(FIXTURE.ledger) }; };
  await assert.rejects(runCodeNode(N.gate, { $env: env, $: refs({ [N.verify]: await verify(0) }), $input: itemsOf([{ accountType: 'STANDARD' }]), $getWorkflowStaticData: getStatic }), /blocked by gate/);
  const cancel = (await runCodeNode(N.gate, { $env: env, $: refs({ [N.verify]: await verify(2) }), $input: itemsOf([FIXTURE.mock_responses.account.body]), $getWorkflowStaticData: getStatic }))[0].json;
  assert.deepEqual([cancel.route, cancel.released.repId], ['released', 'REP_ID_03']);
  const dup = (await runCodeNode(N.gate, { $env: env, $: refs({ [N.verify]: await verify(3) }), $input: itemsOf([FIXTURE.mock_responses.account.body]), $getWorkflowStaticData: getStatic }))[0].json;
  assert.equal(dup.route, 'duplicate');
});

test('workflow: resolve node reads created IDs and 409 conflicts', async function () {
  const scored = { contactAction: 'create', contact: { contactId: null }, actions: { contact: { action: 'create' }, meeting: { properties: { hs_meeting_title: 'x' }, associationTypeId: 200 }, calendarEvent: null } };
  const created = (await runCodeNode(N.resolve, { $: refs({ [N.score]: scored }), $input: itemsOf([{ statusCode: 201, body: { id: '7001' } }]) }))[0].json;
  assert.deepEqual([created.contactId, created.contactResult, created.meetingBody.associations[0].to.id], ['7001', 'created', '7001']);
  const conflict = (await runCodeNode(N.resolve, { $: refs({ [N.score]: scored }), $input: itemsOf([{ statusCode: 409, body: { message: 'Contact already exists. Existing ID: 5001' } }]) }))[0].json;
  assert.deepEqual([conflict.contactId, conflict.contactResult], ['5001', 'exists_owner_left_unchanged']);
  await assert.rejects(runCodeNode(N.resolve, { $: refs({ [N.score]: scored }), $input: itemsOf([{ statusCode: 400, body: {} }]) }), /status 400/);
});

// ---------------------------------------------------------------------------
// 9. Security scan
// ---------------------------------------------------------------------------

const DOMAIN_ALLOWLIST = {
  'dhrobinsystems.com': 'author website and contact (README author block)',
  'behance.net': 'author portfolio (README author block)',
  'linkedin.com': 'author profile (README author block)',
  'github.com': 'repository links in README and package.json',
  'hubapi.com': 'HubSpot API base URL',
  'googleapis.com': 'Google Calendar API endpoints'
};
const ALLOWED_EMAIL_DOMAINS = ['dhrobinsystems.com'];
const SKIP_DIRS = new Set(['.git', 'node_modules', 'coverage']);

function listRepoFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(function (entry) {
    if (SKIP_DIRS.has(entry.name)) return [];
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? listRepoFiles(full) : [full];
  });
}
function isRfc2606(host) {
  return /(^|\.)example\.(com|org|net)$/.test(host) || /(^|\.)(test|example|invalid|localhost)$/.test(host);
}
function isAllowedHost(host) {
  const h = host.toLowerCase().replace(/^www\./, '');
  return isRfc2606(h) || Object.keys(DOMAIN_ALLOWLIST).some(function (d) { return h === d || h.endsWith('.' + d); });
}

const SECRET_PATTERNS = [
  { name: 'private key block', re: new RegExp(['-----BEGIN', '[A-Z ]*PRIVATE KEY-----'].join(' ')) },
  { name: 'HubSpot private app token', re: /\bpat-(?:na|eu|ap)\d-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i },
  { name: 'HubSpot legacy API key', re: /hapikey=[0-9a-f]{8}-[0-9a-f]{4}-/i },
  { name: 'Calendly personal access token (JWT)', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./ },
  { name: 'Google OAuth token', re: /\bya29\.[0-9A-Za-z_-]{20,}/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'Google service account key', re: /"type"\s*:\s*"service_account"/ },
  { name: 'Real Google group calendar ID', re: /[a-z0-9]{20,}@group\.calendar\.google\.com/ },
  { name: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: 'Slack token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { name: 'hard-coded secret assignment', re: /\b[A-Z0-9_]*(?:TOKEN|SECRET|API_KEY|PASSWORD)[ \t]*[=:][ \t]*["']?(?!mock_)[A-Za-z0-9\-_./+:]{16,}/ }
];

test('security: no real secrets, keys, tokens, or calendar IDs in any repository file', function () {
  const findings = [];
  listRepoFiles(ROOT).forEach(function (file) {
    const text = fs.readFileSync(file, 'utf8');
    SECRET_PATTERNS.forEach(function (p) { if (p.re.test(text)) findings.push(path.relative(ROOT, file) + ': ' + p.name); });
  });
  assert.deepEqual(findings, []);
});

test('security: .env.example is a fully blank template and no .env is committed', function () {
  assert.equal(fs.existsSync(path.join(ROOT, '.env')), false);
  const lines = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8').split('\n').filter(function (l) { return l.trim() && !l.trim().startsWith('#'); });
  assert.ok(lines.length >= 20);
  lines.forEach(function (line) {
    assert.match(line, /^[A-Z][A-Z0-9_]*=$/, 'every value must be blank: ' + line);
  });
  ['CALENDLY_WEBHOOK_SECRET=', 'HUBSPOT_API_KEY=', 'TIMEZONE_DEFAULT=', 'DRY_RUN=', 'SANDBOX_MODE='].forEach(function (l) { assert.ok(lines.includes(l), l); });
  config.CONFIG_KEYS.forEach(function (key) { assert.ok(lines.includes(key + '='), key + ' is documented in .env.example'); });
});

test('security: only RFC 2606 domains (plus the documented allowlist) appear in any file', function () {
  const domainRe = /\b((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|net|org|io|co|ai|app|dev))\b/gi;
  const findings = [];
  listRepoFiles(ROOT).forEach(function (file) {
    const text = fs.readFileSync(file, 'utf8');
    let match;
    while ((match = domainRe.exec(text)) !== null) {
      const host = text.charAt(match.index - 1) === '%' ? match[1].slice(2) : match[1];
      if (!isAllowedHost(host)) findings.push(path.relative(ROOT, file) + ': ' + host);
    }
  });
  assert.deepEqual(Array.from(new Set(findings)), []);
});

test('security: every email address uses an RFC 2606 domain or the documented author contact', function () {
  const emailRe = /\b[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)\b/g;
  const findings = [];
  listRepoFiles(ROOT).forEach(function (file) {
    const text = fs.readFileSync(file, 'utf8');
    let match;
    while ((match = emailRe.exec(text)) !== null) {
      const domain = match[1].toLowerCase();
      if (!isRfc2606(domain) && !ALLOWED_EMAIL_DOMAINS.includes(domain)) findings.push(path.relative(ROOT, file) + ': ' + match[0]);
    }
  });
  assert.deepEqual(findings, []);
});

test('security: the scanner catches planted secrets and foreign domains', function () {
  const token = ['pat', 'na1', '12345678-1234-1234-1234-123456789abc'].join('-');
  const assignment = 'CALENDLY_WEBHOOK_SECRET=' + ['live', 'signing', 'key', '0123456789'].join('_');
  [token, assignment].forEach(function (s) { assert.ok(SECRET_PATTERNS.some(function (p) { return p.re.test(s); }), s.slice(0, 12)); });
  assert.equal(isAllowedHost(['acme-corp', 'com'].join('.')), false);
  assert.equal(isAllowedHost('calendar.example.com'), true);
});
