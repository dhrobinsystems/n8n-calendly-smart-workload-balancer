#!/usr/bin/env node
'use strict';

/**
 * build-workflow.js
 *
 * Generates workflow.json from src/ so the n8n Code nodes run exactly the same
 * signature check, validation, PTO / load / timezone scoring, and gate code as
 * the standalone engine.
 *
 *   node scripts/build-workflow.js          regenerate workflow.json
 *   node scripts/build-workflow.js --check  exit 1 if workflow.json is stale
 *
 * The workflow ships with NO credential references. After import I select my
 * own HubSpot and Google Calendar credentials on each HTTP node.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(ROOT, 'workflow.json');
const N = {
  webhook: 'Calendly Webhook',
  verify: 'Verify Signature & Parse',
  accepted: 'Accepted?',
  rejected: 'Respond: Rejected',
  account: 'HubSpot: Account Details',
  gate: 'Gate, Roster & Ledger',
  needsAssignment: 'Needs Assignment?',
  noAssignment: 'Respond: Released / Duplicate',
  contactLookup: 'HubSpot: Find Contact by Email',
  planPto: 'Plan PTO Check',
  checkPto: 'Check PTO Calendars?',
  freeBusy: 'Google Calendar: PTO FreeBusy',
  fanOut: 'Fan Out Reps',
  dealLoad: 'HubSpot: Open Deals per Rep',
  score: 'Score & Assign',
  writes: 'Writes Enabled?',
  dryRun: 'Respond: Dry Run Decision',
  route: 'Route Contact Action',
  createContact: 'HubSpot: Create Contact (with Owner)',
  setOwner: 'HubSpot: Set Contact Owner',
  resolve: 'Resolve Contact ID',
  meetingGate: 'Create HubSpot Meeting?',
  meeting: 'HubSpot: Create Meeting',
  calendarGate: 'Calendar Hand-off?',
  calendar: 'Google Calendar: Insert Hand-off Event',
  assigned: 'Respond: Assigned'
};

function extractCore(relativeFile, name) {
  const source = fs.readFileSync(path.join(ROOT, relativeFile), 'utf8');
  const start = '// <n8n-core:' + name + '>';
  const end = '// </n8n-core:' + name + '>';
  const i = source.indexOf(start);
  const j = source.indexOf(end);
  if (i === -1 || j === -1 || j < i) throw new Error('Missing n8n-core:' + name + ' markers in ' + relativeFile);
  return source.slice(i, j + end.length);
}

function bodyOf(fn) {
  const text = fn.toString();
  const lines = text.slice(text.indexOf('{') + 1, text.lastIndexOf('}')).split('\n');
  while (lines.length && lines[0].trim() === '') lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  const indent = Math.min.apply(null, lines.filter(function (l) { return l.trim(); }).map(function (l) { return l.match(/^ */)[0].length; }));
  return lines.map(function (l) { return l.slice(indent); }).join('\n');
}

/* eslint-disable no-undef */
// These functions never run in Node; their bodies become Code-node source.

async function verifyGlue() {
  const readEnv = (key) => {
    try {
      const value = $env[key];
      return value === undefined || value === null ? undefined : String(value);
    } catch (error) {
      return undefined; // N8N_BLOCK_ENV_ACCESS_IN_NODE=true: fail-safe defaults apply
    }
  };
  const env = {};
  for (const key of CONFIG_KEYS) env[key] = readEnv(key);
  const config = parseConfig(env);
  const item = $input.first();
  const headers = (item.json && item.json.headers) || {};

  let raw = null;
  try {
    const buffer = await this.helpers.getBinaryDataBuffer(0, 'data');
    raw = buffer.toString('utf8');
  } catch (error) {
    raw = null; // Webhook "Raw Body" option is off
  }

  if (config.requireSignature) {
    let cryptoLib = null;
    try { cryptoLib = require('crypto'); } catch (error) { cryptoLib = null; }
    if (!cryptoLib) return [{ json: { accepted: false, httpStatus: 500, reason: 'crypto_unavailable_set_NODE_FUNCTION_ALLOW_BUILTIN_to_crypto' } }];
    if (raw === null) return [{ json: { accepted: false, httpStatus: 500, reason: 'raw_body_unavailable_enable_webhook_raw_body_option' } }];
    const hmac = (secret, data) => cryptoLib.createHmac('sha256', secret).update(data).digest('hex');
    const verdict = verifyCalendlySignature(raw, headers['calendly-webhook-signature'], readEnv('CALENDLY_WEBHOOK_SECRET'), Date.now(), config.signatureToleranceSeconds, hmac);
    if (!verdict.ok) return [{ json: { accepted: false, httpStatus: 401, reason: verdict.reason } }];
  }

  let payload;
  try {
    payload = raw !== null ? JSON.parse(raw) : item.json.body;
  } catch (error) {
    return [{ json: { accepted: false, httpStatus: 400, reason: 'invalid_json' } }];
  }
  const parsed = parseCalendlyEvent(payload);
  if (!parsed.ok) return [{ json: { accepted: false, httpStatus: 422, reason: 'invalid_payload', errors: parsed.errors } }];
  return [{ json: { accepted: true, config, event: parsed.event } }];
}

