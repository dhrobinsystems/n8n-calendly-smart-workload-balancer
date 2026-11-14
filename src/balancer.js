'use strict';

/**
 * balancer.js
 *
 * Core logic of the workload balancer. It runs identically in Node.js and in
 * the n8n Code nodes (scripts/build-workflow.js embeds the n8n-core:balancer
 * region verbatim). It is pure: no network, no clock, no crypto. The caller
 * passes in the current time and an HMAC function.
 *
 * Pipeline for one Calendly `invitee.created` webhook:
 *
 *   1. verifyCalendlySignature()  HMAC-SHA256 over "<t>.<raw body>", with replay window
 *   2. parseCalendlyEvent()       validate and normalize the payload
 *   3. normalizeRoster()          validate the rep roster
 *   4. existing owner             if the contact already has a HubSpot owner who is
 *                                 in the roster and available, the meeting goes to them
 *   5. eligibility (hard rules)   active, not on PTO, under the open-deal cap,
 *                                 inside working hours (STRICT_WORKING_HOURS)
 *   6. scoring (soft rules)       weighted fairness deficit + deal-load headroom
 *                                 + timezone / region fit
 *   7. tie-break                  least recently assigned, then rep ID
 *   8. fallback                   FALLBACK_REP_ID, then the Calendly host, then unassigned
 *   9. buildActions()             HubSpot contact owner, HubSpot meeting, and an
 *                                 optional calendar hand-off event
 *
 * Fairness uses a rolling ledger of recent assignments (ASSIGNMENT_WINDOW_DAYS).
 * Each eligible rep's target share is weight / sum(weights); the fairness score is
 * (target - actual) / target, clamped to [-1, 1]. A rep who is behind their
 * share scores up to +1, and a rep who is ahead scores down to -1. Cancellations
 * release their ledger entry, so a cancelled meeting does not count against a rep.
 */

