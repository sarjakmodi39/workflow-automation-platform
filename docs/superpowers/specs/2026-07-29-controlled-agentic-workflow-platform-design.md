# Controlled Agentic Workflow Automation Platform — Design

**Date:** 2026-07-29
**Status:** Approved
**Expected effort:** 10–14 focused hours

---

## 1. Overview

A web application where a user defines a bounded business workflow from a fixed set of
step types, validates it, executes it, and inspects every decision the system made along
the way.

The workflow engine is the product. The AI steps are two nodes inside it. Everything that
matters — versioning, validation, durable execution, human approval, cancellation,
resumption, selective retry, idempotent writes, permission enforcement, and a complete
audit trail — belongs to the engine.

### Guiding constraint

**The engine holds no in-memory run state.** Every state transition is a database write.
This single rule is what makes cancel, resume, retry, and crash recovery fall out of the
design rather than being bolted on. A run is always reconstructible from its rows alone.

---

## 2. Goals and non-goals

### In scope

- Eight step types in a fixed, versioned registry
- Form-driven workflow definition editor (ordered step list)
- Pre-execution validation: schema compatibility, permission grants, reachability, termination
- Immutable workflow versions with side-by-side diff
- Durable execution engine passing structured output between steps
- Pause on human approval; approve or reject with a reason; resume later
- Cancel a running run; resume a cancelled run
- Retry restricted to steps declared safe
- Idempotency ledger preventing duplicate external writes
- Per-step permission declarations, enforced at validation and at execution
- Full audit trail: AI calls, tool calls, approvals, retries, failures, permission denials, results
- Failure recovery that skips already-completed safe steps
- Execution-path explanation for every conditional branch
- Run history; re-run any earlier version with new sample input

### Explicitly excluded (documented in README)

| Excluded | Reason |
|---|---|
| Multi-user authentication | Single-tenant demo. The brief asks for *step-level* tool and action permissions, which are implemented. Real login is effort better spent on the engine. |
| Drag-and-drop workflow canvas | High build cost, no rubric weight. "Extra features do not automatically improve the score." |
| Real third-party integrations | The brief specifies a *mock* external action. Simulated call with latency and failure toggles, used to demonstrate retry and idempotency. |
| Parallel step execution | Steps run sequentially; branching is via the condition step. Keeps the execution model provable. |
| Vector / embedding search | Document retrieval uses keyword scoring over a small seeded corpus. Honest and sufficient at this scale. |

---

## 3. Stack

| Layer | Choice | Rationale |
|---|---|---|
| App | Next.js (App Router), React, TypeScript | Single repo, single deploy, no CORS, no second service to keep alive |
| Styling | Tailwind CSS | Matches existing familiarity; fast to build dense inspection UIs |
| ORM / DB | Prisma + Postgres (Neon free tier) | Transactions and unique constraints are load-bearing here (idempotency, locking) |
| Hosting | Vercel | No idle spin-down, so free-tier risk stays confined to the LLM provider |
| Tests | Vitest | Already in use on prior work |
| LLM | Google Gemini (`gemini-2.5-flash`) primary, OpenRouter fallback, mock for tests | Gemini's `responseSchema` enforces JSON server-side — essential when step output feeds the next step |

**Rejected:** NestJS + separate React SPA. Closer to day-job stack, but two deploys, CORS
wiring, and Render's idle spin-down cost roughly two hours and stack a second free-tier
failure mode on top of the LLM one.

### Rejected: LangChain / LangGraph

No agent framework is used. This is a considered decision, recorded here because it will be
asked about.

LangGraph's central value proposition — stateful, resumable, multi-step orchestration with
checkpointing — is precisely the capability this project is being evaluated on. Delegating
it to a framework would hide the graded surface rather than demonstrate it.

The specific requirements also resist the abstraction. Retry restricted to steps declared
safe, an idempotency ledger backed by a unique constraint, per-step permission enforcement,
and serialisable branch explanations would each need to be layered on top of, or worked
around, the framework's own state handling. Implementing them directly against Prisma is
less code, not more, and keeps every one of them individually inspectable in the UI — which
is what the brief actually asks to see.

Framework experience is not absent from this decision; it informs it. Knowing what LangGraph
provides is what makes it clear that here it would compete with the deliverable rather than
support it.

---

## 4. Architecture

