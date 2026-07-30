# Controlled Agentic Workflow Automation Platform

A workflow engine for business processes that use AI for reasoning but never for
authority. A workflow is defined as an ordered list of typed steps, validated before it can
run, and then executed one step at a time with every state transition written to Postgres.
AI steps extract and classify; they do not decide. Anything with a real-world effect stops
for a human first, and once a human says no, the platform will not let anything — including
its own retry paths — proceed.

The design goal was auditability over autonomy: at any point you should be able to answer
"what did it do, why did it do that, and who approved it" from database rows alone.

## Live application

**https://workflow-automation-platform-nine.vercel.app**

No credentials are needed. Three workflows are seeded; start with **Vendor Onboarding
Review**, which runs to completion without a human. Sample input is prefilled on every
workflow page — the document corpus knows two vendors, `Globex Industrial` (high risk) and
`Acme Supplies` (low risk), and they take different branches.

## Setup

```bash
git clone <repository-url>
cd workflow-automation-platform
npm install

cp .env.example .env      # then fill in DATABASE_URL and GEMINI_API_KEY
npx prisma db push        # create the schema
npm run db:seed           # seed three demo workflows (idempotent)

npm run dev               # http://localhost:3000
```

`.env.example` lists every variable by name with no values. Only `DATABASE_URL` is strictly
required to boot; set `LLM_PROVIDER=mock` to run the AI steps without any provider key.

| Script | What it does |
|---|---|
| `npm run dev` | Development server |
| `npm run build` | `prisma generate` then `next build` |
| `npm test` | Full Vitest suite — no database, no network |
| `npm run db:push` | Push `schema.prisma` to the database |
| `npm run db:seed` | Seed the three demo workflows. Idempotent — safe to re-run |

### What the seed creates

| Workflow | Why it is there |
|---|---|
| **Vendor Onboarding Review** | Start here. No approval gate and no external write, so it runs to completion unattended. |
| **Invoice Approval and Payment** | Two versions differing only in approval threshold (5000 vs 1000 USD), so version pinning is observable on identical input. Gates on amount **or** on an AI vendor-risk classification. |
| **Permission Enforcement Demo** | Deliberately under-granted, and fails at `post_payment` by design. The API refuses to save a version like this, so seeding it directly is the only way to exercise the runner's execution-time permission check. |

Each workflow's sample input is printed when the seed runs. No runs are seeded: a run is the
engine's own output, and writing one row by row would put an audit trail in the database
describing events that never happened.

## Architecture

### No in-memory run state

The engine holds no run state between calls. A run is entirely described by its rows —
`Run.cursor`, its `StepExecution` records, and its `AuditEvent` log — so any instance can
pick up any run at any time, and a crashed process loses nothing. This is the decision the
rest of the design falls out of.

Its most useful consequence is that **cancel, resume, retry, and crash recovery are the same
code path**: all four are "load durable state, skip what already succeeded, continue." There
is no separate recovery routine that could drift from the normal one.

### The tick loop

`advanceRun(runId)` executes one slice of work:

1. Acquire the run lock with a single conditional `UPDATE` (`lockToken`, `lockedUntil`). If
   it is not acquired, another tick owns the run — return it unchanged rather than
   competing.
2. Load the run, its pinned version definition, and its existing step executions.
3. Step forward: resolve the next step, skip it if it already succeeded, otherwise execute
   it, persist the result, and append audit events.
4. Stop on any of — an approval gate, a terminal state, a step failure, or roughly 40
   seconds of wall clock.
5. Release the lock and return the run.

If the loop stopped on the wall-clock budget the run stays `RUNNING`, and the browser calls
`POST /api/runs/[id]/tick` again. That is what makes a serverless request limit a non-issue
instead of a ceiling on workflow length.

The lock is optimistic and expiring: a single conditional update claims it, so two
concurrent ticks cannot both win, and a lease timeout means a process that dies mid-tick
does not strand the run.

### The `RunStore` boundary

`RunStore` is the one abstraction in the codebase that earns its keep. The engine depends on
the interface and never imports Prisma, so the entire engine test suite runs against an
in-memory implementation — no database, no network, fully deterministic.