// <n8n-core:balancer>
const BALANCER_DAY_MS = 86400000;
const SUPPORTED_EVENTS = ['invitee.created', 'invitee.canceled'];
const EMEA_ASIA_ZONES = [
  'Asia/Dubai', 'Asia/Riyadh', 'Asia/Qatar', 'Asia/Kuwait', 'Asia/Bahrain', 'Asia/Muscat', 'Asia/Jerusalem',
  'Asia/Tel_Aviv', 'Asia/Beirut', 'Asia/Amman', 'Asia/Baghdad', 'Asia/Tehran', 'Asia/Damascus', 'Asia/Nicosia'
];
const REGION_PREFIXES = [
  ['America/', 'AMER'], ['US/', 'AMER'], ['Canada/', 'AMER'], ['Brazil/', 'AMER'], ['Chile/', 'AMER'], ['Mexico/', 'AMER'],
  ['Europe/', 'EMEA'], ['Africa/', 'EMEA'], ['Atlantic/', 'EMEA'],
  ['Asia/', 'APAC'], ['Australia/', 'APAC'], ['Pacific/', 'APAC'], ['Indian/', 'APAC'], ['Antarctica/', 'APAC']
];
const WEEKDAY_NUMBERS = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const ROSTER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const EMAIL_SHAPE = /^[^\s@<>()"',;:]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;

function balBlank(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

function balEmail(value) {
  if (balBlank(value) || typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return EMAIL_SHAPE.test(email) && email.length <= 254 ? email : null;
}

function balText(value, max) {
  if (balBlank(value) || typeof value === 'object') return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

function balZoneOk(zone) {
  if (balBlank(zone)) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return true; } catch (error) { return false; }
}

function balRound(value, digits) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const f = Math.pow(10, digits);
  return Math.round((value + Number.EPSILON) * f) / f;
}

function regionForTimezone(zone) {
  if (balBlank(zone)) return 'UNKNOWN';
  if (zone === 'UTC' || zone === 'Etc/UTC' || zone === 'GMT') return 'EMEA';
  if (EMEA_ASIA_ZONES.indexOf(zone) !== -1) return 'EMEA';
  for (let i = 0; i < REGION_PREFIXES.length; i++) {
    if (zone.indexOf(REGION_PREFIXES[i][0]) === 0) return REGION_PREFIXES[i][1];
  }
  return 'UNKNOWN';
}

function zoneParts(ms, zone) {
  const parts = {};
  new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(new Date(ms)).forEach(function (p) { parts[p.type] = p.value; });
  return parts;
}

function timeZoneOffsetMinutes(zone, ms) {
  const p = zoneParts(ms, zone);
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

function localClock(ms, zone) {
  const p = zoneParts(ms, zone);
  return {
    weekday: WEEKDAY_NUMBERS[p.weekday],
    minutes: Number(p.hour) * 60 + Number(p.minute),
    dateKey: p.year + '-' + p.month + '-' + p.day
  };
}

function parseClock(text) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(text || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function withinWorkingHours(rep, startMs, endMs) {
  const wh = rep.workingHours;
  const start = localClock(startMs, rep.timezone);
  const end = localClock(endMs - 1, rep.timezone);
  if (wh.days.indexOf(start.weekday) === -1) return false;
  if (start.dateKey !== end.dateKey) return false;
  return start.minutes >= wh.startMinutes && end.minutes < wh.endMinutes;
}

function constantTimeEqual(a, b) {
  const x = String(a);
  const y = String(b);
  let diff = x.length ^ y.length;
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i++) diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  return diff === 0;
}

/**
 * Calendly signs webhooks with the header
 *   Calendly-Webhook-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256>
 * where the HMAC covers "<t>.<raw request body>" keyed by the signing key.
 */
function verifyCalendlySignature(rawBody, header, secret, nowMs, toleranceSeconds, hmacHex) {
  if (balBlank(secret)) return { ok: false, reason: 'webhook_secret_not_configured' };
  if (balBlank(header)) return { ok: false, reason: 'signature_header_missing' };
  const parts = {};
  String(header).split(',').forEach(function (segment) {
    const i = segment.indexOf('=');
    if (i > 0) parts[segment.slice(0, i).trim()] = segment.slice(i + 1).trim();
  });
  if (!/^\d+$/.test(parts.t || '') || !/^[0-9a-f]{64}$/i.test(parts.v1 || '')) return { ok: false, reason: 'signature_header_malformed' };
  const signedAtMs = Number(parts.t) * 1000;
  if (Math.abs(nowMs - signedAtMs) > toleranceSeconds * 1000) return { ok: false, reason: 'signature_timestamp_outside_tolerance' };
  const expected = hmacHex(secret, parts.t + '.' + rawBody);
  return constantTimeEqual(String(expected).toLowerCase(), parts.v1.toLowerCase())
    ? { ok: true, reason: null }
    : { ok: false, reason: 'signature_mismatch' };
}

function parseCalendlyEvent(body) {
  const errors = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, errors: ['payload_must_be_a_json_object'], event: null };
  const type = String(body.event || '');
  if (SUPPORTED_EVENTS.indexOf(type) === -1) return { ok: false, errors: ['unsupported_event:' + (type || 'missing')], event: null };
  const p = body.payload && typeof body.payload === 'object' ? body.payload : {};
  const scheduled = p.scheduled_event && typeof p.scheduled_event === 'object' ? p.scheduled_event : {};
  const location = scheduled.location && typeof scheduled.location === 'object' ? scheduled.location : {};
  const startMs = Date.parse(scheduled.start_time);
  const endMs = Date.parse(scheduled.end_time);
  const email = balEmail(p.email);
  const inviteeUri = balText(p.uri, 500);

  if (!inviteeUri) errors.push('invitee_uri_missing');
  if (!email) errors.push('invitee_email_missing_or_invalid');
  if (!Number.isFinite(startMs)) errors.push('start_time_missing_or_invalid');
  if (!Number.isFinite(endMs)) errors.push('end_time_missing_or_invalid');
  if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs <= startMs) errors.push('end_time_not_after_start_time');
  if (errors.length) return { ok: false, errors: errors, event: null };

  const hosts = (Array.isArray(scheduled.event_memberships) ? scheduled.event_memberships : [])
    .map(function (m) { return m && balEmail(m.user_email); })
    .filter(Boolean);
  const timezone = balZoneOk(p.timezone) ? p.timezone : null;

  return {
    ok: true,
    errors: [],
    event: {
      type: type,
      inviteeUri: inviteeUri,
      inviteeEmail: email,
      inviteeName: balText(p.name, 120),
      inviteeTimezone: timezone,
      eventUri: balText(scheduled.uri || p.event, 500),
      eventName: balText(scheduled.name, 150) || 'Calendly meeting',
      eventTypeUri: balText(scheduled.event_type, 500),
      startTime: new Date(startMs).toISOString(),
      endTime: new Date(endMs).toISOString(),
      joinUrl: /^https:\/\//i.test(String(location.join_url || '')) ? String(location.join_url) : null,
      calendlyHostEmails: hosts,
      rescheduled: Boolean(p.rescheduled),
      createdAt: balText(body.created_at, 40)
    }
  };
}

function normalizeRoster(list, cfg) {
  const errors = [];
  const reps = [];
  const seen = {};
  if (!Array.isArray(list) || list.length === 0) return { reps: [], errors: ['roster_empty_or_not_an_array'] };
  list.forEach(function (raw, index) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const label = 'rep[' + index + ']';
    const id = String(r.id || '');
    if (!ROSTER_ID_PATTERN.test(id)) { errors.push(label + ': id must match ' + ROSTER_ID_PATTERN); return; }
    if (seen[id]) { errors.push(label + ': duplicate id ' + id); return; }
    seen[id] = true;
    const email = balEmail(r.email);
    if (!email) errors.push(id + ': email is missing or invalid');
    const timezone = balZoneOk(r.timezone) ? r.timezone : null;
    if (!timezone) errors.push(id + ': timezone must be a valid IANA zone');
    const owner = String(r.hubspotOwnerId === undefined || r.hubspotOwnerId === null ? '' : r.hubspotOwnerId);
    if (!/^\d+$/.test(owner)) errors.push(id + ': hubspotOwnerId must be numeric');
    const weight = r.weight === undefined ? 1 : Number(r.weight);
    if (!Number.isFinite(weight) || weight <= 0 || weight > 100) errors.push(id + ': weight must be > 0 and <= 100');
    const cap = r.maxActiveDeals === undefined ? cfg.maxActiveDealsDefault : Number(r.maxActiveDeals);
    if (!Number.isInteger(cap) || cap < 1) errors.push(id + ': maxActiveDeals must be a positive integer');
    const wh = r.workingHours && typeof r.workingHours === 'object' ? r.workingHours : {};
    const startMinutes = parseClock(wh.start || '09:00');
    const endMinutes = parseClock(wh.end || '17:00');
    const days = Array.isArray(wh.days) ? wh.days.map(Number) : [1, 2, 3, 4, 5];
    if (startMinutes === null || endMinutes === null || endMinutes <= startMinutes) errors.push(id + ': workingHours start/end must be HH:MM with end after start');
    if (!days.length || days.some(function (d) { return !Number.isInteger(d) || d < 1 || d > 7; })) errors.push(id + ': workingHours.days must be ISO weekdays 1 (Mon) to 7 (Sun)');
    const regions = (Array.isArray(r.regions) && r.regions.length ? r.regions : [regionForTimezone(timezone)]).map(function (x) { return String(x).toUpperCase(); });
    reps.push({
      id: id,
      name: balText(r.name, 120) || id,
      email: email,
      hubspotOwnerId: owner,
      timezone: timezone,
      regions: regions,
      weight: weight,
      maxActiveDeals: cap,
      workingHours: { start: wh.start || '09:00', end: wh.end || '17:00', startMinutes: startMinutes, endMinutes: endMinutes, days: days },
      ptoCalendarId: balText(r.ptoCalendarId, 300),
      calendarId: balText(r.calendarId, 300),
      active: r.active !== false
    });
  });
  return { reps: errors.length ? [] : reps, errors: errors };
}