```
src/
  app/
    page.tsx                       workflow list
    workflows/[id]/page.tsx        versions, editor, validate
    workflows/[id]/diff/page.tsx   version diff
    runs/page.tsx                  run history
    runs/[id]/page.tsx             run detail — the centrepiece
    api/
      workflows/route.ts
      workflows/[id]/versions/route.ts
      workflows/[id]/validate/route.ts
      runs/route.ts
      runs/[id]/route.ts
      runs/[id]/tick/route.ts
      runs/[id]/approve/route.ts
      runs/[id]/cancel/route.ts
      runs/[id]/retry/route.ts
      runs/[id]/resume/route.ts
  lib/
    engine/
      registry.ts        step type definitions and contracts
      validator.ts       pre-execution validation
      executor.ts        execute exactly one step
      runner.ts          advanceRun — the tick loop
      idempotency.ts     duplicate-write ledger
      permissions.ts     grant checking
      expression.ts      safe declarative comparator
      store.ts           RunStore interface
      store.prisma.ts    production implementation
      store.memory.ts    test implementation
    steps/               one handler per step type
    llm/
      index.ts           provider interface + fallback chain
      gemini.ts
      openrouter.ts
      mock.ts
    audit.ts             append-only event log
    errors.ts            typed error taxonomy
  seed/
    corpus.ts            document corpus for retrieval
    workflow.ts          seeded demo workflow + completed demo run
```

### Module boundaries

`RunStore` is the one abstraction worth its cost. The engine depends on the interface, not
on Prisma, so the entire test suite runs against an in-memory implementation — fast,
deterministic, and requiring no database in CI. Everything outside the engine talks to
Prisma directly; no general-purpose repository layer.

Each step handler is a self-contained module implementing one interface. Adding a step type
means adding one file and one registry entry, touching nothing else.

### The tick loop

`advanceRun(runId)`:

1. Acquire the run lock via conditional update (`lockToken`, `lockedUntil`). If not
   acquired, return — another tick owns it.
2. Load the run, its version definition, and completed step executions.
3. Loop: resolve the next step; skip if already `SUCCEEDED`; otherwise execute, persist the
   result, append audit events.
4. Stop on any of: approval gate reached, terminal state, step failure, or ~40s wall-clock
   budget consumed.
5. Release the lock and return the run state.

If the loop stopped on budget, the run remains `RUNNING` and the client's poller calls
`POST /api/runs/[id]/tick` to continue. The UI polls `GET /api/runs/[id]` every second while
a run is active.

**Why this shape:** it makes the serverless execution limit a non-issue, and it makes
cancel, resume, retry, and crash recovery the *same code path* — all of them are "load
durable state, skip what succeeded, continue."

---

## 5. Step type registry

Every step type declares: input schema, output schema, required permissions, and whether it
is safe to retry automatically.

| # | Type | AI | Retry-safe | Required permission | Behaviour |
|---|---|---|---|---|---|
| 1 | `structured_input` | No | Yes | — | Validates run input against a declared JSON schema |
| 2 | `document_retrieval` | No | Yes | `tool:document_search` | Keyword-scored top-k over the seeded corpus |
| 3 | `ai_extraction` | Yes | Yes | `tool:llm` | Extracts declared fields from prior text/documents |
| 4 | `ai_classification` | Yes | Yes | `tool:llm` | Assigns one of a declared label set, plus confidence and rationale |
| 5 | `deterministic_condition` | No | Yes | — | Evaluates a declarative comparator, selects a branch |
| 6 | `human_approval` | No | n/a | — | Halts the run until a decision is recorded |
| 7 | `mock_external_action` | No | **No** | `action:<name>` | Simulated write, guarded by the idempotency ledger |
| 8 | `final_report` | Optional | Yes | `tool:llm` if summarising | Assembles a structured report from all prior outputs |

### Conditions without `eval`

Condition steps use a declarative comparator, never evaluated code:

```json
{ "left": "$.steps.extract.amount", "op": "gt", "right": 5000 }
```

