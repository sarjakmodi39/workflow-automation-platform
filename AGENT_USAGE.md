# AI Agent Usage

This project was built with AI assistance. This document records how, what was delegated,
where the AI was wrong, and how its output was checked — because the interesting part of
working this way is not the acceleration, it is the verification discipline that has to sit
underneath it.

## Tools used

**Claude Code (Claude Opus)**, used across four distinct phases:

| Phase | Use |
|---|---|
| Design | Interactive brainstorming to pin down scope, then a written design spec committed before any code |
| Planning | Generating a task-by-task implementation plan from the spec, with explicit interfaces between tasks |
| Implementation | Executing the plan one task at a time, each with a written brief, tests first for the engine core |
| Review | Adversarial review of completed task groups, then fixing what it found |

Also used: `git`, Prisma CLI, Vitest, TypeScript's compiler — all driven from the same
session, which is what made the verify-then-claim loop below practical.

## Workflow

The sequence was deliberately front-loaded:

1. **Brainstorm before writing anything.** Scope, non-goals, and the stack decisions were
   settled in conversation first, including which requirements were load-bearing for grading
   and which were nice to have.
2. **Commit the design spec.** A single document covering architecture, data model, step
   registry, a requirement-to-mechanism mapping table, and the test list. Committed before
   implementation so it could be reviewed as a standalone artefact and so later drift from it
   would be visible.
3. **Generate the implementation plan from the spec.** Eighteen tasks with declared
   interfaces, so each task could be given to a fresh context without needing the whole
   history.
4. **Execute task by task, tests first for the engine.** Each task got a written brief
   naming the files, the source of truth to read, the constraints, and the exact verification
   commands. Each finished with `tsc`, the full suite, and a build.
5. **Review in groups, then fix.** After the store, provider, and API layers were complete
   they were reviewed together rather than individually, which is what surfaced the
   cross-layer problems — a lock token leaking through a route, a clock dependence in the
   engine reachable only through a specific store ordering.

The engine core was built test-first. The UI and the thin adapters were not; see *Known
limitations* in the README, which states that trade openly.

## Representative prompts

The prompts that did the most work were constraint-setting rather than
generate-me-this-feature. Four representative examples:

**Establishing a hard constraint that reshaped the design.** Early on the AI proposed
invoking the Claude CLI server-side to power the AI steps. The response — that no paid API
credit would be purchased and a free-tier provider had to be found instead — is what produced
the Gemini-primary / OpenRouter-fallback / mock-for-tests chain that the project actually
ships. Constraints stated early changed the architecture; the same constraint stated late
would have caused a rewrite.

**A task brief, rather than a feature request** (excerpt, Task 14 — API routes):

> Read `src/lib/engine/runner.ts` — the exported entry points. **Read their guard clauses.**
> Which statuses each refuses, and with which error, determines what your routes return; do
> not re-implement those checks in the route layer, and do not weaken them.
>
> A non-`AppError` must never leak its message to the client. Log it server-side, return a
> generic 500 body. An unexpected exception can carry a connection string or a key.

**Naming the hazard, not just the task** (excerpt, Task 16 — UI):

> The assignment explicitly requires clear loading, empty, validation, success, and failure
> states. Distinguish a 409 ("you can't do that right now") from a 500 ("something broke"),
> because they call for different user action. Never show a raw stack trace or a bare
> "Error".

**Refusing a self-assessment.** Repeatedly: *don't tell me it works, show me the command
output.* A subagent reporting "all tests pass" was treated as a claim to check, not a result
— which was correct, because on several occasions the claim was wrong.

## What was delegated

- Project scaffolding, Prisma schema, and the initial type definitions.
- Test-first implementation of each engine module: validator, expression evaluator,
  permissions, registry, the `RunStore` interface and both implementations, the runner.
- The step handlers, one per step type.
- The LLM adapter layer: provider interface, Gemini and OpenRouter clients, the mock, the
  fallback chain and per-run call budget.
- The eleven API route handlers and the error-code-to-HTTP-status mapping.
- All UI components and pages.
- Adversarial code review of completed task groups.

What was **not** delegated: the scope decisions, the stack choices, the free-tier constraint,
and every judgement about whether a reported result was actually true.

## Agent mistakes and rejected suggestions

Recorded as they happened. These are the reason the verification section below exists.