function publicRep(rep) {
  return rep ? { id: rep.id, name: rep.name, email: rep.email, hubspotOwnerId: rep.hubspotOwnerId, timezone: rep.timezone } : null;
}

// --- Contact lookup ---------------------------------------------------------

function buildContactLookupRequest(event) {
  return {
    method: 'POST',
    path: '/crm/v3/objects/contacts/search',
    body: {
      filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: event.inviteeEmail }] }],
      properties: ['email', 'hubspot_owner_id', 'firstname', 'lastname'],
      limit: 1
    }
  };
}

function readContactLookup(response) {
  if (!response || Number(response.statusCode) !== 200) return { ok: false, found: false, contactId: null, ownerId: null };
  const results = response.body && Array.isArray(response.body.results) ? response.body.results : [];
  if (!results.length) return { ok: true, found: false, contactId: null, ownerId: null };
  const props = results[0].properties || {};
  return {
    ok: true,
    found: true,
    contactId: String(results[0].id),
    ownerId: balBlank(props.hubspot_owner_id) ? null : String(props.hubspot_owner_id)
  };
}

// --- PTO (Google Calendar freeBusy) -----------------------------------------

function buildFreeBusyRequest(reps, event) {
  const ids = [];
  reps.forEach(function (r) { if (r.active && r.ptoCalendarId && ids.indexOf(r.ptoCalendarId) === -1) ids.push(r.ptoCalendarId); });
  if (!ids.length) return null;
  return { timeMin: event.startTime, timeMax: event.endTime, items: ids.map(function (id) { return { id: id }; }) };
}