function gateGlue() {
  const base = $('Verify Signature & Parse').first().json;
  const config = base.config;
  const event = base.event;
  const account = $input.first().json;
  const verdict = evaluateHubSpotTarget(config, account);
  if (!verdict.allowed) throw new Error('HubSpot access blocked by gate: ' + verdict.reason);

  let list = null;
  let rosterSource = 'REP_ROSTER_JSON';
  try {
    const value = $env.REP_ROSTER_JSON;
    if (value && String(value).trim()) list = JSON.parse(String(value));
  } catch (error) {
    list = null;
  }
  if (!list) {
    if (config.writesEnabled) throw new Error('REP_ROSTER_JSON is blank or invalid. The example roster may only be used in dry run.');
    list = EXAMPLE_ROSTER;
    rosterSource = 'example_roster_dry_run_only';
  }
  const roster = normalizeRoster(list, config);
  if (roster.errors.length) throw new Error('Rep roster is invalid: ' + roster.errors.join('; '));

  const nowMs = Date.now();
  let store = {};
  try { store = $getWorkflowStaticData('global'); } catch (error) { store = {}; }
  const ledger = pruneLedger(store.ledger || emptyLedger(), nowMs, config.assignmentWindowDays);

  if (event.type === 'invitee.canceled') {
    const out = releaseAssignment(ledger, event.inviteeUri);
    if (config.writesEnabled) store.ledger = out.ledger;
    return [{ json: { route: 'released', config, event, released: out.released } }];
  }
  const existing = findAssignment(ledger, event.inviteeUri);
  if (existing) return [{ json: { route: 'duplicate', config, event, assignment: existing } }];

  return [{ json: { route: 'assign', config, event, reps: roster.reps, rosterSource, ledger, contactLookup: buildContactLookupRequest(event) } }];
}

function planPtoGlue() {
  const base = $('Gate, Roster & Ledger').first().json;
  const lookup = $input.first().json;
  const contact = readContactLookup(lookup.error ? null : { statusCode: lookup.statusCode, body: lookup.body });
  const freeBusy = base.config.ptoCheckEnabled ? buildFreeBusyRequest(base.reps, base.event) : null;
  return [{ json: Object.assign({}, base, { contact, freeBusy, checkPto: Boolean(freeBusy) }) }];
}

function fanOutGlue() {
  const plan = $('Plan PTO Check').first().json;
  const inbound = $input.first().json;
  let response = null;
  if (plan.checkPto) response = inbound.error ? { statusCode: 0, body: null } : { statusCode: inbound.statusCode, body: inbound.body };
  const availability = applyFreeBusy(plan.reps, plan.event, response);
  return plan.reps.map((rep) => ({ json: { repId: rep.id, availability, request: buildDealLoadRequest(rep) } }));
}