**Suggested running the Claude CLI on the server.** Rejected. A Claude subscription does not
grant API access, and even if it did, every reviewer visiting the deployed app would be
spending a personal quota on someone else's evaluation. Replaced with free-tier API providers
and a fallback chain.

**A human approval gate that could be bypassed.** Found by writing a probe that forced a run
back to `RUNNING` past the gate directly in the store, rather than by reading the code. It
advanced. This was the single most important property in the project failing quietly. Fixed
at three independent layers — the rejection handler, `resumeRun`, and `retryStep` — and
covered by four tests, one of which reproduces the original bypass.

**A brief written by the AI itself named three error codes that do not exist.**
`VALIDATION_FAILED`, `RATE_LIMITED`, and `STEP_EXECUTION_FAILED`, where the codebase defines
`VALIDATION_ERROR`, `RATE_LIMIT`, and `STEP_EXECUTION_ERROR`. Transcribed literally, all
three would have fallen through the status mapping to a generic 500 — a validation error
reported as a server fault, with nothing failing loudly. The implementing agent caught it and
pushed back, which is the behaviour worth wanting.

**A successful AI call logged as a provider failure.** The success-path `recordLlmCall` sat
inside the same `try` as the provider call, so if the *database* write failed, the code
recorded a successful completion as a provider `ERROR` and discarded the model's output. Two
unrelated faults collapsed into one wrong diagnosis. The recording now sits outside that
block, with a comment explaining why it must stay there.

**"Cosmetic" mislabelled a data-integrity bug.** An agent reported that step attempt numbers
reset to 1 on resume and called it cosmetic. It was not: `@@unique([runId, stepId, attempt])`
means a resumed run re-executing a step would violate the constraint. Verified as a real
P2002 before fixing, in both the caller and the in-memory store.

**A clock dependence that could have caused a duplicate external write.** The rule for
skipping already-succeeded steps took the last row per step in `startedAt` order — a
timestamp stamped by whichever instance created the row. Under clock skew between two
instances, a stale `FAILED` row could sort last and a completed step could re-execute, with
only the idempotency ledger as a backstop. Reviewer flagged the ordering; the fix went
further and keyed on `max(attempt)` instead, removing the wall clock from the rule entirely.

**Lock tokens published to the browser.** Run responses on unauthenticated routes included
`lockToken` and `lockedUntil`. Not exploitable as built, since no endpoint accepts a token —
but it would have made any future worker endpoint forgeable by default. Stripped at the route
boundary.

**Two tests that passed for the wrong reason.** Both proven hollow by mutation during review:
an OpenRouter test asserted only that the API key was *absent* from the URL and body, so it
passed even with the key never sent at all; and `parseJsonBody` was untested, so
reintroducing a `SyntaxError`-to-500 hole broke nothing. Both closed, and both mutations
re-run afterwards to confirm the new tests fail.

**A tick loop that ran exactly once.** The planned run-detail code drove the engine from a
React effect whose dependencies were the run status, the run id, and a stable callback. While
a run is `RUNNING` none of those change, so the effect never re-ran and the run stalled after
one slice with no error and no visible cause. Caught by reasoning through the dependency
array rather than by running it, since reproducing it needs a live database.

**A Resume button offered on runs that cannot be resumed.** The planned UI offered Resume for
`CANCELLED` runs. `resumeRun` refuses `CANCELLED`, and a run stopped by a rejected approval
*is* `CANCELLED` — so the button invited a reviewer to try to override a human's rejection.
The API would have refused it, so not a security hole, but the wrong thing to put in front of
someone.

**A hardcoded approval reason.** The planned approval handler sent
`"Approved from run detail view."` as the reason on every decision. That is an audit trail
that documents nothing. Replaced with a reason the reviewer writes, stored verbatim.

**A hollow test written for this project's own UI.** A test claimed rejection required a
confirmation step. Mutating the Reject button to submit immediately **did not fail it** — it
asserted on rendered text, which is identical either way. Fixed by extracting the rule into a
pure function that can be asserted directly, then re-running an equivalent mutation to
confirm it now fails. The test file documents what is still uncovered: the wiring from button
to rule, which needs click simulation.