function applyFreeBusy(reps, event, response) {
  const startMs = Date.parse(event.startTime);
  const endMs = Date.parse(event.endTime);
  const ok = response && Number(response.statusCode) === 200 && response.body && response.body.calendars;
  const out = {};
  reps.forEach(function (r) {
    if (!r.ptoCalendarId) { out[r.id] = { checked: false, onPto: false, note: 'no_pto_calendar' }; return; }
    if (!response) { out[r.id] = { checked: false, onPto: false, note: 'pto_check_skipped' }; return; }
    if (!ok) { out[r.id] = { checked: false, onPto: false, note: 'pto_check_failed' }; return; }
    const cal = response.body.calendars[r.ptoCalendarId];
    if (!cal || (Array.isArray(cal.errors) && cal.errors.length)) { out[r.id] = { checked: false, onPto: false, note: 'pto_calendar_unreadable' }; return; }
    const onPto = (Array.isArray(cal.busy) ? cal.busy : []).some(function (b) {
      const bs = Date.parse(b.start);
      const be = Date.parse(b.end);
      return Number.isFinite(bs) && Number.isFinite(be) && bs < endMs && be > startMs;
    });
    out[r.id] = { checked: true, onPto: onPto, note: null };
  });
  return out;
}

// --- Active deal load -------------------------------------------------------

function buildDealLoadRequest(rep) {
  return {
    method: 'POST',
    path: '/crm/v3/objects/deals/search',
    body: {
      filterGroups: [{ filters: [
        { propertyName: 'hubspot_owner_id', operator: 'EQ', value: rep.hubspotOwnerId },
        { propertyName: 'hs_is_closed', operator: 'EQ', value: 'false' }
      ] }],
      properties: ['dealname'],
      limit: 1
    }
  };
}

function readDealLoad(response) {
  if (!response || Number(response.statusCode) !== 200 || !response.body) return null;
  const total = Number(response.body.total);
  return Number.isFinite(total) && total >= 0 ? total : null;
}

// --- Fairness ledger ---------------------------------------------------------

function emptyLedger() {
  return { assignments: [] };
}

function pruneLedger(ledger, nowMs, windowDays) {
  const cutoff = nowMs - windowDays * BALANCER_DAY_MS;
  const list = ledger && Array.isArray(ledger.assignments) ? ledger.assignments : [];
  return { assignments: list.filter(function (a) { const t = Date.parse(a.assignedAt); return Number.isFinite(t) && t >= cutoff; }) };
}

function findAssignment(ledger, inviteeUri) {
  const list = ledger && Array.isArray(ledger.assignments) ? ledger.assignments : [];
  return list.find(function (a) { return a.inviteeUri === inviteeUri; }) || null;
}

