# Ledger contract

The gate's only data interface. Two tab-separated files in `.release-gate/<run-id>/` inside the
audited repo. Add `.release-gate/` to `.gitignore` before writing the first row — a captured
session cookie or a test password in a committed ledger is the most common breach this workflow
causes.

Tabs, header required, `-` for empty, no quoting. A stray tab breaks the run loudly (exit 2)
instead of shifting a field silently into the wrong column.

## `lanes.tsv` — one row per lane per target

```
lane	target	verdict	git_sha	recorded_at	checker_exit	descoped_by	notes
```

| Column | Rule |
|---|---|
| `lane` | `exposure` \| `app-tests` \| `perf` |
| `target` | the host or URL the lane actually pointed at. Multiple hosts get multiple rows. |
| `verdict` | the lane's **own** vocabulary, copied verbatim: `PASS` / `PASS WITH FIXES` / `BLOCK` / `INCONCLUSIVE` for exposure; `ready` / `HOLD` for app-tests; `measured` / `not-measured` for perf; `untested` for any lane that did not run. The gate never translates one into another's. |
| `git_sha` | HEAD of the audited repo when the lane ran. This is the freshness key — a lane recorded at a different sha describes different code. |
| `recorded_at` | ISO date |
| `checker_exit` | exit code of the app lane's `check_results.mjs`; `-` when it never ran |
| `descoped_by` | empty, or `user:<reason>`. Only a recorded user choice drops a lane. |
| `notes` | free text; the reason a row is `not-applicable` belongs here |

Duplicate `lane`+`target` is a contract break — reruns update the ledger or go to a new run
directory, they do not append a second answer for the same question.

## `findings.tsv` — one row per finding, every lane

```
id	lane	route	severity	remediation	evidence	touches	accepted_by
```

| Column | Rule |
|---|---|
| `id` | `PREFLIGHT-<nn>` \| `REDTEAM-S<nn>` \| `PERF-<nn>`. Stable per issue across reruns; a re-used id that changed meaning is a contract break, so the checker rejects a duplicate. |
| `lane` | which lane raised it |
| `route` | the endpoint, page, file or component |
| `severity` | `CRITICAL` \| `HIGH` \| `MEDIUM` \| `LOW`. Perf `P0`-`P3` maps to CRITICAL/HIGH/MEDIUM/LOW and keeps its working label in the report. |
| `remediation` | `open` \| `fixed-verified` \| `fixed-unproven` \| `accepted-risk` |
| `evidence` | a bounded reference: status plus size, or a path into the run directory. Never a secret, never a raw body. |
| `touches` | `data` \| `money` \| `role` \| `none` \| `unknown` — does the finding reach another user's data, money or role boundaries? Severity alone cannot answer this. `unknown` on CRITICAL/HIGH holds: `none` is a claim, not a default. |
| `accepted_by` | mandatory when `remediation` is `accepted-risk`, and it names the person and date. Attribution is what separates acceptance from silence. |

## Posture triggers

| Code | Fires when |
|---|---|
| R1 | any lane verdict ∈ `BLOCK`, `INCONCLUSIVE`, `HOLD`, `fail`, `untested` |
| R2 | CRITICAL or HIGH finding with remediation `open` or `fixed-unproven` |
| R3 | app-tests lane recorded with `checker_exit` `-` or non-zero |
| R4 | `touches` ∈ `data`, `money`, `role` with remediation `open` or `fixed-unproven` |
| R5 | a required lane has no row at all |
| R6 | a lane's `git_sha` is not the sha passed to `--sha` |
| R7 | `accepted-risk` with no `accepted_by` |
| R8 | CRITICAL or HIGH with `touches=unknown` |

`HOLD` if any fires, `ready` otherwise. Exit `0` ready, `1` HOLD, `2` contract break. An
unrecognised enum value exits 2 rather than defaulting to `ready`.

**Attribution beats the boundary rule.** A `accepted-risk` row naming a person is honoured even on
a `data` finding, because an explicit recorded choice by the owner outranks the gate's default.
Every other unresolved state on a boundary finding holds. R4 covers `open` and `fixed-unproven`;
R7 polices `accepted-risk`.

## What the ledger is not

It is not a merged score. Three lanes keep three verdicts; the posture is a gate, not an average.
Nothing in this format converts `INCONCLUSIVE` into `PASS`, or a red-team `not-applicable` into a
pass, or one lane's `ready` into another's.