**Two failed attempts at a test sentinel value, then rejecting the approach outright.** An
attempt to test that idempotency keys separate control characters first embedded literal NUL
bytes into a source file, then a scripted fix collapsed an escape sequence into a real NUL
again. Diagnosed with a `repr` test. Then the whole idea was dropped on its merits rather
than repaired: raw NULs make git treat a file as binary, Postgres rejects `0x00` in `text`
columns, and these strings reach a `text` column. The lesson was that two failures in a row
on the same mechanism is a signal to re-examine the goal, not the implementation.

### A pattern worth naming

Three separate bugs shared one root cause: **the in-memory test store was more permissive
than Postgres**, so the entire engine suite was structurally blind to a class of error. It
happened with the unique constraint on approvals, with attempt numbering, and with
required-JSON columns. After the third, it became a standing rule — any divergence between
`MemoryRunStore` and the schema is a defect in the test double. That is a pattern no single
code review would have surfaced; it only became visible by tracking mistakes across tasks.

## How output was verified

Nothing was accepted on assertion.

**Every engine module was built test-first**, and the full suite — 226 tests across 16 files
— runs with no database, no network, and no API key. That is what makes it usable as a
verification tool rather than a formality: it runs in about two seconds, so it ran after
every change.

**Mutation testing before trusting any fix.** The habit that mattered most: after fixing
something and writing a test for it, deliberately re-break the fix and confirm the test
fails. A test that passes both before and after a fix is worse than no test, because it
manufactures confidence. This caught three hollow tests in this codebase — two during
review, one written for the UI.

**Subagent reports were treated as claims, not results.** Every completed task was
independently re-verified: `npx tsc --noEmit`, the full suite, and `npm run build` with
`DATABASE_URL` deliberately empty to prove no route connects to a database at build time. On
more than one occasion a task reported as verified was not, and one agent's abandoned dev
server had to be tracked down by process command line because it was holding a file lock and
silently failing later builds.

**Probes rather than code reading for the properties that mattered.** The approval bypass was
found by attempting the bypass. The API's error disclosure was confirmed by requesting a
route with no database configured and reading the actual response body — a generic
`INTERNAL_ERROR` with no message, while the full Prisma stack trace including the schema path
stayed in the server log.

**The UI's failure states were verified by rendering them**, not by inspecting the JSX. Using
`react-dom/server`, which the framework already depends on, the components are rendered to a
string and asserted on — including that a 409 and a 500 do not produce the same text, and
that model-influenced content is escaped rather than interpreted as markup.

### What the live run changed

An earlier draft of this document ended by stating plainly that nothing had yet run against a
live database or a real provider — that the Gemini call, the approval flow and the
duplicate-write prevention were *expected* to work and had never been *observed* working, and
that those are different claims.

They were different claims, and the gap was worth stating, because closing it found four
defects that 238 passing tests could not:

- **The default model 404'd.** `gemini-2.5-flash` had become "no longer available to new
  users" — a non-retryable error, so every AI step failed outright. No mock can catch a model
  being retired.
- **Its replacement was a thinking model.** `gemini-flash-latest` spent 179 thinking tokens to
  produce 36 output tokens, with latency swinging between 10s and 25s against a 15s client
  timeout, and a free tier of 20 requests per day. Both facts came from reading real response
  headers and quota errors, not documentation.
- **Every route would have timed out in production.** No handler declared `maxDuration`, so
  Vercel's 10s default would have killed a tick with a 40s budget. This works locally and
  fails only once deployed, which is the worst place to find it.
- **A branch condition could never fire.** The classifier was reading the policy documents
  rather than the vendor profile, so it returned `low_risk` for a vendor the corpus rates high
  risk. The tests asserted the workflow was *valid*; validity does not mean the branch is
  reachable.

What is now observed rather than assumed, against Neon and the real Gemini API: a run
completing unattended; an approval gate halting a run and resuming on approval; a rejection
leaving the run permanently `CANCELLED`, with `resume`, `retry` and a second approval all
refused and zero external actions written; the execution-time permission check failing a step
the API would never have allowed to be saved; two versions deciding differently on identical
input; a transient provider fault producing an automatic retry and a recoverable `FAILED` run;
and a simulated crash after an external write resuming to `duplicatePrevented: true` against
the original ledger reference rather than issuing a second payment.

The remaining honest gap: the application has not yet been exercised *as deployed*. Everything
above ran against the production database from a local process.