function recordAssignment(ledger, entry) {
  const list = (ledger && Array.isArray(ledger.assignments) ? ledger.assignments : []).filter(function (a) { return a.inviteeUri !== entry.inviteeUri; });
  return { assignments: list.concat([entry]) };
}

function releaseAssignment(ledger, inviteeUri) {
  const list = ledger && Array.isArray(ledger.assignments) ? ledger.assignments : [];
  const released = list.find(function (a) { return a.inviteeUri === inviteeUri; }) || null;
  return { ledger: { assignments: list.filter(function (a) { return a.inviteeUri !== inviteeUri; }) }, released: released };
}

// --- Scoring ---------------------------------------------------------------

function exclusionReasons(rep, ctx, startMs, endMs) {
  const reasons = [];
  if (!rep.active) reasons.push('inactive');
  const pto = ctx.availability[rep.id];
  if (pto && pto.onPto) reasons.push('on_pto');
  const load = ctx.loads[rep.id];
  if (load !== null && load !== undefined && load >= rep.maxActiveDeals) reasons.push('at_deal_capacity');
  if (ctx.cfg.strictWorkingHours && !withinWorkingHours(rep, startMs, endMs)) reasons.push('outside_working_hours');
  return reasons;
}

function scoreCandidates(reps, ctx) {
  const cfg = ctx.cfg;
  const event = ctx.event;
  const startMs = Date.parse(event.startTime);
  const endMs = Date.parse(event.endTime);
  const inviteeZone = event.inviteeTimezone || cfg.timezoneDefault;
  const inviteeRegion = regionForTimezone(inviteeZone);
  const inviteeOffset = timeZoneOffsetMinutes(inviteeZone, startMs);
  const ledger = pruneLedger(ctx.ledger, ctx.nowMs, cfg.assignmentWindowDays);

  const counts = {};
  const lastAssigned = {};
  ledger.assignments.forEach(function (a) {
    counts[a.repId] = (counts[a.repId] || 0) + 1;
    if (!lastAssigned[a.repId] || a.assignedAt > lastAssigned[a.repId]) lastAssigned[a.repId] = a.assignedAt;
  });

  const excluded = [];
  const eligible = [];
  reps.forEach(function (rep) {
    const reasons = exclusionReasons(rep, ctx, startMs, endMs);
    if (reasons.length) excluded.push({ repId: rep.id, reasons: reasons });
    else eligible.push(rep);
  });

  const totalWeight = eligible.reduce(function (s, r) { return s + r.weight; }, 0);
  const totalAssigned = eligible.reduce(function (s, r) { return s + (counts[r.id] || 0); }, 0);
  const w = cfg.weights;

  const candidates = eligible.map(function (rep) {
    const target = rep.weight / totalWeight;
    const assigned = counts[rep.id] || 0;
    const actual = totalAssigned ? assigned / totalAssigned : target;
    const fairness = Math.max(-1, Math.min(1, (target - actual) / target));
    const load = ctx.loads[rep.id];
    const loadKnown = load !== null && load !== undefined;
    const loadRatio = loadKnown ? Math.min(1, load / rep.maxActiveDeals) : 0.5;
    const offsetHours = Math.abs(timeZoneOffsetMinutes(rep.timezone, startMs) - inviteeOffset) / 60;
    const wrapped = Math.min(offsetHours, 24 - offsetHours);
    const regionMatch = rep.regions.indexOf(inviteeRegion) !== -1;
    const timezoneFit = regionMatch ? 1 : Math.max(0, 1 - wrapped / 12);
    const inHours = withinWorkingHours(rep, startMs, endMs);
    const penalty = !cfg.strictWorkingHours && !inHours ? 0.25 : 0;
    const score = w.fairness * fairness + w.load * (1 - loadRatio) + w.timezone * timezoneFit - penalty;
    return {
      repId: rep.id,
      score: balRound(score, 6),
      breakdown: {
        fairness: balRound(fairness, 4),
        targetShare: balRound(target, 4),
        actualShare: balRound(actual, 4),
        recentAssignments: assigned,
        activeDeals: loadKnown ? load : null,
        loadRatio: balRound(loadRatio, 4),
        loadKnown: loadKnown,
        timezoneFit: balRound(timezoneFit, 4),
        regionMatch: regionMatch,
        offsetHours: balRound(wrapped, 2),
        withinWorkingHours: inHours,
        workingHoursPenalty: penalty
      },
      lastAssignedAt: lastAssigned[rep.id] || null
    };
  }).sort(function (a, b) {
    if (b.score !== a.score) return b.score - a.score;
    const la = a.lastAssignedAt || '';
    const lb = b.lastAssignedAt || '';
    if (la !== lb) return la < lb ? -1 : 1;
    return a.repId < b.repId ? -1 : (a.repId > b.repId ? 1 : 0);
  });

  return { inviteeTimezone: inviteeZone, inviteeRegion: inviteeRegion, candidates: candidates, excluded: excluded, ledgerSize: ledger.assignments.length };
}