That boundary carries a hazard worth naming, because it bit this project three times: when
the in-memory store is more permissive than Postgres, **every engine test is structurally
blind to the difference**. It happened with a missing unique constraint on approvals, with
attempt numbering, and with required-JSON columns. `MemoryRunStore` now mirrors the
schema's constraints deliberately, and any divergence is treated as a defect in the test
double rather than a quirk.

Everything outside the engine talks to Prisma directly. There is no general-purpose
repository layer.

### Module map

```
src/
  app/
    page.tsx                        workflow list + recent runs
    workflows/[id]/                 versions, validation, run launcher
    runs/[id]/                      run detail — the centrepiece
    api/                            11 route handlers
  lib/
    engine/
      registry.ts                   step types, permissions, retry safety
      validator.ts                  pre-execution validation
      runner.ts                     advanceRun and the run control verbs
      expression.ts                 declarative comparators, no eval
      permissions.ts                grant checking
      context.ts                    $.input / $.steps path resolution
      store.ts                      the RunStore interface
      store.prisma.ts               production implementation
      store.memory.ts               test implementation
      deps.ts                       dependency wiring
    steps/index.ts                  one handler per step type
    llm/                            provider interface, Gemini, OpenRouter, mock
    api.ts                          error-code to HTTP-status mapping
    errors.ts                       typed error taxonomy
    client-api.ts                   the browser's half of the API contract
  seed/corpus.ts                    document corpus for retrieval
```

## Step types

Every step type declares its config schema, required permissions, and whether it is safe to
retry automatically. The registry is the single source of that truth — the UI reads labels
and retry safety from it rather than keeping its own copy.

| # | Type | AI | Retry-safe | Required permission | Behaviour |
|---|---|---|---|---|---|
| 1 | `structured_input` | No | Yes | — | Validates run input against declared fields |
| 2 | `document_retrieval` | No | Yes | `tool:document_search` | Keyword-scored top-k over the corpus |
| 3 | `ai_extraction` | Yes | Yes | `tool:llm` | Extracts declared scalar fields from prior text |
| 4 | `ai_classification` | Yes | Yes | `tool:llm` | Assigns one of a declared label set, with confidence and rationale |
| 5 | `deterministic_condition` | No | Yes | — | Evaluates a declarative comparator and selects a branch |
| 6 | `human_approval` | No | n/a | — | Halts the run until a person records a decision |
| 7 | `mock_external_action` | No | **No** | `action:<name>` | Simulated write, guarded by the idempotency ledger |
| 8 | `final_report` | Optional | Yes | `tool:llm` when summarising | Assembles a report from all prior outputs |

`mock_external_action` is the only step type that is not retry-safe, and that single flag is
what the UI, the automatic retry logic, and the manual retry warning all read from.

### Conditions without `eval`

Conditions are data, never code:

```json
{ "left": "$.steps.extract.amount", "op": "gt", "right": 5000 }
```

Operators are `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in`, `contains`, composable with
`allOf` and `anyOf`. There is no `eval` and no `new Function` anywhere in the codebase. Being
plain data also means a condition is serialisable into an audit record and renderable as a
sentence a reviewer can read.

### Branching terminates by construction

Steps are an ordered list with stable ids. A condition step declares `onTrue` and `onFalse`,
each either a **forward** step id or the literal `end`. The validator rejects backward jumps,
so a workflow cannot loop — every run terminates, and that is a property of the definition
rather than a runtime guard.

## How each requirement is met

