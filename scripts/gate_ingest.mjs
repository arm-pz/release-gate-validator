#!/usr/bin/env node
// Ingest an existing pre-ship-security-red-team run into the gate ledger. No attacking, no editing.
// The red-team results table is the only pre-ship artifact that is machine-readable, so this
// fork parses that one and demands the other two lanes as verbatim tables.
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const LANE_COLS = ['lane', 'target', 'verdict', 'git_sha', 'recorded_at', 'checker_exit', 'descoped_by', 'notes'];
const FINDING_COLS = ['id', 'lane', 'route', 'severity', 'remediation', 'evidence', 'touches', 'accepted_by'];
const SEVERITY_WORDS = { critical: 'CRITICAL', high: 'HIGH', medium: 'MEDIUM', low: 'LOW' };

// Which boundary each scenario crosses. Deterministic by design: an ingest that left every row
// `unknown` would hold on R8 and teach nothing. Review the mapping before trusting `ready`.
const TOUCHES = {
  S01: 'data', S02: 'data', S03: 'role', S04: 'data', S05: 'role',
  S06: 'money', S07: 'money', S08: 'none', S09: 'none', S10: 'none',
  S11: 'none', S12: 'data', S13: 'data', S14: 'none',
};

const positional = process.argv.slice(2);
const checkerIdx = positional.indexOf('--checker');
const checkerExit = checkerIdx >= 0 ? positional.splice(checkerIdx, 2)[1] : '-';
const [runDir, rtDir, gitSha = '-', target = '-'] = positional;
if (!runDir || !rtDir) {
  console.error('usage: node gate_ingest.mjs <gate-run-dir> <red-team-run-dir> [git-sha] [app-target] [--checker <exit-code-of-check_results.mjs>]');
  console.error('This fork runs nothing. Pass --checker only if you ran the red team\'s checker yourself;');
  console.error('without it the app-tests lane holds on R3, which is the honest outcome, not a bug.');
  process.exit(2);
}
const resultsDir = join(rtDir, 'results');
if (!existsSync(resultsDir)) {
  console.error(`NOT-INGESTABLE: ${resultsDir} is missing. This fork reads reports; it does not produce them.`);
  process.exit(2);
}

const cells = (line) => line.split('|').slice(1, -1).map((c) => c.replace(/`/g, '').trim());

// Reports are masked by their own skill's rules; that is not a reason to copy a live credential
// into a ledger that outlives the run.
const redact = (s) => s.replace(/(password|passwd|token|cookie|secret|authorization|api[_-]?key)\s*[:=]\s*\S+/gi, '$1=[masked]');

const rows = [];
for (const f of readdirSync(resultsDir).filter((n) => /^group-\d+\.md$/.test(n)).sort()) {
  for (const line of readFileSync(join(resultsDir, f), 'utf8').split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue;
    const c = cells(line);
    if (c.length < 12 || c[0] === 'id' || /^-+$/.test(c[0])) continue;
    const [id, scenario, verdict, executed, method, request, response, severity, fix, falsified, after, notes] = c;
    const s = scenario.match(/S\d{2}/)?.[0];
    if (!s) continue;
    rows.push({ key: id, scenario: s, verdict: verdict.toLowerCase(), executed, method, request, response, severity, falsified: falsified.toLowerCase(), after, notes, file: f });
  }
}
if (!rows.length) {
  console.error(`NOT-INGESTABLE: no result rows found in ${resultsDir}.`);
  process.exit(2);
}

const sev = (r) => SEVERITY_WORDS[(r.severity || '').toLowerCase()] ?? null;
// The results table's `method` cell is a narrative, not a route. Take the first path-shaped token
// from the request, and fall back to the scenario name rather than dumping prose into the ledger.
const routeOf = (r) => {
  for (const src of [r.request, r.method]) {
    const m = (src || '').match(/\/[A-Za-z0-9_~:.\-/{}]+/);
    if (m) return m[0];
  }
  return r.key;
};

function remediationOf(r) {
  if (r.verdict === 'fail') return 'open';
  if (r.verdict === 'pass') return r.falsified === 'yes' ? 'fixed-verified' : 'fixed-unproven';
  if (r.verdict === 'not-proven') return 'open';
  return null;
}

const findings = [];
const skipped = [];
for (const r of rows) {
  const severity = sev(r);
  if (!severity) {
    skipped.push(`${r.scenario} verdict=${r.verdict || 'unrun'} severity=${r.severity || '-'} — no finding row`);
    continue;
  }
  const remediation = remediationOf(r);
  if (!remediation) {
    skipped.push(`${r.scenario} verdict=${r.verdict} — not-applicable, recorded in the lane notes`);
    continue;
  }
  findings.push([
    `REDTEAM-${r.scenario}`, 'app-tests', redact(routeOf(r)), severity, remediation,
    redact(`${r.file}#${r.key} response=${(r.response || '-').replace(/\s+/g, ' ').slice(0, 80)}`),
    TOUCHES[r.scenario] ?? 'unknown', '-',
  ]);
}

const anyFail = rows.some((r) => r.verdict === 'fail');
const postureFile = join(rtDir, 'report.md');
let verdict = null;
if (existsSync(postureFile)) {
  const text = readFileSync(postureFile, 'utf8');
  const m = text.match(/ship posture[:\s]*`?(HOLD|ready)/i);
  if (m) verdict = m[1].toLowerCase() === 'hold' ? 'HOLD' : 'ready';
}
if (!verdict) verdict = anyFail ? 'HOLD' : 'ready';

const notApplicable = rows.filter((r) => r.verdict === 'not-applicable').map((r) => r.scenario);
const laneRow = [
  'app-tests', target, verdict, gitSha, new Date().toISOString().slice(0, 10),
  /-?\d+|-/.test(checkerExit) ? checkerExit : '-', '-',
  `ingested from ${rtDir}; ${notApplicable.length ? `not-applicable: ${notApplicable.join(' ')}` : 'no not-applicable scenarios'}`.replace(/\s+/g, ' '),
];

// Re-ingesting replaces only what this ingester owns. Other lanes' rows in the same ledger are
// left alone, so running this twice is safe and running it second is safe too.
function merge(file, cols, keep, replacementRows) {
  mkdirSync(runDir, { recursive: true });
  const existing = existsSync(file)
    ? readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '' && !l.startsWith('#')).slice(1)
    : [];
  const kept = existing.filter((l) => keep(l.split('\t')[0] ?? ''));
  writeFileSync(file, [cols.join('\t'), ...kept, ...replacementRows].join('\n') + '\n');
}

merge(join(runDir, 'lanes.tsv'), LANE_COLS, (lane) => lane !== 'app-tests', [laneRow.join('\t')]);
merge(join(runDir, 'findings.tsv'), FINDING_COLS, (id) => !id.startsWith('REDTEAM-'), findings.map((f) => f.join('\t')));

console.log(`ingested ${rows.length} scenarios -> ${findings.length} findings, lane verdict ${verdict}`);
if (skipped.length) console.log('skipped (no finding row written):\n  ' + skipped.join('\n  '));
console.log('\nStill yours to record — this fork does not run lanes:');
console.log('  node scripts/gate_record.mjs lane ' + runDir + ' --lane exposure --target <host> --verdict <PASS|PASS WITH FIXES|BLOCK|INCONCLUSIVE|untested> --sha <sha>');
console.log('  node scripts/gate_record.mjs lane ' + runDir + ' --lane perf --target <host> --verdict <measured|not-measured> --sha <sha>');
console.log('Then copy each report\'s finding table into the ledger verbatim, and run check_gate.mjs.');
