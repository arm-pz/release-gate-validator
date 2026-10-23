---
name: release-gate-validator
description: >-
  Turns three pre-launch reports that already exist into one release posture (HOLD or ready)
  without running any of them. Ingests the security red team's on-disk results table
  mechanically, takes the preflight and performance tables as verbatim pastes, and computes the
  posture with a script. Use when the lanes were run earlier or by someone else, or when a
  deploy decision is needed now from those reports and re-running three skills is not
  affordable. Runs no attacks, no probes, no
  measurements, no subagents. A lane's pass never covers another lane, and an absent lane is
  reported absent. Not for producing the reports in the first place (use release-gate-chair),
  and not for deploying.
argument-hint: <red-team-run-dir> [production URL] [--report <path>]
version: 0.1.0
---

# Release gate validator

This fork **judges, it does not test.** Nothing here touches a target. It reads reports that
already exist, puts them in one ledger, and applies the same deterministic posture rule the other
two forks use. Its entire value is that the posture arithmetic is redone by a script and the
freshness of every lane is written down rather than remembered.

`<skill-dir>` is this skill's directory.

## What each lane can be, and how it gets here

| Lane | Source of truth | How recorded |
|---|---|---|
| `app-tests` | `.pre-ship-red-team/<run-id>/results/group-*.md` | `scripts/gate_ingest.mjs` parses the 12-column table — no prose summarising |
| `exposure` | the `web-preflight` report | its host verdict plus its finding table, pasted verbatim through `scripts/gate_record.mjs` |
| `perf` | the `pre-ship-performance-audit` report | its before/after tables and `PERF-<nn>` rows, pasted verbatim |

The red team is the only lane with a machine-readable artifact, so it is the only lane parsed
automatically. Accepting the other two as pastes instead of paraphrasing them is the point: a
summary is where a `fixed-unproven` quietly becomes a `fixed-verified`.

## 1. Ingest what exists

```
node "<skill-dir>/scripts/gate_ingest.mjs" .release-gate/<run-id> <red-team-run-dir> <git-sha-when-it-ran> <app-target> --checker <exit-of-check_results.mjs>
```

It writes one `app-tests` lane row and one finding row per scenario that had a severity, and prints
what it skipped (`not-applicable` and no-severity rows are coverage, not findings). Re-running it
replaces only the `REDTEAM-*` rows and the `app-tests` row; other lanes' rows survive.

Pass `--checker` only if you actually ran

```
node "<red-team-skill-dir>/scripts/check_results.mjs" <red-team-run-dir> --require-fixes
```

and saw the exit code. Without it the lane holds on R3, which is the correct outcome — this fork
does not run that checker for you.

## 2. Record the other two lanes

```
node "<skill-dir>/scripts/gate_record.mjs" lane .release-gate/<run-id> --lane exposure --target <host> --verdict <PASS|PASS WITH FIXES|BLOCK|INCONCLUSIVE|untested> --sha <sha>
node "<skill-dir>/scripts/gate_record.mjs" lane .release-gate/<run-id> --lane perf --target <host> --verdict <measured|not-measured> --sha <sha>
```

One `finding` row per finding in those reports, copying severity, remediation and evidence exactly
as the report wrote them. Fill `touches` from what the finding says: `data`, `money`, `role`, `none`
or `unknown`. A lane that has no report at all gets `--verdict untested`, never an omitted row — an
omitted row is silence, and silence is not a pass.

## 3. Compute the posture

```
node "<skill-dir>/scripts/check_gate.mjs" .release-gate/<run-id> --sha <current-head-sha>
```

Exit `0` ready, `1` HOLD, `2` contract break. Report the rule codes. **Staleness is the failure mode
of this fork**, so always pass `--sha`: a lane recorded at another commit fires R6, and `ready` then
means only what the fresh lanes covered. Read the report as "what was true of this build", never as
"what is true of the site".

Urgency does not change posture. Deploying on a `HOLD`, or on a stale lane, is the user's call and
gets recorded as such.

## 4. Deliver

Print the register with the coverage line, the `GAP:` list and the accepted-risk attributions. State
plainly that no lane was re-run here and name the run dates. Then recommend the user run the live
`web-preflight` lane against the production host if the exposure lane is older than the last deploy.

## Does not

- Send a single request to any target, dispatch a subagent, or fix anything.
- Invent a verdict for a lane whose report is missing, ambiguous, or contradicts the ledger.
- Merge verdicts into a score, or let one lane's pass cover another's absence.
- Present itself as equivalent to the other two forks. It is the cheapest and the least fresh.

Read `caffeinity-stack` before reporting Caffeinity work. W3 in `caffeinity-routing` is the sequence
this skill validates.

## Verify

```
node "<skill-dir>/tests/posture.mjs"
node "<skill-dir>/scripts/gate_ingest.mjs" /tmp/empty /tmp/nope
```

The second must exit `2` with `NOT-INGESTABLE`. An ingester that invents an empty ledger for a
missing report is a gate that passes on nothing.
