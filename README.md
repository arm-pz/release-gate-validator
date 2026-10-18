# release-gate-validator

One answer to "can we deploy?" — from reports that already exist. This fork sends no requests,
dispatches no subagents and fixes nothing.

`web-preflight`, `pre-ship-security-red-team` and `pre-ship-performance-audit` answer different
questions about the same site. This skill puts their three verdicts in one ledger and computes the
release posture with a script. **Three verdicts stay separate**: the posture is a gate, not an
average, and a preflight `PASS` never implies the application survived penetration testing.

## Install

```
npx skills add arm-pz/release-gate-validator --skill release-gate-validator
```

Then `/release-gate-validator redteam-rig/.pre-ship-red-team/2026-10-18-verify https://example.com`

## When to use this fork instead of the other two

- The lanes were run earlier, or by someone else, and re-running three of them is not affordable.
- A deploy decision is needed now and the evidence already exists on disk.
- You want the posture arithmetic and the staleness check without a second full pass.

If the reports do not exist, use
[`release-gate-chair`](https://github.com/arm-pz/release-gate-chair) — this fork cannot produce
them, and it will say so rather than invent a lane.

## What it does mechanically

The red team is the only pre-ship skill with a machine-readable artifact, so `gate_ingest.mjs`
parses its 12-column results table directly. The other two lanes are accepted **verbatim** — a
paraphrase is where `fixed-unproven` quietly becomes `fixed-verified`.

```
RELEASE POSTURE: ready   (rule: none fired)
Coverage: exposure=PASS app-tests=ready perf=measured
```

Re-ingesting replaces only `REDTEAM-*` rows; rows for the other lanes survive, so the order you
record lanes in does not matter.

## The honest weakness

Freshness. Every posture claim here is about the build those reports describe. Always pass `--sha`
to `check_gate.mjs`, which fires R6 on any lane recorded at a different commit. `ready` from this
fork means "ready for what these reports covered, at the sha they ran" — nothing more.

`touches` is inferred from the scenario id by a fixed table (S01/S02/S04/S12/S13 → `data`,
S03/S05 → `role`, S06/S07 → `money`, the rest → `none`) because an ingest that left everything
`unknown` would hold on every CRITICAL row and teach nothing. Review that mapping before trusting a
`ready`; correct a row in `findings.tsv` if the finding says otherwise.

## Layout

| Path | What |
|---|---|
| `SKILL.md` | ingest, record, compute, deliver |
| `scripts/check_gate.mjs` | the posture rule as code |
| `scripts/gate_ingest.mjs` | parses red-team results into the ledger |
| `scripts/gate_record.mjs` | validating writer for the pasted lanes |
| `references/ledger.md` | the shared two-file ledger contract |
| `tests/posture.mjs` | 20 fixtures; 7 must come back `ready` |

## Posture rule

HOLD if: a lane is `BLOCK`, `INCONCLUSIVE`, `HOLD`, `fail` or `untested` (R1); CRITICAL/HIGH is
`open` or `fixed-unproven` (R2); the app lane lacks a `check_results.mjs` exit 0 (R3); a finding
touching another user's data, money or role is not `fixed-verified` (R4); a required lane has no row
(R5); a lane sits at a stale sha (R6); `accepted-risk` has no attribution (R7); CRITICAL/HIGH leaves
`touches=unknown` (R8). Exit `0` ready, `1` HOLD, `2` contract break.

MIT © 2026 Abdul Rahman P Z
