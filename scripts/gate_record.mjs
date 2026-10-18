#!/usr/bin/env node
// Append one lane or finding row to a release-gate ledger, validating it first.
// Lanes write their own rows; the gate never has to guess what a lane meant.
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const LANE_COLS = ['lane', 'target', 'verdict', 'git_sha', 'recorded_at', 'checker_exit', 'descoped_by', 'notes'];
const FINDING_COLS = ['id', 'lane', 'route', 'severity', 'remediation', 'evidence', 'touches', 'accepted_by'];

const LANES = ['exposure', 'app-tests', 'perf'];
const TOUCHES = ['data', 'money', 'role', 'none', 'unknown'];
const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
const REMEDIATIONS = ['open', 'fixed-verified', 'fixed-unproven', 'accepted-risk'];
const VERDICTS = {
  exposure: ['PASS', 'PASS WITH FIXES', 'BLOCK', 'INCONCLUSIVE', 'untested'],
  'app-tests': ['ready', 'HOLD', 'pass', 'fail', 'not-proven', 'not-applicable', 'untested'],
  perf: ['measured', 'not-measured', 'untested'],
};

function flag(name, args) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
}

const [kind, runDir, ...args] = process.argv.slice(2);
if (!['lane', 'finding'].includes(kind) || !runDir) {
  console.error('usage:\n  node gate_record.mjs lane <run-dir> --lane <name> --target <host> --verdict <v> --sha <sha> [--checker <exit>] [--descoped <user:reason>] [--notes <text>]\n  node gate_record.mjs finding <run-dir> --id <ID> --lane <name> --route <path> --severity <s> --remediation <r> --evidence <ref> --touches <t> [--accepted-by <who>]');
  process.exit(2);
}

const file = join(runDir, kind === 'lane' ? 'lanes.tsv' : 'findings.tsv');
const cols = kind === 'lane' ? LANE_COLS : FINDING_COLS;
const today = new Date().toISOString().slice(0, 10);
const errors = [];

let row;
if (kind === 'lane') {
  const laneName = flag('lane', args);
  const verdict = flag('verdict', args);
  const descoped = flag('descoped', args);
  if (!LANES.includes(laneName ?? '')) errors.push(`--lane must be ${LANES.join('|')}`);
  else if (!descoped && !VERDICTS[laneName].includes(verdict ?? '')) {
    errors.push(`--verdict "${verdict}" is outside the ${laneName} vocabulary: ${VERDICTS[laneName].join('|')}`);
  } else if (!verdict) errors.push('--verdict is required (use "untested" if nothing ran)');
  row = [
    laneName ?? '-',
    flag('target', args) ?? '-',
    descoped ? verdict ?? 'untested' : verdict ?? '-',
    flag('sha', args) ?? '-',
    today,
    flag('checker', args) ?? '-',
    descoped ?? '-',
    (flag('notes', args) ?? '-').replace(/\s+/g, ' '),
  ];
} else {
  const id = flag('id', args);
  const laneName = flag('lane', args);
  const severity = flag('severity', args);
  const remediation = flag('remediation', args);
  const touches = flag('touches', args);
  const evidence = flag('evidence', args);
  if (!/^(PREFLIGHT-\d+|REDTEAM-S\d+|PERF-\d+)$/.test(id ?? '')) errors.push('--id must be PREFLIGHT-<nn> | REDTEAM-S<nn> | PERF-<nn>');
  if (!LANES.includes(laneName ?? '')) errors.push(`--lane must be ${LANES.join('|')}`);
  if (!SEVERITIES.includes(severity ?? '')) errors.push(`--severity must be ${SEVERITIES.join('|')} (map perf P0-P3 first)`);
  if (!REMEDIATIONS.includes(remediation ?? '')) errors.push(`--remediation must be ${REMEDIATIONS.join('|')}`);
  if (!TOUCHES.includes(touches ?? '')) errors.push(`--touches must be ${TOUCHES.join('|')} — "none" is a claim, not a default`);
  if (!evidence) errors.push('--evidence is required; a finding without a reference is not a finding');
  if (remediation === 'accepted-risk' && !flag('accepted-by', args)) errors.push('--accepted-by is required for accepted-risk');
  row = [id ?? '-', laneName ?? '-', (flag('route', args) ?? '-').replace(/\s+/g, ' '), severity ?? '-', remediation ?? '-', evidence ?? '-', touches ?? '-', flag('accepted-by', args) ?? '-'];
}

if (errors.length) {
  for (const e of errors) console.error(`REJECTED: ${e}`);
  process.exit(2);
}
if (row.some((c) => c.includes('\t'))) {
  console.error('REJECTED: a field contains a tab; the ledger is tab-delimited');
  process.exit(2);
}

if (!existsSync(file)) writeFileSync(file, cols.join('\t') + '\n');
appendFileSync(file, row.join('\t') + '\n');
console.log(`recorded ${kind}: ${row[0]}`);