Operators: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in`, `contains`, combined with `allOf` /
`anyOf`. This is safe by construction, trivially serialisable into a version diff, and
directly renderable as a human-readable explanation.

### Branching and termination

Steps form an ordered list with stable ids. A condition step declares `onTrue` and
`onFalse`, each either a forward step id or `end`. **Forward-only jumps are enforced by the
validator**, which guarantees every run terminates — a property worth stating explicitly in
the interview.

---

## 6. Data model

| Model | Key fields | Notes |
|---|---|---|
| `Workflow` | `id`, `name`, `createdAt` | Identity only |
| `WorkflowVersion` | `id`, `workflowId`, `version`, `definition` Json, `grantedPermissions` Json, `createdAt` | **Immutable.** Never updated after creation |
| `Run` | `id`, `workflowVersionId`, `status`, `input` Json, `cursor`, `lockToken`, `lockedUntil`, `error` | The cursor plus step rows fully describe progress |
| `StepExecution` | `id`, `runId`, `stepId`, `stepType`, `status`, `attempt`, `input` Json, `output` Json, `explanation` Json, `error`, `retrySafe`, timestamps | One row per step per attempt — the retry history is the audit |
| `Approval` | `id`, `stepExecutionId`, `decision`, `reason`, `decidedAt` | |
| `LlmCall` | `id`, `stepExecutionId`, `provider`, `model`, `prompt`, `response`, `inputTokens`, `outputTokens`, `latencyMs`, `status`, `error` | Every AI call, including failed ones |
| `ExternalAction` | `id`, `idempotencyKey` **unique**, `runId`, `stepId`, `request` Json, `response` Json | The duplicate-write ledger |
| `AuditEvent` | `id`, `runId`, `stepExecutionId?`, `type`, `payload` Json, `createdAt` | Append-only, never updated or deleted |

**Run status:** `PENDING → RUNNING → AWAITING_APPROVAL → COMPLETED | FAILED | CANCELLED`
**Step status:** `PENDING | RUNNING | SUCCEEDED | FAILED | SKIPPED | AWAITING_APPROVAL | CANCELLED`

Audit event types: `RUN_CREATED`, `STEP_STARTED`, `STEP_SUCCEEDED`, `STEP_FAILED`,
`LLM_CALL`, `TOOL_CALL`, `APPROVAL_REQUESTED`, `APPROVAL_DECIDED`, `RETRY_ATTEMPTED`,
`DUPLICATE_WRITE_PREVENTED`, `PERMISSION_DENIED`, `RUN_CANCELLED`, `RUN_RESUMED`,
`RUN_COMPLETED`, `RUN_FAILED`.

---

## 7. Requirement-to-mechanism mapping

| Requirement | Mechanism |
|---|---|
| Validate before execution | `validator.ts` checks schema compatibility between consecutive steps, permission grants, branch target reachability, and forward-only termination |
| Store and compare versions | Versions are immutable rows; diff renders a field-level comparison of two `definition` blobs |
| Display steps and current state | Run detail page renders the timeline from `StepExecution` rows, polling while active |
| Pass structured output between steps | Each step's declared output schema must satisfy the next step's input schema, checked at validation; runtime output is persisted and referenced via `$.steps.<id>.<field>` |
| Pause for approval | Approval step sets `AWAITING_APPROVAL` and returns; `POST /approve` records the decision and calls `advanceRun` |
| Cancel and resume | Cancel sets status and clears the lock; resume re-enters `advanceRun`, which skips `SUCCEEDED` steps |
| Retry only safe steps | Registry declares `retrySafe`; automatic retry with backoff applies only to safe steps. `mock_external_action` is never auto-retried |
| Prevent duplicate writes | External action inserts its `idempotencyKey` first. A unique-constraint conflict returns the stored response and logs `DUPLICATE_WRITE_PREVENTED`, so even a manual retry cannot double-write |
| Enforce permissions | Version declares grants; steps declare requirements. Checked at validation and re-checked at execution; violations fail the step and write `PERMISSION_DENIED` |
| Record everything | `AuditEvent` plus `LlmCall` rows; both surfaced in the UI |
| Recover without repeating work | Same skip-completed path as resume — no new run, no duplicated effort |
| Explain the path | Condition steps persist `{expression, resolvedInputs, result, branchTaken}`, rendered as "Took branch B because amount (5200) > threshold (5000)" |
| Inspect and re-run old versions | Versions immutable, so re-run is `POST /api/runs {workflowVersionId, input}` |

---

## 8. LLM adapter

```ts
interface LlmProvider {
  name: string
  complete<T>(req: {
    system: string
    user: string
    schema: JsonSchema
    maxTokens: number
  }): Promise<{ data: T; usage: Usage; raw: string }>
}
```

- **Gemini** uses `responseSchema` for server-enforced JSON.
- **OpenRouter** uses JSON mode, validated with Zod, with one reprompt on parse failure.
- **Mock** returns deterministic fixtures keyed by prompt hash — used by every test.

`callLlm()` wraps the chain: permission check → per-run call budget check → primary provider
→ fallback on `429`/`5xx` → persist an `LlmCall` row (success or failure) → return. Provider
selection is environment-driven; adding a provider means adding one file.

**Free-tier mitigation.** Rate limits are the known risk. Absorbed by: the two-provider
fallback chain, a per-run AI call cap, rate-limited steps failing as *retryable* with a
working retry button, and a pre-seeded completed run so reviewers can always inspect a full
execution even if live calls are throttled. Documented in the README as a known limitation.

---

## 9. API surface

| Method | Path | Purpose |
|---|---|---|
| `GET` `POST` | `/api/workflows` | List, create |
| `GET` | `/api/workflows/[id]` | Detail with versions |
| `POST` | `/api/workflows/[id]/versions` | Create a version (validates first) |
| `POST` | `/api/workflows/[id]/validate` | Validate a draft definition |
| `GET` `POST` | `/api/runs` | List, create |
| `GET` | `/api/runs/[id]` | Full detail: steps, LLM calls, audit |
| `POST` | `/api/runs/[id]/tick` | Continue a budget-paused run |
| `POST` | `/api/runs/[id]/approve` | Record decision, resume |
| `POST` | `/api/runs/[id]/cancel` | Cancel |
| `POST` | `/api/runs/[id]/resume` | Resume cancelled or failed |
| `POST` | `/api/runs/[id]/retry` | Retry one failed step |

---

## 10. Error handling

Typed taxonomy in `errors.ts`, each carrying a `retryable` flag:

| Error | Meaning | Outcome |
|---|---|---|
| `ValidationError` | Bad definition or input | 400, never reaches execution |
| `PermissionDeniedError` | Step lacks a grant | Step fails, `PERMISSION_DENIED` audited, not retryable |
| `RateLimitError` | Provider 429 | Fallback attempted; if exhausted, step fails as retryable |
| `ProviderError` | Provider 5xx or malformed output | Retryable |
| `StepExecutionError` | Handler failure | Retryable per registry declaration |

Every failure writes an audit event and leaves the run **resumable** rather than dead. The
UI distinguishes loading, empty, validation-error, success, and failure states explicitly.

---

## 11. Testing

Vitest, in-memory `RunStore`, mock LLM provider. No network, no database, deterministic.

| # | Test | Requirement covered |
|---|---|---|
| 1 | Validator rejects schema-incompatible step chain | Pre-execution validation |
| 2 | Validator rejects ungranted permission | Permission enforcement |
| 3 | Step N output reaches step N+1 intact | Structured output passing |
| 4 | Run halts at approval and does not advance | Human approval |
| 5 | Approve resumes to completion; reject terminates | Human approval |
| 6 | Cancel then resume skips completed steps | Cancellation and recovery |
| 7 | Safe step retries; unsafe step does not auto-retry | Selective retry |
| 8 | Duplicate idempotency key does not double-write | Idempotency |
| 9 | Condition step records branch explanation | Path explanation |
| 10 | LLM adapter falls back to secondary provider on 429 | Reliability |

Each test is pinned to a graded requirement rather than to code coverage.

---

## 12. Seeded demo

A single seeded workflow exercising all eight step types — an invoice approval pipeline:

`structured_input` (invoice) → `document_retrieval` (vendor policy) → `ai_extraction`
(amount, vendor, line items) → `ai_classification` (risk level) →
`deterministic_condition` (amount > threshold) → `human_approval` (high-risk branch only) →
`mock_external_action` (post to accounting) → `final_report`

Seeded alongside it: one **completed** run with full audit trail, so reviewers see a
finished execution immediately on landing, with zero dependence on live API calls.

---

## 13. Deployment

- Vercel project connected to the GitHub repository
- Neon Postgres, `DATABASE_URL` in Vercel environment variables
- `prisma migrate deploy` plus seed on build
- `.env.example` lists `DATABASE_URL`, `LLM_PROVIDER`, `GEMINI_API_KEY`,
  `OPENROUTER_API_KEY`, `MAX_LLM_CALLS_PER_RUN` — names only, no values
- No secrets committed at any point

---

## 14. Known limitations (for README)

1. Single-tenant; no user authentication. Permissions are enforced at step level as specified.
2. Free-tier LLM providers; sustained load can hit rate limits. Mitigated by fallback, retry, and the seeded run.
3. Sequential execution only; no parallel branches.
4. Keyword retrieval, not semantic search.
5. External actions are simulated, not real integrations.
6. Run progress advances via client-driven ticks rather than a background worker — a deliberate consequence of serverless hosting, and the reason execution state is fully durable.

---

## 15. Delivery order

| Phase | Content |
|---|---|
| 1 | Scaffold, Prisma schema, migrations, `RunStore` interface + both implementations |
| 2 | Registry, validator, expression evaluator, permissions — with tests 1, 2, 9 |
| 3 | Executor, runner, locking, resume/cancel/retry, idempotency — with tests 3–8 |
| 4 | LLM adapter, providers, mock, step handlers — with test 10 |
| 5 | UI: workflow list, editor, validation, diff |
| 6 | UI: run detail timeline, approval panel, audit view, controls |
| 7 | Seed data, deployment, README, AGENT_USAGE.md, final verification |

Phases 2–4 are the graded core and are built test-first. Phases 5–6 are where remaining
time gets spent or cut.