function decideAssignment(event, reps, ctx) {
  const warnings = [];
  const byId = {};
  const byOwner = {};
  const byEmail = {};
  reps.forEach(function (r) { byId[r.id] = r; byOwner[r.hubspotOwnerId] = r; byEmail[r.email] = r; });

  const duplicate = findAssignment(ctx.ledger, event.inviteeUri);
  if (duplicate && byId[duplicate.repId]) {
    return { status: 'duplicate', reason: 'invitee_already_assigned', rep: publicRep(byId[duplicate.repId]), candidates: [], excluded: [], warnings: warnings, hostMatches: event.calendlyHostEmails.indexOf(byId[duplicate.repId].email) !== -1 };
  }

  Object.keys(ctx.availability).forEach(function (id) {
    const note = ctx.availability[id].note;
    if (note === 'pto_check_failed' || note === 'pto_calendar_unreadable') warnings.push(id + ':' + note);
  });
  reps.forEach(function (r) { if (ctx.loads[r.id] === null || ctx.loads[r.id] === undefined) warnings.push(r.id + ':deal_load_unknown'); });

  const scored = scoreCandidates(reps, ctx);
  let chosen = null;
  let status;
  let reason;

  const contact = ctx.contact || { found: false, ownerId: null };
  const existingOwner = contact.ownerId ? byOwner[contact.ownerId] : null;
  const existingExcluded = existingOwner ? scored.excluded.find(function (x) { return x.repId === existingOwner.id; }) : null;

  if (existingOwner && !existingExcluded) {
    chosen = existingOwner;
    status = 'existing_owner';
    reason = 'contact_already_owned_by_available_rep';
  } else if (scored.candidates.length) {
    chosen = byId[scored.candidates[0].repId];
    status = 'assigned';
    reason = existingOwner ? 'existing_owner_unavailable_round_robin' : 'weighted_round_robin';
    if (existingOwner) warnings.push('existing_owner_' + existingOwner.id + '_excluded:' + existingExcluded.reasons.join('+'));
  } else if (ctx.cfg.fallbackRepId && byId[ctx.cfg.fallbackRepId] && byId[ctx.cfg.fallbackRepId].active) {
    chosen = byId[ctx.cfg.fallbackRepId];
    status = 'fallback';
    reason = 'no_eligible_rep_used_fallback';
  } else {
    const host = event.calendlyHostEmails.map(function (e) { return byEmail[e]; }).find(Boolean);
    if (host) {
      chosen = host;
      status = 'kept_calendly_host';
      reason = 'no_eligible_rep_kept_calendly_host';
    } else {
      status = 'unassigned';
      reason = 'no_eligible_rep_and_no_fallback';
    }
  }

  return {
    status: status,
    reason: reason,
    rep: publicRep(chosen),
    inviteeTimezone: scored.inviteeTimezone,
    inviteeRegion: scored.inviteeRegion,
    calendlyHostEmails: event.calendlyHostEmails,
    hostMatches: Boolean(chosen) && event.calendlyHostEmails.indexOf(chosen.email) !== -1,
    candidates: scored.candidates,
    excluded: scored.excluded,
    ledgerSize: scored.ledgerSize,
    warnings: warnings
  };
}

