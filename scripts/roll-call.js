// Roll Call — daily Shapes → Slack poster
//
// Runs inside a GitHub Actions workflow:
// 1. Exchanges the stored refresh token for a fresh access token
// 2. Queries Shapes for time-away bookings, employees, reasons, offices and
//    employee field values (to resolve each person's office)
// 3. Filters to approved bookings overlapping "today" (Israel time)
// 4. Adds anyone whose office has a public holiday today (see holidays.json)
// 5. Posts a formatted message to Slack via incoming webhook
// 6. Emits the new refresh token so the workflow can persist it as a secret
//
// Required env vars:
//   SHAPES_REFRESH_TOKEN  the stored refresh JWT
//   SLACK_WEBHOOK_URL     Slack incoming webhook for #roll-call
//   DRY_RUN               optional; if "1"/"true", print the message and do NOT post
//   GITHUB_OUTPUT         (set automatically by GitHub Actions) path for outputs
//
// WHY holidays.json EXISTS
// The Shapes API exposes no public-holiday or work-schedule data. Confirmed two
// ways: full schema introspection (12 root query fields, 36 object types, no
// holiday/schedule type; Office is only { id, name }) and Shapes support, who
// said holidays live only in the app UI and that mirroring them is "the only
// supported way today". Public holidays also do NOT appear as timeAwayBookings,
// so no filter change can surface them. holidays.json therefore mirrors
// Time Management -> Time Away -> Holidays (reason 15106) and must be kept in
// sync by hand. The script fails loudly rather than silently when it goes stale.

const SHAPES_ENDPOINT = 'https://api.shapes.co/v1';
const TZ = 'Asia/Jerusalem'; // adjust if your team is elsewhere

const fs = require('fs');
const path = require('path');

const DRY_RUN = /^(1|true|yes)$/i.test(process.env.DRY_RUN || '');

function todayISODateInTZ(tz) {
  // Return YYYY-MM-DD for "now" in the given IANA timezone
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const y = parts.find(p => p.type === 'year').value;
  const m = parts.find(p => p.type === 'month').value;
  const d = parts.find(p => p.type === 'day').value;
  return `${y}-${m}-${d}`;
}

function longDateLabel(tz) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz, weekday: 'long', month: 'long', day: 'numeric',
  }).format(new Date());
}

function emojiFor(name) {
  const n = (name || '').toLowerCase();
  if (n.includes('sick')) return '🤒';
  if (n.includes('vacation')) return '🏖️';
  if (n.includes('working from home') || n.includes('wfh')) return '🏠';
  if (n.includes('traveling for work')) return '✈️';
  if (n.includes('training')) return '📚';
  if (n.includes('parental') || n.includes('maternity')) return '👶';
  if (n.includes('holiday')) return '🎉';
  if (n.includes('miluim')) return '🪖';
  if (n.includes('volunteering')) return '🤝';
  if (n.includes('paid leave')) return '💼';
  if (n.includes('time off')) return '🕐';
  return '📌';
}

function toISODate(v) {
  if (!v) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  if (typeof v === 'object' && v.date) return String(v.date).slice(0, 10);
  return null;
}

async function refreshTokens(refreshToken) {
  const res = await fetch(SHAPES_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Refresh-Token': refreshToken,
    },
    body: JSON.stringify({
      query: 'mutation { refreshToken { accessToken refreshToken } }',
    }),
  });
  if (!res.ok) throw new Error(`refreshToken HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors) throw new Error(`refreshToken errors: ${JSON.stringify(json.errors)}`);
  const t = json?.data?.refreshToken;
  if (!t?.accessToken) throw new Error(`refreshToken missing accessToken in response: ${JSON.stringify(json)}`);
  return { accessToken: t.accessToken, refreshToken: t.refreshToken || refreshToken };
}

async function fetchRollCallData(accessToken) {
  const query = `query WhoIsAway {
    timeAwayBookings { id employeeId timeAwayReasonId fromDate toDate bookingStatus }
    employees { id firstName lastName employeeFieldValues { employeeFieldTypeId textValue fieldValue } }
    timeAwayReasons { id name type }
    offices { id name }
    employeeFieldTypes { id fieldName }
  }`;
  const res = await fetch(SHAPES_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`query HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors) throw new Error(`query errors: ${JSON.stringify(json.errors)}`);
  return json.data || {};
}

