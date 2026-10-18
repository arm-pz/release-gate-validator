#!/usr/bin/env node
// Compute a release posture from a run directory's ledger.
// Exit 0 = ready, 1 = HOLD, 2 = contract break. Never defaults to ready.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const LANE_COLS = ['lane', 'target', 'verdict', 'git_sha', 'recorded_at', 'checker_exit', 'descoped_by', 'notes'];
const FINDING_COLS = ['id', 'lane', 'route', 'severity', 'remediation', 'evidence', 'touches', 'accepted_by'];

const LANE_NAMES = ['exposure', 'app-tests', 'perf'];
const BLOCKING = ['BLOCK', 'INCONCLUSIVE', 'HOLD', 'fail', 'untested'];
const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
const REMEDIATIONS = ['open', 'fixed-verified', 'fixed-unproven', 'accepted-risk'];
const TOUCHES = ['data', 'money', 'role', 'none', 'unknown'];
const ID_SHAPE = /^(PREFLIGHT-\d+|REDTEAM-S\d+|PERF-\d+)$/;

function breakContract(msg) {
  console.error(`CONTRACT BREAK: ${msg}`);
  console.error('The gate refuses to guess. Fix the ledger and rerun.');
  process.exit(2);
}

function cell(v) {
  return v === '' || v === '-' ? null : v;
}

function readTsv(file, cols, label) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    breakContract(`${label} file ${file} is missing — a gate cannot report on rows it does not have`);
  }
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '' && !l.startsWith('#'));
  if (lines[0].split('\t').join('|') !== cols.join('|')) {
    breakContract(`${file} header must be exactly: ${cols.join('\\t')}`);
  }
  return lines.slice(1).map((line, i) => {
    const cells = line.split('\t');
    if (cells.length !== cols.length) {
      breakContract(`${file} line ${i + 2} has ${cells.length} fields, expected ${cols.length} ("-" for empty)`);
    }
    return Object.fromEntries(cols.map((c, j) => [c, cells[j].trim()]));
  });
}

function validateLanes(rows) {
  const seen = new Set();
  for (const r of rows) {
    if (!LANE_NAMES.includes(r.lane)) breakContract(`unknown lane "${r.lane}" (expected ${LANE_NAMES.join('|')})`);
    if (!r.verdict) breakContract(`lane ${r.lane} has no verdict; record one, or "untested"`);
    if (r.checker_exit !== '-' && !/^-?\d+$/.test(r.checker_exit)) {
      breakContract(`lane ${r.lane} checker_exit "${r.checker_exit}" is not an integer or "-"`);
    }
    const key = `${r.lane}|${r.target}`;
    if (seen.has(key)) breakContract(`duplicate lane record for ${key}`);
    seen.add(key);
  }
  return rows;
}

function validateFindings(rows) {
  const ids = new Set();
  for (const r of rows) {
    if (!ID_SHAPE.test(r.id)) breakContract(`finding id "${r.id}" is not PREFLIGHT-<nn> | REDTEAM-S<nn> | PERF-<nn>`);
    if (ids.has(r.id)) breakContract(`finding id "${r.id}" appears twice — ids are stable per issue across reruns`);
    ids.add(r.id);
    if (!LANE_NAMES.includes(r.lane)) breakContract(`finding ${r.id} names unknown lane "${r.lane}"`);
    if (!SEVERITIES.includes(r.severity)) breakContract(`finding ${r.id} severity "${r.severity}" is not ${SEVERITIES.join('|')}`);
    if (!REMEDIATIONS.includes(r.remediation)) breakContract(`finding ${r.id} remediation "${r.remediation}" is not ${REMEDIATIONS.join('|')}`);
    if (!TOUCHES.includes(r.touches)) breakContract(`finding ${r.id} touches "${r.touches}" is not ${TOUCHES.join('|')}`);
    if (!r.evidence || r.evidence === '-') breakContract(`finding ${r.id} has no evidence reference`);
  }
  return rows;
}