| Requirement | Mechanism |
|---|---|
| Validate before execution | `validator.ts` checks step types, config, permission grants, source-path references, branch targets, and forward-only termination. A version that fails is refused at save time, not discovered mid-run |
| Store and compare versions | `WorkflowVersion` rows are immutable and never updated, and a run is pinned to the version it started on. The compare panel diffs any two versions field by field — matching steps by id so an inserted step does not read as a rewrite, ignoring key order so a re-serialised definition is not a false change, and calling out permission-grant changes separately |
| Display steps and current state | The run detail page renders the timeline from `StepExecution` rows and advances via the tick loop while the run is active |
| Pass structured output between steps | Step output is persisted and referenced by later steps as `$.steps.<id>.<field>`; the validator rejects a path pointing at a nonexistent or later step |
| Pause for approval | The runner intercepts approval gates before the handler runs, sets `AWAITING_APPROVAL`, and stops. `POST /approve` records the decision and resumes |
| Cancel and resume | Cancel sets the status and releases the lock; resume re-enters `advanceRun`, which skips succeeded steps. `resumeRun` refuses `CANCELLED`, `AWAITING_APPROVAL`, and `COMPLETED` |
| Retry only safe steps | The registry declares `retrySafe`. Automatic retry applies only to safe steps; `mock_external_action` is never retried automatically, only on an explicit human request |
| Prevent duplicate writes | The external action inserts its idempotency key **first** and catches the unique-constraint violation. It never reads-then-writes, which would be a race. A conflict returns the stored response and logs `DUPLICATE_WRITE_PREVENTED`, so even a manual retry cannot double-write |
| Enforce permissions | Versions declare grants, steps declare requirements. Checked at validation and re-checked at execution; a violation fails the step and writes `PERMISSION_DENIED` |
| Record everything | `AuditEvent` and `LlmCall` rows, both append-only, both surfaced in the UI including failed AI calls |
| Recover without repeating work | The same skip-succeeded path as resume. No new run, no repeated side effects |
| Explain the path taken | Condition steps persist their resolved inputs, result, and branch, rendered as a sentence rather than as raw JSON |
| Re-run an old version | Versions are immutable, so re-running one is just `POST /api/runs` with that `workflowVersionId` |

### A rejected approval is permanent

This is the property the design treats as most important, so it is enforced at three
independent layers rather than one: the rejection handler terminates the run as `CANCELLED`,
`resumeRun` refuses `CANCELLED` outright, and `retryStep` scans for a rejected gate and
refuses every step on that run. Defeating one layer is not enough to get a rejected workflow
moving again, and there are four tests asserting exactly that — including one that forces the
run back to `RUNNING` in the database, past the gate, and confirms the rejection is
re-asserted anyway.

The UI matches: a cancelled run is not offered a Resume button at all, because the API would
refuse it and offering it would suggest a human's decision is negotiable.

## Design decisions

**No agent framework.** LangGraph's core value — stateful, resumable, checkpointed
multi-step orchestration — is exactly the capability being demonstrated here, so delegating
it would hide the work rather than show it. The specific requirements also resist the
abstraction: retry restricted to steps declared safe, an idempotency ledger backed by a
unique constraint, per-step permission checks, and serialisable branch explanations would
each need to be layered onto or worked around a framework's own state handling.
Implementing them directly against Prisma is less code, not more, and keeps each one
individually inspectable in the UI. This is not unfamiliarity with the tools; knowing what
they provide is what makes it clear they would compete with the deliverable here.

**Single Next.js repo rather than a separate API and SPA.** One deploy, no CORS, no second
service to keep warm. A separate backend would have added two free-tier failure modes and
some hours of wiring for no reviewable benefit.

**Forward-only branching instead of a general graph.** Loops would require a step budget, a
cycle detector, and a story about partial progress inside a loop. Forward-only jumps make
termination a property of the definition, checkable once at save time.

**Client-driven ticks instead of a background worker.** Serverless functions have a request
timeout; a long workflow cannot live inside one request. Rather than fight that, execution
is sliced by wall clock and driven from the browser — which is only safe *because* run state
is fully durable, and which makes the durability visible instead of theoretical.

**Gemini primary, OpenRouter fallback.** Gemini's `responseSchema` enforces JSON
server-side, which matters when one step's structured output is the next step's input.
OpenRouter's equivalent is advisory, so that adapter restates the schema in the prompt and
strips markdown fences before parsing.

## Tests

```bash
npm test
```

**226 tests across 16 files.** The suite needs no database, no network, and no API key: the
engine runs against `MemoryRunStore` and `MockLlmProvider`, so it is fast and deterministic.

