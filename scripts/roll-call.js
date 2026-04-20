// Roll Call — daily Shapes → Slack poster
//
// Runs inside a GitHub Actions workflow:
//   1. Exchanges the stored refresh token for a fresh access token
//   2. Queries Shapes for all time-away bookings, employees, reasons
//   3. Filters to approved bookings overlapping "today" (Israel time)
//   4. Posts a formatted message to Slack via incoming webhook
//   5. Emits the new refresh token so the workflow can persist it as a secret
//
// Required env vars:
//   SHAPES_REFRESH_TOKEN   the stored refresh JWT
//   SLACK_WEBHOOK_URL      Slack incoming webhook for #roll-call
//   GITHUB_OUTPUT          (set automatically by GitHub Actions) path for outputs

const SHAPES_ENDPOINT = 'https://api.shapes.co/v1';
const TZ = 'Asia/Jerusalem'; // adjust if your team is elsewhere

const fs = require('fs');

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
    employees { id firstName lastName }
    timeAwayReasons { id name type }
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

function buildMessage(payload, today, dateLabel) {
  const employees = Object.fromEntries(
    (payload.employees || []).map(e => [e.id, `${e.firstName || ''} ${e.lastName || ''}`.trim()])
  );
  const reasons = Object.fromEntries(
    (payload.timeAwayReasons || []).map(r => [r.id, r.name])
  );

  const bookings = (payload.timeAwayBookings || []).filter(b => {
    if ((b.bookingStatus || '').toLowerCase() !== 'approved') return false;
    const from = toISODate(b.fromDate);
    const to = toISODate(b.toDate);
    return from && to && from <= today && to >= today;
  });

  const lines = bookings
    .map(b => {
      const name = employees[b.employeeId] || `Employee ${b.employeeId}`;
      const reason = reasons[b.timeAwayReasonId] || 'Away';
      return { name, text: `• ${name} — ${emojiFor(reason)} ${reason}` };
    })
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(x => x.text);

  const body = lines.length === 0
    ? `📋 *Roll Call — ${dateLabel}*\n\n✅ No mentionable notifications today. Everyone is in the office!`
    : `📋 *Roll Call — ${dateLabel}*\n\n${lines.join('\n')}`;

  return { text: body, count: lines.length };
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
  // Use EOF delimiter syntax to avoid issues with multi-line / special chars
  const delim = 'EOF_' + Math.random().toString(36).slice(2, 10);
  const line = `${key}<<${delim}\n${value}\n${delim}\n`;
  fs.appendFileSync(process.env.GITHUB_OUTPUT, line);
}

(async () => {
  const refreshToken = process.env.SHAPES_REFRESH_TOKEN;
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!refreshToken) throw new Error('SHAPES_REFRESH_TOKEN is not set');
  if (!webhookUrl) throw new Error('SLACK_WEBHOOK_URL is not set');

  console.log('Refreshing Shapes access token…');
  const { accessToken, refreshToken: newRefresh } = await refreshTokens(refreshToken);

  // Mask the new refresh token from logs
  console.log('::add-mask::' + newRefresh);
  console.log('::add-mask::' + accessToken);

  console.log('Fetching roll-call data…');
  const data = await fetchRollCallData(accessToken);

  const today = todayISODateInTZ(TZ);
  const dateLabel = longDateLabel(TZ);
  const { text, count } = buildMessage(data, today, dateLabel);

  console.log(`Posting to Slack (${count} people away today, ${today})…`);
  await postToSlack(webhookUrl, text);

  // Expose the new refresh token to the next workflow step (so it can be persisted).
  writeOutput('new_refresh_token', newRefresh);
  writeOutput('rotated', newRefresh !== refreshToken ? 'true' : 'false');

  console.log('Done.');
})().catch(err => {
  console.error('Roll Call failed:', err?.message || err);
  process.exit(1);
});