export function evaluate({ lanes, findings, currentSha }) {
  const rules = [];
  const gaps = [];
  const accepted = [];
  const fire = (code, text) => {
    if (!rules.some((r) => r.code === code)) rules.push({ code, text });
  };

  for (const lane of lanes) {
    const descoped = cell(lane.descoped_by);
    if (descoped) {
      gaps.push(`lane=${lane.lane} target=${lane.target} de-scoped by ${descoped}`);
      continue;
    }
    if (BLOCKING.includes(lane.verdict)) {
      fire('R1', `lane ${lane.lane} (${lane.target}) verdict ${lane.verdict} — an unassessed lane is not a passed lane`);
    }
    if (lane.lane === 'app-tests') {
      if (lane.checker_exit === '-') fire('R3', 'app-tests lane ran without check_results.mjs — prose is not mechanical evidence');
      else if (Number(lane.checker_exit) !== 0) fire('R3', `app-tests check_results.mjs exited ${lane.checker_exit}`);
    }
    const sha = cell(lane.git_sha);
    if (currentSha && sha && sha !== currentSha) {
      fire('R6', `lane ${lane.lane} recorded at ${sha}, not the current ${currentSha} — it describes different code`);
    }
  }

  for (const name of LANE_NAMES) {
    if (!lanes.some((l) => l.lane === name)) {
      fire('R5', `required lane ${name} has no record — run it or write down the user's de-scoping reason`);
    }
  }

  for (const f of findings) {
    const high = f.severity === 'CRITICAL' || f.severity === 'HIGH';
    const unresolved = f.remediation === 'open' || f.remediation === 'fixed-unproven';
    const boundary = f.touches === 'data' || f.touches === 'money' || f.touches === 'role';
    if (high && unresolved) fire('R2', `${f.id} ${f.severity} ${f.remediation} on ${f.route}`);
    if (boundary && unresolved) fire('R4', `${f.id} touches ${f.touches} and is ${f.remediation} — boundary findings need fixed-verified`);
    if (high && f.touches === 'unknown') fire('R8', `${f.id} ${f.severity} has touches=unknown — cannot tell whether it crosses a user boundary`);
    if (f.remediation === 'accepted-risk') {
      const by = cell(f.accepted_by);
      if (!by) fire('R7', `${f.id} is accepted-risk with no attribution — acceptance is never inferred`);
      else accepted.push(`${f.id} ${f.severity} on ${f.route} — accepted by ${by}`);
    }
  }

  return { posture: rules.length ? 'HOLD' : 'ready', rules, gaps, accepted };
}

function coverage(lanes) {
  return LANE_NAMES.map((name) => {
    const rows = lanes.filter((l) => l.lane === name);
    if (!rows.length) return `${name}=MISSING`;
    return rows
      .map((r) => `${name}${rows.length > 1 ? `(${r.target})` : ''}=${cell(r.descoped_by) ? `DESCOPED(${r.descoped_by})` : r.verdict}`)
      .join(' ');
  }).join(' ');
}

const argv = process.argv.slice(2);
const runDir = argv.find((a) => !a.startsWith('--'));
const shaIdx = argv.indexOf('--sha');
const currentSha = shaIdx >= 0 ? argv[shaIdx + 1] : null;
if (!runDir) {
  console.error('usage: node check_gate.mjs <run-dir> [--sha <current-git-sha>]');
  process.exit(2);
}

const lanes = validateLanes(readTsv(join(runDir, 'lanes.tsv'), LANE_COLS, 'lane'));
const findings = validateFindings(readTsv(join(runDir, 'findings.tsv'), FINDING_COLS, 'finding'));
const result = evaluate({ lanes, findings, currentSha });

console.log(`RELEASE POSTURE: ${result.posture}   (rule: ${result.rules.map((r) => r.code).join(', ') || 'none fired'})`);
console.log(`Coverage: ${coverage(lanes)}`);
console.log('');
console.log('| finding-id | lane | route | severity | remediation | touches | evidence |');
console.log('|---|---|---|---|---|---|---|');
for (const f of findings) {
  console.log(`| ${f.id} | ${f.lane} | ${f.route} | ${f.severity} | ${f.remediation} | ${f.touches} | ${f.evidence} |`);
}
if (!findings.length) console.log('| - | - | no findings recorded | - | - | - | - |');
console.log('');
for (const r of result.rules) console.log(`HOLD ${r.code}: ${r.text}`);
for (const g of result.gaps) console.log(`GAP: ${g}`);
for (const a of result.accepted) console.log(`ACCEPTED-RISK: ${a}`);
if (result.posture === 'ready' && !result.gaps.length) {
  console.log('ready means ready for the coverage stated above, and nothing beyond it.');
}
process.exit(result.posture === 'ready' ? 0 : 1);