function scoreGlue() {
  const plan = $('Plan PTO Check').first().json;
  const fanned = $('Fan Out Reps').all();
  const responses = $input.all();
  const loads = {};
  fanned.forEach((item, index) => {
    const res = responses[index] ? responses[index].json : null;
    loads[item.json.repId] = res && !res.error ? readDealLoad({ statusCode: res.statusCode, body: res.body }) : null;
  });
  const availability = fanned.length ? fanned[0].json.availability : {};
  const nowMs = Date.now();
  const config = plan.config;
  const warnings = plan.contact.ok ? [] : ['contact_lookup_failed'];
  if (config.ptoCheckEnabled && !plan.checkPto) warnings.push('pto_check_skipped_no_pto_calendars');

  const decision = decideAssignment(plan.event, plan.reps, { event: plan.event, availability, loads, ledger: plan.ledger, contact: plan.contact, cfg: config, nowMs });
  decision.warnings = warnings.concat(decision.warnings);
  const actions = buildActions(decision, plan.event, plan.contact, plan.reps, config);

  const recorded = ['assigned', 'existing_owner', 'fallback', 'kept_calendly_host'];
  if (config.writesEnabled && decision.rep && recorded.indexOf(decision.status) !== -1) {
    let store = {};
    try { store = $getWorkflowStaticData('global'); } catch (error) { store = {}; }
    // Recorded before the CRM writes, so a retried webhook is treated as a duplicate.
    store.ledger = recordAssignment(plan.ledger, {
      inviteeUri: plan.event.inviteeUri, repId: decision.rep.id, assignedAt: new Date(nowMs).toISOString(), eventStart: plan.event.startTime, status: decision.status
    });
  }
  return [{
    json: {
      writesEnabled: config.writesEnabled,
      writeMode: config.writeMode,
      hubspotBaseUrl: config.hubspotBaseUrl,
      event: plan.event,
      contact: plan.contact,
      decision,
      actions,
      contactAction: actions.contact.action
    }
  }];
}

function resolveGlue() {
  const s = $('Score & Assign').first().json;
  const inbound = $input.first().json;
  let contactId = s.actions.contact.contactId || s.contact.contactId || null;
  let contactResult = s.contactAction === 'none' ? 'unchanged' : 'owner_set';
  if (s.contactAction === 'create') {
    const status = Number(inbound.statusCode);
    if (status === 200 || status === 201) { contactId = String(inbound.body.id); contactResult = 'created'; }
    else if (status === 409) { contactId = parseExistingContactId(inbound.body); contactResult = 'exists_owner_left_unchanged'; }
    else throw new Error('HubSpot contact create failed with status ' + (inbound.statusCode || 'n/a'));
  }
  const meeting = s.actions.meeting;
  const meetingBody = meeting ? {
    properties: meeting.properties,
    associations: contactId ? [{ to: { id: contactId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: meeting.associationTypeId }] }] : []
  } : null;
  return [{
    json: {
      contactId,
      contactResult,
      hasMeeting: Boolean(meetingBody),
      meetingBody,
      hasCalendar: Boolean(s.actions.calendarEvent),
      calendarEvent: s.actions.calendarEvent
    }
  }];
}
/* eslint-enable no-undef */

function codeNode(name, id, position, cores, body) {
  return {
    parameters: { jsCode: '// GENERATED by scripts/build-workflow.js from src/. Edit src/, then rebuild.\n' + cores.concat([body]).join('\n\n') + '\n' },
    id: id, name: name, type: 'n8n-nodes-base.code', typeVersion: 2, position: position
  };
}

function ifNode(name, id, position, expression) {
  return {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
        conditions: [{ id: id + '-condition', leftValue: expression, rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }],
        combinator: 'and'
      },
      options: {}
    },
    id: id, name: name, type: 'n8n-nodes-base.if', typeVersion: 2, position: position
  };
}

function respondNode(name, id, position, code, body) {
  return {
    parameters: { respondWith: 'json', responseBody: body, options: { responseCode: code } },
    id: id, name: name, type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.1, position: position
  };
}

const FULL = { response: { response: { fullResponse: true, neverError: true } } };
const RETRY = { retryOnFail: true, maxTries: 3, waitBetweenTries: 1500 };
const HS_BASE = "{{ $('" + N.verify + "').first().json.config.hubspotBaseUrl }}";

function http(name, id, position, params, extra) {
  return Object.assign({ parameters: params, id: id, name: name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: position }, extra || {});
}

function hubspot(method, apiPath, extra) {
  return Object.assign({ method: method, url: '=' + HS_BASE + apiPath, authentication: 'predefinedCredentialType', nodeCredentialType: 'hubspotAppToken' }, extra);
}