Each test is pinned to a requirement rather than to coverage:

| # | Requirement | Where |
|---|---|---|
| 1 | Invalid definitions are refused before execution | `validator.test.ts` — 13 tests including backward-jump rejection |
| 2 | Ungranted permissions are refused | `validator.test.ts`, `permissions.test.ts` |
| 3 | Step N's output reaches step N+1 intact | `runner.test.ts` |
| 4 | A run halts at an approval gate and advances no further | `runner.test.ts` — including a second `advanceRun` that must do nothing |
| 5 | Approve resumes to completion; reject terminates permanently | `runner.test.ts` — 4 tests on permanence alone |
| 6 | Cancel then resume skips completed steps | `runner.test.ts` — plus the three statuses resume must refuse |
| 7 | Safe steps retry; the unsafe step never auto-retries | `runner.test.ts` |
| 8 | A duplicate idempotency key does not double-write | `handlers.test.ts`, `store.memory.test.ts`, `runner.test.ts` |
| 9 | Condition steps record the branch and why | `handlers.test.ts`, `runner.test.ts` |
| 10 | The LLM adapter falls back on rate limits and errors | `llm/index.test.ts` |

Beyond that list: the run lock is tested under contention and lease expiry with an injected
clock, the wall-clock budget is tested for picking up from the cursor, the idempotency key is
tested for deep key-order stability and for not emitting control characters Postgres would
reject, both providers are tested for never letting an API key reach an error message or a
URL, and the UI's failure states are tested to confirm a 409 and a 500 do not read the same.

Where a fix was made, the test for it was verified by mutation — reverting the fix and
confirming the test fails — rather than trusting that a passing test proves anything. That
practice caught two tests in this codebase that passed for the wrong reason, and one of the
UI tests written for this document's own feature set.

## Known limitations

1. **Single-tenant, no user authentication.** Permissions are enforced at the step level as
   specified, but there is no notion of *who* is approving. `Approval.reason` is free text.
2. **Free-tier LLM providers.** Sustained load can hit rate limits, and free-tier quotas are
   both low and model-specific — the full `flash` alias allows only 20 requests per day, which
   is why the default is `gemini-flash-lite-latest`. Mitigated by the fallback chain and
   automatic retry; set `LLM_PROVIDER=mock` to demonstrate the engine with no provider at all.
3. **Sequential execution only.** No parallel branches.
4. **Keyword retrieval, not semantic search.** The corpus is small and scored by keyword
   overlap; there are no embeddings.
5. **External actions are simulated.** `mock_external_action` writes a ledger row rather
   than calling a real system. The idempotency guarantee around it is real; the integration
   is not.
6. **Progress advances via client-driven ticks, not a background worker.** A closed browser
   tab means a `RUNNING` run stops advancing until someone opens it again. This is a
   deliberate consequence of serverless hosting, and the reason run state is fully durable.
7. **The version diff compares definitions, not run outcomes.** Two versions are compared
   field by field, including permission grants, but the view does not predict how a given
   input would decide differently under each — that is shown by running both.
8. **The Prisma store and the API routes have no unit tests.** Both are thin adapters whose
   meaningful behaviour is covered through the in-memory store, and testing them properly
   needs a live database. The type checker and manual verification cover them instead. This
   is a deliberate trade, not an oversight — and it is the gap most worth closing first.

## Deployment

Vercel plus Neon Postgres.

1. Import the repository at vercel.com/new.
2. Set environment variables, by name: `DATABASE_URL`, `LLM_PROVIDER`, `GEMINI_API_KEY`,
   `OPENROUTER_API_KEY`, `MAX_LLM_CALLS_PER_RUN`.
3. Deploy.
4. From a local machine, against the production `DATABASE_URL`: `npx prisma db push` then
   `npm run db:seed`.

`DATABASE_URL` must be Neon's **pooled** connection string — the host contains `-pooler`.
Serverless functions open a connection per invocation and will exhaust a direct connection
limit under even light use.

No secrets are committed at any point. `.env` is gitignored; `.env.example` carries names
only.
