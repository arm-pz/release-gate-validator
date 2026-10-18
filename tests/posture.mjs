#!/usr/bin/env node
// Posture fixtures for check_gate.mjs. Run: node tests/posture.mjs
// Both directions count: a checker that always answered HOLD would pass half of this by accident.
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CHECKER = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'check_gate.mjs');
const LANE_HEAD = ['lane', 'target', 'verdict', 'git_sha', 'recorded_at', 'checker_exit', 'descoped_by', 'notes'];
const FIND_HEAD = ['id', 'lane', 'route', 'severity', 'remediation', 'evidence', 'touches', 'accepted_by'];

const lane = (name, verdict, opts = {}) =>
  [name, opts.target ?? 'example.com', verdict, opts.sha ?? 'abc123', '2026-10-18', opts.checker ?? '-', opts.descope ?? '-', opts.notes ?? '-'].join('\t');
const finding = (id, laneName, route, severity, remediation, touches, opts = {}) =>
  [id, laneName, route, severity, remediation, opts.evidence ?? 'bounded evidence ref', touches, opts.by ?? '-'].join('\t');

const CLEAN = (findings = []) => ({
  lanes: [lane('exposure', 'PASS'), lane('app-tests', 'ready', { checker: '0' }), lane('perf', 'measured')],
  findings,
});

const cases = [
  { name: '01 all lanes clean, one MEDIUM open', ...CLEAN([finding('PREFLIGHT-01', 'exposure', '/.git/HEAD', 'MEDIUM', 'open', 'none')]), want: 0, wantRules: [] },
  { name: '02 app lane untested, no reason recorded', lanes: [lane('exposure', 'PASS'), lane('app-tests', 'untested'), lane('perf', 'measured')], findings: [], want: 1, wantRules: ['R1'] },
  { name: '03 app lane de-scoped by the user', lanes: [lane('exposure', 'PASS'), lane('app-tests', 'untested', { descope: 'user:no isolated environment' }), lane('perf', 'measured')], findings: [], want: 0, wantRules: [] },
  { name: '04 exposure INCONCLUSIVE', lanes: [lane('exposure', 'INCONCLUSIVE'), lane('app-tests', 'ready', { checker: '0' }), lane('perf', 'measured')], findings: [], want: 1, wantRules: ['R1'] },
  { name: '05 HIGH fixed-unproven', ...CLEAN([finding('PREFLIGHT-02', 'exposure', '/assets/app.js.map', 'HIGH', 'fixed-unproven', 'none')]), want: 1, wantRules: ['R2'] },
  { name: '06 HIGH fixed-verified', ...CLEAN([finding('PREFLIGHT-02', 'exposure', '/assets/app.js.map', 'HIGH', 'fixed-verified', 'none')]), want: 0, wantRules: [] },
  { name: '07 boundary finding accepted-risk, attributed', ...CLEAN([finding('REDTEAM-S02', 'app-tests', '/api/orders/:id', 'HIGH', 'accepted-risk', 'data', { by: 'user:2026-10-18' })]), want: 0, wantRules: [] },
  { name: '08 app lane ran without the checker', lanes: [lane('exposure', 'PASS'), lane('app-tests', 'ready'), lane('perf', 'measured')], findings: [], want: 1, wantRules: ['R3'] },
  { name: '09 checker exited 1', lanes: [lane('exposure', 'PASS'), lane('app-tests', 'ready', { checker: '1' }), lane('perf', 'measured')], findings: [], want: 1, wantRules: ['R3'] },
  { name: '10 two hosts, one BLOCK', lanes: [lane('exposure', 'PASS', { target: 'example.com' }), lane('exposure', 'BLOCK', { target: 'www.example.com' }), lane('app-tests', 'ready', { checker: '0' }), lane('perf', 'measured')], findings: [finding('PREFLIGHT-01', 'exposure', '/.env', 'CRITICAL', 'open', 'none')], want: 1, wantRules: ['R1', 'R2'] },
  { name: '11 boundary finding fixed-unproven', ...CLEAN([finding('REDTEAM-S03', 'app-tests', '/api/me/role', 'HIGH', 'fixed-unproven', 'role')]), want: 1, wantRules: ['R2', 'R4'] },
  { name: '12 perf lane missing entirely', lanes: [lane('exposure', 'PASS'), lane('app-tests', 'ready', { checker: '0' })], findings: [], want: 1, wantRules: ['R5'] },
  { name: '13 lane recorded at a stale sha', ...CLEAN(), sha: 'zzz999', want: 1, wantRules: ['R6'] },
  { name: '14 severity outside the ladder', ...CLEAN([finding('PERF-01', 'perf', '/guides', 'P1', 'open', 'none')]), want: 2, wantRules: [] },
  { name: '15 CRITICAL with touches=unknown', ...CLEAN([finding('REDTEAM-S01', 'app-tests', '/api/orders', 'CRITICAL', 'fixed-verified', 'unknown')]), want: 1, wantRules: ['R8'] },
  { name: '16 accepted-risk with no attribution', ...CLEAN([finding('PERF-02', 'perf', '/blog', 'HIGH', 'accepted-risk', 'none')]), want: 1, wantRules: ['R7'] },
  { name: '17 duplicate finding id', ...CLEAN([finding('PREFLIGHT-01', 'exposure', '/a', 'LOW', 'open', 'none'), finding('PREFLIGHT-01', 'exposure', '/b', 'LOW', 'open', 'none')]), want: 2, wantRules: [] },
  { name: '18 wrong header', lanes: ['lane\ttarget\tverdict\tsha\trecorded_at\tchecker_exit\tdescoped_by\tnotes', ...[]], findings: [], want: 2, wantRules: [] },
  { name: '19 MEDIUM fixed-unproven does not block', ...CLEAN([finding('PERF-03', 'perf', '/pricing', 'MEDIUM', 'fixed-unproven', 'none')]), want: 0, wantRules: [] },
  { name: '20 perf lane not-measured, no findings', lanes: [lane('exposure', 'PASS'), lane('app-tests', 'ready', { checker: '0' }), lane('perf', 'not-measured', { notes: 'no page to lighthous' })], findings: [], want: 0, wantRules: [] },
];

const root = mkdtempSync(join(tmpdir(), 'release-gate-fixtures-'));
let failed = 0;
const rows = [];

for (const c of cases) {
  const dir = join(root, c.name.replace(/[^a-z0-9]+/gi, '-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'lanes.tsv'), [LANE_HEAD.join('\t'), ...c.lanes].join('\n') + '\n');
  writeFileSync(join(dir, 'findings.tsv'), [FIND_HEAD.join('\t'), ...c.findings].join('\n') + '\n');
  const args = [CHECKER, dir];
  if (c.sha) args.push('--sha', c.sha);
  const run = spawnSync(process.execPath, args, { encoding: 'utf8' });
  const out = run.stdout + run.stderr;
  const exitOk = run.status === c.want;
  const rulesOk = c.wantRules.every((code) => out.includes(`${code}:`));
  const ok = exitOk && rulesOk;
  if (!ok) {
    failed++;
    console.log(`\n--- ${c.name} FAILED ---\n${out}`);
  }
  rows.push(`${ok ? 'pass' : 'FAIL'}  ${c.name}  exit=${run.status} want=${c.want} rules=${c.wantRules.join('+') || 'none'}`);
}

console.log(rows.join('\n'));
rmSync(root, { recursive: true, force: true });
console.log(`\n${cases.length - failed}/${cases.length} fixtures agree with the rule.`);
process.exit(failed ? 1 : 0);