function loadHolidayConfig() {
  const file = path.join(__dirname, '..', 'holidays.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Resolve employeeId -> office name using the "Office" employee field.
// Office is a custom employee field, not a first-class field on Employee, so we
// find the field type called "Office" and then read each employee's value. The
// value may be the office name (textValue) or an office id (fieldValue).
function resolveOffices(payload) {
  const officeById = Object.fromEntries((payload.offices || []).map(o => [String(o.id), o.name]));
  const officeFieldType = (payload.employeeFieldTypes || [])
    .find(t => /^office$/i.test((t.fieldName || '').trim()))
    || (payload.employeeFieldTypes || []).find(t => /office/i.test(t.fieldName || ''));

  const byEmployee = {};
  if (!officeFieldType) return { byEmployee, officeFieldFound: false };

  for (const e of payload.employees || []) {
    const val = (e.employeeFieldValues || [])
      .find(v => String(v.employeeFieldTypeId) === String(officeFieldType.id));
    if (!val) continue;
    let name = (val.textValue || '').trim();
    if (!name && val.fieldValue != null) {
      const raw = typeof val.fieldValue === 'object'
        ? (val.fieldValue.id ?? val.fieldValue.value ?? null)
        : val.fieldValue;
      if (raw != null) name = officeById[String(raw)] || '';
    }
    if (name) byEmployee[String(e.id)] = name;
  }
  return { byEmployee, officeFieldFound: true };
}

function holidayForOffice(config, officeName, today) {
  const policyKey = config.officeToPolicy?.[officeName];
  if (!policyKey) return { status: 'no-policy' };
  const policy = config.policies?.[policyKey];
  if (!policy) return { status: 'no-policy' };
  const year = today.slice(0, 4);
  const days = policy.years?.[year];
  if (!days) return { status: 'no-year', policy };
  const hit = days.find(d => d.date === today);
  return hit ? { status: 'holiday', hit, policy } : { status: 'working', policy };
}

function buildMessage(payload, today, dateLabel, config) {
  const warnings = [];

  const employees = Object.fromEntries(
    (payload.employees || []).map(e => [String(e.id), `${e.firstName || ''} ${e.lastName || ''}`.trim()])
  );
  const reasons = Object.fromEntries(
    (payload.timeAwayReasons || []).map(r => [String(r.id), r.name])
  );

  // --- 1. Approved time-away bookings overlapping today ------------------
  const bookings = (payload.timeAwayBookings || []).filter(b => {
    if ((b.bookingStatus || '').toLowerCase() !== 'approved') return false;
    const from = toISODate(b.fromDate);
    const to = toISODate(b.toDate);
    return from && to && from <= today && to >= today;
  });

  const entries = bookings.map(b => {
    const name = employees[String(b.employeeId)] || `Employee ${b.employeeId}`;
    const reason = reasons[String(b.timeAwayReasonId)] || 'Away';
    return { name, text: `• ${name} — ${emojiFor(reason)} ${reason}` };
  });

  // --- 2. Public holidays, grouped per office -------------------------
  const { byEmployee, officeFieldFound } = resolveOffices(payload);
  if (!officeFieldFound) {
    warnings.push('Could not find an "Office" employee field - public holidays were NOT checked.');
  }

  const noOffice = [];
  const unmappedOffices = new Set();
  const staleYears = new Set();
  // One line per (holiday, office) rather than per person. Listing each person
  // individually buried the handful of real absences under the whole office.
  const holidayGroups = new Map();

  for (const e of payload.employees || []) {
    const id = String(e.id);
    const name = employees[id];
    const office = byEmployee[id];

    if (!office) {
      if (officeFieldFound) noOffice.push(name);
      continue;
    }

    const r = holidayForOffice(config, office, today);
    if (r.status === 'no-policy') { unmappedOffices.add(office); continue; }
    if (r.status === 'no-year') { staleYears.add(`${office} (${today.slice(0, 4)})`); continue; }
    if (r.status !== 'holiday') continue;

    const key = `${r.policy.label}|${r.hit.name}|${r.hit.half ? 1 : 0}`;
    if (!holidayGroups.has(key)) {
      holidayGroups.set(key, { label: r.policy.label, holiday: r.hit.name, half: !!r.hit.half });
    }
  }

  if (noOffice.length) {
    warnings.push(`No office set, holidays not checked: ${noOffice.sort().join(', ')}`);
  }
  if (unmappedOffices.size) {
    warnings.push(`Offices with no holiday policy: ${[...unmappedOffices].sort().join(', ')}`);
  }
  if (staleYears.size) {
    warnings.push(`holidays.json has no dates for: ${[...staleYears].sort().join(', ')} - UPDATE IT.`);
  }

  const lines = entries
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(x => x.text);

  const holidayLines = [...holidayGroups.values()]
    .sort((a, b) => a.label.localeCompare(b.label))
    .map(g => `🎉 *${g.holiday}* — ${g.label} office off${g.half ? ', half day' : ''}`);

  const sections = [];
  if (holidayLines.length) sections.push(holidayLines.join('\n'));

  if (lines.length) {
    // The "Away today" heading only earns its place under a holiday block.
    sections.push(holidayLines.length ? `*Away today:*\n${lines.join('\n')}` : lines.join('\n'));
  } else if (holidayLines.length) {
    sections.push('✅ No other absences today.');
  } else {
    // Fri is the weekend in Israel and Sun is the weekend for the overseas
    // offices, so on those days don't claim the whole company is in.
    const partial = [0, 5].includes(new Date(today + 'T00:00:00Z').getUTCDay());
    sections.push(`✅ No mentionable notifications today. Everyone${partial ? ' working today' : ''} is in the office!`);
  }

  const body = `📋 *Roll Call — ${dateLabel}*\n\n${sections.join('\n\n')}`;

  return { text: body, count: lines.length, warnings };
}

async function postToSlack(webhookUrl, text) {
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`slack HTTP ${res.status}: ${await res.text()}`);
}

function writeOutput(key, value) {
  // Emits GITHUB_OUTPUT entries so the workflow can pick them up
  if (!process.env.GITHUB_OUTPUT) return;
  const delim = 'EOF_' + Math.random().toString(36).slice(2, 10);
  const line = `${key}<<${delim}\n${value}\n${delim}\n`;
  fs.appendFileSync(process.env.GITHUB_OUTPUT, line);
}

async function main() {
  const refreshToken = process.env.SHAPES_REFRESH_TOKEN;
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!refreshToken) throw new Error('SHAPES_REFRESH_TOKEN is not set');
  if (!webhookUrl && !DRY_RUN) throw new Error('SLACK_WEBHOOK_URL is not set');

  const config = loadHolidayConfig();

  console.log('Refreshing Shapes access token...');
  const { accessToken, refreshToken: newRefresh } = await refreshTokens(refreshToken);

  // Mask the new refresh token from logs
  console.log('::add-mask::' + newRefresh);
  console.log('::add-mask::' + accessToken);

  console.log('Fetching roll-call data...');
  const data = await fetchRollCallData(accessToken);

  const today = todayISODateInTZ(TZ);
  const dateLabel = longDateLabel(TZ);
  const { text, count, warnings } = buildMessage(data, today, dateLabel, config);

  for (const w of warnings) console.log(`::warning::${w}`);

  if (DRY_RUN) {
    console.log(`DRY RUN - not posting. ${count} entries for ${today}.`);
    console.log('----- message that WOULD be posted -----');
    console.log(text);
    console.log('----------------------------------------');
  } else {
    console.log(`Posting to Slack (${count} people away today, ${today})...`);
    await postToSlack(webhookUrl, text);
  }

  // Expose the new refresh token to the next workflow step (so it can be persisted).
  writeOutput('new_refresh_token', newRefresh);
  writeOutput('rotated', newRefresh !== refreshToken ? 'true' : 'false');

  console.log('Done.');
}

// Only run when executed directly, so tests can require this file safely.
if (require.main === module) {
  main().catch(err => {
    console.error('Roll Call failed:', err?.message || err);
    process.exit(1);
  });
}

module.exports = { buildMessage, resolveOffices, holidayForOffice, emojiFor, toISODate };