function buildWorkflow() {
  const configCore = extractCore('src/config.js', 'config');
  const balancerCore = extractCore('src/balancer.js', 'balancer');
  const roster = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'rep-roster.example.json'), 'utf8'));
  const rosterConst = '// Example roster with dummy identifiers. Used ONLY in dry run when REP_ROSTER_JSON is blank.\nconst EXAMPLE_ROSTER = ' + JSON.stringify(roster) + ';';
  let counter = 0;
  const id = function () { counter++; return '5005e000-0000-4000-8000-' + String(counter).padStart(12, '0'); };

  const nodes = [
    {
      parameters: { httpMethod: 'POST', path: 'calendly-workload-balancer', responseMode: 'responseNode', options: { rawBody: true } },
      id: id(), name: N.webhook, type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 300], webhookId: '6006f000-0000-4000-8000-000000000001'
    },
    codeNode(N.verify, id(), [220, 300], [configCore, balancerCore], bodyOf(verifyGlue)),
    ifNode(N.accepted, id(), [440, 300], '={{ $json.accepted }}'),
    respondNode(N.rejected, id(), [660, 520], '={{ $json.httpStatus }}', "={{ JSON.stringify({ status: 'rejected', reason: $json.reason, errors: $json.errors || [] }) }}"),
    http(N.account, id(), [660, 200], hubspot('GET', '/account-info/v3/details', { options: {} }), RETRY),
    codeNode(N.gate, id(), [880, 200], [configCore, balancerCore, rosterConst], bodyOf(gateGlue)),
    ifNode(N.needsAssignment, id(), [1100, 200], "={{ $json.route === 'assign' }}"),
    respondNode(N.noAssignment, id(), [1320, 420], 200, "={{ JSON.stringify({ status: $json.route, writeMode: $json.config.writeMode, released: $json.released || null, assignment: $json.assignment || null }) }}"),
    http(N.contactLookup, id(), [1320, 120], hubspot('POST', '/crm/v3/objects/contacts/search', {
      sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify($json.contactLookup.body) }}', options: FULL
    }), Object.assign({ onError: 'continueRegularOutput' }, RETRY)),
    codeNode(N.planPto, id(), [1540, 120], [configCore, balancerCore], bodyOf(planPtoGlue)),
    ifNode(N.checkPto, id(), [1760, 120], '={{ $json.checkPto }}'),
    http(N.freeBusy, id(), [1980, 0], {
      method: 'POST', url: 'https://www.googleapis.com/calendar/v3/freeBusy',
      authentication: 'predefinedCredentialType', nodeCredentialType: 'googleCalendarOAuth2Api',
      sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify($json.freeBusy) }}', options: FULL
    }, Object.assign({ onError: 'continueRegularOutput' }, RETRY)),
    codeNode(N.fanOut, id(), [2200, 120], [configCore, balancerCore], bodyOf(fanOutGlue)),
    http(N.dealLoad, id(), [2420, 120], hubspot('POST', '/crm/v3/objects/deals/search', {
      sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify($json.request.body) }}',
      options: Object.assign({ batching: { batch: { batchSize: 4, batchInterval: 250 } } }, FULL)
    }), Object.assign({ onError: 'continueRegularOutput' }, RETRY)),
    codeNode(N.score, id(), [2640, 120], [configCore, balancerCore], bodyOf(scoreGlue)),
    ifNode(N.writes, id(), [2860, 120], '={{ $json.writesEnabled }}'),
    respondNode(N.dryRun, id(), [3080, 340], 200, "={{ JSON.stringify({ status: 'dry_run', writeMode: $json.writeMode, decision: $json.decision, actions: $json.actions }) }}"),
    {
      parameters: {
        rules: {
          values: ['create', 'set_owner', 'none'].map(function (value) {
            return {
              conditions: {
                options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
                conditions: [{ leftValue: '={{ $json.contactAction }}', rightValue: value, operator: { type: 'string', operation: 'equals' } }],
                combinator: 'and'
              },
              renameOutput: true,
              outputKey: value
            };
          })
        },
        options: {}
      },
      id: id(), name: N.route, type: 'n8n-nodes-base.switch', typeVersion: 3, position: [3080, 40]
    },
    http(N.createContact, id(), [3300, -80], hubspot('POST', '/crm/v3/objects/contacts', {
      sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify({ properties: $json.actions.contact.properties }) }}', options: FULL
    }), RETRY),
    http(N.setOwner, id(), [3300, 60], hubspot('PATCH', '/crm/v3/objects/contacts/{{ $json.actions.contact.contactId }}', {
      sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify({ properties: $json.actions.contact.properties }) }}', options: {}
    }), RETRY),
    codeNode(N.resolve, id(), [3520, 40], [balancerCore], bodyOf(resolveGlue)),
    ifNode(N.meetingGate, id(), [3740, 40], '={{ $json.hasMeeting }}'),
    http(N.meeting, id(), [3960, -60], hubspot('POST', '/crm/v3/objects/meetings', {
      sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify($json.meetingBody) }}', options: {}
    }), RETRY),
    ifNode(N.calendarGate, id(), [4180, 40], "={{ $('" + N.resolve + "').first().json.hasCalendar }}"),
    http(N.calendar, id(), [4400, -60], {
      method: 'POST',
      url: "=https://www.googleapis.com/calendar/v3/calendars/{{ encodeURIComponent($('" + N.resolve + "').first().json.calendarEvent.calendarId) }}/events",
      authentication: 'predefinedCredentialType', nodeCredentialType: 'googleCalendarOAuth2Api',
      sendQuery: true, queryParameters: { parameters: [{ name: 'sendUpdates', value: 'none' }] },
      sendBody: true, specifyBody: 'json', jsonBody: "={{ JSON.stringify($('" + N.resolve + "').first().json.calendarEvent.body) }}", options: {}
    }, RETRY),
    respondNode(N.assigned, id(), [4620, 40], 200, "={{ JSON.stringify({ status: 'written', writeMode: $('" + N.score + "').first().json.writeMode, decision: $('" + N.score + "').first().json.decision, contact: $('" + N.resolve + "').first().json.contactResult }) }}")
  ];

  const connections = {};
  const link = function (from, to, output) {
    const index = output || 0;
    connections[from] = connections[from] || { main: [] };
    while (connections[from].main.length <= index) connections[from].main.push([]);
    connections[from].main[index].push({ node: to, type: 'main', index: 0 });
  };
  link(N.webhook, N.verify);
  link(N.verify, N.accepted);
  link(N.accepted, N.account, 0);
  link(N.accepted, N.rejected, 1);
  link(N.account, N.gate);
  link(N.gate, N.needsAssignment);
  link(N.needsAssignment, N.contactLookup, 0);
  link(N.needsAssignment, N.noAssignment, 1);
  link(N.contactLookup, N.planPto);
  link(N.planPto, N.checkPto);
  link(N.checkPto, N.freeBusy, 0);
  link(N.checkPto, N.fanOut, 1);
  link(N.freeBusy, N.fanOut);
  link(N.fanOut, N.dealLoad);
  link(N.dealLoad, N.score);
  link(N.score, N.writes);
  link(N.writes, N.route, 0);
  link(N.writes, N.dryRun, 1);
  link(N.route, N.createContact, 0);
  link(N.route, N.setOwner, 1);
  link(N.route, N.resolve, 2);
  link(N.createContact, N.resolve);
  link(N.setOwner, N.resolve);
  link(N.resolve, N.meetingGate);
  link(N.meetingGate, N.meeting, 0);
  link(N.meetingGate, N.calendarGate, 1);
  link(N.meeting, N.calendarGate);
  link(N.calendarGate, N.calendar, 0);
  link(N.calendarGate, N.assigned, 1);
  link(N.calendar, N.assigned);

  return {
    name: 'Calendly Smart Workload Balancer (DRY RUN + SANDBOX by default)',
    nodes: nodes,
    connections: connections,
    active: false,
    settings: { executionOrder: 'v1', saveManualExecutions: true, callerPolicy: 'workflowsFromSameOwner' },
    pinData: {},
    meta: { templateCredsSetupCompleted: false },
    tags: []
  };
}

function render() {
  return JSON.stringify(buildWorkflow(), null, 2) + '\n';
}

if (require.main === module) {
  const output = render();
  if (process.argv.includes('--check')) {
    const current = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, 'utf8') : '';
    if (current !== output) {
      process.stderr.write('workflow.json is out of date. Run: npm run build:workflow\n');
      process.exitCode = 1;
    } else {
      process.stdout.write('workflow.json is in sync with src/.\n');
    }
  } else {
    fs.writeFileSync(OUTPUT, output);
    process.stdout.write('Wrote ' + path.relative(process.cwd(), OUTPUT) + '\n');
  }
}

module.exports = { buildWorkflow, render, extractCore, bodyOf, NODES: N };
