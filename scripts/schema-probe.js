// TEMPORARY schema probe — goes at scripts/schema-probe.js
//
// Why this exists: Roll Call currently reports only `timeAwayBookings`. But an
// employee can also be off because of a PUBLIC HOLIDAY attached to their office
// (e.g. Simona / N. Macedonia office, 8 Sep = Independence Day). That is a
// different part of the Shapes schema, and we don't yet know the field names.
//
// This script prints the schema fragments we need. Run it once from the Actions
// tab, read the log, then extend roll-call.js and DELETE this file + its workflow.
//
// IMPORTANT: refreshing can rotate the stored refresh token. This script emits
// the new token so the workflow can persist it, exactly like roll-call.js does.
// Without that, the daily Roll Call would start failing auth.

const SHAPES_ENDPOINT = 'https://api.shapes.co/v1';
const fs = require('fs');

async function refreshTokens(refreshToken) {
  const res = await fetch(SHAPES_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Refresh-Token': refreshToken },
    body: JSON.stringify({ query: 'mutation { refreshToken { accessToken refreshToken } }' }),
  });
  if (!res.ok) throw new Error(`refreshToken HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors) throw new Error(`refreshToken errors: ${JSON.stringify(json.errors)}`);
  const t = json?.data?.refreshToken;
  if (!t?.accessToken) throw new Error('refreshToken missing accessToken');
  return { accessToken: t.accessToken, refreshToken: t.refreshToken || refreshToken };
}

async function gql(accessToken, query) {
  const res = await fetch(SHAPES_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ query }),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${txt}`);
  const json = JSON.parse(txt);
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

function writeOutput(key, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  const delim = 'EOF_' + Math.random().toString(36).slice(2, 10);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}<<${delim}\n${value}\n${delim}\n`);
}

// v2: dump the WHOLE schema. The targeted search found no holiday/schedule
// query at all, so we now need to see every type and every root field's args.
const RE = /./;

(async () => {
  const stored = process.env.SHAPES_REFRESH_TOKEN;
  if (!stored) throw new Error('SHAPES_REFRESH_TOKEN is not set');

  const { accessToken, refreshToken: newRefresh } = await refreshTokens(stored);
  console.log('::add-mask::' + newRefresh);
  console.log('::add-mask::' + accessToken);

  const rootData = await gql(
    accessToken,
    '{ __schema { queryType { fields { name args { name type { name kind ofType { name } } } type { name kind ofType { name } } } } } }'
  );
  const rootFields = rootData.__schema.queryType.fields;

  console.log(`=== ROOT QUERY FIELDS WITH ARGS (${rootFields.length}) ===`);
  for (const f of rootFields) {
    const args = (f.args || [])
      .map((a) => a.name + ':' + (a.type.name || a.type.ofType?.name || a.type.kind))
      .join(', ');
    const ret = f.type.name || f.type.ofType?.name || f.type.kind;
    console.log(`  ${f.name}(${args}) -> ${ret}`);
  }

  const typeData = await gql(
    accessToken,
    '{ __schema { types { name kind fields { name type { name kind ofType { name kind ofType { name } } } } } } }'
  );

  const matched = typeData.__schema.types.filter(
    (t) => t.name && !t.name.startsWith('__') && (t.fields || []).length && RE.test(t.name)
  );

  console.log(`\n=== ALL OBJECT TYPES (${matched.length}) ===`);
  for (const t of matched) {
    console.log(`\n--- ${t.kind} ${t.name} ---`);
    for (const f of t.fields || []) {
      const ty = f.type;
      const tname = ty.name || ty.ofType?.name || ty.ofType?.ofType?.name || ty.kind;
      console.log(`  ${f.name}: ${tname}`);
    }
  }

  writeOutput('new_refresh_token', newRefresh);
  writeOutput('rotated', newRefresh !== stored ? 'true' : 'false');
  console.log('\nProbe done.');
})().catch((err) => {
  console.error('Schema probe failed:', err?.message || err);
  process.exit(1);
});