function splitName(name) {
  if (!name) return { firstname: null, lastname: null };
  const parts = name.split(' ');
  return { firstname: parts[0] || null, lastname: parts.length > 1 ? parts.slice(1).join(' ') : null };
}

function buildActions(decision, event, contact, reps, cfg) {
  const repFull = decision.rep ? reps.find(function (r) { return r.id === decision.rep.id; }) : null;
  if (!repFull || decision.status === 'duplicate') return { contact: { action: 'none' }, meeting: null, calendarEvent: null };
  const lookup = contact || { found: false, contactId: null, ownerId: null };

  let contactAction;
  if (!lookup.found) {
    const names = splitName(event.inviteeName);
    const properties = { email: event.inviteeEmail, hubspot_owner_id: repFull.hubspotOwnerId };
    if (names.firstname) properties.firstname = names.firstname;
    if (names.lastname) properties.lastname = names.lastname;
    contactAction = { action: 'create', properties: properties };
  } else if (!lookup.ownerId) {
    contactAction = { action: 'set_owner', contactId: lookup.contactId, properties: { hubspot_owner_id: repFull.hubspotOwnerId } };
  } else {
    // Never take an existing owner's contact away; only the meeting is routed.
    contactAction = { action: 'none', contactId: lookup.contactId, reason: 'contact_already_owned' };
  }

  const meeting = cfg.createHubspotMeeting ? {
    properties: {
      hs_timestamp: event.startTime,
      hs_meeting_title: balText(event.eventName + (event.inviteeName ? ' with ' + event.inviteeName : ''), 250),
      hs_meeting_start_time: event.startTime,
      hs_meeting_end_time: event.endTime,
      hs_meeting_outcome: 'SCHEDULED',
      hubspot_owner_id: repFull.hubspotOwnerId,
      hs_meeting_external_url: event.joinUrl || '',
      hs_meeting_body: 'Booked via Calendly. Routed by the workload balancer (' + decision.status + ': ' + decision.reason + ').'
    },
    // HUBSPOT_DEFINED association type 200 = meeting to contact.
    associationTypeId: 200
  } : null;

  let calendarEvent = null;
  if (cfg.bookingMode === 'calendar_handoff' && !decision.hostMatches) {
    const calendarId = cfg.sandboxMode ? cfg.sandboxCalendarId : repFull.calendarId;
    if (calendarId) {
      calendarEvent = {
        calendarId: calendarId,
        body: {
          summary: (cfg.sandboxMode ? '[SANDBOX] ' : '') + 'Hand-off: ' + event.eventName,
          description: 'Calendly booking routed to ' + repFull.name + ' (' + repFull.id + '). Invitee: ' + (event.inviteeName || 'unknown') +
            '. Original Calendly hosts: ' + (event.calendlyHostEmails.join(', ') || 'none') + '.',
          start: { dateTime: event.startTime },
          end: { dateTime: event.endTime },
          location: event.joinUrl || undefined,
          attendees: cfg.sandboxMode ? [] : [{ email: repFull.email }],
          reminders: { useDefault: true }
        }
      };
    }
  }
  return { contact: contactAction, meeting: meeting, calendarEvent: calendarEvent };
}

function parseExistingContactId(body) {
  const message = body && typeof body === 'object' ? String(body.message || '') : '';
  const match = /Existing ID:\s*(\d+)/i.exec(message);
  return match ? match[1] : null;
}
// </n8n-core:balancer>

module.exports = {
  SUPPORTED_EVENTS,
  regionForTimezone,
  timeZoneOffsetMinutes,
  localClock,
  withinWorkingHours,
  constantTimeEqual,
  verifyCalendlySignature,
  parseCalendlyEvent,
  normalizeRoster,
  publicRep,
  buildContactLookupRequest,
  readContactLookup,
  buildFreeBusyRequest,
  applyFreeBusy,
  buildDealLoadRequest,
  readDealLoad,
  emptyLedger,
  pruneLedger,
  findAssignment,
  recordAssignment,
  releaseAssignment,
  scoreCandidates,
  decideAssignment,
  buildActions,
  parseExistingContactId
};
