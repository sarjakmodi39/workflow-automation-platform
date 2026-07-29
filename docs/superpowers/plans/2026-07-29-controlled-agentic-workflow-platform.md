# Controlled Agentic Workflow Automation Platform — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a web application where a user defines, validates, versions, executes, and inspects a bounded business workflow, with durable execution supporting human approval, cancellation, resumption, selective retry, idempotent external writes, and a complete audit trail.

**Architecture:** The engine holds no in-memory run state — every state transition is a database write, so a run is fully reconstructible from its rows. Execution is a tick loop (`advanceRun`) that executes one step at a time until it hits an approval gate, a terminal state, a failure, or a wall-clock budget; the client then calls `/tick` to continue. A `RunStore` interface separates the engine from Prisma so the entire engine test suite runs in-memory with no database.

**Tech Stack:** Next.js 15 (App Router) · React 19 · TypeScript · Tailwind CSS 4 · Prisma · PostgreSQL (Neon) · Vitest · Zod · Google Gemini + OpenRouter

**Spec:** `docs/superpowers/specs/2026-07-29-controlled-agentic-workflow-platform-design.md`

## Global Constraints

- Node 22, npm 10, Windows development host. Use forward slashes in code; npm scripts must be cross-platform (no `&&` chains relying on POSIX shell in `package.json`).
- **No secrets committed at any point.** `.env` is gitignored; `.env.example` lists variable names only.
- Engine code (`src/lib/engine/**`, `src/lib/steps/**`, `src/lib/llm/**`) must not import `@prisma/client` directly. It depends on the `RunStore` interface only. Enforced by review.
- All engine tests run against `MemoryRunStore` and `MockLlmProvider`. No test touches the network or a database.
- Every step type declares `retrySafe`. `mock_external_action` is `retrySafe: false` and is never auto-retried.
- Condition evaluation never uses `eval` or `Function`. Declarative comparators only.
- Branch jumps are forward-only; the validator rejects backward jumps to guarantee termination.
- Run status values: `PENDING`, `RUNNING`, `AWAITING_APPROVAL`, `COMPLETED`, `FAILED`, `CANCELLED`.
- Step status values: `PENDING`, `RUNNING`, `SUCCEEDED`, `FAILED`, `SKIPPED`, `AWAITING_APPROVAL`, `CANCELLED`.
- Audit event types: `RUN_CREATED`, `STEP_STARTED`, `STEP_SUCCEEDED`, `STEP_FAILED`, `LLM_CALL`, `TOOL_CALL`, `APPROVAL_REQUESTED`, `APPROVAL_DECIDED`, `RETRY_ATTEMPTED`, `DUPLICATE_WRITE_PREVENTED`, `PERMISSION_DENIED`, `RUN_CANCELLED`, `RUN_RESUMED`, `RUN_COMPLETED`, `RUN_FAILED`.
- Commit after every task. Conventional commit prefixes (`feat:`, `test:`, `chore:`, `fix:`, `docs:`).

## File Structure

| Path | Responsibility |
|---|---|
| `prisma/schema.prisma` | Database schema — 8 models |
| `src/lib/types.ts` | Shared domain types and enums used across engine and UI |
| `src/lib/errors.ts` | Typed error taxonomy with `retryable` flags |
| `src/lib/engine/expression.ts` | Safe declarative comparator evaluation |
| `src/lib/engine/registry.ts` | Step type definitions: schemas, permissions, retry safety |
| `src/lib/engine/permissions.ts` | Grant checking |
| `src/lib/engine/validator.ts` | Pre-execution workflow validation |
| `src/lib/engine/store.ts` | `RunStore` interface |
| `src/lib/engine/store.memory.ts` | In-memory implementation for tests |
| `src/lib/engine/store.prisma.ts` | Production implementation |
| `src/lib/engine/idempotency.ts` | Duplicate-write ledger logic |
| `src/lib/engine/context.ts` | `$.steps.<id>.<field>` path resolution |
| `src/lib/engine/executor.ts` | Execute exactly one step |
| `src/lib/engine/runner.ts` | `advanceRun` tick loop, locking, resume/cancel/retry |
| `src/lib/llm/types.ts` | `LlmProvider` interface |
| `src/lib/llm/mock.ts` | Deterministic fixture provider |
| `src/lib/llm/gemini.ts` | Gemini provider |
| `src/lib/llm/openrouter.ts` | OpenRouter provider |
| `src/lib/llm/index.ts` | Fallback chain, budget cap, call logging |
| `src/lib/steps/*.ts` | One handler per step type (8 files) |
| `src/lib/db.ts` | Prisma client singleton |
| `src/seed/corpus.ts` | Document corpus for retrieval |
| `src/seed/workflow.ts` | Demo workflow definition |
| `prisma/seed.ts` | Seeds workflow + one completed demo run |
| `src/app/api/**` | Route handlers |
| `src/app/**` | UI pages |

---

## Task 1: Project scaffold and toolchain

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `vitest.config.ts`, `postcss.config.mjs`, `.env.example`
- Create: `src/app/layout.tsx`, `src/app/page.tsx`, `src/app/globals.css`
- Create: `src/lib/smoke.ts`, `src/lib/smoke.test.ts`

**Interfaces:**
- Consumes: nothing (first task)
- Produces: working `npm test`, `npm run build`, `npm run dev`. Path alias `@/*` → `src/*`.

- [ ] **Step 1: Initialise the project**

Run in `C:/Users/sm/Documents/workflow-automation-platform`:

```bash
npm init -y
npm install next@15 react@19 react-dom@19 zod
npm install -D typescript @types/node @types/react @types/react-dom vitest @vitejs/plugin-react tailwindcss @tailwindcss/postcss prisma tsx
```

- [ ] **Step 2: Write config files**

`package.json` — replace the `scripts` and `name` blocks (keep the generated `dependencies`/`devDependencies`):

```json
{
  "name": "workflow-automation-platform",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "prisma generate && next build",
    "start": "next start",
    "test": "vitest run",
    "test:watch": "vitest",
    "db:push": "prisma db push",
    "db:seed": "tsx prisma/seed.ts",
    "postinstall": "prisma generate"
  },
  "prisma": {
    "seed": "tsx prisma/seed.ts"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

`next.config.ts`:

```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {};

export default nextConfig;
```

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
```

`postcss.config.mjs`:

```js
const config = {
  plugins: { "@tailwindcss/postcss": {} },
};

export default config;
```

`.env.example`:

```
# PostgreSQL connection string (Neon)
DATABASE_URL=

# LLM provider selection: gemini | openrouter | mock
LLM_PROVIDER=gemini

# Google Gemini API key (free tier)
GEMINI_API_KEY=

# OpenRouter API key (free tier, used as fallback)
OPENROUTER_API_KEY=

# Maximum AI calls permitted per workflow run
MAX_LLM_CALLS_PER_RUN=20
```

- [ ] **Step 3: Write the app shell**

`src/app/globals.css`:

```css
@import "tailwindcss";
```

`src/app/layout.tsx`:

```tsx
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Workflow Automation Platform",
  description: "Define, execute, and inspect controlled agentic workflows",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="bg-slate-50 text-slate-900 antialiased">{children}</body>
    </html>
  );
}
```

`src/app/page.tsx`:

```tsx
export default function Home() {
  return <main className="p-8">Workflow Automation Platform</main>;
}
```

- [ ] **Step 4: Write the toolchain smoke test**

`src/lib/smoke.ts`:

```ts
export function toolchainReady(): boolean {
  return true;
}
```

`src/lib/smoke.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { toolchainReady } from "@/lib/smoke";

describe("toolchain", () => {
  it("resolves the @/ path alias and runs tests", () => {
    expect(toolchainReady()).toBe(true);
  });
});
```

- [ ] **Step 5: Verify the toolchain**

Run: `npm test`
Expected: PASS, 1 test.

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: scaffold Next.js project with Vitest and Tailwind"
```

---

## Task 2: Domain types and error taxonomy

**Files:**
- Create: `src/lib/types.ts`
- Create: `src/lib/errors.ts`
- Create: `src/lib/errors.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `RunStatus`, `StepStatus`, `AuditEventType`, `StepType` — string union types
  - `WorkflowDefinition`, `StepDefinition`, `Condition`, `Comparator` — definition shapes
  - `AppError` base class with `code: string`, `retryable: boolean`, `details?: unknown`
  - `ValidationError`, `PermissionDeniedError`, `RateLimitError`, `ProviderError`, `StepExecutionError`, `NotFoundError`, `ConflictError`

- [ ] **Step 1: Write the types module**

`src/lib/types.ts`:

```ts
export type RunStatus =
  | "PENDING"
  | "RUNNING"
  | "AWAITING_APPROVAL"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

export type StepStatus =
  | "PENDING"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "SKIPPED"
  | "AWAITING_APPROVAL"
  | "CANCELLED";

export type StepType =
  | "structured_input"
  | "document_retrieval"
  | "ai_extraction"
  | "ai_classification"
  | "deterministic_condition"
  | "human_approval"
  | "mock_external_action"
  | "final_report";

export type AuditEventType =
  | "RUN_CREATED"
  | "STEP_STARTED"
  | "STEP_SUCCEEDED"
  | "STEP_FAILED"
  | "LLM_CALL"
  | "TOOL_CALL"
  | "APPROVAL_REQUESTED"
  | "APPROVAL_DECIDED"
  | "RETRY_ATTEMPTED"
  | "DUPLICATE_WRITE_PREVENTED"
  | "PERMISSION_DENIED"
  | "RUN_CANCELLED"
  | "RUN_RESUMED"
  | "RUN_COMPLETED"
  | "RUN_FAILED";

export type ComparatorOp =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "in"
  | "contains";

/** A single comparison against a resolved path or literal. */
export interface Comparator {
  left: string;
  op: ComparatorOp;
  right: unknown;
}

/** A comparator, or a boolean grouping of conditions. */
export type Condition =
  | Comparator
  | { allOf: Condition[] }
  | { anyOf: Condition[] };

export interface StepDefinition {
  id: string;
  type: StepType;
  name: string;
  /** Step-type-specific configuration. Validated per type by the registry. */
  config: Record<string, unknown>;
  /** Only present on deterministic_condition steps. */
  condition?: Condition;
  /** Forward step id or "end". Only on deterministic_condition steps. */
  onTrue?: string;
  onFalse?: string;
}

export interface WorkflowDefinition {
  steps: StepDefinition[];
}

export interface RunRecord {
  id: string;
  workflowVersionId: string;
  status: RunStatus;
  input: unknown;
  cursor: string | null;
  lockToken: string | null;
  lockedUntil: Date | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface StepExecutionRecord {
  id: string;
  runId: string;
  stepId: string;
  stepType: StepType;
  status: StepStatus;
  attempt: number;
  retrySafe: boolean;
  input: unknown;
  output: unknown;
  explanation: unknown;
  error: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface AuditEventRecord {
  id: string;
  runId: string;
  stepExecutionId: string | null;
  type: AuditEventType;
  payload: unknown;
  createdAt: Date;
}

export interface LlmCallRecord {
  id: string;
  stepExecutionId: string | null;
  runId: string;
  provider: string;
  model: string;
  prompt: string;
  response: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
  status: "SUCCESS" | "ERROR";
  error: string | null;
  createdAt: Date;
}

export interface ExternalActionRecord {
  id: string;
  idempotencyKey: string;
  runId: string;
  stepId: string;
  request: unknown;
  response: unknown;
  createdAt: Date;
}
```

- [ ] **Step 2: Write the failing error-taxonomy test**

`src/lib/errors.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  AppError,
  PermissionDeniedError,
  RateLimitError,
  ValidationError,
} from "@/lib/errors";

describe("error taxonomy", () => {
  it("marks validation errors as not retryable", () => {
    const err = new ValidationError("bad definition", { field: "steps" });
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe("VALIDATION_ERROR");
    expect(err.retryable).toBe(false);
    expect(err.details).toEqual({ field: "steps" });
  });

  it("marks permission denials as not retryable", () => {
    const err = new PermissionDeniedError("tool:llm");
    expect(err.code).toBe("PERMISSION_DENIED");
    expect(err.retryable).toBe(false);
    expect(err.message).toContain("tool:llm");
  });

  it("marks rate limits as retryable", () => {
    const err = new RateLimitError("gemini");
    expect(err.code).toBe("RATE_LIMIT");
    expect(err.retryable).toBe(true);
  });

  it("preserves the stack and name for debugging", () => {
    const err = new ValidationError("x");
    expect(err.name).toBe("ValidationError");
    expect(err.stack).toBeDefined();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/lib/errors.test.ts`
Expected: FAIL — cannot resolve `@/lib/errors`.

- [ ] **Step 4: Write the implementation**

`src/lib/errors.ts`:

```ts
export class AppError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(
    code: string,
    message: string,
    retryable: boolean,
    details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.retryable = retryable;
    this.details = details;
    Error.captureStackTrace?.(this, new.target);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super("VALIDATION_ERROR", message, false, details);
  }
}

export class NotFoundError extends AppError {
  constructor(what: string) {
    super("NOT_FOUND", `${what} not found`, false);
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super("CONFLICT", message, false);
  }
}

export class PermissionDeniedError extends AppError {
  constructor(permission: string) {
    super(
      "PERMISSION_DENIED",
      `Permission not granted: ${permission}`,
      false,
      { permission },
    );
  }
}

export class RateLimitError extends AppError {
  constructor(provider: string) {
    super("RATE_LIMIT", `Provider rate limited: ${provider}`, true, {
      provider,
    });
  }
}

export class ProviderError extends AppError {
  constructor(provider: string, message: string) {
    super("PROVIDER_ERROR", `${provider}: ${message}`, true, { provider });
  }
}

export class StepExecutionError extends AppError {
  constructor(message: string, retryable: boolean, details?: unknown) {
    super("STEP_EXECUTION_ERROR", message, retryable, details);
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

export function toErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/lib/errors.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add src/lib/types.ts src/lib/errors.ts src/lib/errors.test.ts
git commit -m "feat: add domain types and typed error taxonomy"
```

---

## Task 3: Prisma schema and client

**Files:**
- Create: `prisma/schema.prisma`
- Create: `src/lib/db.ts`

**Interfaces:**
- Consumes: `src/lib/types.ts` (status string unions mirror the Prisma enums)
- Produces: generated Prisma client; `prisma` singleton exported from `@/lib/db`. Model names: `Workflow`, `WorkflowVersion`, `Run`, `StepExecution`, `Approval`, `LlmCall`, `ExternalAction`, `AuditEvent`.

- [ ] **Step 1: Write the schema**

`prisma/schema.prisma`:

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum RunStatus {
  PENDING
  RUNNING
  AWAITING_APPROVAL
  COMPLETED
  FAILED
  CANCELLED
}

enum StepStatus {
  PENDING
  RUNNING
  SUCCEEDED
  FAILED
  SKIPPED
  AWAITING_APPROVAL
  CANCELLED
}

enum ApprovalDecision {
  APPROVED
  REJECTED
}

enum LlmCallStatus {
  SUCCESS
  ERROR
}

model Workflow {
  id        String            @id @default(cuid())
  name      String
  createdAt DateTime          @default(now())
  versions  WorkflowVersion[]
}

model WorkflowVersion {
  id                 String   @id @default(cuid())
  workflowId         String
  version            Int
  definition         Json
  grantedPermissions Json
  createdAt          DateTime @default(now())

  workflow Workflow @relation(fields: [workflowId], references: [id], onDelete: Cascade)
  runs     Run[]

  @@unique([workflowId, version])
  @@index([workflowId])
}

model Run {
  id                String    @id @default(cuid())
  workflowVersionId String
  status            RunStatus @default(PENDING)
  input             Json
  cursor            String?
  lockToken         String?
  lockedUntil       DateTime?
  error             String?
  createdAt         DateTime  @default(now())
  updatedAt         DateTime  @updatedAt

  workflowVersion  WorkflowVersion  @relation(fields: [workflowVersionId], references: [id], onDelete: Cascade)
  stepExecutions   StepExecution[]
  auditEvents      AuditEvent[]
  llmCalls         LlmCall[]
  externalActions  ExternalAction[]

  @@index([workflowVersionId])
  @@index([status])
}

model StepExecution {
  id          String     @id @default(cuid())
  runId       String
  stepId      String
  stepType    String
  status      StepStatus @default(PENDING)
  attempt     Int        @default(1)
  retrySafe   Boolean    @default(true)
  input       Json?
  output      Json?
  explanation Json?
  error       String?
  startedAt   DateTime?
  finishedAt  DateTime?

  run         Run          @relation(fields: [runId], references: [id], onDelete: Cascade)
  approval    Approval?
  llmCalls    LlmCall[]
  auditEvents AuditEvent[]

  @@index([runId])
  @@unique([runId, stepId, attempt])
}

model Approval {
  id              String           @id @default(cuid())
  stepExecutionId String           @unique
  decision        ApprovalDecision
  reason          String?
  decidedAt       DateTime         @default(now())

  stepExecution StepExecution @relation(fields: [stepExecutionId], references: [id], onDelete: Cascade)
}

model LlmCall {
  id              String        @id @default(cuid())
  runId           String
  stepExecutionId String?
  provider        String
  model           String
  prompt          String
  response        String?
  inputTokens     Int?
  outputTokens    Int?
  latencyMs       Int
  status          LlmCallStatus
  error           String?
  createdAt       DateTime      @default(now())

  run           Run            @relation(fields: [runId], references: [id], onDelete: Cascade)
  stepExecution StepExecution? @relation(fields: [stepExecutionId], references: [id], onDelete: Cascade)

  @@index([runId])
}

model ExternalAction {
  id             String   @id @default(cuid())
  idempotencyKey String   @unique
  runId          String
  stepId         String
  request        Json
  response       Json
  createdAt      DateTime @default(now())

  run Run @relation(fields: [runId], references: [id], onDelete: Cascade)

  @@index([runId])
}

model AuditEvent {
  id              String   @id @default(cuid())
  runId           String
  stepExecutionId String?
  type            String
  payload         Json
  createdAt       DateTime @default(now())

  run           Run            @relation(fields: [runId], references: [id], onDelete: Cascade)
  stepExecution StepExecution? @relation(fields: [stepExecutionId], references: [id], onDelete: Cascade)

  @@index([runId, createdAt])
}
```

- [ ] **Step 2: Write the client singleton**

`src/lib/db.ts`:

```ts
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
```

- [ ] **Step 3: Generate the client and verify it compiles**

Run: `npx prisma generate`
Expected: "Generated Prisma Client".

Run: `npx tsc --noEmit`
Expected: no errors.

Note: `DATABASE_URL` is not needed for `generate`. Database provisioning happens in Task 18.

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma src/lib/db.ts package.json package-lock.json
git commit -m "feat: add Prisma schema for workflows, runs, audit, and idempotency"
```

---

## Task 4: Safe condition expression evaluator

**Files:**
- Create: `src/lib/engine/context.ts`
- Create: `src/lib/engine/expression.ts`
- Create: `src/lib/engine/expression.test.ts`

**Interfaces:**
- Consumes: `Condition`, `Comparator` from `@/lib/types`
- Produces:
  - `resolvePath(path: string, ctx: ExecutionContext): unknown` — resolves `$.input.x` and `$.steps.<id>.<field>`
  - `ExecutionContext = { input: unknown; steps: Record<string, unknown> }`
  - `evaluateCondition(cond: Condition, ctx: ExecutionContext): ConditionResult`
  - `ConditionResult = { result: boolean; resolvedInputs: Record<string, unknown>; description: string }`

- [ ] **Step 1: Write the failing test**

`src/lib/engine/expression.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { evaluateCondition, resolvePath } from "@/lib/engine/expression";
import type { ExecutionContext } from "@/lib/engine/context";

const ctx: ExecutionContext = {
  input: { invoiceId: "INV-1" },
  steps: {
    extract: { amount: 5200, vendor: "Acme", tags: ["urgent", "eu"] },
    classify: { label: "high_risk" },
  },
};

describe("resolvePath", () => {
  it("resolves a run input path", () => {
    expect(resolvePath("$.input.invoiceId", ctx)).toBe("INV-1");
  });

  it("resolves a step output path", () => {
    expect(resolvePath("$.steps.extract.amount", ctx)).toBe(5200);
  });

  it("returns undefined for a missing path rather than throwing", () => {
    expect(resolvePath("$.steps.nope.field", ctx)).toBeUndefined();
  });

  it("treats a non-$ string as a literal", () => {
    expect(resolvePath("plain", ctx)).toBe("plain");
  });
});

describe("evaluateCondition", () => {
  it("evaluates a greater-than comparator", () => {
    const r = evaluateCondition(
      { left: "$.steps.extract.amount", op: "gt", right: 5000 },
      ctx,
    );
    expect(r.result).toBe(true);
    expect(r.resolvedInputs["$.steps.extract.amount"]).toBe(5200);
  });

  it("produces a human-readable description of the decision", () => {
    const r = evaluateCondition(
      { left: "$.steps.extract.amount", op: "gt", right: 5000 },
      ctx,
    );
    expect(r.description).toBe("amount (5200) > 5000");
  });

  it("evaluates equality against a step output", () => {
    const r = evaluateCondition(
      { left: "$.steps.classify.label", op: "eq", right: "high_risk" },
      ctx,
    );
    expect(r.result).toBe(true);
  });

  it("evaluates `in` against an array literal", () => {
    const r = evaluateCondition(
      { left: "$.steps.classify.label", op: "in", right: ["high_risk", "critical"] },
      ctx,
    );
    expect(r.result).toBe(true);
  });

  it("evaluates `contains` against a resolved array", () => {
    const r = evaluateCondition(
      { left: "$.steps.extract.tags", op: "contains", right: "urgent" },
      ctx,
    );
    expect(r.result).toBe(true);
  });

  it("evaluates allOf as logical AND", () => {
    const r = evaluateCondition(
      {
        allOf: [
          { left: "$.steps.extract.amount", op: "gt", right: 5000 },
          { left: "$.steps.classify.label", op: "eq", right: "high_risk" },
        ],
      },
      ctx,
    );
    expect(r.result).toBe(true);
    expect(r.description).toContain(" AND ");
  });

  it("evaluates anyOf as logical OR", () => {
    const r = evaluateCondition(
      {
        anyOf: [
          { left: "$.steps.extract.amount", op: "gt", right: 99999 },
          { left: "$.steps.classify.label", op: "eq", right: "high_risk" },
        ],
      },
      ctx,
    );
    expect(r.result).toBe(true);
  });

  it("returns false when a comparator references a missing path", () => {
    const r = evaluateCondition(
      { left: "$.steps.missing.amount", op: "gt", right: 1 },
      ctx,
    );
    expect(r.result).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/engine/expression.test.ts`
Expected: FAIL — cannot resolve `@/lib/engine/expression`.

- [ ] **Step 3: Write the context module**

`src/lib/engine/context.ts`:

```ts
export interface ExecutionContext {
  /** The run's initial input. */
  input: unknown;
  /** Outputs of completed steps, keyed by step id. */
  steps: Record<string, unknown>;
}

export function emptyContext(input: unknown): ExecutionContext {
  return { input, steps: {} };
}
```

- [ ] **Step 4: Write the evaluator**

`src/lib/engine/expression.ts`:

```ts
import type { Comparator, Condition } from "@/lib/types";
import type { ExecutionContext } from "@/lib/engine/context";

export interface ConditionResult {
  result: boolean;
  /** Every path referenced, with the value it resolved to. */
  resolvedInputs: Record<string, unknown>;
  /** Human-readable rendering of the decision, e.g. "amount (5200) > 5000". */
  description: string;
}

/**
 * Resolves a `$.`-prefixed path against the execution context.
 * Anything not starting with `$.` is treated as a literal value.
 * Missing paths resolve to `undefined` rather than throwing.
 */
export function resolvePath(path: string, ctx: ExecutionContext): unknown {
  if (typeof path !== "string" || !path.startsWith("$.")) return path;

  const segments = path.slice(2).split(".");
  const [root, ...rest] = segments;

  let current: unknown;
  if (root === "input") {
    current = ctx.input;
  } else if (root === "steps") {
    const [stepId, ...fields] = rest;
    current = ctx.steps[stepId];
    return walk(current, fields);
  } else {
    return undefined;
  }

  return walk(current, rest);
}

function walk(value: unknown, fields: string[]): unknown {
  let current = value;
  for (const field of fields) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[field];
  }
  return current;
}

function isComparator(c: Condition): c is Comparator {
  return typeof c === "object" && c !== null && "op" in c;
}

const OP_SYMBOL: Record<Comparator["op"], string> = {
  eq: "==",
  neq: "!=",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
  in: "in",
  contains: "contains",
};

function lastSegment(path: string): string {
  if (typeof path !== "string" || !path.startsWith("$.")) return String(path);
  const parts = path.split(".");
  return parts[parts.length - 1];
}

function render(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? String(value);
}

function applyOp(op: Comparator["op"], left: unknown, right: unknown): boolean {
  switch (op) {
    case "eq":
      return left === right;
    case "neq":
      return left !== right;
    case "gt":
      return typeof left === "number" && typeof right === "number" && left > right;
    case "gte":
      return typeof left === "number" && typeof right === "number" && left >= right;
    case "lt":
      return typeof left === "number" && typeof right === "number" && left < right;
    case "lte":
      return typeof left === "number" && typeof right === "number" && left <= right;
    case "in":
      return Array.isArray(right) && right.includes(left as never);
    case "contains":
      if (Array.isArray(left)) return left.includes(right as never);
      if (typeof left === "string") return left.includes(String(right));
      return false;
    default:
      return false;
  }
}

/**
 * Evaluates a declarative condition. Never uses eval or Function —
 * only the fixed operator set above.
 */
export function evaluateCondition(
  cond: Condition,
  ctx: ExecutionContext,
): ConditionResult {
  const resolvedInputs: Record<string, unknown> = {};

  const evaluate = (c: Condition): { result: boolean; description: string } => {
    if (isComparator(c)) {
      const left = resolvePath(c.left, ctx);
      const right =
        typeof c.right === "string" && c.right.startsWith("$.")
          ? resolvePath(c.right, ctx)
          : c.right;

      if (typeof c.left === "string" && c.left.startsWith("$.")) {
        resolvedInputs[c.left] = left;
      }
      if (typeof c.right === "string" && c.right.startsWith("$.")) {
        resolvedInputs[c.right] = right;
      }

      const result = applyOp(c.op, left, right);
      const description = `${lastSegment(c.left)} (${render(left)}) ${OP_SYMBOL[c.op]} ${render(right)}`;
      return { result, description };
    }

    if ("allOf" in c) {
      const parts = c.allOf.map(evaluate);
      return {
        result: parts.every((p) => p.result),
        description: parts.map((p) => p.description).join(" AND "),
      };
    }

    const parts = c.anyOf.map(evaluate);
    return {
      result: parts.some((p) => p.result),
      description: parts.map((p) => p.description).join(" OR "),
    };
  };

  const { result, description } = evaluate(cond);
  return { result, resolvedInputs, description };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/lib/engine/expression.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 6: Commit**

```bash
git add src/lib/engine/context.ts src/lib/engine/expression.ts src/lib/engine/expression.test.ts
git commit -m "feat: add safe declarative condition evaluator with path resolution"
```

---

## Task 5: Step type registry

**Files:**
- Create: `src/lib/engine/registry.ts`
- Create: `src/lib/engine/registry.test.ts`

**Interfaces:**
- Consumes: `StepType` from `@/lib/types`
- Produces:
  - `StepTypeSpec = { type: StepType; retrySafe: boolean; requiredPermissions(config): string[]; inputSchema: JsonShape; outputSchema(config): JsonShape; validateConfig(config): string[] }`
  - `JsonShape = Record<string, "string" | "number" | "boolean" | "object" | "array" | "any">`
  - `REGISTRY: Record<StepType, StepTypeSpec>`
  - `getStepSpec(type: string): StepTypeSpec` — throws `ValidationError` on unknown type

`JsonShape` is a deliberately small field-name-to-kind map, not full JSON Schema. It is
sufficient for the compatibility check the validator performs and keeps diffs readable.

- [ ] **Step 1: Write the failing test**

`src/lib/engine/registry.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { REGISTRY, getStepSpec } from "@/lib/engine/registry";
import { ValidationError } from "@/lib/errors";

describe("step registry", () => {
  it("defines exactly the eight supported step types", () => {
    expect(Object.keys(REGISTRY).sort()).toEqual(
      [
        "ai_classification",
        "ai_extraction",
        "deterministic_condition",
        "document_retrieval",
        "final_report",
        "human_approval",
        "mock_external_action",
        "structured_input",
      ].sort(),
    );
  });

  it("marks the external action as unsafe to retry", () => {
    expect(REGISTRY.mock_external_action.retrySafe).toBe(false);
  });

  it("marks read-only steps as safe to retry", () => {
    expect(REGISTRY.document_retrieval.retrySafe).toBe(true);
    expect(REGISTRY.ai_extraction.retrySafe).toBe(true);
    expect(REGISTRY.ai_classification.retrySafe).toBe(true);
    expect(REGISTRY.deterministic_condition.retrySafe).toBe(true);
  });

  it("requires the llm tool permission for AI steps", () => {
    expect(REGISTRY.ai_extraction.requiredPermissions({})).toContain("tool:llm");
    expect(REGISTRY.ai_classification.requiredPermissions({})).toContain("tool:llm");
  });

  it("requires the document search permission for retrieval", () => {
    expect(REGISTRY.document_retrieval.requiredPermissions({})).toContain(
      "tool:document_search",
    );
  });

  it("derives the external action permission from its configured action name", () => {
    expect(
      REGISTRY.mock_external_action.requiredPermissions({ action: "post_invoice" }),
    ).toEqual(["action:post_invoice"]);
  });

  it("requires the llm permission for the report only when summarising", () => {
    expect(REGISTRY.final_report.requiredPermissions({ summarize: false })).toEqual([]);
    expect(REGISTRY.final_report.requiredPermissions({ summarize: true })).toEqual([
      "tool:llm",
    ]);
  });

  it("derives the extraction output shape from its configured fields", () => {
    const shape = REGISTRY.ai_extraction.outputSchema({
      fields: [
        { name: "amount", kind: "number" },
        { name: "vendor", kind: "string" },
      ],
    });
    expect(shape).toEqual({ amount: "number", vendor: "string" });
  });

  it("reports a config error when extraction declares no fields", () => {
    const errors = REGISTRY.ai_extraction.validateConfig({ fields: [] });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("at least one field");
  });

  it("reports a config error when classification declares fewer than two labels", () => {
    const errors = REGISTRY.ai_classification.validateConfig({ labels: ["only"] });
    expect(errors.length).toBeGreaterThan(0);
  });

  it("accepts a valid classification config", () => {
    expect(
      REGISTRY.ai_classification.validateConfig({ labels: ["low", "high"] }),
    ).toEqual([]);
  });

  it("throws a ValidationError for an unknown step type", () => {
    expect(() => getStepSpec("nonexistent")).toThrow(ValidationError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/engine/registry.test.ts`
Expected: FAIL — cannot resolve `@/lib/engine/registry`.

- [ ] **Step 3: Write the registry**

`src/lib/engine/registry.ts`:

```ts
import { ValidationError } from "@/lib/errors";
import type { StepType } from "@/lib/types";

export type FieldKind =
  | "string"
  | "number"
  | "boolean"
  | "object"
  | "array"
  | "any";

/** Field-name to kind map. Deliberately smaller than JSON Schema. */
export type JsonShape = Record<string, FieldKind>;

export interface StepTypeSpec {
  type: StepType;
  label: string;
  description: string;
  retrySafe: boolean;
  /** Permissions this step needs, derived from its configuration. */
  requiredPermissions(config: Record<string, unknown>): string[];
  /** Fields this step expects to find in the accumulated context. */
  inputSchema(config: Record<string, unknown>): JsonShape;
  /** Fields this step guarantees to produce. */
  outputSchema(config: Record<string, unknown>): JsonShape;
  /** Returns human-readable config problems; empty array means valid. */
  validateConfig(config: Record<string, unknown>): string[];
}

interface ExtractionField {
  name: string;
  kind: FieldKind;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export const REGISTRY: Record<StepType, StepTypeSpec> = {
  structured_input: {
    type: "structured_input",
    label: "Structured Input",
    description: "Validates the run input against a declared field shape.",
    retrySafe: true,
    requiredPermissions: () => [],
    inputSchema: () => ({}),
    outputSchema: (config) => {
      const shape: JsonShape = {};
      for (const f of asArray<ExtractionField>(config.fields)) {
        shape[f.name] = f.kind;
      }
      return shape;
    },
    validateConfig: (config) => {
      const fields = asArray<ExtractionField>(config.fields);
      if (fields.length === 0) return ["Structured input must declare at least one field."];
      const errors: string[] = [];
      for (const f of fields) {
        if (!f.name) errors.push("Every input field needs a name.");
      }
      return errors;
    },
  },

  document_retrieval: {
    type: "document_retrieval",
    label: "Document Retrieval",
    description: "Keyword-scored lookup over the seeded document corpus.",
    retrySafe: true,
    requiredPermissions: () => ["tool:document_search"],
    inputSchema: () => ({}),
    outputSchema: () => ({ documents: "array", matchCount: "number" }),
    validateConfig: (config) => {
      const errors: string[] = [];
      if (typeof config.query !== "string" || config.query.length === 0) {
        errors.push("Document retrieval needs a query.");
      }
      const topK = config.topK;
      if (topK !== undefined && (typeof topK !== "number" || topK < 1)) {
        errors.push("topK must be a positive number.");
      }
      return errors;
    },
  },

  ai_extraction: {
    type: "ai_extraction",
    label: "AI Extraction",
    description: "Extracts declared fields from prior step output using an LLM.",
    retrySafe: true,
    requiredPermissions: () => ["tool:llm"],
    inputSchema: () => ({}),
    outputSchema: (config) => {
      const shape: JsonShape = {};
      for (const f of asArray<ExtractionField>(config.fields)) {
        shape[f.name] = f.kind;
      }
      return shape;
    },
    validateConfig: (config) => {
      const fields = asArray<ExtractionField>(config.fields);
      if (fields.length === 0) {
        return ["AI extraction must declare at least one field to extract."];
      }
      const errors: string[] = [];
      if (typeof config.source !== "string" || config.source.length === 0) {
        errors.push("AI extraction needs a source path (e.g. $.steps.retrieve.documents).");
      }
      for (const f of fields) {
        if (!f.name) errors.push("Every extraction field needs a name.");
      }
      return errors;
    },
  },

  ai_classification: {
    type: "ai_classification",
    label: "AI Classification",
    description: "Assigns one of a declared label set, with confidence and rationale.",
    retrySafe: true,
    requiredPermissions: () => ["tool:llm"],
    inputSchema: () => ({}),
    outputSchema: () => ({
      label: "string",
      confidence: "number",
      rationale: "string",
    }),
    validateConfig: (config) => {
      const labels = asArray<string>(config.labels);
      const errors: string[] = [];
      if (labels.length < 2) {
        errors.push("AI classification needs at least two labels.");
      }
      if (typeof config.source !== "string" || config.source.length === 0) {
        errors.push("AI classification needs a source path.");
      }
      return errors;
    },
  },

  deterministic_condition: {
    type: "deterministic_condition",
    label: "Condition",
    description: "Evaluates a declarative comparator and selects a branch.",
    retrySafe: true,
    requiredPermissions: () => [],
    inputSchema: () => ({}),
    outputSchema: () => ({ result: "boolean", branchTaken: "string" }),
    validateConfig: () => [],
  },

  human_approval: {
    type: "human_approval",
    label: "Human Approval",
    description: "Halts the run until a person approves or rejects.",
    retrySafe: true,
    requiredPermissions: () => [],
    inputSchema: () => ({}),
    outputSchema: () => ({ decision: "string", reason: "string" }),
    validateConfig: (config) => {
      if (typeof config.prompt !== "string" || config.prompt.length === 0) {
        return ["Human approval needs a prompt explaining what is being approved."];
      }
      return [];
    },
  },

  mock_external_action: {
    type: "mock_external_action",
    label: "External Action (mock)",
    description: "Simulated write, guarded by the idempotency ledger.",
    retrySafe: false,
    requiredPermissions: (config) => {
      const action = typeof config.action === "string" ? config.action : "unknown";
      return [`action:${action}`];
    },
    inputSchema: () => ({}),
    outputSchema: () => ({
      actionId: "string",
      status: "string",
      duplicatePrevented: "boolean",
    }),
    validateConfig: (config) => {
      const errors: string[] = [];
      if (typeof config.action !== "string" || config.action.length === 0) {
        errors.push("External action needs an action name.");
      }
      if (config.payload !== undefined && typeof config.payload !== "object") {
        errors.push("External action payload must be an object.");
      }
      return errors;
    },
  },

  final_report: {
    type: "final_report",
    label: "Final Report",
    description: "Assembles a structured report from all prior step outputs.",
    retrySafe: true,
    requiredPermissions: (config) => (config.summarize === true ? ["tool:llm"] : []),
    inputSchema: () => ({}),
    outputSchema: (config) =>
      config.summarize === true
        ? { title: "string", sections: "array", summary: "string" }
        : { title: "string", sections: "array" },
    validateConfig: (config) => {
      if (typeof config.title !== "string" || config.title.length === 0) {
        return ["Final report needs a title."];
      }
      return [];
    },
  },
};

export function getStepSpec(type: string): StepTypeSpec {
  const spec = REGISTRY[type as StepType];
  if (!spec) {
    throw new ValidationError(`Unknown step type: ${type}`, { type });
  }
  return spec;
}

export const ALL_STEP_TYPES = Object.keys(REGISTRY) as StepType[];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/engine/registry.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/engine/registry.ts src/lib/engine/registry.test.ts
git commit -m "feat: add step type registry with permissions and retry safety"
```

---

## Task 6: Permission checking

**Files:**
- Create: `src/lib/engine/permissions.ts`
- Create: `src/lib/engine/permissions.test.ts`

**Interfaces:**
- Consumes: `getStepSpec` from `@/lib/engine/registry`, `PermissionDeniedError` from `@/lib/errors`
- Produces:
  - `missingPermissions(step: StepDefinition, granted: string[]): string[]`
  - `assertPermitted(step: StepDefinition, granted: string[]): void` — throws `PermissionDeniedError`

- [ ] **Step 1: Write the failing test**

`src/lib/engine/permissions.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { assertPermitted, missingPermissions } from "@/lib/engine/permissions";
import { PermissionDeniedError } from "@/lib/errors";
import type { StepDefinition } from "@/lib/types";

const aiStep: StepDefinition = {
  id: "extract",
  type: "ai_extraction",
  name: "Extract fields",
  config: { source: "$.input", fields: [{ name: "amount", kind: "number" }] },
};

const actionStep: StepDefinition = {
  id: "post",
  type: "mock_external_action",
  name: "Post to accounting",
  config: { action: "post_invoice" },
};

describe("permissions", () => {
  it("reports nothing missing when the grant covers the step", () => {
    expect(missingPermissions(aiStep, ["tool:llm"])).toEqual([]);
  });

  it("reports the missing permission when the grant is absent", () => {
    expect(missingPermissions(aiStep, [])).toEqual(["tool:llm"]);
  });

  it("matches action permissions by their configured action name", () => {
    expect(missingPermissions(actionStep, ["action:post_invoice"])).toEqual([]);
    expect(missingPermissions(actionStep, ["action:something_else"])).toEqual([
      "action:post_invoice",
    ]);
  });

  it("throws PermissionDeniedError naming the missing permission", () => {
    expect(() => assertPermitted(aiStep, [])).toThrow(PermissionDeniedError);
    try {
      assertPermitted(aiStep, []);
    } catch (e) {
      expect((e as PermissionDeniedError).message).toContain("tool:llm");
    }
  });

  it("does not throw when every required permission is granted", () => {
    expect(() => assertPermitted(actionStep, ["action:post_invoice"])).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/engine/permissions.test.ts`
Expected: FAIL — cannot resolve `@/lib/engine/permissions`.

- [ ] **Step 3: Write the implementation**

`src/lib/engine/permissions.ts`:

```ts
import { getStepSpec } from "@/lib/engine/registry";
import { PermissionDeniedError } from "@/lib/errors";
import type { StepDefinition } from "@/lib/types";

/** Permissions the step needs that the version has not granted. */
export function missingPermissions(
  step: StepDefinition,
  granted: string[],
): string[] {
  const spec = getStepSpec(step.type);
  const required = spec.requiredPermissions(step.config ?? {});
  const grantedSet = new Set(granted);
  return required.filter((p) => !grantedSet.has(p));
}

/** Throws PermissionDeniedError for the first missing permission. */
export function assertPermitted(
  step: StepDefinition,
  granted: string[],
): void {
  const missing = missingPermissions(step, granted);
  if (missing.length > 0) {
    throw new PermissionDeniedError(missing[0]);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/engine/permissions.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/engine/permissions.ts src/lib/engine/permissions.test.ts
git commit -m "feat: add step-level permission checking"
```

---

## Task 7: Workflow validator

**Files:**
- Create: `src/lib/engine/validator.ts`
- Create: `src/lib/engine/validator.test.ts`

**Interfaces:**
- Consumes: `REGISTRY`/`getStepSpec`, `missingPermissions`, `WorkflowDefinition`
- Produces:
  - `ValidationIssue = { stepId: string | null; code: string; message: string }`
  - `validateWorkflow(def: WorkflowDefinition, granted: string[]): ValidationIssue[]`

Checks performed: non-empty; unique step ids; known step types; per-type config validity;
permission grants; branch targets exist; branch jumps are forward-only; source paths
reference an earlier step; final step reachable.

- [ ] **Step 1: Write the failing test**

`src/lib/engine/validator.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { validateWorkflow } from "@/lib/engine/validator";
import type { WorkflowDefinition } from "@/lib/types";

const GRANTS = ["tool:llm", "tool:document_search", "action:post_invoice"];

function validDefinition(): WorkflowDefinition {
  return {
    steps: [
      {
        id: "intake",
        type: "structured_input",
        name: "Intake",
        config: { fields: [{ name: "invoiceId", kind: "string" }] },
      },
      {
        id: "extract",
        type: "ai_extraction",
        name: "Extract",
        config: {
          source: "$.steps.intake.invoiceId",
          fields: [{ name: "amount", kind: "number" }],
        },
      },
      {
        id: "report",
        type: "final_report",
        name: "Report",
        config: { title: "Result", summarize: false },
      },
    ],
  };
}

describe("validateWorkflow", () => {
  it("accepts a well-formed definition", () => {
    expect(validateWorkflow(validDefinition(), GRANTS)).toEqual([]);
  });

  it("rejects an empty workflow", () => {
    const issues = validateWorkflow({ steps: [] }, GRANTS);
    expect(issues.some((i) => i.code === "EMPTY_WORKFLOW")).toBe(true);
  });

  it("rejects duplicate step ids", () => {
    const def = validDefinition();
    def.steps[1].id = "intake";
    const issues = validateWorkflow(def, GRANTS);
    expect(issues.some((i) => i.code === "DUPLICATE_STEP_ID")).toBe(true);
  });

  it("rejects an unknown step type", () => {
    const def = validDefinition();
    (def.steps[1] as { type: string }).type = "telepathy";
    const issues = validateWorkflow(def, GRANTS);
    expect(issues.some((i) => i.code === "UNKNOWN_STEP_TYPE")).toBe(true);
  });

  it("rejects a step whose config is invalid for its type", () => {
    const def = validDefinition();
    def.steps[1].config = { source: "$.input", fields: [] };
    const issues = validateWorkflow(def, GRANTS);
    expect(issues.some((i) => i.code === "INVALID_STEP_CONFIG")).toBe(true);
  });

  it("rejects a step requesting an ungranted permission", () => {
    const issues = validateWorkflow(validDefinition(), ["tool:document_search"]);
    const denied = issues.find((i) => i.code === "PERMISSION_NOT_GRANTED");
    expect(denied).toBeDefined();
    expect(denied?.message).toContain("tool:llm");
  });

  it("rejects a source path referencing a step that does not exist", () => {
    const def = validDefinition();
    def.steps[1].config = {
      source: "$.steps.ghost.value",
      fields: [{ name: "amount", kind: "number" }],
    };
    const issues = validateWorkflow(def, GRANTS);
    expect(issues.some((i) => i.code === "UNKNOWN_SOURCE_STEP")).toBe(true);
  });

  it("rejects a source path referencing a later step", () => {
    const def = validDefinition();
    def.steps[1].config = {
      source: "$.steps.report.title",
      fields: [{ name: "amount", kind: "number" }],
    };
    const issues = validateWorkflow(def, GRANTS);
    expect(issues.some((i) => i.code === "FORWARD_SOURCE_REFERENCE")).toBe(true);
  });

  it("rejects a branch target that does not exist", () => {
    const def = validDefinition();
    def.steps.splice(2, 0, {
      id: "check",
      type: "deterministic_condition",
      name: "Check",
      config: {},
      condition: { left: "$.steps.extract.amount", op: "gt", right: 100 },
      onTrue: "nowhere",
      onFalse: "report",
    });
    const issues = validateWorkflow(def, GRANTS);
    expect(issues.some((i) => i.code === "UNKNOWN_BRANCH_TARGET")).toBe(true);
  });

  it("rejects a backward branch jump so termination is guaranteed", () => {
    const def = validDefinition();
    def.steps.splice(2, 0, {
      id: "check",
      type: "deterministic_condition",
      name: "Check",
      config: {},
      condition: { left: "$.steps.extract.amount", op: "gt", right: 100 },
      onTrue: "intake",
      onFalse: "report",
    });
    const issues = validateWorkflow(def, GRANTS);
    expect(issues.some((i) => i.code === "BACKWARD_BRANCH")).toBe(true);
  });

  it("accepts a forward branch jump and the literal target `end`", () => {
    const def = validDefinition();
    def.steps.splice(2, 0, {
      id: "check",
      type: "deterministic_condition",
      name: "Check",
      config: {},
      condition: { left: "$.steps.extract.amount", op: "gt", right: 100 },
      onTrue: "report",
      onFalse: "end",
    });
    expect(validateWorkflow(def, GRANTS)).toEqual([]);
  });

  it("rejects a condition step with no condition defined", () => {
    const def = validDefinition();
    def.steps.splice(2, 0, {
      id: "check",
      type: "deterministic_condition",
      name: "Check",
      config: {},
      onTrue: "report",
      onFalse: "end",
    });
    const issues = validateWorkflow(def, GRANTS);
    expect(issues.some((i) => i.code === "MISSING_CONDITION")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/engine/validator.test.ts`
Expected: FAIL — cannot resolve `@/lib/engine/validator`.

- [ ] **Step 3: Write the validator**

`src/lib/engine/validator.ts`:

```ts
import { REGISTRY } from "@/lib/engine/registry";
import { missingPermissions } from "@/lib/engine/permissions";
import type { Condition, StepDefinition, StepType, WorkflowDefinition } from "@/lib/types";

export interface ValidationIssue {
  stepId: string | null;
  code: string;
  message: string;
}

/** Collects every `$.steps.<id>` reference inside an arbitrary config value. */
function collectStepRefs(value: unknown, out: Set<string>): void {
  if (typeof value === "string") {
    if (value.startsWith("$.steps.")) {
      const parts = value.split(".");
      if (parts[2]) out.add(parts[2]);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectStepRefs(v, out);
    return;
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) collectStepRefs(v, out);
  }
}

function collectConditionRefs(cond: Condition | undefined, out: Set<string>): void {
  if (!cond) return;
  if ("allOf" in cond) {
    for (const c of cond.allOf) collectConditionRefs(c, out);
    return;
  }
  if ("anyOf" in cond) {
    for (const c of cond.anyOf) collectConditionRefs(c, out);
    return;
  }
  collectStepRefs(cond.left, out);
  collectStepRefs(cond.right, out);
}

export function validateWorkflow(
  def: WorkflowDefinition,
  granted: string[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const steps = def?.steps ?? [];

  if (steps.length === 0) {
    issues.push({
      stepId: null,
      code: "EMPTY_WORKFLOW",
      message: "A workflow must contain at least one step.",
    });
    return issues;
  }

  // Unique ids
  const seen = new Set<string>();
  for (const step of steps) {
    if (!step.id) {
      issues.push({
        stepId: null,
        code: "MISSING_STEP_ID",
        message: "Every step needs an id.",
      });
      continue;
    }
    if (seen.has(step.id)) {
      issues.push({
        stepId: step.id,
        code: "DUPLICATE_STEP_ID",
        message: `Step id "${step.id}" is used more than once.`,
      });
    }
    seen.add(step.id);
  }

  const indexById = new Map<string, number>();
  steps.forEach((s, i) => {
    if (s.id && !indexById.has(s.id)) indexById.set(s.id, i);
  });

  steps.forEach((step: StepDefinition, index: number) => {
    const spec = REGISTRY[step.type as StepType];

    if (!spec) {
      issues.push({
        stepId: step.id,
        code: "UNKNOWN_STEP_TYPE",
        message: `Unknown step type "${step.type}".`,
      });
      return;
    }

    // Per-type config validity
    for (const message of spec.validateConfig(step.config ?? {})) {
      issues.push({ stepId: step.id, code: "INVALID_STEP_CONFIG", message });
    }

    // Permission grants
    for (const permission of missingPermissions(step, granted)) {
      issues.push({
        stepId: step.id,
        code: "PERMISSION_NOT_GRANTED",
        message: `Step "${step.name || step.id}" requires ${permission}, which this workflow version does not grant.`,
      });
    }

    // Step references must point at an earlier step
    const refs = new Set<string>();
    collectStepRefs(step.config ?? {}, refs);
    collectConditionRefs(step.condition, refs);

    for (const ref of refs) {
      const refIndex = indexById.get(ref);
      if (refIndex === undefined) {
        issues.push({
          stepId: step.id,
          code: "UNKNOWN_SOURCE_STEP",
          message: `Step "${step.id}" references "${ref}", which does not exist.`,
        });
      } else if (refIndex >= index) {
        issues.push({
          stepId: step.id,
          code: "FORWARD_SOURCE_REFERENCE",
          message: `Step "${step.id}" references "${ref}", which does not run before it.`,
        });
      }
    }

    // Condition steps: condition present, branch targets valid and forward-only
    if (step.type === "deterministic_condition") {
      if (!step.condition) {
        issues.push({
          stepId: step.id,
          code: "MISSING_CONDITION",
          message: `Condition step "${step.id}" has no condition defined.`,
        });
      }

      for (const [branch, target] of [
        ["onTrue", step.onTrue],
        ["onFalse", step.onFalse],
      ] as const) {
        if (target === undefined || target === "end") continue;

        const targetIndex = indexById.get(target);
        if (targetIndex === undefined) {
          issues.push({
            stepId: step.id,
            code: "UNKNOWN_BRANCH_TARGET",
            message: `Branch ${branch} of "${step.id}" points at "${target}", which does not exist.`,
          });
        } else if (targetIndex <= index) {
          issues.push({
            stepId: step.id,
            code: "BACKWARD_BRANCH",
            message: `Branch ${branch} of "${step.id}" jumps backward to "${target}". Jumps must move forward so every run terminates.`,
          });
        }
      }
    }
  });

  return issues;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/engine/validator.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/engine/validator.ts src/lib/engine/validator.test.ts
git commit -m "feat: add workflow validator with forward-only branch enforcement"
```

---

## Task 8: RunStore interface and in-memory implementation

**Files:**
- Modify: `src/lib/types.ts` (append `WorkflowVersionRecord`, `ApprovalRecord`)
- Create: `src/lib/engine/store.ts`
- Create: `src/lib/engine/store.memory.ts`
- Create: `src/lib/engine/store.memory.test.ts`

**Interfaces:**
- Consumes: record types from `@/lib/types`
- Produces:
  - `WorkflowVersionRecord = { id, workflowId, version, definition: WorkflowDefinition, grantedPermissions: string[], createdAt }`
  - `ApprovalRecord = { id, stepExecutionId, decision: "APPROVED" | "REJECTED", reason, decidedAt }`
  - `RunStore` interface — the only persistence contract the engine knows
  - `MemoryRunStore` class and `createMemoryStore(seed?)` helper

- [ ] **Step 1: Append the two record types**

Append to `src/lib/types.ts`:

```ts
export interface WorkflowVersionRecord {
  id: string;
  workflowId: string;
  version: number;
  definition: WorkflowDefinition;
  grantedPermissions: string[];
  createdAt: Date;
}

export interface ApprovalRecord {
  id: string;
  stepExecutionId: string;
  decision: "APPROVED" | "REJECTED";
  reason: string | null;
  decidedAt: Date;
}
```

- [ ] **Step 2: Write the store interface**

`src/lib/engine/store.ts`:

```ts
import type {
  ApprovalRecord,
  AuditEventRecord,
  AuditEventType,
  ExternalActionRecord,
  LlmCallRecord,
  RunRecord,
  RunStatus,
  StepExecutionRecord,
  StepStatus,
  StepType,
  WorkflowVersionRecord,
} from "@/lib/types";

export interface CreateRunInput {
  workflowVersionId: string;
  input: unknown;
}

export interface CreateStepExecutionInput {
  runId: string;
  stepId: string;
  stepType: StepType;
  status: StepStatus;
  attempt: number;
  retrySafe: boolean;
  input: unknown;
}

export interface UpdateStepExecutionInput {
  status?: StepStatus;
  output?: unknown;
  explanation?: unknown;
  error?: string | null;
  finishedAt?: Date | null;
}

export interface UpdateRunInput {
  status?: RunStatus;
  cursor?: string | null;
  error?: string | null;
}

export interface AppendAuditInput {
  runId: string;
  stepExecutionId?: string | null;
  type: AuditEventType;
  payload: unknown;
}

export interface RecordLlmCallInput {
  runId: string;
  stepExecutionId?: string | null;
  provider: string;
  model: string;
  prompt: string;
  response: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
  status: "SUCCESS" | "ERROR";
  error: string | null;
}

export interface InsertExternalActionInput {
  idempotencyKey: string;
  runId: string;
  stepId: string;
  request: unknown;
  response: unknown;
}

export interface InsertExternalActionResult {
  /** False when the key already existed — a duplicate write was prevented. */
  created: boolean;
  record: ExternalActionRecord;
}

/**
 * Everything the engine needs from persistence. The engine depends on this
 * interface only — never on Prisma — so the entire engine test suite runs
 * against MemoryRunStore with no database.
 */
export interface RunStore {
  getWorkflowVersion(id: string): Promise<WorkflowVersionRecord | null>;

  createRun(input: CreateRunInput): Promise<RunRecord>;
  getRun(runId: string): Promise<RunRecord | null>;
  updateRun(runId: string, patch: UpdateRunInput): Promise<RunRecord>;

  /** Conditional acquire. Returns false when another worker holds the lock. */
  acquireLock(runId: string, token: string, until: Date): Promise<boolean>;
  releaseLock(runId: string, token: string): Promise<void>;

  listStepExecutions(runId: string): Promise<StepExecutionRecord[]>;
  createStepExecution(input: CreateStepExecutionInput): Promise<StepExecutionRecord>;
  updateStepExecution(
    id: string,
    patch: UpdateStepExecutionInput,
  ): Promise<StepExecutionRecord>;

  createApproval(
    stepExecutionId: string,
    decision: "APPROVED" | "REJECTED",
    reason: string | null,
  ): Promise<ApprovalRecord>;
  getApproval(stepExecutionId: string): Promise<ApprovalRecord | null>;

  appendAudit(input: AppendAuditInput): Promise<AuditEventRecord>;
  listAudit(runId: string): Promise<AuditEventRecord[]>;

  recordLlmCall(input: RecordLlmCallInput): Promise<LlmCallRecord>;
  countLlmCalls(runId: string): Promise<number>;
  listLlmCalls(runId: string): Promise<LlmCallRecord[]>;

  /** Insert-if-absent on idempotencyKey. Never overwrites an existing row. */
  insertExternalAction(
    input: InsertExternalActionInput,
  ): Promise<InsertExternalActionResult>;
}
```

- [ ] **Step 3: Write the failing test**

`src/lib/engine/store.memory.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createMemoryStore } from "@/lib/engine/store.memory";
import type { WorkflowVersionRecord } from "@/lib/types";

const version: WorkflowVersionRecord = {
  id: "wv1",
  workflowId: "w1",
  version: 1,
  definition: { steps: [] },
  grantedPermissions: ["tool:llm"],
  createdAt: new Date("2026-01-01"),
};

describe("MemoryRunStore", () => {
  it("returns a seeded workflow version and null for a missing one", async () => {
    const store = createMemoryStore({ versions: [version] });
    expect((await store.getWorkflowVersion("wv1"))?.version).toBe(1);
    expect(await store.getWorkflowVersion("missing")).toBeNull();
  });

  it("creates a run in PENDING with no cursor", async () => {
    const store = createMemoryStore({ versions: [version] });
    const run = await store.createRun({ workflowVersionId: "wv1", input: { a: 1 } });
    expect(run.status).toBe("PENDING");
    expect(run.cursor).toBeNull();
    expect(await store.getRun(run.id)).not.toBeNull();
  });

  it("grants the lock once and refuses a second holder", async () => {
    const store = createMemoryStore({ versions: [version] });
    const run = await store.createRun({ workflowVersionId: "wv1", input: {} });
    const until = new Date(Date.now() + 60_000);
    expect(await store.acquireLock(run.id, "token-a", until)).toBe(true);
    expect(await store.acquireLock(run.id, "token-b", until)).toBe(false);
  });

  it("allows re-acquisition after the lock expires", async () => {
    const store = createMemoryStore({ versions: [version] });
    const run = await store.createRun({ workflowVersionId: "wv1", input: {} });
    await store.acquireLock(run.id, "token-a", new Date(Date.now() - 1000));
    expect(
      await store.acquireLock(run.id, "token-b", new Date(Date.now() + 60_000)),
    ).toBe(true);
  });

  it("only releases the lock for the token that holds it", async () => {
    const store = createMemoryStore({ versions: [version] });
    const run = await store.createRun({ workflowVersionId: "wv1", input: {} });
    await store.acquireLock(run.id, "token-a", new Date(Date.now() + 60_000));
    await store.releaseLock(run.id, "token-b");
    expect(
      await store.acquireLock(run.id, "token-c", new Date(Date.now() + 60_000)),
    ).toBe(false);
    await store.releaseLock(run.id, "token-a");
    expect(
      await store.acquireLock(run.id, "token-c", new Date(Date.now() + 60_000)),
    ).toBe(true);
  });

  it("records step executions and returns them in creation order", async () => {
    const store = createMemoryStore({ versions: [version] });
    const run = await store.createRun({ workflowVersionId: "wv1", input: {} });
    await store.createStepExecution({
      runId: run.id,
      stepId: "a",
      stepType: "structured_input",
      status: "RUNNING",
      attempt: 1,
      retrySafe: true,
      input: {},
    });
    const second = await store.createStepExecution({
      runId: run.id,
      stepId: "b",
      stepType: "final_report",
      status: "RUNNING",
      attempt: 1,
      retrySafe: true,
      input: {},
    });
    await store.updateStepExecution(second.id, {
      status: "SUCCEEDED",
      output: { ok: 1 },
    });

    const all = await store.listStepExecutions(run.id);
    expect(all.map((s) => s.stepId)).toEqual(["a", "b"]);
    expect(all[1].status).toBe("SUCCEEDED");
    expect(all[1].output).toEqual({ ok: 1 });
  });

  it("appends audit events in order", async () => {
    const store = createMemoryStore({ versions: [version] });
    const run = await store.createRun({ workflowVersionId: "wv1", input: {} });
    await store.appendAudit({ runId: run.id, type: "RUN_CREATED", payload: {} });
    await store.appendAudit({
      runId: run.id,
      type: "STEP_STARTED",
      payload: { stepId: "a" },
    });
    const events = await store.listAudit(run.id);
    expect(events.map((e) => e.type)).toEqual(["RUN_CREATED", "STEP_STARTED"]);
  });

  it("counts LLM calls per run", async () => {
    const store = createMemoryStore({ versions: [version] });
    const run = await store.createRun({ workflowVersionId: "wv1", input: {} });
    expect(await store.countLlmCalls(run.id)).toBe(0);
    await store.recordLlmCall({
      runId: run.id,
      provider: "mock",
      model: "mock-1",
      prompt: "p",
      response: "r",
      inputTokens: 1,
      outputTokens: 1,
      latencyMs: 5,
      status: "SUCCESS",
      error: null,
    });
    expect(await store.countLlmCalls(run.id)).toBe(1);
  });

  it("inserts an external action once and reports duplicates without overwriting", async () => {
    const store = createMemoryStore({ versions: [version] });
    const run = await store.createRun({ workflowVersionId: "wv1", input: {} });

    const first = await store.insertExternalAction({
      idempotencyKey: "key-1",
      runId: run.id,
      stepId: "post",
      request: { amount: 10 },
      response: { ref: "EXT-1" },
    });
    expect(first.created).toBe(true);

    const second = await store.insertExternalAction({
      idempotencyKey: "key-1",
      runId: run.id,
      stepId: "post",
      request: { amount: 999 },
      response: { ref: "EXT-2" },
    });
    expect(second.created).toBe(false);
    expect(second.record.response).toEqual({ ref: "EXT-1" });
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run src/lib/engine/store.memory.test.ts`
Expected: FAIL — cannot resolve `@/lib/engine/store.memory`.

- [ ] **Step 5: Write the in-memory implementation**

`src/lib/engine/store.memory.ts`:

```ts
import { NotFoundError } from "@/lib/errors";
import type {
  AppendAuditInput,
  CreateRunInput,
  CreateStepExecutionInput,
  InsertExternalActionInput,
  InsertExternalActionResult,
  RecordLlmCallInput,
  RunStore,
  UpdateRunInput,
  UpdateStepExecutionInput,
} from "@/lib/engine/store";
import type {
  ApprovalRecord,
  AuditEventRecord,
  ExternalActionRecord,
  LlmCallRecord,
  RunRecord,
  StepExecutionRecord,
  WorkflowVersionRecord,
} from "@/lib/types";

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}_${counter}`;
}

export interface MemorySeed {
  versions?: WorkflowVersionRecord[];
}

export class MemoryRunStore implements RunStore {
  private versions = new Map<string, WorkflowVersionRecord>();
  private runs = new Map<string, RunRecord>();
  private steps: StepExecutionRecord[] = [];
  private approvals = new Map<string, ApprovalRecord>();
  private audit: AuditEventRecord[] = [];
  private llmCalls: LlmCallRecord[] = [];
  private externalActions = new Map<string, ExternalActionRecord>();

  constructor(seed: MemorySeed = {}) {
    for (const v of seed.versions ?? []) this.versions.set(v.id, v);
  }

  async getWorkflowVersion(id: string): Promise<WorkflowVersionRecord | null> {
    return this.versions.get(id) ?? null;
  }

  async createRun(input: CreateRunInput): Promise<RunRecord> {
    const now = new Date();
    const run: RunRecord = {
      id: nextId("run"),
      workflowVersionId: input.workflowVersionId,
      status: "PENDING",
      input: input.input,
      cursor: null,
      lockToken: null,
      lockedUntil: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    this.runs.set(run.id, run);
    return { ...run };
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    const run = this.runs.get(runId);
    return run ? { ...run } : null;
  }

  async updateRun(runId: string, patch: UpdateRunInput): Promise<RunRecord> {
    const run = this.runs.get(runId);
    if (!run) throw new NotFoundError(`Run ${runId}`);
    if (patch.status !== undefined) run.status = patch.status;
    if (patch.cursor !== undefined) run.cursor = patch.cursor;
    if (patch.error !== undefined) run.error = patch.error;
    run.updatedAt = new Date();
    return { ...run };
  }

  async acquireLock(runId: string, token: string, until: Date): Promise<boolean> {
    const run = this.runs.get(runId);
    if (!run) throw new NotFoundError(`Run ${runId}`);
    const held =
      run.lockToken !== null &&
      run.lockedUntil !== null &&
      run.lockedUntil.getTime() > Date.now();
    if (held) return false;
    run.lockToken = token;
    run.lockedUntil = until;
    return true;
  }

  async releaseLock(runId: string, token: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;
    if (run.lockToken !== token) return;
    run.lockToken = null;
    run.lockedUntil = null;
  }

  async listStepExecutions(runId: string): Promise<StepExecutionRecord[]> {
    return this.steps.filter((s) => s.runId === runId).map((s) => ({ ...s }));
  }

  async createStepExecution(
    input: CreateStepExecutionInput,
  ): Promise<StepExecutionRecord> {
    const record: StepExecutionRecord = {
      id: nextId("step"),
      runId: input.runId,
      stepId: input.stepId,
      stepType: input.stepType,
      status: input.status,
      attempt: input.attempt,
      retrySafe: input.retrySafe,
      input: input.input,
      output: null,
      explanation: null,
      error: null,
      startedAt: new Date(),
      finishedAt: null,
    };
    this.steps.push(record);
    return { ...record };
  }

  async updateStepExecution(
    id: string,
    patch: UpdateStepExecutionInput,
  ): Promise<StepExecutionRecord> {
    const record = this.steps.find((s) => s.id === id);
    if (!record) throw new NotFoundError(`StepExecution ${id}`);
    if (patch.status !== undefined) record.status = patch.status;
    if (patch.output !== undefined) record.output = patch.output;
    if (patch.explanation !== undefined) record.explanation = patch.explanation;
    if (patch.error !== undefined) record.error = patch.error;
    if (patch.finishedAt !== undefined) record.finishedAt = patch.finishedAt;
    return { ...record };
  }

  async createApproval(
    stepExecutionId: string,
    decision: "APPROVED" | "REJECTED",
    reason: string | null,
  ): Promise<ApprovalRecord> {
    const record: ApprovalRecord = {
      id: nextId("appr"),
      stepExecutionId,
      decision,
      reason,
      decidedAt: new Date(),
    };
    this.approvals.set(stepExecutionId, record);
    return { ...record };
  }

  async getApproval(stepExecutionId: string): Promise<ApprovalRecord | null> {
    return this.approvals.get(stepExecutionId) ?? null;
  }

  async appendAudit(input: AppendAuditInput): Promise<AuditEventRecord> {
    const record: AuditEventRecord = {
      id: nextId("evt"),
      runId: input.runId,
      stepExecutionId: input.stepExecutionId ?? null,
      type: input.type,
      payload: input.payload,
      createdAt: new Date(),
    };
    this.audit.push(record);
    return { ...record };
  }

  async listAudit(runId: string): Promise<AuditEventRecord[]> {
    return this.audit.filter((e) => e.runId === runId).map((e) => ({ ...e }));
  }

  async recordLlmCall(input: RecordLlmCallInput): Promise<LlmCallRecord> {
    const record: LlmCallRecord = {
      id: nextId("llm"),
      runId: input.runId,
      stepExecutionId: input.stepExecutionId ?? null,
      provider: input.provider,
      model: input.model,
      prompt: input.prompt,
      response: input.response,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      latencyMs: input.latencyMs,
      status: input.status,
      error: input.error,
      createdAt: new Date(),
    };
    this.llmCalls.push(record);
    return { ...record };
  }

  async countLlmCalls(runId: string): Promise<number> {
    return this.llmCalls.filter((c) => c.runId === runId).length;
  }

  async listLlmCalls(runId: string): Promise<LlmCallRecord[]> {
    return this.llmCalls.filter((c) => c.runId === runId).map((c) => ({ ...c }));
  }

  async insertExternalAction(
    input: InsertExternalActionInput,
  ): Promise<InsertExternalActionResult> {
    const existing = this.externalActions.get(input.idempotencyKey);
    if (existing) return { created: false, record: { ...existing } };

    const record: ExternalActionRecord = {
      id: nextId("ext"),
      idempotencyKey: input.idempotencyKey,
      runId: input.runId,
      stepId: input.stepId,
      request: input.request,
      response: input.response,
      createdAt: new Date(),
    };
    this.externalActions.set(input.idempotencyKey, record);
    return { created: true, record: { ...record } };
  }
}

export function createMemoryStore(seed: MemorySeed = {}): MemoryRunStore {
  return new MemoryRunStore(seed);
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run src/lib/engine/store.memory.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 7: Commit**

```bash
git add src/lib/types.ts src/lib/engine/store.ts src/lib/engine/store.memory.ts src/lib/engine/store.memory.test.ts
git commit -m "feat: add RunStore interface and in-memory implementation"
```

---

## Task 9: LLM provider interface, mock provider, and fallback chain

**Files:**
- Create: `src/lib/llm/types.ts`
- Create: `src/lib/llm/mock.ts`
- Create: `src/lib/llm/index.ts`
- Create: `src/lib/llm/index.test.ts`

**Interfaces:**
- Consumes: `RunStore` from `@/lib/engine/store`, `JsonShape` from `@/lib/engine/registry`, errors from `@/lib/errors`
- Produces:
  - `LlmRequest = { system: string; user: string; schema: JsonShape; maxTokens?: number }`
  - `LlmResponse<T> = { data: T; raw: string; inputTokens: number; outputTokens: number }`
  - `LlmProvider = { name: string; model: string; complete<T>(req): Promise<LlmResponse<T>> }`
  - `MockLlmProvider` with `setFixture(key, value)`, `setDefault(value)`, `failWith(error)`, `recordedCalls()`
  - `callLlm<T>(deps, req): Promise<T>` — `deps = { store, runId, stepExecutionId, providers, maxCalls }`

- [ ] **Step 1: Write the provider types**

`src/lib/llm/types.ts`:

```ts
import type { JsonShape } from "@/lib/engine/registry";

export interface LlmRequest {
  system: string;
  user: string;
  /** Field shape the provider must return. */
  schema: JsonShape;
  maxTokens?: number;
}

export interface LlmResponse<T = unknown> {
  data: T;
  raw: string;
  inputTokens: number;
  outputTokens: number;
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  complete<T = unknown>(req: LlmRequest): Promise<LlmResponse<T>>;
}
```

- [ ] **Step 2: Write the failing test**

`src/lib/llm/index.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createMemoryStore } from "@/lib/engine/store.memory";
import { MockLlmProvider } from "@/lib/llm/mock";
import { callLlm } from "@/lib/llm";
import { ProviderError, RateLimitError } from "@/lib/errors";
import type { WorkflowVersionRecord } from "@/lib/types";

const version: WorkflowVersionRecord = {
  id: "wv1",
  workflowId: "w1",
  version: 1,
  definition: { steps: [] },
  grantedPermissions: [],
  createdAt: new Date(),
};

async function setup() {
  const store = createMemoryStore({ versions: [version] });
  const run = await store.createRun({ workflowVersionId: "wv1", input: {} });
  return { store, runId: run.id };
}

const REQ = {
  system: "extract",
  user: "invoice text",
  schema: { amount: "number" as const },
};

describe("callLlm", () => {
  it("returns the primary provider's data and logs the call", async () => {
    const { store, runId } = await setup();
    const primary = new MockLlmProvider("gemini");
    primary.setDefault({ amount: 5200 });

    const data = await callLlm<{ amount: number }>(
      { store, runId, stepExecutionId: null, providers: [primary], maxCalls: 10 },
      REQ,
    );

    expect(data.amount).toBe(5200);
    const calls = await store.listLlmCalls(runId);
    expect(calls).toHaveLength(1);
    expect(calls[0].provider).toBe("gemini");
    expect(calls[0].status).toBe("SUCCESS");
  });

  it("falls back to the secondary provider when the primary is rate limited", async () => {
    const { store, runId } = await setup();
    const primary = new MockLlmProvider("gemini");
    primary.failWith(new RateLimitError("gemini"));
    const fallback = new MockLlmProvider("openrouter");
    fallback.setDefault({ amount: 42 });

    const data = await callLlm<{ amount: number }>(
      {
        store,
        runId,
        stepExecutionId: null,
        providers: [primary, fallback],
        maxCalls: 10,
      },
      REQ,
    );

    expect(data.amount).toBe(42);
    const calls = await store.listLlmCalls(runId);
    expect(calls).toHaveLength(2);
    expect(calls[0].provider).toBe("gemini");
    expect(calls[0].status).toBe("ERROR");
    expect(calls[1].provider).toBe("openrouter");
    expect(calls[1].status).toBe("SUCCESS");
  });

  it("falls back on a provider error as well as a rate limit", async () => {
    const { store, runId } = await setup();
    const primary = new MockLlmProvider("gemini");
    primary.failWith(new ProviderError("gemini", "502 bad gateway"));
    const fallback = new MockLlmProvider("openrouter");
    fallback.setDefault({ amount: 7 });

    const data = await callLlm<{ amount: number }>(
      {
        store,
        runId,
        stepExecutionId: null,
        providers: [primary, fallback],
        maxCalls: 10,
      },
      REQ,
    );
    expect(data.amount).toBe(7);
  });

  it("throws the last error when every provider fails", async () => {
    const { store, runId } = await setup();
    const primary = new MockLlmProvider("gemini");
    primary.failWith(new RateLimitError("gemini"));
    const fallback = new MockLlmProvider("openrouter");
    fallback.failWith(new RateLimitError("openrouter"));

    await expect(
      callLlm(
        {
          store,
          runId,
          stepExecutionId: null,
          providers: [primary, fallback],
          maxCalls: 10,
        },
        REQ,
      ),
    ).rejects.toBeInstanceOf(RateLimitError);

    const calls = await store.listLlmCalls(runId);
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.status === "ERROR")).toBe(true);
  });

  it("refuses to exceed the per-run call budget", async () => {
    const { store, runId } = await setup();
    const provider = new MockLlmProvider("gemini");
    provider.setDefault({ amount: 1 });

    await callLlm(
      { store, runId, stepExecutionId: null, providers: [provider], maxCalls: 1 },
      REQ,
    );

    await expect(
      callLlm(
        { store, runId, stepExecutionId: null, providers: [provider], maxCalls: 1 },
        REQ,
      ),
    ).rejects.toThrow(/budget/i);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/lib/llm/index.test.ts`
Expected: FAIL — cannot resolve `@/lib/llm/mock`.

- [ ] **Step 4: Write the mock provider**

`src/lib/llm/mock.ts`:

```ts
import type { LlmProvider, LlmRequest, LlmResponse } from "@/lib/llm/types";

/**
 * Deterministic provider for tests and offline demos. Fixtures are keyed by
 * `system::user`; anything unmatched falls back to the default value.
 */
export class MockLlmProvider implements LlmProvider {
  readonly name: string;
  readonly model = "mock-1";

  private fixtures = new Map<string, unknown>();
  private defaultValue: unknown = {};
  private error: Error | null = null;
  private calls: LlmRequest[] = [];

  constructor(name = "mock") {
    this.name = name;
  }

  setFixture(key: string, value: unknown): this {
    this.fixtures.set(key, value);
    return this;
  }

  setDefault(value: unknown): this {
    this.defaultValue = value;
    return this;
  }

  failWith(error: Error): this {
    this.error = error;
    return this;
  }

  recordedCalls(): LlmRequest[] {
    return [...this.calls];
  }

  async complete<T = unknown>(req: LlmRequest): Promise<LlmResponse<T>> {
    this.calls.push(req);
    if (this.error) throw this.error;

    const key = `${req.system}::${req.user}`;
    const data = (this.fixtures.get(key) ?? this.defaultValue) as T;
    const raw = JSON.stringify(data);

    return {
      data,
      raw,
      inputTokens: req.user.length,
      outputTokens: raw.length,
    };
  }
}
```

- [ ] **Step 5: Write the fallback chain**

`src/lib/llm/index.ts`:

```ts
import { StepExecutionError, toErrorMessage } from "@/lib/errors";
import type { RunStore } from "@/lib/engine/store";
import type { LlmProvider, LlmRequest } from "@/lib/llm/types";

export type { LlmProvider, LlmRequest, LlmResponse } from "@/lib/llm/types";
export { MockLlmProvider } from "@/lib/llm/mock";

export interface CallLlmDeps {
  store: RunStore;
  runId: string;
  stepExecutionId: string | null;
  /** Tried in order; the first success wins. */
  providers: LlmProvider[];
  maxCalls: number;
}

/**
 * Calls the first provider that succeeds, logging every attempt — successful
 * or not — as an LlmCall row. Enforces the per-run call budget before trying.
 */
export async function callLlm<T = unknown>(
  deps: CallLlmDeps,
  req: LlmRequest,
): Promise<T> {
  const used = await deps.store.countLlmCalls(deps.runId);
  if (used >= deps.maxCalls) {
    throw new StepExecutionError(
      `AI call budget exhausted for this run (limit ${deps.maxCalls} calls).`,
      false,
      { used, maxCalls: deps.maxCalls },
    );
  }

  if (deps.providers.length === 0) {
    throw new StepExecutionError("No LLM provider configured.", false);
  }

  let lastError: unknown;

  for (const provider of deps.providers) {
    const startedAt = Date.now();
    try {
      const result = await provider.complete<T>(req);
      await deps.store.recordLlmCall({
        runId: deps.runId,
        stepExecutionId: deps.stepExecutionId,
        provider: provider.name,
        model: provider.model,
        prompt: `${req.system}\n---\n${req.user}`,
        response: result.raw,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        latencyMs: Date.now() - startedAt,
        status: "SUCCESS",
        error: null,
      });
      return result.data;
    } catch (e) {
      lastError = e;
      await deps.store.recordLlmCall({
        runId: deps.runId,
        stepExecutionId: deps.stepExecutionId,
        provider: provider.name,
        model: provider.model,
        prompt: `${req.system}\n---\n${req.user}`,
        response: null,
        inputTokens: null,
        outputTokens: null,
        latencyMs: Date.now() - startedAt,
        status: "ERROR",
        error: toErrorMessage(e),
      });
    }
  }

  throw lastError;
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run src/lib/llm/index.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 7: Commit**

```bash
git add src/lib/llm
git commit -m "feat: add LLM provider interface, mock provider, and fallback chain"
```

---

## Task 10: Step handlers

**Files:**
- Create: `src/seed/corpus.ts`
- Create: `src/lib/steps/index.ts`
- Create: `src/lib/steps/handlers.test.ts`

**Interfaces:**
- Consumes: `ExecutionContext`, `resolvePath`, `evaluateCondition`, `callLlm`, `RunStore`
- Produces:
  - `StepHandlerDeps = { store; runId; stepExecutionId; providers; maxLlmCalls; ctx; now(): Date }`
  - `StepHandlerResult = { output: unknown; explanation?: unknown; nextStepId?: string | "end" }`
  - `StepHandler = (step: StepDefinition, deps: StepHandlerDeps) => Promise<StepHandlerResult>`
  - `HANDLERS: Record<StepType, StepHandler>`
  - `buildIdempotencyKey(runId, stepId, action, payload): string`

Note: `human_approval` has no handler — the runner intercepts it before dispatch, because it
must suspend rather than produce a result.

- [ ] **Step 1: Write the document corpus**

`src/seed/corpus.ts`:

```ts
export interface CorpusDocument {
  id: string;
  title: string;
  body: string;
  tags: string[];
}

export const CORPUS: CorpusDocument[] = [
  {
    id: "policy-approval-thresholds",
    title: "Invoice Approval Thresholds",
    body: "Invoices at or below 5000 USD are auto-approved. Invoices above 5000 USD require manager approval before payment. Invoices above 50000 USD require director approval.",
    tags: ["policy", "approval", "threshold"],
  },
  {
    id: "policy-vendor-onboarding",
    title: "Vendor Onboarding Requirements",
    body: "New vendors must supply a tax identification number and banking details before their first invoice is paid. Vendors flagged as high risk require a compliance review.",
    tags: ["policy", "vendor", "onboarding"],
  },
  {
    id: "policy-payment-terms",
    title: "Standard Payment Terms",
    body: "Default payment terms are net 30 from invoice receipt. Early payment discounts of 2 percent apply when settled within 10 days.",
    tags: ["policy", "payment", "terms"],
  },
  {
    id: "vendor-acme-profile",
    title: "Vendor Profile: Acme Supplies",
    body: "Acme Supplies has been an approved vendor since 2021. Risk rating: low. Standard terms net 30. Contact: accounts@acme.example.",
    tags: ["vendor", "acme", "profile"],
  },
  {
    id: "vendor-globex-profile",
    title: "Vendor Profile: Globex Industrial",
    body: "Globex Industrial was onboarded in 2026 and is currently under enhanced monitoring. Risk rating: high. All invoices require manual review regardless of amount.",
    tags: ["vendor", "globex", "profile", "high-risk"],
  },
];

/** Simple term-overlap scoring. Deterministic, no external service. */
export function searchCorpus(query: string, topK = 3): CorpusDocument[] {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2);

  if (terms.length === 0) return [];

  const scored = CORPUS.map((doc) => {
    const haystack = `${doc.title} ${doc.body} ${doc.tags.join(" ")}`.toLowerCase();
    const score = terms.reduce(
      (acc, term) => acc + (haystack.includes(term) ? 1 : 0),
      0,
    );
    return { doc, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.doc.id.localeCompare(b.doc.id))
    .slice(0, topK)
    .map((s) => s.doc);
}
```

- [ ] **Step 2: Write the failing test**

`src/lib/steps/handlers.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { HANDLERS, buildIdempotencyKey } from "@/lib/steps";
import { createMemoryStore } from "@/lib/engine/store.memory";
import { MockLlmProvider } from "@/lib/llm/mock";
import type { StepDefinition, WorkflowVersionRecord } from "@/lib/types";
import type { StepHandlerDeps } from "@/lib/steps";

const version: WorkflowVersionRecord = {
  id: "wv1",
  workflowId: "w1",
  version: 1,
  definition: { steps: [] },
  grantedPermissions: [],
  createdAt: new Date(),
};

async function makeDeps(
  ctxOverrides: Partial<StepHandlerDeps["ctx"]> = {},
  provider = new MockLlmProvider("gemini"),
): Promise<StepHandlerDeps> {
  const store = createMemoryStore({ versions: [version] });
  const run = await store.createRun({ workflowVersionId: "wv1", input: {} });
  return {
    store,
    runId: run.id,
    stepExecutionId: null,
    providers: [provider],
    maxLlmCalls: 20,
    ctx: { input: {}, steps: {}, ...ctxOverrides },
    now: () => new Date("2026-07-29T00:00:00Z"),
  };
}

describe("structured_input handler", () => {
  it("returns the declared fields from the run input", async () => {
    const deps = await makeDeps({ input: { invoiceId: "INV-1", amount: 100 } });
    const step: StepDefinition = {
      id: "intake",
      type: "structured_input",
      name: "Intake",
      config: {
        fields: [
          { name: "invoiceId", kind: "string" },
          { name: "amount", kind: "number" },
        ],
      },
    };
    const result = await HANDLERS.structured_input(step, deps);
    expect(result.output).toEqual({ invoiceId: "INV-1", amount: 100 });
  });

  it("rejects input missing a declared field", async () => {
    const deps = await makeDeps({ input: { invoiceId: "INV-1" } });
    const step: StepDefinition = {
      id: "intake",
      type: "structured_input",
      name: "Intake",
      config: { fields: [{ name: "amount", kind: "number" }] },
    };
    await expect(HANDLERS.structured_input(step, deps)).rejects.toThrow(/amount/);
  });

  it("rejects input where a declared field has the wrong type", async () => {
    const deps = await makeDeps({ input: { amount: "not-a-number" } });
    const step: StepDefinition = {
      id: "intake",
      type: "structured_input",
      name: "Intake",
      config: { fields: [{ name: "amount", kind: "number" }] },
    };
    await expect(HANDLERS.structured_input(step, deps)).rejects.toThrow(/number/);
  });
});

describe("document_retrieval handler", () => {
  it("returns matching documents and a count", async () => {
    const deps = await makeDeps();
    const step: StepDefinition = {
      id: "retrieve",
      type: "document_retrieval",
      name: "Retrieve",
      config: { query: "invoice approval threshold", topK: 2 },
    };
    const result = await HANDLERS.document_retrieval(step, deps);
    const output = result.output as { documents: unknown[]; matchCount: number };
    expect(output.matchCount).toBeGreaterThan(0);
    expect(output.documents.length).toBeLessThanOrEqual(2);
  });

  it("resolves a query containing a context path", async () => {
    const deps = await makeDeps({ steps: { intake: { vendor: "Globex" } } });
    const step: StepDefinition = {
      id: "retrieve",
      type: "document_retrieval",
      name: "Retrieve",
      config: { query: "$.steps.intake.vendor", topK: 3 },
    };
    const result = await HANDLERS.document_retrieval(step, deps);
    const output = result.output as { documents: { id: string }[] };
    expect(output.documents.some((d) => d.id === "vendor-globex-profile")).toBe(true);
  });
});

describe("ai_extraction handler", () => {
  it("returns the fields the model produced", async () => {
    const provider = new MockLlmProvider("gemini").setDefault({
      amount: 5200,
      vendor: "Acme",
    });
    const deps = await makeDeps({ steps: { intake: { raw: "invoice body" } } }, provider);
    const step: StepDefinition = {
      id: "extract",
      type: "ai_extraction",
      name: "Extract",
      config: {
        source: "$.steps.intake.raw",
        fields: [
          { name: "amount", kind: "number" },
          { name: "vendor", kind: "string" },
        ],
      },
    };
    const result = await HANDLERS.ai_extraction(step, deps);
    expect(result.output).toEqual({ amount: 5200, vendor: "Acme" });
  });

  it("fails when the model omits a declared field", async () => {
    const provider = new MockLlmProvider("gemini").setDefault({ vendor: "Acme" });
    const deps = await makeDeps({ steps: { intake: { raw: "x" } } }, provider);
    const step: StepDefinition = {
      id: "extract",
      type: "ai_extraction",
      name: "Extract",
      config: {
        source: "$.steps.intake.raw",
        fields: [{ name: "amount", kind: "number" }],
      },
    };
    await expect(HANDLERS.ai_extraction(step, deps)).rejects.toThrow(/amount/);
  });
});

describe("ai_classification handler", () => {
  it("returns the label, confidence, and rationale", async () => {
    const provider = new MockLlmProvider("gemini").setDefault({
      label: "high_risk",
      confidence: 0.91,
      rationale: "Vendor is under enhanced monitoring.",
    });
    const deps = await makeDeps({ steps: { extract: { vendor: "Globex" } } }, provider);
    const step: StepDefinition = {
      id: "classify",
      type: "ai_classification",
      name: "Classify",
      config: { source: "$.steps.extract", labels: ["low_risk", "high_risk"] },
    };
    const result = await HANDLERS.ai_classification(step, deps);
    const output = result.output as { label: string; confidence: number };
    expect(output.label).toBe("high_risk");
    expect(output.confidence).toBeCloseTo(0.91);
  });

  it("fails when the model returns a label outside the declared set", async () => {
    const provider = new MockLlmProvider("gemini").setDefault({
      label: "catastrophic",
      confidence: 1,
      rationale: "made up",
    });
    const deps = await makeDeps({ steps: { extract: {} } }, provider);
    const step: StepDefinition = {
      id: "classify",
      type: "ai_classification",
      name: "Classify",
      config: { source: "$.steps.extract", labels: ["low_risk", "high_risk"] },
    };
    await expect(HANDLERS.ai_classification(step, deps)).rejects.toThrow(/catastrophic/);
  });
});

describe("deterministic_condition handler", () => {
  it("records the branch taken and why", async () => {
    const deps = await makeDeps({ steps: { extract: { amount: 5200 } } });
    const step: StepDefinition = {
      id: "check",
      type: "deterministic_condition",
      name: "Over threshold?",
      config: {},
      condition: { left: "$.steps.extract.amount", op: "gt", right: 5000 },
      onTrue: "approve",
      onFalse: "report",
    };
    const result = await HANDLERS.deterministic_condition(step, deps);
    const output = result.output as { result: boolean; branchTaken: string };
    expect(output.result).toBe(true);
    expect(output.branchTaken).toBe("approve");
    expect(result.nextStepId).toBe("approve");

    const explanation = result.explanation as {
      description: string;
      resolvedInputs: Record<string, unknown>;
    };
    expect(explanation.description).toBe("amount (5200) > 5000");
    expect(explanation.resolvedInputs["$.steps.extract.amount"]).toBe(5200);
  });

  it("takes the false branch when the comparator does not hold", async () => {
    const deps = await makeDeps({ steps: { extract: { amount: 10 } } });
    const step: StepDefinition = {
      id: "check",
      type: "deterministic_condition",
      name: "Over threshold?",
      config: {},
      condition: { left: "$.steps.extract.amount", op: "gt", right: 5000 },
      onTrue: "approve",
      onFalse: "report",
    };
    const result = await HANDLERS.deterministic_condition(step, deps);
    expect(result.nextStepId).toBe("report");
  });
});

describe("mock_external_action handler", () => {
  it("performs the write once and reports it as not duplicated", async () => {
    const deps = await makeDeps({ steps: { extract: { amount: 100 } } });
    const step: StepDefinition = {
      id: "post",
      type: "mock_external_action",
      name: "Post",
      config: { action: "post_invoice", payload: { amount: "$.steps.extract.amount" } },
    };
    const result = await HANDLERS.mock_external_action(step, deps);
    const output = result.output as { duplicatePrevented: boolean; status: string };
    expect(output.duplicatePrevented).toBe(false);
    expect(output.status).toBe("SUBMITTED");
  });

  it("returns the original response and flags a duplicate on a second call", async () => {
    const deps = await makeDeps({ steps: { extract: { amount: 100 } } });
    const step: StepDefinition = {
      id: "post",
      type: "mock_external_action",
      name: "Post",
      config: { action: "post_invoice", payload: { amount: "$.steps.extract.amount" } },
    };
    const first = await HANDLERS.mock_external_action(step, deps);
    const second = await HANDLERS.mock_external_action(step, deps);

    const a = first.output as { actionId: string; duplicatePrevented: boolean };
    const b = second.output as { actionId: string; duplicatePrevented: boolean };

    expect(b.duplicatePrevented).toBe(true);
    expect(b.actionId).toBe(a.actionId);
  });
});

describe("final_report handler", () => {
  it("assembles sections from prior step outputs", async () => {
    const deps = await makeDeps({
      steps: { extract: { amount: 5200 }, classify: { label: "high_risk" } },
    });
    const step: StepDefinition = {
      id: "report",
      type: "final_report",
      name: "Report",
      config: { title: "Invoice Review", summarize: false },
    };
    const result = await HANDLERS.final_report(step, deps);
    const output = result.output as { title: string; sections: { stepId: string }[] };
    expect(output.title).toBe("Invoice Review");
    expect(output.sections.map((s) => s.stepId)).toEqual(["extract", "classify"]);
  });
});

describe("buildIdempotencyKey", () => {
  it("is stable for the same inputs and differs for different payloads", () => {
    const a = buildIdempotencyKey("run1", "post", "post_invoice", { amount: 1 });
    const b = buildIdempotencyKey("run1", "post", "post_invoice", { amount: 1 });
    const c = buildIdempotencyKey("run1", "post", "post_invoice", { amount: 2 });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("ignores key order within the payload", () => {
    const a = buildIdempotencyKey("run1", "post", "act", { x: 1, y: 2 });
    const b = buildIdempotencyKey("run1", "post", "act", { y: 2, x: 1 });
    expect(a).toBe(b);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/lib/steps/handlers.test.ts`
Expected: FAIL — cannot resolve `@/lib/steps`.

- [ ] **Step 4: Write the handlers**

`src/lib/steps/index.ts`:

```ts
import { createHash } from "node:crypto";
import { evaluateCondition, resolvePath } from "@/lib/engine/expression";
import type { ExecutionContext } from "@/lib/engine/context";
import type { FieldKind, JsonShape } from "@/lib/engine/registry";
import type { RunStore } from "@/lib/engine/store";
import { StepExecutionError } from "@/lib/errors";
import { callLlm } from "@/lib/llm";
import type { LlmProvider } from "@/lib/llm/types";
import { searchCorpus } from "@/seed/corpus";
import type { StepDefinition, StepType } from "@/lib/types";

export interface StepHandlerDeps {
  store: RunStore;
  runId: string;
  stepExecutionId: string | null;
  providers: LlmProvider[];
  maxLlmCalls: number;
  ctx: ExecutionContext;
  now: () => Date;
}

export interface StepHandlerResult {
  output: unknown;
  explanation?: unknown;
  /** Only condition steps set this. "end" terminates the run. */
  nextStepId?: string;
}

export type StepHandler = (
  step: StepDefinition,
  deps: StepHandlerDeps,
) => Promise<StepHandlerResult>;

interface FieldSpec {
  name: string;
  kind: FieldKind;
}

function fieldsOf(config: Record<string, unknown>): FieldSpec[] {
  return Array.isArray(config.fields) ? (config.fields as FieldSpec[]) : [];
}

function shapeOf(fields: FieldSpec[]): JsonShape {
  const shape: JsonShape = {};
  for (const f of fields) shape[f.name] = f.kind;
  return shape;
}

function kindMatches(value: unknown, kind: FieldKind): boolean {
  switch (kind) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "any":
      return true;
  }
}

function assertFields(
  source: Record<string, unknown>,
  fields: FieldSpec[],
  what: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const value = source?.[field.name];
    if (value === undefined || value === null) {
      throw new StepExecutionError(
        `${what} is missing required field "${field.name}".`,
        true,
        { field: field.name },
      );
    }
    if (!kindMatches(value, field.kind)) {
      throw new StepExecutionError(
        `${what} field "${field.name}" should be a ${field.kind} but was ${typeof value}.`,
        true,
        { field: field.name, expected: field.kind },
      );
    }
    out[field.name] = value;
  }
  return out;
}

/** Deterministic, order-insensitive JSON stringify for hashing. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const entries = keys.map(
    (k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`,
  );
  return `{${entries.join(",")}}`;
}

export function buildIdempotencyKey(
  runId: string,
  stepId: string,
  action: string,
  payload: unknown,
): string {
  const material = `${runId}|${stepId}|${action}|${stableStringify(payload)}`;
  return createHash("sha256").update(material).digest("hex").slice(0, 48);
}

/** Recursively resolves any `$.`-prefixed string inside a config value. */
function resolveDeep(value: unknown, ctx: ExecutionContext): unknown {
  if (typeof value === "string") return resolvePath(value, ctx);
  if (Array.isArray(value)) return value.map((v) => resolveDeep(v, ctx));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveDeep(v, ctx);
    return out;
  }
  return value;
}

const structuredInput: StepHandler = async (step, deps) => {
  const fields = fieldsOf(step.config);
  const input = (deps.ctx.input ?? {}) as Record<string, unknown>;
  return { output: assertFields(input, fields, "Run input") };
};

const documentRetrieval: StepHandler = async (step, deps) => {
  const rawQuery = String(step.config.query ?? "");
  const resolved = resolvePath(rawQuery, deps.ctx);
  const query = typeof resolved === "string" ? resolved : stableStringify(resolved);
  const topK = typeof step.config.topK === "number" ? step.config.topK : 3;

  const documents = searchCorpus(query, topK);
  return {
    output: { documents, matchCount: documents.length },
    explanation: { query, topK },
  };
};

const aiExtraction: StepHandler = async (step, deps) => {
  const fields = fieldsOf(step.config);
  const source = resolveDeep(step.config.source, deps.ctx);

  const data = await callLlm<Record<string, unknown>>(
    {
      store: deps.store,
      runId: deps.runId,
      stepExecutionId: deps.stepExecutionId,
      providers: deps.providers,
      maxCalls: deps.maxLlmCalls,
    },
    {
      system:
        "You extract structured data from business documents. Return only the requested fields. Use null for anything genuinely absent.",
      user: `Extract these fields: ${fields
        .map((f) => `${f.name} (${f.kind})`)
        .join(", ")}\n\nSource:\n${stableStringify(source)}`,
      schema: shapeOf(fields),
    },
  );

  return { output: assertFields(data ?? {}, fields, "Model output") };
};

const aiClassification: StepHandler = async (step, deps) => {
  const labels = Array.isArray(step.config.labels)
    ? (step.config.labels as string[])
    : [];
  const source = resolveDeep(step.config.source, deps.ctx);

  const data = await callLlm<{
    label: string;
    confidence: number;
    rationale: string;
  }>(
    {
      store: deps.store,
      runId: deps.runId,
      stepExecutionId: deps.stepExecutionId,
      providers: deps.providers,
      maxCalls: deps.maxLlmCalls,
    },
    {
      system:
        "You classify business records. Choose exactly one label from the provided list and explain your choice in one sentence.",
      user: `Labels: ${labels.join(", ")}\n\nRecord:\n${stableStringify(source)}`,
      schema: { label: "string", confidence: "number", rationale: "string" },
    },
  );

  if (!labels.includes(data?.label)) {
    throw new StepExecutionError(
      `Model returned label "${data?.label}", which is not one of: ${labels.join(", ")}.`,
      true,
      { returned: data?.label, allowed: labels },
    );
  }

  return {
    output: {
      label: data.label,
      confidence: typeof data.confidence === "number" ? data.confidence : 0,
      rationale: String(data.rationale ?? ""),
    },
  };
};

const deterministicCondition: StepHandler = async (step, deps) => {
  if (!step.condition) {
    throw new StepExecutionError(
      `Condition step "${step.id}" has no condition defined.`,
      false,
    );
  }

  const evaluated = evaluateCondition(step.condition, deps.ctx);
  const branchTaken = evaluated.result ? step.onTrue : step.onFalse;

  return {
    output: { result: evaluated.result, branchTaken: branchTaken ?? "end" },
    explanation: {
      condition: step.condition,
      resolvedInputs: evaluated.resolvedInputs,
      result: evaluated.result,
      description: evaluated.description,
      branchTaken: branchTaken ?? "end",
    },
    nextStepId: branchTaken ?? "end",
  };
};

const mockExternalAction: StepHandler = async (step, deps) => {
  const action = String(step.config.action ?? "unknown");
  const payload = resolveDeep(step.config.payload ?? {}, deps.ctx);
  const key = buildIdempotencyKey(deps.runId, step.id, action, payload);

  const response = {
    ref: `EXT-${key.slice(0, 8).toUpperCase()}`,
    action,
    submittedAt: deps.now().toISOString(),
  };

  const inserted = await deps.store.insertExternalAction({
    idempotencyKey: key,
    runId: deps.runId,
    stepId: step.id,
    request: payload,
    response,
  });

  if (!inserted.created) {
    await deps.store.appendAudit({
      runId: deps.runId,
      stepExecutionId: deps.stepExecutionId,
      type: "DUPLICATE_WRITE_PREVENTED",
      payload: { idempotencyKey: key, action, stepId: step.id },
    });
  } else {
    await deps.store.appendAudit({
      runId: deps.runId,
      stepExecutionId: deps.stepExecutionId,
      type: "TOOL_CALL",
      payload: { action, stepId: step.id, idempotencyKey: key, request: payload },
    });
  }

  const stored = inserted.record.response as { ref: string };

  return {
    output: {
      actionId: stored.ref,
      status: "SUBMITTED",
      duplicatePrevented: !inserted.created,
    },
    explanation: { idempotencyKey: key, action },
  };
};

const finalReport: StepHandler = async (step, deps) => {
  const title = String(step.config.title ?? "Report");
  const sections = Object.entries(deps.ctx.steps).map(([stepId, output]) => ({
    stepId,
    output,
  }));

  if (step.config.summarize !== true) {
    return { output: { title, sections } };
  }

  const data = await callLlm<{ summary: string }>(
    {
      store: deps.store,
      runId: deps.runId,
      stepExecutionId: deps.stepExecutionId,
      providers: deps.providers,
      maxCalls: deps.maxLlmCalls,
    },
    {
      system:
        "You summarise the outcome of an automated business workflow in two or three sentences for a reviewer who did not watch it run.",
      user: stableStringify(sections),
      schema: { summary: "string" },
    },
  );

  return { output: { title, sections, summary: String(data?.summary ?? "") } };
};

const notDispatchable: StepHandler = async (step) => {
  throw new StepExecutionError(
    `Step type "${step.type}" is handled by the runner, not by a handler.`,
    false,
  );
};

export const HANDLERS: Record<StepType, StepHandler> = {
  structured_input: structuredInput,
  document_retrieval: documentRetrieval,
  ai_extraction: aiExtraction,
  ai_classification: aiClassification,
  deterministic_condition: deterministicCondition,
  human_approval: notDispatchable,
  mock_external_action: mockExternalAction,
  final_report: finalReport,
};
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/lib/steps/handlers.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 6: Commit**

```bash
git add src/seed/corpus.ts src/lib/steps
git commit -m "feat: add step handlers for all executable step types"
```

---

## Task 11: Execution runner

**Files:**
- Create: `src/lib/engine/runner.ts`
- Create: `src/lib/engine/runner.test.ts`

**Interfaces:**
- Consumes: `RunStore`, `HANDLERS`, `assertPermitted`, `getStepSpec`, `ExecutionContext`
- Produces:
  - `RunnerDeps = { store; providers; maxLlmCalls; budgetMs; lockMs; maxAutoAttempts; now(); newToken() }`
  - `startRun(deps, workflowVersionId, input): Promise<RunRecord>`
  - `advanceRun(deps, runId): Promise<RunRecord>`
  - `decideApproval(deps, runId, stepExecutionId, decision, reason): Promise<RunRecord>`
  - `cancelRun(deps, runId): Promise<RunRecord>`
  - `resumeRun(deps, runId): Promise<RunRecord>`
  - `retryStep(deps, runId, stepExecutionId): Promise<RunRecord>`
  - `buildContext(run, steps): ExecutionContext`

**Semantics fixed by this task:**

- A run with `cursor === null` starts at `steps[0]`.
- A step whose latest attempt is `SUCCEEDED` is skipped on any later pass — this is what makes resume and recovery non-repeating.
- Condition steps set the next cursor from their branch; every other step advances in array order.
- A branch target of `"end"`, or running past the last step, completes the run.
- `human_approval` is intercepted before handler dispatch: it creates an `AWAITING_APPROVAL` step execution, sets the run to `AWAITING_APPROVAL`, and returns.
- **Rejection is a terminal, non-error outcome.** The approval step execution is recorded as `SUCCEEDED` with `decision: "REJECTED"`, and the run ends as `CANCELLED` — a human stopped it, which is not a failure.
- **Automatic retry** re-attempts a failed step only when the step type is `retrySafe` *and* the error is `retryable`, up to `maxAutoAttempts`. `mock_external_action` is never auto-retried.
- **Manual retry** (`retryStep`) is permitted on any failed step, including unsafe ones — the idempotency ledger is what makes that safe.

- [ ] **Step 1: Write the failing test**

`src/lib/engine/runner.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import {
  advanceRun,
  cancelRun,
  decideApproval,
  resumeRun,
  retryStep,
  startRun,
  type RunnerDeps,
} from "@/lib/engine/runner";
import { createMemoryStore, MemoryRunStore } from "@/lib/engine/store.memory";
import { MockLlmProvider } from "@/lib/llm/mock";
import { RateLimitError } from "@/lib/errors";
import type { WorkflowDefinition, WorkflowVersionRecord } from "@/lib/types";

const GRANTS = ["tool:llm", "tool:document_search", "action:post_invoice"];

function definition(): WorkflowDefinition {
  return {
    steps: [
      {
        id: "intake",
        type: "structured_input",
        name: "Intake",
        config: {
          fields: [
            { name: "invoiceId", kind: "string" },
            { name: "amount", kind: "number" },
          ],
        },
      },
      {
        id: "classify",
        type: "ai_classification",
        name: "Classify risk",
        config: { source: "$.steps.intake", labels: ["low_risk", "high_risk"] },
      },
      {
        id: "check",
        type: "deterministic_condition",
        name: "Over threshold?",
        config: {},
        condition: { left: "$.steps.intake.amount", op: "gt", right: 5000 },
        onTrue: "approve",
        onFalse: "report",
      },
      {
        id: "approve",
        type: "human_approval",
        name: "Manager approval",
        config: { prompt: "Approve this high-value invoice?" },
      },
      {
        id: "post",
        type: "mock_external_action",
        name: "Post to accounting",
        config: {
          action: "post_invoice",
          payload: { amount: "$.steps.intake.amount" },
        },
      },
      {
        id: "report",
        type: "final_report",
        name: "Report",
        config: { title: "Invoice Review", summarize: false },
      },
    ],
  };
}

function version(def = definition()): WorkflowVersionRecord {
  return {
    id: "wv1",
    workflowId: "w1",
    version: 1,
    definition: def,
    grantedPermissions: GRANTS,
    createdAt: new Date(),
  };
}

let store: MemoryRunStore;
let provider: MockLlmProvider;
let deps: RunnerDeps;

function makeDeps(overrides: Partial<RunnerDeps> = {}): RunnerDeps {
  return {
    store,
    providers: [provider],
    maxLlmCalls: 20,
    budgetMs: 30_000,
    lockMs: 60_000,
    maxAutoAttempts: 2,
    now: () => new Date("2026-07-29T00:00:00Z"),
    newToken: () => `tok_${Math.random().toString(36).slice(2)}`,
    ...overrides,
  };
}

beforeEach(() => {
  store = createMemoryStore({ versions: [version()] });
  provider = new MockLlmProvider("gemini").setDefault({
    label: "high_risk",
    confidence: 0.9,
    rationale: "Large amount.",
  });
  deps = makeDeps();
});

describe("output passing between steps", () => {
  it("makes step N's output available to step N+1", async () => {
    const run = await startRun(deps, "wv1", { invoiceId: "INV-1", amount: 100 });
    const finished = await advanceRun(deps, run.id);

    expect(finished.status).toBe("COMPLETED");

    const steps = await store.listStepExecutions(run.id);
    const intake = steps.find((s) => s.stepId === "intake");
    const report = steps.find((s) => s.stepId === "report");

    expect(intake?.output).toEqual({ invoiceId: "INV-1", amount: 100 });

    const sections = (report?.output as { sections: { stepId: string }[] }).sections;
    expect(sections.map((s) => s.stepId)).toContain("intake");
    expect(sections.map((s) => s.stepId)).toContain("classify");
  });
});

describe("human approval", () => {
  it("halts at the approval step and advances no further", async () => {
    const run = await startRun(deps, "wv1", { invoiceId: "INV-2", amount: 9000 });
    const paused = await advanceRun(deps, run.id);

    expect(paused.status).toBe("AWAITING_APPROVAL");

    const steps = await store.listStepExecutions(run.id);
    expect(steps.find((s) => s.stepId === "approve")?.status).toBe("AWAITING_APPROVAL");
    expect(steps.find((s) => s.stepId === "post")).toBeUndefined();

    const audit = await store.listAudit(run.id);
    expect(audit.some((e) => e.type === "APPROVAL_REQUESTED")).toBe(true);
  });

  it("does not advance when advanceRun is called again while awaiting approval", async () => {
    const run = await startRun(deps, "wv1", { invoiceId: "INV-2", amount: 9000 });
    await advanceRun(deps, run.id);
    const again = await advanceRun(deps, run.id);

    expect(again.status).toBe("AWAITING_APPROVAL");
    const steps = await store.listStepExecutions(run.id);
    expect(steps.filter((s) => s.stepId === "approve")).toHaveLength(1);
  });

  it("resumes to completion once approved", async () => {
    const run = await startRun(deps, "wv1", { invoiceId: "INV-2", amount: 9000 });
    await advanceRun(deps, run.id);

    const steps = await store.listStepExecutions(run.id);
    const approval = steps.find((s) => s.stepId === "approve");

    const finished = await decideApproval(
      deps,
      run.id,
      approval!.id,
      "APPROVED",
      "Checked against policy.",
    );

    expect(finished.status).toBe("COMPLETED");

    const after = await store.listStepExecutions(run.id);
    expect(after.find((s) => s.stepId === "post")?.status).toBe("SUCCEEDED");

    const audit = await store.listAudit(run.id);
    expect(audit.some((e) => e.type === "APPROVAL_DECIDED")).toBe(true);
  });

  it("terminates the run as CANCELLED when rejected, without running later steps", async () => {
    const run = await startRun(deps, "wv1", { invoiceId: "INV-2", amount: 9000 });
    await advanceRun(deps, run.id);

    const steps = await store.listStepExecutions(run.id);
    const approval = steps.find((s) => s.stepId === "approve");

    const finished = await decideApproval(
      deps,
      run.id,
      approval!.id,
      "REJECTED",
      "Vendor not verified.",
    );

    expect(finished.status).toBe("CANCELLED");

    const after = await store.listStepExecutions(run.id);
    expect(after.find((s) => s.stepId === "post")).toBeUndefined();
    expect(after.find((s) => s.stepId === "approve")?.status).toBe("SUCCEEDED");
  });
});

describe("cancel and resume", () => {
  it("cancels a run awaiting approval", async () => {
    const run = await startRun(deps, "wv1", { invoiceId: "INV-3", amount: 9000 });
    await advanceRun(deps, run.id);
    const cancelled = await cancelRun(deps, run.id);

    expect(cancelled.status).toBe("CANCELLED");
    const audit = await store.listAudit(run.id);
    expect(audit.some((e) => e.type === "RUN_CANCELLED")).toBe(true);
  });

  it("resumes a cancelled run without re-executing completed steps", async () => {
    const run = await startRun(deps, "wv1", { invoiceId: "INV-3", amount: 100 });
    await advanceRun(deps, run.id);

    const before = await store.listStepExecutions(run.id);
    const intakeId = before.find((s) => s.stepId === "intake")!.id;

    await cancelRun(deps, run.id);
    await resumeRun(deps, run.id);

    const after = await store.listStepExecutions(run.id);
    expect(after.filter((s) => s.stepId === "intake")).toHaveLength(1);
    expect(after.find((s) => s.stepId === "intake")!.id).toBe(intakeId);

    const audit = await store.listAudit(run.id);
    expect(audit.some((e) => e.type === "RUN_RESUMED")).toBe(true);
  });
});

describe("failure and retry", () => {
  it("fails the run and leaves it resumable when a step errors", async () => {
    provider.failWith(new RateLimitError("gemini"));
    const secondary = new MockLlmProvider("openrouter").failWith(
      new RateLimitError("openrouter"),
    );
    deps = makeDeps({ providers: [provider, secondary], maxAutoAttempts: 1 });

    const run = await startRun(deps, "wv1", { invoiceId: "INV-4", amount: 100 });
    const failed = await advanceRun(deps, run.id);

    expect(failed.status).toBe("FAILED");

    const steps = await store.listStepExecutions(run.id);
    expect(steps.find((s) => s.stepId === "classify")?.status).toBe("FAILED");

    const audit = await store.listAudit(run.id);
    expect(audit.some((e) => e.type === "STEP_FAILED")).toBe(true);
  });

  it("auto-retries a safe step whose error is retryable", async () => {
    let attempts = 0;
    const flaky = new MockLlmProvider("gemini");
    const original = flaky.complete.bind(flaky);
    flaky.complete = (async (req) => {
      attempts += 1;
      if (attempts === 1) throw new RateLimitError("gemini");
      return original(req);
    }) as typeof flaky.complete;
    flaky.setDefault({ label: "low_risk", confidence: 0.8, rationale: "Small." });

    deps = makeDeps({ providers: [flaky], maxAutoAttempts: 2 });

    const run = await startRun(deps, "wv1", { invoiceId: "INV-5", amount: 100 });
    const finished = await advanceRun(deps, run.id);

    expect(finished.status).toBe("COMPLETED");
    const steps = await store.listStepExecutions(run.id);
    const classifyAttempts = steps.filter((s) => s.stepId === "classify");
    expect(classifyAttempts.length).toBe(2);
    expect(classifyAttempts.at(-1)?.status).toBe("SUCCEEDED");
  });

  it("never auto-retries the unsafe external action step", async () => {
    const def = definition();
    def.steps = [
      def.steps[0],
      { ...def.steps[4], config: { action: "post_invoice", payload: { bad: true } } },
    ];
    store = createMemoryStore({ versions: [version(def)] });
    deps = makeDeps();

    const run = await startRun(deps, "wv1", { invoiceId: "INV-6", amount: 100 });
    await advanceRun(deps, run.id);

    const steps = await store.listStepExecutions(run.id);
    expect(steps.filter((s) => s.stepId === "post").length).toBe(1);
    expect(steps.find((s) => s.stepId === "post")?.retrySafe).toBe(false);
  });

  it("retries a failed safe step on request and completes the run", async () => {
    const failing = new MockLlmProvider("gemini").failWith(new RateLimitError("gemini"));
    deps = makeDeps({ providers: [failing], maxAutoAttempts: 1 });

    const run = await startRun(deps, "wv1", { invoiceId: "INV-7", amount: 100 });
    await advanceRun(deps, run.id);

    const steps = await store.listStepExecutions(run.id);
    const failedStep = steps.find((s) => s.stepId === "classify" && s.status === "FAILED");
    expect(failedStep).toBeDefined();

    const healthy = new MockLlmProvider("gemini").setDefault({
      label: "low_risk",
      confidence: 0.7,
      rationale: "Recovered.",
    });
    deps = makeDeps({ providers: [healthy] });

    const finished = await retryStep(deps, run.id, failedStep!.id);
    expect(finished.status).toBe("COMPLETED");

    const audit = await store.listAudit(run.id);
    expect(audit.some((e) => e.type === "RETRY_ATTEMPTED")).toBe(true);
  });
});

describe("idempotency across retries", () => {
  it("does not write the external action twice when the step is retried", async () => {
    const def = definition();
    def.steps = [def.steps[0], def.steps[4], def.steps[5]];
    store = createMemoryStore({ versions: [version(def)] });
    deps = makeDeps();

    const run = await startRun(deps, "wv1", { invoiceId: "INV-8", amount: 100 });
    await advanceRun(deps, run.id);

    const steps = await store.listStepExecutions(run.id);
    const post = steps.find((s) => s.stepId === "post");
    const firstRef = (post?.output as { actionId: string }).actionId;

    await retryStep(deps, run.id, post!.id);

    const after = await store.listStepExecutions(run.id);
    const retried = after.filter((s) => s.stepId === "post").at(-1);
    const output = retried?.output as { actionId: string; duplicatePrevented: boolean };

    expect(output.actionId).toBe(firstRef);
    expect(output.duplicatePrevented).toBe(true);

    const audit = await store.listAudit(run.id);
    expect(audit.some((e) => e.type === "DUPLICATE_WRITE_PREVENTED")).toBe(true);
  });
});

describe("execution path explanation", () => {
  it("records the resolved inputs and branch for a condition step", async () => {
    const run = await startRun(deps, "wv1", { invoiceId: "INV-9", amount: 9000 });
    await advanceRun(deps, run.id);

    const steps = await store.listStepExecutions(run.id);
    const check = steps.find((s) => s.stepId === "check");
    const explanation = check?.explanation as {
      description: string;
      branchTaken: string;
      resolvedInputs: Record<string, unknown>;
    };

    expect(explanation.description).toBe("amount (9000) > 5000");
    expect(explanation.branchTaken).toBe("approve");
    expect(explanation.resolvedInputs["$.steps.intake.amount"]).toBe(9000);
  });

  it("takes the false branch and skips approval for a small invoice", async () => {
    const run = await startRun(deps, "wv1", { invoiceId: "INV-10", amount: 10 });
    const finished = await advanceRun(deps, run.id);

    expect(finished.status).toBe("COMPLETED");
    const steps = await store.listStepExecutions(run.id);
    expect(steps.find((s) => s.stepId === "approve")).toBeUndefined();
    expect(steps.find((s) => s.stepId === "report")?.status).toBe("SUCCEEDED");
  });
});

describe("locking", () => {
  it("returns the current run without advancing when the lock is held", async () => {
    const run = await startRun(deps, "wv1", { invoiceId: "INV-11", amount: 100 });
    await store.acquireLock(run.id, "someone-else", new Date(Date.now() + 60_000));

    const result = await advanceRun(deps, run.id);
    expect(result.status).toBe("PENDING");
    expect(await store.listStepExecutions(run.id)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/engine/runner.test.ts`
Expected: FAIL — cannot resolve `@/lib/engine/runner`.

- [ ] **Step 3: Write the runner**

`src/lib/engine/runner.ts`:

```ts
import type { ExecutionContext } from "@/lib/engine/context";
import { assertPermitted } from "@/lib/engine/permissions";
import { getStepSpec } from "@/lib/engine/registry";
import type { RunStore } from "@/lib/engine/store";
import { ConflictError, NotFoundError, isAppError, toErrorMessage } from "@/lib/errors";
import type { LlmProvider } from "@/lib/llm/types";
import { HANDLERS } from "@/lib/steps";
import type {
  RunRecord,
  StepDefinition,
  StepExecutionRecord,
  WorkflowVersionRecord,
} from "@/lib/types";

export interface RunnerDeps {
  store: RunStore;
  providers: LlmProvider[];
  maxLlmCalls: number;
  /** Wall-clock budget for a single advanceRun call. */
  budgetMs: number;
  /** How long the run lock is held. */
  lockMs: number;
  /** Total attempts permitted for an auto-retryable step, including the first. */
  maxAutoAttempts: number;
  now: () => Date;
  newToken: () => string;
}

const TERMINAL: RunRecord["status"][] = ["COMPLETED", "FAILED", "CANCELLED"];

/** Latest attempt per step id, in creation order. */
function latestByStep(
  steps: StepExecutionRecord[],
): Map<string, StepExecutionRecord> {
  const map = new Map<string, StepExecutionRecord>();
  for (const s of steps) map.set(s.stepId, s);
  return map;
}

export function buildContext(
  run: RunRecord,
  steps: StepExecutionRecord[],
): ExecutionContext {
  const ctx: ExecutionContext = { input: run.input, steps: {} };
  for (const step of steps) {
    if (step.status === "SUCCEEDED") ctx.steps[step.stepId] = step.output;
  }
  return ctx;
}

function findStep(
  version: WorkflowVersionRecord,
  stepId: string,
): StepDefinition | undefined {
  return version.definition.steps.find((s) => s.id === stepId);
}

function stepAfter(
  version: WorkflowVersionRecord,
  stepId: string,
): string | null {
  const steps = version.definition.steps;
  const index = steps.findIndex((s) => s.id === stepId);
  if (index === -1 || index === steps.length - 1) return null;
  return steps[index + 1].id;
}

async function loadVersion(
  deps: RunnerDeps,
  run: RunRecord,
): Promise<WorkflowVersionRecord> {
  const version = await deps.store.getWorkflowVersion(run.workflowVersionId);
  if (!version) throw new NotFoundError(`WorkflowVersion ${run.workflowVersionId}`);
  return version;
}

export async function startRun(
  deps: RunnerDeps,
  workflowVersionId: string,
  input: unknown,
): Promise<RunRecord> {
  const version = await deps.store.getWorkflowVersion(workflowVersionId);
  if (!version) throw new NotFoundError(`WorkflowVersion ${workflowVersionId}`);

  const run = await deps.store.createRun({ workflowVersionId, input });
  await deps.store.appendAudit({
    runId: run.id,
    type: "RUN_CREATED",
    payload: { workflowVersionId, input },
  });
  return run;
}

/**
 * Executes one step and persists the outcome.
 * Returns the next cursor, or null when the run should complete.
 */
async function executeStep(
  deps: RunnerDeps,
  run: RunRecord,
  version: WorkflowVersionRecord,
  step: StepDefinition,
  ctx: ExecutionContext,
  attempt: number,
): Promise<{ nextCursor: string | null; failed: boolean }> {
  const spec = getStepSpec(step.type);

  const execution = await deps.store.createStepExecution({
    runId: run.id,
    stepId: step.id,
    stepType: step.type,
    status: "RUNNING",
    attempt,
    retrySafe: spec.retrySafe,
    input: step.config,
  });

  await deps.store.appendAudit({
    runId: run.id,
    stepExecutionId: execution.id,
    type: "STEP_STARTED",
    payload: { stepId: step.id, stepType: step.type, attempt },
  });

  try {
    assertPermitted(step, version.grantedPermissions);

    const handler = HANDLERS[step.type];
    const result = await handler(step, {
      store: deps.store,
      runId: run.id,
      stepExecutionId: execution.id,
      providers: deps.providers,
      maxLlmCalls: deps.maxLlmCalls,
      ctx,
      now: deps.now,
    });

    await deps.store.updateStepExecution(execution.id, {
      status: "SUCCEEDED",
      output: result.output,
      explanation: result.explanation ?? null,
      finishedAt: deps.now(),
    });

    await deps.store.appendAudit({
      runId: run.id,
      stepExecutionId: execution.id,
      type: "STEP_SUCCEEDED",
      payload: { stepId: step.id, output: result.output },
    });

    ctx.steps[step.id] = result.output;

    const next =
      result.nextStepId !== undefined
        ? result.nextStepId === "end"
          ? null
          : result.nextStepId
        : stepAfter(version, step.id);

    return { nextCursor: next, failed: false };
  } catch (error) {
    const message = toErrorMessage(error);
    const isPermission = isAppError(error) && error.code === "PERMISSION_DENIED";

    await deps.store.updateStepExecution(execution.id, {
      status: "FAILED",
      error: message,
      finishedAt: deps.now(),
    });

    if (isPermission) {
      await deps.store.appendAudit({
        runId: run.id,
        stepExecutionId: execution.id,
        type: "PERMISSION_DENIED",
        payload: { stepId: step.id, error: message },
      });
    }

    await deps.store.appendAudit({
      runId: run.id,
      stepExecutionId: execution.id,
      type: "STEP_FAILED",
      payload: {
        stepId: step.id,
        attempt,
        error: message,
        retryable: isAppError(error) ? error.retryable : false,
        retrySafe: spec.retrySafe,
      },
    });

    const canAutoRetry =
      spec.retrySafe &&
      isAppError(error) &&
      error.retryable &&
      attempt < deps.maxAutoAttempts;

    if (canAutoRetry) {
      await deps.store.appendAudit({
        runId: run.id,
        stepExecutionId: execution.id,
        type: "RETRY_ATTEMPTED",
        payload: { stepId: step.id, attempt: attempt + 1, automatic: true },
      });
      return executeStep(deps, run, version, step, ctx, attempt + 1);
    }

    return { nextCursor: null, failed: true };
  }
}

/**
 * Drives the run forward until it hits an approval gate, a terminal state,
 * a step failure, or the wall-clock budget. Every transition is persisted,
 * so the run is always resumable from storage alone.
 */
export async function advanceRun(
  deps: RunnerDeps,
  runId: string,
): Promise<RunRecord> {
  const token = deps.newToken();
  const until = new Date(deps.now().getTime() + deps.lockMs);

  const acquired = await deps.store.acquireLock(runId, token, until);
  if (!acquired) {
    const current = await deps.store.getRun(runId);
    if (!current) throw new NotFoundError(`Run ${runId}`);
    return current;
  }

  try {
    let run = await deps.store.getRun(runId);
    if (!run) throw new NotFoundError(`Run ${runId}`);
    if (TERMINAL.includes(run.status) || run.status === "AWAITING_APPROVAL") {
      return run;
    }

    const version = await loadVersion(deps, run);
    const executions = await deps.store.listStepExecutions(runId);
    const ctx = buildContext(run, executions);
    const latest = latestByStep(executions);

    let cursor = run.cursor ?? version.definition.steps[0]?.id ?? null;
    run = await deps.store.updateRun(runId, { status: "RUNNING", cursor });

    const deadline = Date.now() + deps.budgetMs;

    while (cursor !== null) {
      if (Date.now() > deadline) {
        return await deps.store.updateRun(runId, { status: "RUNNING", cursor });
      }

      const step = findStep(version, cursor);
      if (!step) {
        return await completeRun(deps, runId);
      }

      const previous = latest.get(step.id);
      if (previous?.status === "SUCCEEDED") {
        ctx.steps[step.id] = previous.output;
        const explanation = previous.explanation as { branchTaken?: string } | null;
        cursor =
          step.type === "deterministic_condition" && explanation?.branchTaken
            ? explanation.branchTaken === "end"
              ? null
              : explanation.branchTaken
            : stepAfter(version, step.id);
        await deps.store.updateRun(runId, { cursor });
        continue;
      }

      if (step.type === "human_approval") {
        const execution = await deps.store.createStepExecution({
          runId,
          stepId: step.id,
          stepType: step.type,
          status: "AWAITING_APPROVAL",
          attempt: 1,
          retrySafe: true,
          input: step.config,
        });
        await deps.store.appendAudit({
          runId,
          stepExecutionId: execution.id,
          type: "APPROVAL_REQUESTED",
          payload: { stepId: step.id, prompt: step.config.prompt },
        });
        return await deps.store.updateRun(runId, {
          status: "AWAITING_APPROVAL",
          cursor: step.id,
        });
      }

      const { nextCursor, failed } = await executeStep(
        deps,
        run,
        version,
        step,
        ctx,
        1,
      );

      if (failed) {
        await deps.store.appendAudit({
          runId,
          type: "RUN_FAILED",
          payload: { stepId: step.id },
        });
        return await deps.store.updateRun(runId, {
          status: "FAILED",
          cursor: step.id,
          error: `Step "${step.id}" failed.`,
        });
      }

      cursor = nextCursor;
      await deps.store.updateRun(runId, { cursor });
    }

    return await completeRun(deps, runId);
  } finally {
    await deps.store.releaseLock(runId, token);
  }
}

async function completeRun(deps: RunnerDeps, runId: string): Promise<RunRecord> {
  await deps.store.appendAudit({ runId, type: "RUN_COMPLETED", payload: {} });
  return deps.store.updateRun(runId, {
    status: "COMPLETED",
    cursor: null,
    error: null,
  });
}

export async function decideApproval(
  deps: RunnerDeps,
  runId: string,
  stepExecutionId: string,
  decision: "APPROVED" | "REJECTED",
  reason: string | null,
): Promise<RunRecord> {
  const run = await deps.store.getRun(runId);
  if (!run) throw new NotFoundError(`Run ${runId}`);
  if (run.status !== "AWAITING_APPROVAL") {
    throw new ConflictError(`Run ${runId} is not awaiting approval.`);
  }

  const executions = await deps.store.listStepExecutions(runId);
  const execution = executions.find((s) => s.id === stepExecutionId);
  if (!execution) throw new NotFoundError(`StepExecution ${stepExecutionId}`);
  if (execution.status !== "AWAITING_APPROVAL") {
    throw new ConflictError(`Step ${execution.stepId} is not awaiting approval.`);
  }

  await deps.store.createApproval(stepExecutionId, decision, reason);
  await deps.store.updateStepExecution(stepExecutionId, {
    status: "SUCCEEDED",
    output: { decision, reason },
    finishedAt: deps.now(),
  });
  await deps.store.appendAudit({
    runId,
    stepExecutionId,
    type: "APPROVAL_DECIDED",
    payload: { stepId: execution.stepId, decision, reason },
  });

  if (decision === "REJECTED") {
    await deps.store.appendAudit({
      runId,
      type: "RUN_CANCELLED",
      payload: { reason: "Approval rejected", stepId: execution.stepId },
    });
    return deps.store.updateRun(runId, {
      status: "CANCELLED",
      cursor: null,
      error: null,
    });
  }

  const version = await loadVersion(deps, run);
  await deps.store.updateRun(runId, {
    status: "RUNNING",
    cursor: stepAfter(version, execution.stepId),
  });

  return advanceRun(deps, runId);
}

export async function cancelRun(
  deps: RunnerDeps,
  runId: string,
): Promise<RunRecord> {
  const run = await deps.store.getRun(runId);
  if (!run) throw new NotFoundError(`Run ${runId}`);
  if (TERMINAL.includes(run.status)) return run;

  await deps.store.appendAudit({
    runId,
    type: "RUN_CANCELLED",
    payload: { previousStatus: run.status },
  });
  return deps.store.updateRun(runId, { status: "CANCELLED" });
}

export async function resumeRun(
  deps: RunnerDeps,
  runId: string,
): Promise<RunRecord> {
  const run = await deps.store.getRun(runId);
  if (!run) throw new NotFoundError(`Run ${runId}`);
  if (run.status === "COMPLETED") return run;

  await deps.store.appendAudit({
    runId,
    type: "RUN_RESUMED",
    payload: { previousStatus: run.status },
  });
  await deps.store.updateRun(runId, { status: "RUNNING", error: null });

  return advanceRun(deps, runId);
}

/**
 * Manual retry of a single failed step. Permitted even for steps that are not
 * auto-retry-safe — the idempotency ledger is what makes that safe.
 */
export async function retryStep(
  deps: RunnerDeps,
  runId: string,
  stepExecutionId: string,
): Promise<RunRecord> {
  const run = await deps.store.getRun(runId);
  if (!run) throw new NotFoundError(`Run ${runId}`);

  const executions = await deps.store.listStepExecutions(runId);
  const execution = executions.find((s) => s.id === stepExecutionId);
  if (!execution) throw new NotFoundError(`StepExecution ${stepExecutionId}`);

  const version = await loadVersion(deps, run);
  const step = findStep(version, execution.stepId);
  if (!step) throw new NotFoundError(`Step ${execution.stepId}`);

  await deps.store.appendAudit({
    runId,
    stepExecutionId,
    type: "RETRY_ATTEMPTED",
    payload: {
      stepId: execution.stepId,
      attempt: execution.attempt + 1,
      automatic: false,
      retrySafe: execution.retrySafe,
    },
  });

  const ctx = buildContext(run, executions);
  const { nextCursor, failed } = await executeStep(
    deps,
    run,
    version,
    step,
    ctx,
    execution.attempt + 1,
  );

  if (failed) {
    return deps.store.updateRun(runId, {
      status: "FAILED",
      cursor: step.id,
      error: `Step "${step.id}" failed on retry.`,
    });
  }

  await deps.store.updateRun(runId, { status: "RUNNING", cursor: nextCursor, error: null });
  return advanceRun(deps, runId);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/engine/runner.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: PASS, all tests green.

- [ ] **Step 6: Commit**

```bash
git add src/lib/engine/runner.ts src/lib/engine/runner.test.ts
git commit -m "feat: add durable execution runner with approval, retry, and recovery"
```

---

## Task 12: Prisma-backed RunStore

**Files:**
- Create: `src/lib/engine/store.prisma.ts`
- Create: `src/lib/engine/deps.ts`

**Interfaces:**
- Consumes: `RunStore` interface, `prisma` from `@/lib/db`
- Produces:
  - `PrismaRunStore` implementing `RunStore`
  - `createRunnerDeps(): RunnerDeps` — wires the Prisma store, the configured providers, and env-driven budgets

The two behaviours that must be correct here are the conditional lock acquire and the
insert-if-absent for external actions. Both use database guarantees rather than
read-then-write.

- [ ] **Step 1: Write the Prisma store**

`src/lib/engine/store.prisma.ts`:

```ts
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { NotFoundError } from "@/lib/errors";
import type {
  AppendAuditInput,
  CreateRunInput,
  CreateStepExecutionInput,
  InsertExternalActionInput,
  InsertExternalActionResult,
  RecordLlmCallInput,
  RunStore,
  UpdateRunInput,
  UpdateStepExecutionInput,
} from "@/lib/engine/store";
import type {
  ApprovalRecord,
  AuditEventRecord,
  AuditEventType,
  LlmCallRecord,
  RunRecord,
  StepExecutionRecord,
  StepType,
  WorkflowDefinition,
  WorkflowVersionRecord,
} from "@/lib/types";

const json = (value: unknown): Prisma.InputJsonValue =>
  (value ?? null) as Prisma.InputJsonValue;

export class PrismaRunStore implements RunStore {
  async getWorkflowVersion(id: string): Promise<WorkflowVersionRecord | null> {
    const row = await prisma.workflowVersion.findUnique({ where: { id } });
    if (!row) return null;
    return {
      id: row.id,
      workflowId: row.workflowId,
      version: row.version,
      definition: row.definition as unknown as WorkflowDefinition,
      grantedPermissions: (row.grantedPermissions as unknown as string[]) ?? [],
      createdAt: row.createdAt,
    };
  }

  async createRun(input: CreateRunInput): Promise<RunRecord> {
    const row = await prisma.run.create({
      data: {
        workflowVersionId: input.workflowVersionId,
        input: json(input.input),
        status: "PENDING",
      },
    });
    return row as unknown as RunRecord;
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    const row = await prisma.run.findUnique({ where: { id: runId } });
    return (row as unknown as RunRecord) ?? null;
  }

  async updateRun(runId: string, patch: UpdateRunInput): Promise<RunRecord> {
    const row = await prisma.run.update({
      where: { id: runId },
      data: {
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.cursor !== undefined ? { cursor: patch.cursor } : {}),
        ...(patch.error !== undefined ? { error: patch.error } : {}),
      },
    });
    return row as unknown as RunRecord;
  }

  /** Conditional update — succeeds only when no live lock is held. */
  async acquireLock(runId: string, token: string, until: Date): Promise<boolean> {
    const result = await prisma.run.updateMany({
      where: {
        id: runId,
        OR: [{ lockToken: null }, { lockedUntil: { lt: new Date() } }],
      },
      data: { lockToken: token, lockedUntil: until },
    });
    return result.count === 1;
  }

  async releaseLock(runId: string, token: string): Promise<void> {
    await prisma.run.updateMany({
      where: { id: runId, lockToken: token },
      data: { lockToken: null, lockedUntil: null },
    });
  }

  async listStepExecutions(runId: string): Promise<StepExecutionRecord[]> {
    const rows = await prisma.stepExecution.findMany({
      where: { runId },
      orderBy: [{ startedAt: "asc" }, { attempt: "asc" }],
    });
    return rows as unknown as StepExecutionRecord[];
  }

  async createStepExecution(
    input: CreateStepExecutionInput,
  ): Promise<StepExecutionRecord> {
    const row = await prisma.stepExecution.create({
      data: {
        runId: input.runId,
        stepId: input.stepId,
        stepType: input.stepType,
        status: input.status,
        attempt: input.attempt,
        retrySafe: input.retrySafe,
        input: json(input.input),
        startedAt: new Date(),
      },
    });
    return row as unknown as StepExecutionRecord;
  }

  async updateStepExecution(
    id: string,
    patch: UpdateStepExecutionInput,
  ): Promise<StepExecutionRecord> {
    const row = await prisma.stepExecution.update({
      where: { id },
      data: {
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.output !== undefined ? { output: json(patch.output) } : {}),
        ...(patch.explanation !== undefined
          ? { explanation: json(patch.explanation) }
          : {}),
        ...(patch.error !== undefined ? { error: patch.error } : {}),
        ...(patch.finishedAt !== undefined ? { finishedAt: patch.finishedAt } : {}),
      },
    });
    return row as unknown as StepExecutionRecord;
  }

  async createApproval(
    stepExecutionId: string,
    decision: "APPROVED" | "REJECTED",
    reason: string | null,
  ): Promise<ApprovalRecord> {
    const row = await prisma.approval.create({
      data: { stepExecutionId, decision, reason },
    });
    return row as unknown as ApprovalRecord;
  }

  async getApproval(stepExecutionId: string): Promise<ApprovalRecord | null> {
    const row = await prisma.approval.findUnique({ where: { stepExecutionId } });
    return (row as unknown as ApprovalRecord) ?? null;
  }

  async appendAudit(input: AppendAuditInput): Promise<AuditEventRecord> {
    const row = await prisma.auditEvent.create({
      data: {
        runId: input.runId,
        stepExecutionId: input.stepExecutionId ?? null,
        type: input.type,
        payload: json(input.payload),
      },
    });
    return { ...row, type: row.type as AuditEventType } as AuditEventRecord;
  }

  async listAudit(runId: string): Promise<AuditEventRecord[]> {
    const rows = await prisma.auditEvent.findMany({
      where: { runId },
      orderBy: { createdAt: "asc" },
    });
    return rows as unknown as AuditEventRecord[];
  }

  async recordLlmCall(input: RecordLlmCallInput): Promise<LlmCallRecord> {
    const row = await prisma.llmCall.create({
      data: {
        runId: input.runId,
        stepExecutionId: input.stepExecutionId ?? null,
        provider: input.provider,
        model: input.model,
        prompt: input.prompt,
        response: input.response,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        latencyMs: input.latencyMs,
        status: input.status,
        error: input.error,
      },
    });
    return row as unknown as LlmCallRecord;
  }

  async countLlmCalls(runId: string): Promise<number> {
    return prisma.llmCall.count({ where: { runId } });
  }

  async listLlmCalls(runId: string): Promise<LlmCallRecord[]> {
    const rows = await prisma.llmCall.findMany({
      where: { runId },
      orderBy: { createdAt: "asc" },
    });
    return rows as unknown as LlmCallRecord[];
  }

  /**
   * Insert-if-absent. The unique constraint on idempotencyKey is what prevents
   * a duplicate write; a P2002 conflict means the action already ran.
   */
  async insertExternalAction(
    input: InsertExternalActionInput,
  ): Promise<InsertExternalActionResult> {
    try {
      const row = await prisma.externalAction.create({
        data: {
          idempotencyKey: input.idempotencyKey,
          runId: input.runId,
          stepId: input.stepId,
          request: json(input.request),
          response: json(input.response),
        },
      });
      return { created: true, record: row as unknown as never };
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === "P2002"
      ) {
        const existing = await prisma.externalAction.findUnique({
          where: { idempotencyKey: input.idempotencyKey },
        });
        if (!existing) throw new NotFoundError("ExternalAction after conflict");
        return { created: false, record: existing as unknown as never };
      }
      throw e;
    }
  }
}

export const prismaRunStore = new PrismaRunStore();
export type { StepType };
```

- [ ] **Step 2: Write the dependency wiring**

`src/lib/engine/deps.ts`:

```ts
import { randomUUID } from "node:crypto";
import { prismaRunStore } from "@/lib/engine/store.prisma";
import type { RunnerDeps } from "@/lib/engine/runner";
import { GeminiProvider } from "@/lib/llm/gemini";
import { OpenRouterProvider } from "@/lib/llm/openrouter";
import { MockLlmProvider } from "@/lib/llm/mock";
import type { LlmProvider } from "@/lib/llm/types";

function buildProviders(): LlmProvider[] {
  const configured = (process.env.LLM_PROVIDER ?? "gemini").toLowerCase();

  if (configured === "mock") {
    return [
      new MockLlmProvider("mock").setDefault({
        label: "low_risk",
        confidence: 0.5,
        rationale: "Mock provider response.",
      }),
    ];
  }

  const providers: LlmProvider[] = [];
  if (process.env.GEMINI_API_KEY) providers.push(new GeminiProvider());
  if (process.env.OPENROUTER_API_KEY) providers.push(new OpenRouterProvider());

  if (configured === "openrouter") providers.reverse();
  return providers;
}

export function createRunnerDeps(): RunnerDeps {
  return {
    store: prismaRunStore,
    providers: buildProviders(),
    maxLlmCalls: Number(process.env.MAX_LLM_CALLS_PER_RUN ?? 20),
    budgetMs: 40_000,
    lockMs: 60_000,
    maxAutoAttempts: 2,
    now: () => new Date(),
    newToken: () => randomUUID(),
  };
}
```

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: errors only for the not-yet-written `@/lib/llm/gemini` and `@/lib/llm/openrouter`. Those arrive in Task 13; proceed.

- [ ] **Step 4: Commit**

```bash
git add src/lib/engine/store.prisma.ts src/lib/engine/deps.ts
git commit -m "feat: add Prisma-backed RunStore with conditional locking"
```

---

## Task 13: Gemini and OpenRouter providers

**Files:**
- Create: `src/lib/llm/gemini.ts`
- Create: `src/lib/llm/openrouter.ts`
- Create: `src/lib/llm/providers.test.ts`

**Interfaces:**
- Consumes: `LlmProvider`, `LlmRequest`, `LlmResponse`, `JsonShape`, errors
- Produces: `GeminiProvider`, `OpenRouterProvider`, `toGeminiSchema(shape)`, `parseJsonStrict(raw)`

Both providers accept an injected `fetch` so their error mapping is testable without network
access.

- [ ] **Step 1: Write the failing test**

`src/lib/llm/providers.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { GeminiProvider, toGeminiSchema } from "@/lib/llm/gemini";
import { OpenRouterProvider } from "@/lib/llm/openrouter";
import { ProviderError, RateLimitError } from "@/lib/errors";

const REQ = {
  system: "extract",
  user: "text",
  schema: { amount: "number" as const, vendor: "string" as const },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("toGeminiSchema", () => {
  it("maps the field shape onto a Gemini responseSchema", () => {
    expect(toGeminiSchema({ amount: "number", tags: "array" })).toEqual({
      type: "OBJECT",
      properties: { amount: { type: "NUMBER" }, tags: { type: "ARRAY" } },
      required: ["amount", "tags"],
    });
  });
});

describe("GeminiProvider", () => {
  it("returns parsed data from a successful response", async () => {
    const provider = new GeminiProvider({
      apiKey: "k",
      fetchImpl: async () =>
        jsonResponse({
          candidates: [
            { content: { parts: [{ text: '{"amount":10,"vendor":"Acme"}' }] } },
          ],
          usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 8 },
        }),
    });

    const result = await provider.complete<{ amount: number }>(REQ);
    expect(result.data.amount).toBe(10);
    expect(result.inputTokens).toBe(12);
    expect(result.outputTokens).toBe(8);
  });

  it("maps HTTP 429 to a retryable RateLimitError", async () => {
    const provider = new GeminiProvider({
      apiKey: "k",
      fetchImpl: async () => jsonResponse({ error: "quota" }, 429),
    });
    await expect(provider.complete(REQ)).rejects.toBeInstanceOf(RateLimitError);
  });

  it("maps HTTP 500 to a retryable ProviderError", async () => {
    const provider = new GeminiProvider({
      apiKey: "k",
      fetchImpl: async () => jsonResponse({ error: "boom" }, 500),
    });
    const error = await provider.complete(REQ).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.retryable).toBe(true);
  });

  it("raises a ProviderError when the model returns unparseable output", async () => {
    const provider = new GeminiProvider({
      apiKey: "k",
      fetchImpl: async () =>
        jsonResponse({
          candidates: [{ content: { parts: [{ text: "not json at all" }] } }],
        }),
    });
    await expect(provider.complete(REQ)).rejects.toBeInstanceOf(ProviderError);
  });
});

describe("OpenRouterProvider", () => {
  it("returns parsed data from a successful response", async () => {
    const provider = new OpenRouterProvider({
      apiKey: "k",
      fetchImpl: async () =>
        jsonResponse({
          choices: [{ message: { content: '{"amount":3,"vendor":"Globex"}' } }],
          usage: { prompt_tokens: 5, completion_tokens: 4 },
        }),
    });

    const result = await provider.complete<{ vendor: string }>(REQ);
    expect(result.data.vendor).toBe("Globex");
  });

  it("strips a markdown code fence before parsing", async () => {
    const provider = new OpenRouterProvider({
      apiKey: "k",
      fetchImpl: async () =>
        jsonResponse({
          choices: [
            { message: { content: '```json\n{"amount":1,"vendor":"X"}\n```' } },
          ],
        }),
    });
    const result = await provider.complete<{ amount: number }>(REQ);
    expect(result.data.amount).toBe(1);
  });

  it("maps HTTP 429 to a retryable RateLimitError", async () => {
    const provider = new OpenRouterProvider({
      apiKey: "k",
      fetchImpl: async () => jsonResponse({ error: "rate" }, 429),
    });
    await expect(provider.complete(REQ)).rejects.toBeInstanceOf(RateLimitError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/llm/providers.test.ts`
Expected: FAIL — cannot resolve `@/lib/llm/gemini`.

- [ ] **Step 3: Write the Gemini provider**

`src/lib/llm/gemini.ts`:

```ts
import { ProviderError, RateLimitError } from "@/lib/errors";
import type { FieldKind, JsonShape } from "@/lib/engine/registry";
import type { LlmProvider, LlmRequest, LlmResponse } from "@/lib/llm/types";

const KIND_TO_GEMINI: Record<FieldKind, string> = {
  string: "STRING",
  number: "NUMBER",
  boolean: "BOOLEAN",
  object: "OBJECT",
  array: "ARRAY",
  any: "STRING",
};

export function toGeminiSchema(shape: JsonShape) {
  const properties: Record<string, { type: string }> = {};
  for (const [name, kind] of Object.entries(shape)) {
    properties[name] = { type: KIND_TO_GEMINI[kind] };
  }
  return { type: "OBJECT", properties, required: Object.keys(shape) };
}

export function parseJsonStrict(raw: string, provider: string): unknown {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(cleaned);
  } catch {
    throw new ProviderError(
      provider,
      `Model returned output that is not valid JSON: ${raw.slice(0, 200)}`,
    );
  }
}

export interface GeminiOptions {
  apiKey?: string;
  model?: string;
  fetchImpl?: typeof fetch;
}

export class GeminiProvider implements LlmProvider {
  readonly name = "gemini";
  readonly model: string;
  private apiKey: string;
  private fetchImpl: typeof fetch;

  constructor(options: GeminiOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.GEMINI_API_KEY ?? "";
    this.model = options.model ?? "gemini-2.5-flash";
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async complete<T = unknown>(req: LlmRequest): Promise<LlmResponse<T>> {
    if (!this.apiKey) throw new ProviderError(this.name, "GEMINI_API_KEY is not set.");

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`;

    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": this.apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: req.system }] },
        contents: [{ role: "user", parts: [{ text: req.user }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: toGeminiSchema(req.schema),
          maxOutputTokens: req.maxTokens ?? 2048,
        },
      }),
    });

    if (response.status === 429) throw new RateLimitError(this.name);
    if (!response.ok) {
      throw new ProviderError(this.name, `HTTP ${response.status}`);
    }

    const body = (await response.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };

    const text = body.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new ProviderError(this.name, "Response contained no content.");

    return {
      data: parseJsonStrict(text, this.name) as T,
      raw: text,
      inputTokens: body.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: body.usageMetadata?.candidatesTokenCount ?? 0,
    };
  }
}
```

- [ ] **Step 4: Write the OpenRouter provider**

`src/lib/llm/openrouter.ts`:

```ts
import { ProviderError, RateLimitError } from "@/lib/errors";
import { parseJsonStrict } from "@/lib/llm/gemini";
import type { LlmProvider, LlmRequest, LlmResponse } from "@/lib/llm/types";

export interface OpenRouterOptions {
  apiKey?: string;
  model?: string;
  fetchImpl?: typeof fetch;
}

export class OpenRouterProvider implements LlmProvider {
  readonly name = "openrouter";
  readonly model: string;
  private apiKey: string;
  private fetchImpl: typeof fetch;

  constructor(options: OpenRouterOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY ?? "";
    this.model =
      options.model ??
      process.env.OPENROUTER_MODEL ??
      "meta-llama/llama-3.3-70b-instruct:free";
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async complete<T = unknown>(req: LlmRequest): Promise<LlmResponse<T>> {
    if (!this.apiKey) {
      throw new ProviderError(this.name, "OPENROUTER_API_KEY is not set.");
    }

    const fieldList = Object.entries(req.schema)
      .map(([name, kind]) => `"${name}": ${kind}`)
      .join(", ");

    const response = await this.fetchImpl("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        response_format: { type: "json_object" },
        max_tokens: req.maxTokens ?? 2048,
        messages: [
          {
            role: "system",
            content: `${req.system}\n\nRespond with a single JSON object containing exactly these keys: { ${fieldList} }. Output nothing else.`,
          },
          { role: "user", content: req.user },
        ],
      }),
    });

    if (response.status === 429) throw new RateLimitError(this.name);
    if (!response.ok) {
      throw new ProviderError(this.name, `HTTP ${response.status}`);
    }

    const body = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    const text = body.choices?.[0]?.message?.content;
    if (!text) throw new ProviderError(this.name, "Response contained no content.");

    return {
      data: parseJsonStrict(text, this.name) as T,
      raw: text,
      inputTokens: body.usage?.prompt_tokens ?? 0,
      outputTokens: body.usage?.completion_tokens ?? 0,
    };
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/lib/llm/providers.test.ts`
Expected: PASS, 8 tests.

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/llm/gemini.ts src/lib/llm/openrouter.ts src/lib/llm/providers.test.ts
git commit -m "feat: add Gemini and OpenRouter providers with error mapping"
```

---

## Task 14: API routes

**Files:**
- Create: `src/lib/api.ts`
- Create: `src/app/api/workflows/route.ts`
- Create: `src/app/api/workflows/[id]/route.ts`
- Create: `src/app/api/workflows/[id]/versions/route.ts`
- Create: `src/app/api/workflows/[id]/validate/route.ts`
- Create: `src/app/api/runs/route.ts`
- Create: `src/app/api/runs/[id]/route.ts`
- Create: `src/app/api/runs/[id]/tick/route.ts`
- Create: `src/app/api/runs/[id]/approve/route.ts`
- Create: `src/app/api/runs/[id]/cancel/route.ts`
- Create: `src/app/api/runs/[id]/resume/route.ts`
- Create: `src/app/api/runs/[id]/retry/route.ts`

**Interfaces:**
- Consumes: `createRunnerDeps`, runner functions, `validateWorkflow`, `prisma`
- Produces: `ok(data)`, `fail(error)` helpers; `RunDetail` response shape consumed by the UI in Task 16:
  `{ run, version, workflow, steps, audit, llmCalls }`

All routes run on the Node runtime (Prisma requires it) and are marked dynamic.

- [ ] **Step 1: Write the response helpers**

`src/lib/api.ts`:

```ts
import { NextResponse } from "next/server";
import { isAppError, toErrorMessage } from "@/lib/errors";

const STATUS_BY_CODE: Record<string, number> = {
  VALIDATION_ERROR: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PERMISSION_DENIED: 403,
  RATE_LIMIT: 429,
  PROVIDER_ERROR: 502,
  STEP_EXECUTION_ERROR: 500,
};

export function ok<T>(data: T, status = 200) {
  return NextResponse.json(data, { status });
}

export function fail(error: unknown) {
  if (isAppError(error)) {
    return NextResponse.json(
      {
        error: {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
          details: error.details ?? null,
        },
      },
      { status: STATUS_BY_CODE[error.code] ?? 500 },
    );
  }

  return NextResponse.json(
    {
      error: {
        code: "INTERNAL_ERROR",
        message: toErrorMessage(error),
        retryable: false,
        details: null,
      },
    },
    { status: 500 },
  );
}
```

- [ ] **Step 2: Write the workflow routes**

`src/app/api/workflows/route.ts`:

```ts
import { prisma } from "@/lib/db";
import { fail, ok } from "@/lib/api";
import { validateWorkflow } from "@/lib/engine/validator";
import { ValidationError } from "@/lib/errors";
import type { WorkflowDefinition } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const workflows = await prisma.workflow.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        versions: { orderBy: { version: "desc" }, select: { id: true, version: true, createdAt: true } },
      },
    });
    return ok({ workflows });
  } catch (e) {
    return fail(e);
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      name?: string;
      definition?: WorkflowDefinition;
      grantedPermissions?: string[];
    };

    if (!body.name) throw new ValidationError("A workflow name is required.");
    const definition = body.definition ?? { steps: [] };
    const grants = body.grantedPermissions ?? [];

    const issues = validateWorkflow(definition, grants);
    if (issues.length > 0) {
      throw new ValidationError("Workflow definition is not valid.", { issues });
    }

    const workflow = await prisma.workflow.create({
      data: {
        name: body.name,
        versions: {
          create: { version: 1, definition: definition as never, grantedPermissions: grants as never },
        },
      },
      include: { versions: true },
    });

    return ok({ workflow }, 201);
  } catch (e) {
    return fail(e);
  }
}
```

`src/app/api/workflows/[id]/route.ts`:

```ts
import { prisma } from "@/lib/db";
import { fail, ok } from "@/lib/api";
import { NotFoundError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const workflow = await prisma.workflow.findUnique({
      where: { id },
      include: { versions: { orderBy: { version: "desc" } } },
    });
    if (!workflow) throw new NotFoundError(`Workflow ${id}`);
    return ok({ workflow });
  } catch (e) {
    return fail(e);
  }
}
```

`src/app/api/workflows/[id]/versions/route.ts`:

```ts
import { prisma } from "@/lib/db";
import { fail, ok } from "@/lib/api";
import { validateWorkflow } from "@/lib/engine/validator";
import { NotFoundError, ValidationError } from "@/lib/errors";
import type { WorkflowDefinition } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = (await request.json()) as {
      definition?: WorkflowDefinition;
      grantedPermissions?: string[];
    };

    const workflow = await prisma.workflow.findUnique({
      where: { id },
      include: { versions: { orderBy: { version: "desc" }, take: 1 } },
    });
    if (!workflow) throw new NotFoundError(`Workflow ${id}`);

    const definition = body.definition ?? { steps: [] };
    const grants = body.grantedPermissions ?? [];

    const issues = validateWorkflow(definition, grants);
    if (issues.length > 0) {
      throw new ValidationError("Workflow definition is not valid.", { issues });
    }

    const nextVersion = (workflow.versions[0]?.version ?? 0) + 1;

    const version = await prisma.workflowVersion.create({
      data: {
        workflowId: id,
        version: nextVersion,
        definition: definition as never,
        grantedPermissions: grants as never,
      },
    });

    return ok({ version }, 201);
  } catch (e) {
    return fail(e);
  }
}
```

`src/app/api/workflows/[id]/validate/route.ts`:

```ts
import { fail, ok } from "@/lib/api";
import { validateWorkflow } from "@/lib/engine/validator";
import type { WorkflowDefinition } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      definition?: WorkflowDefinition;
      grantedPermissions?: string[];
    };
    const issues = validateWorkflow(body.definition ?? { steps: [] }, body.grantedPermissions ?? []);
    return ok({ valid: issues.length === 0, issues });
  } catch (e) {
    return fail(e);
  }
}
```

- [ ] **Step 3: Write the run routes**

`src/app/api/runs/route.ts`:

```ts
import { prisma } from "@/lib/db";
import { fail, ok } from "@/lib/api";
import { createRunnerDeps } from "@/lib/engine/deps";
import { advanceRun, startRun } from "@/lib/engine/runner";
import { ValidationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const runs = await prisma.run.findMany({
      orderBy: { createdAt: "desc" },
      take: 50,
      include: {
        workflowVersion: { include: { workflow: { select: { name: true } } } },
      },
    });
    return ok({ runs });
  } catch (e) {
    return fail(e);
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      workflowVersionId?: string;
      input?: unknown;
    };
    if (!body.workflowVersionId) {
      throw new ValidationError("workflowVersionId is required.");
    }

    const deps = createRunnerDeps();
    const created = await startRun(deps, body.workflowVersionId, body.input ?? {});
    const run = await advanceRun(deps, created.id);

    return ok({ run }, 201);
  } catch (e) {
    return fail(e);
  }
}
```

`src/app/api/runs/[id]/route.ts`:

```ts
import { prisma } from "@/lib/db";
import { fail, ok } from "@/lib/api";
import { NotFoundError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    const run = await prisma.run.findUnique({
      where: { id },
      include: {
        workflowVersion: { include: { workflow: true } },
        stepExecutions: {
          orderBy: [{ startedAt: "asc" }, { attempt: "asc" }],
          include: { approval: true },
        },
        auditEvents: { orderBy: { createdAt: "asc" } },
        llmCalls: { orderBy: { createdAt: "asc" } },
      },
    });

    if (!run) throw new NotFoundError(`Run ${id}`);

    return ok({
      run,
      workflow: run.workflowVersion.workflow,
      version: run.workflowVersion,
      steps: run.stepExecutions,
      audit: run.auditEvents,
      llmCalls: run.llmCalls,
    });
  } catch (e) {
    return fail(e);
  }
}
```

`src/app/api/runs/[id]/tick/route.ts`:

```ts
import { fail, ok } from "@/lib/api";
import { createRunnerDeps } from "@/lib/engine/deps";
import { advanceRun } from "@/lib/engine/runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const run = await advanceRun(createRunnerDeps(), id);
    return ok({ run });
  } catch (e) {
    return fail(e);
  }
}
```

`src/app/api/runs/[id]/approve/route.ts`:

```ts
import { fail, ok } from "@/lib/api";
import { createRunnerDeps } from "@/lib/engine/deps";
import { decideApproval } from "@/lib/engine/runner";
import { ValidationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = (await request.json()) as {
      stepExecutionId?: string;
      decision?: "APPROVED" | "REJECTED";
      reason?: string;
    };

    if (!body.stepExecutionId) throw new ValidationError("stepExecutionId is required.");
    if (body.decision !== "APPROVED" && body.decision !== "REJECTED") {
      throw new ValidationError("decision must be APPROVED or REJECTED.");
    }

    const run = await decideApproval(
      createRunnerDeps(),
      id,
      body.stepExecutionId,
      body.decision,
      body.reason ?? null,
    );
    return ok({ run });
  } catch (e) {
    return fail(e);
  }
}
```

`src/app/api/runs/[id]/cancel/route.ts`:

```ts
import { fail, ok } from "@/lib/api";
import { createRunnerDeps } from "@/lib/engine/deps";
import { cancelRun } from "@/lib/engine/runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const run = await cancelRun(createRunnerDeps(), id);
    return ok({ run });
  } catch (e) {
    return fail(e);
  }
}
```

`src/app/api/runs/[id]/resume/route.ts`:

```ts
import { fail, ok } from "@/lib/api";
import { createRunnerDeps } from "@/lib/engine/deps";
import { resumeRun } from "@/lib/engine/runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const run = await resumeRun(createRunnerDeps(), id);
    return ok({ run });
  } catch (e) {
    return fail(e);
  }
}
```

`src/app/api/runs/[id]/retry/route.ts`:

```ts
import { fail, ok } from "@/lib/api";
import { createRunnerDeps } from "@/lib/engine/deps";
import { retryStep } from "@/lib/engine/runner";
import { ValidationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = (await request.json()) as { stepExecutionId?: string };
    if (!body.stepExecutionId) throw new ValidationError("stepExecutionId is required.");

    const run = await retryStep(createRunnerDeps(), id, body.stepExecutionId);
    return ok({ run });
  } catch (e) {
    return fail(e);
  }
}
```

- [ ] **Step 4: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npm test`
Expected: PASS, all tests still green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/api.ts src/app/api
git commit -m "feat: add API routes for workflows, versions, validation, and run control"
```

---

## Task 15: Seed data and database provisioning

**Files:**
- Create: `src/seed/workflow.ts`
- Create: `prisma/seed.ts`
- Create: `.env` (local only, gitignored)

**Interfaces:**
- Consumes: `WorkflowDefinition`, `prisma`, runner + `MockLlmProvider`
- Produces: `DEMO_WORKFLOW`, `DEMO_GRANTS`, `DEMO_INPUT_HIGH`, `DEMO_INPUT_LOW`

The seed creates the demo workflow **and one completed run**, so reviewers see a full
execution with its audit trail on first load even if the live LLM is rate-limited. The
seeded run uses the mock provider so seeding never depends on network access.

- [ ] **Step 1: Write the demo workflow**

`src/seed/workflow.ts`:

```ts
import type { WorkflowDefinition } from "@/lib/types";

export const DEMO_GRANTS = [
  "tool:llm",
  "tool:document_search",
  "action:post_invoice",
];

export const DEMO_WORKFLOW: WorkflowDefinition = {
  steps: [
    {
      id: "intake",
      type: "structured_input",
      name: "Invoice intake",
      config: {
        fields: [
          { name: "invoiceId", kind: "string" },
          { name: "vendor", kind: "string" },
          { name: "amount", kind: "number" },
          { name: "description", kind: "string" },
        ],
      },
    },
    {
      id: "policy",
      type: "document_retrieval",
      name: "Retrieve vendor policy",
      config: { query: "$.steps.intake.vendor", topK: 3 },
    },
    {
      id: "extract",
      type: "ai_extraction",
      name: "Extract invoice facts",
      config: {
        source: "$.steps.intake",
        fields: [
          { name: "amount", kind: "number" },
          { name: "vendor", kind: "string" },
          { name: "category", kind: "string" },
        ],
      },
    },
    {
      id: "classify",
      type: "ai_classification",
      name: "Classify risk",
      config: {
        source: "$.steps.policy.documents",
        labels: ["low_risk", "high_risk"],
      },
    },
    {
      id: "check",
      type: "deterministic_condition",
      name: "Requires manager approval?",
      config: {},
      condition: {
        anyOf: [
          { left: "$.steps.extract.amount", op: "gt", right: 5000 },
          { left: "$.steps.classify.label", op: "eq", right: "high_risk" },
        ],
      },
      onTrue: "approve",
      onFalse: "post",
    },
    {
      id: "approve",
      type: "human_approval",
      name: "Manager approval",
      config: {
        prompt:
          "This invoice exceeded the auto-approval threshold or was classified as high risk. Approve payment?",
      },
    },
    {
      id: "post",
      type: "mock_external_action",
      name: "Post to accounting system",
      config: {
        action: "post_invoice",
        payload: {
          invoiceId: "$.steps.intake.invoiceId",
          amount: "$.steps.extract.amount",
          vendor: "$.steps.extract.vendor",
        },
      },
    },
    {
      id: "report",
      type: "final_report",
      name: "Final report",
      config: { title: "Invoice Review Summary", summarize: false },
    },
  ],
};

export const DEMO_INPUT_HIGH = {
  invoiceId: "INV-2026-0042",
  vendor: "Globex Industrial",
  amount: 8400,
  description: "Quarterly industrial parts supply",
};

export const DEMO_INPUT_LOW = {
  invoiceId: "INV-2026-0043",
  vendor: "Acme Supplies",
  amount: 320,
  description: "Office stationery restock",
};
```

- [ ] **Step 2: Write the seed script**

`prisma/seed.ts`:

```ts
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { prismaRunStore } from "../src/lib/engine/store.prisma";
import { advanceRun, decideApproval, startRun } from "../src/lib/engine/runner";
import { MockLlmProvider } from "../src/lib/llm/mock";
import {
  DEMO_GRANTS,
  DEMO_INPUT_HIGH,
  DEMO_INPUT_LOW,
  DEMO_WORKFLOW,
} from "../src/seed/workflow";

const prisma = new PrismaClient();

function seedProvider() {
  const provider = new MockLlmProvider("seed-mock");
  provider.setDefault({
    amount: DEMO_INPUT_HIGH.amount,
    vendor: DEMO_INPUT_HIGH.vendor,
    category: "supplies",
    label: "high_risk",
    confidence: 0.88,
    rationale:
      "Globex Industrial is under enhanced monitoring and the amount exceeds the auto-approval threshold.",
  });
  return provider;
}

function seedDeps() {
  return {
    store: prismaRunStore,
    providers: [seedProvider()],
    maxLlmCalls: 20,
    budgetMs: 60_000,
    lockMs: 60_000,
    maxAutoAttempts: 2,
    now: () => new Date(),
    newToken: () => randomUUID(),
  };
}

async function main() {
  const existing = await prisma.workflow.findFirst({
    where: { name: "Invoice Approval" },
  });
  if (existing) {
    console.log("Seed data already present; skipping.");
    return;
  }

  const workflow = await prisma.workflow.create({
    data: {
      name: "Invoice Approval",
      versions: {
        create: {
          version: 1,
          definition: DEMO_WORKFLOW as never,
          grantedPermissions: DEMO_GRANTS as never,
        },
      },
    },
    include: { versions: true },
  });

  const versionId = workflow.versions[0].id;
  console.log(`Created workflow ${workflow.id} version ${versionId}`);

  const deps = seedDeps();

  // A completed run that passed through the approval gate.
  const highRun = await startRun(deps, versionId, DEMO_INPUT_HIGH);
  await advanceRun(deps, highRun.id);

  const steps = await prismaRunStore.listStepExecutions(highRun.id);
  const approval = steps.find((s) => s.status === "AWAITING_APPROVAL");
  if (approval) {
    await decideApproval(
      deps,
      highRun.id,
      approval.id,
      "APPROVED",
      "Checked against vendor policy and approved by finance.",
    );
  }
  console.log(`Seeded completed run ${highRun.id}`);

  // A second completed run that skipped approval entirely.
  const lowRun = await startRun(deps, versionId, DEMO_INPUT_LOW);
  await advanceRun(deps, lowRun.id);
  console.log(`Seeded auto-approved run ${lowRun.id}`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
```

- [ ] **Step 3: Provision the database**

Create a Neon Postgres project at https://neon.tech and copy the pooled connection string.

Create `.env` locally (gitignored — never committed):

```
DATABASE_URL="postgresql://...neon.tech/neondb?sslmode=require"
LLM_PROVIDER=gemini
GEMINI_API_KEY=...
OPENROUTER_API_KEY=...
MAX_LLM_CALLS_PER_RUN=20
```

Run: `npx prisma db push`
Expected: "Your database is now in sync with your Prisma schema."

Run: `npm run db:seed`
Expected: logs a created workflow and two seeded run ids.

- [ ] **Step 4: Verify the seed landed**

Run: `npx prisma studio`
Expected: `Workflow` has 1 row, `Run` has 2 rows both `COMPLETED`, `AuditEvent` has many rows, `ExternalAction` has rows with distinct `idempotencyKey` values.

Close Prisma Studio when done.

- [ ] **Step 5: Commit**

```bash
git add src/seed/workflow.ts prisma/seed.ts
git commit -m "feat: add demo workflow and seed script with completed runs"
```

---

## Task 16: Workflow list and detail UI

**Files:**
- Create: `src/components/StatusBadge.tsx`
- Create: `src/components/JsonBlock.tsx`
- Modify: `src/app/page.tsx`
- Create: `src/app/workflows/[id]/page.tsx`

**Interfaces:**
- Consumes: `/api/workflows`, `/api/workflows/[id]`, `/api/runs`
- Produces: `StatusBadge({ status })`, `JsonBlock({ value, label? })` — reused by Task 17

- [ ] **Step 1: Write the shared presentational components**

`src/components/StatusBadge.tsx`:

```tsx
const STYLES: Record<string, string> = {
  PENDING: "bg-slate-100 text-slate-700 ring-slate-200",
  RUNNING: "bg-blue-50 text-blue-700 ring-blue-200",
  AWAITING_APPROVAL: "bg-amber-50 text-amber-800 ring-amber-200",
  SUCCEEDED: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  COMPLETED: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  FAILED: "bg-rose-50 text-rose-700 ring-rose-200",
  CANCELLED: "bg-slate-100 text-slate-600 ring-slate-200",
  SKIPPED: "bg-slate-50 text-slate-500 ring-slate-200",
};

export function StatusBadge({ status }: { status: string }) {
  const style = STYLES[status] ?? STYLES.PENDING;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${style}`}
    >
      {status.replace(/_/g, " ").toLowerCase()}
    </span>
  );
}
```

`src/components/JsonBlock.tsx`:

```tsx
export function JsonBlock({ value, label }: { value: unknown; label?: string }) {
  if (value === null || value === undefined) return null;
  return (
    <div className="mt-2">
      {label ? (
        <div className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">
          {label}
        </div>
      ) : null}
      <pre className="max-h-64 overflow-auto rounded-md bg-slate-900 p-3 text-xs leading-relaxed text-slate-100">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}
```

- [ ] **Step 2: Write the workflow list page**

`src/app/page.tsx`:

```tsx
import Link from "next/link";
import { prisma } from "@/lib/db";
import { StatusBadge } from "@/components/StatusBadge";

export const dynamic = "force-dynamic";

export default async function Home() {
  const [workflows, runs] = await Promise.all([
    prisma.workflow.findMany({
      orderBy: { createdAt: "desc" },
      include: { versions: { orderBy: { version: "desc" } } },
    }),
    prisma.run.findMany({
      orderBy: { createdAt: "desc" },
      take: 10,
      include: { workflowVersion: { include: { workflow: true } } },
    }),
  ]);

  return (
    <main className="mx-auto max-w-5xl p-8">
      <h1 className="text-2xl font-semibold">Workflow Automation Platform</h1>
      <p className="mt-1 text-sm text-slate-600">
        Define, validate, execute, and inspect controlled agentic workflows.
      </p>

      <section className="mt-8">
        <h2 className="text-lg font-medium">Workflows</h2>
        {workflows.length === 0 ? (
          <p className="mt-3 rounded-md border border-dashed border-slate-300 p-6 text-sm text-slate-500">
            No workflows yet. Run <code className="font-mono">npm run db:seed</code> to load the demo workflow.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-slate-200 rounded-md border border-slate-200 bg-white">
            {workflows.map((w) => (
              <li key={w.id} className="flex items-center justify-between p-4">
                <div>
                  <Link
                    href={`/workflows/${w.id}`}
                    className="font-medium text-blue-700 hover:underline"
                  >
                    {w.name}
                  </Link>
                  <div className="text-xs text-slate-500">
                    {w.versions.length} version{w.versions.length === 1 ? "" : "s"} · latest v
                    {w.versions[0]?.version ?? 0}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-10">
        <h2 className="text-lg font-medium">Recent runs</h2>
        {runs.length === 0 ? (
          <p className="mt-3 rounded-md border border-dashed border-slate-300 p-6 text-sm text-slate-500">
            No runs yet.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-slate-200 rounded-md border border-slate-200 bg-white">
            {runs.map((r) => (
              <li key={r.id} className="flex items-center justify-between p-4">
                <div>
                  <Link
                    href={`/runs/${r.id}`}
                    className="font-medium text-blue-700 hover:underline"
                  >
                    {r.workflowVersion.workflow.name} · v{r.workflowVersion.version}
                  </Link>
                  <div className="font-mono text-xs text-slate-500">{r.id}</div>
                </div>
                <StatusBadge status={r.status} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
```

- [ ] **Step 3: Write the workflow detail page**

`src/app/workflows/[id]/page.tsx`:

```tsx
import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { JsonBlock } from "@/components/JsonBlock";
import { RunLauncher } from "@/app/workflows/[id]/RunLauncher";
import type { WorkflowDefinition } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function WorkflowPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const workflow = await prisma.workflow.findUnique({
    where: { id },
    include: { versions: { orderBy: { version: "desc" } } },
  });
  if (!workflow) notFound();

  const latest = workflow.versions[0];
  const definition = latest?.definition as unknown as WorkflowDefinition;
  const grants = (latest?.grantedPermissions as unknown as string[]) ?? [];

  return (
    <main className="mx-auto max-w-5xl p-8">
      <Link href="/" className="text-sm text-blue-700 hover:underline">
        ← All workflows
      </Link>
      <h1 className="mt-2 text-2xl font-semibold">{workflow.name}</h1>

      <section className="mt-6">
        <h2 className="text-lg font-medium">Versions</h2>
        <ul className="mt-2 flex flex-wrap gap-2">
          {workflow.versions.map((v) => (
            <li
              key={v.id}
              className="rounded-md border border-slate-200 bg-white px-3 py-1 text-sm"
            >
              v{v.version}
              <span className="ml-2 font-mono text-xs text-slate-500">{v.id}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-8">
        <h2 className="text-lg font-medium">Granted permissions</h2>
        <ul className="mt-2 flex flex-wrap gap-2">
          {grants.map((g) => (
            <li
              key={g}
              className="rounded-full bg-slate-100 px-3 py-1 font-mono text-xs text-slate-700"
            >
              {g}
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-8">
        <h2 className="text-lg font-medium">Steps (v{latest?.version})</h2>
        <ol className="mt-3 space-y-2">
          {definition?.steps.map((step, i) => (
            <li
              key={step.id}
              className="rounded-md border border-slate-200 bg-white p-4"
            >
              <div className="flex items-baseline justify-between">
                <span className="font-medium">
                  {i + 1}. {step.name}
                </span>
                <span className="font-mono text-xs text-slate-500">{step.type}</span>
              </div>
              {step.condition ? (
                <JsonBlock value={step.condition} label="condition" />
              ) : null}
              {step.onTrue || step.onFalse ? (
                <div className="mt-2 text-xs text-slate-600">
                  true → <code>{step.onTrue}</code> · false → <code>{step.onFalse}</code>
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      </section>

      {latest ? <RunLauncher versionId={latest.id} /> : null}
    </main>
  );
}
```

`src/app/workflows/[id]/RunLauncher.tsx`:

```tsx
"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

const DEFAULT_INPUT = JSON.stringify(
  {
    invoiceId: "INV-2026-0099",
    vendor: "Globex Industrial",
    amount: 7400,
    description: "Replacement conveyor motors",
  },
  null,
  2,
);

export function RunLauncher({ versionId }: { versionId: string }) {
  const router = useRouter();
  const [input, setInput] = useState(DEFAULT_INPUT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function launch() {
    setBusy(true);
    setError(null);
    try {
      const parsed = JSON.parse(input);
      const response = await fetch("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workflowVersionId: versionId, input: parsed }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error?.message ?? "Failed to start run.");
      router.push(`/runs/${body.run.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-10 rounded-md border border-slate-200 bg-white p-4">
      <h2 className="text-lg font-medium">Run with sample input</h2>
      <textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        rows={8}
        spellCheck={false}
        className="mt-3 w-full rounded-md border border-slate-300 p-3 font-mono text-xs"
      />
      {error ? (
        <p className="mt-2 rounded-md bg-rose-50 p-2 text-sm text-rose-700">{error}</p>
      ) : null}
      <button
        onClick={launch}
        disabled={busy}
        className="mt-3 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {busy ? "Starting…" : "Start run"}
      </button>
    </section>
  );
}
```

- [ ] **Step 4: Verify the pages render**

Run: `npm run dev`
Visit `http://localhost:3000` — the seeded workflow and two runs are listed.
Visit the workflow — steps, permissions, and the run launcher render.

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/components src/app/page.tsx src/app/workflows
git commit -m "feat: add workflow list and detail pages with run launcher"
```

---

## Task 17: Run detail page

**Files:**
- Create: `src/app/runs/[id]/page.tsx`
- Create: `src/app/runs/[id]/RunView.tsx`

**Interfaces:**
- Consumes: `GET /api/runs/[id]`, and the control endpoints from Task 14
- Produces: the reviewer-facing centrepiece — live step timeline, approval panel, retry and cancel controls, LLM call log, and audit trail

Polling: while the run status is `RUNNING`, the client refetches every second and calls
`POST /api/runs/[id]/tick` to drive the next slice of work. This is what turns the
server-side wall-clock budget into continuous progress.

- [ ] **Step 1: Write the server page**

`src/app/runs/[id]/page.tsx`:

```tsx
import Link from "next/link";
import { RunView } from "@/app/runs/[id]/RunView";

export const dynamic = "force-dynamic";

export default async function RunPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <main className="mx-auto max-w-5xl p-8">
      <Link href="/" className="text-sm text-blue-700 hover:underline">
        ← All workflows
      </Link>
      <RunView runId={id} />
    </main>
  );
}
```

- [ ] **Step 2: Write the client view**

`src/app/runs/[id]/RunView.tsx`:

```tsx
"use client";

import { useCallback, useEffect, useState } from "react";
import { JsonBlock } from "@/components/JsonBlock";
import { StatusBadge } from "@/components/StatusBadge";

interface StepRow {
  id: string;
  stepId: string;
  stepType: string;
  status: string;
  attempt: number;
  retrySafe: boolean;
  output: unknown;
  explanation: unknown;
  error: string | null;
}

interface AuditRow {
  id: string;
  type: string;
  payload: unknown;
  createdAt: string;
}

interface LlmRow {
  id: string;
  provider: string;
  model: string;
  status: string;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  error: string | null;
}

interface RunDetail {
  run: { id: string; status: string; error: string | null; input: unknown };
  workflow: { name: string };
  version: { version: number };
  steps: StepRow[];
  audit: AuditRow[];
  llmCalls: LlmRow[];
}

type Tab = "timeline" | "ai" | "audit";

export function RunView({ runId }: { runId: string }) {
  const [data, setData] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>("timeline");

  const load = useCallback(async () => {
    const response = await fetch(`/api/runs/${runId}`, { cache: "no-store" });
    const body = await response.json();
    if (!response.ok) {
      setError(body?.error?.message ?? "Failed to load run.");
      return;
    }
    setData(body);
  }, [runId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Drive the tick loop while the run is still working.
  useEffect(() => {
    if (data?.run.status !== "RUNNING") return;
    const timer = setTimeout(async () => {
      await fetch(`/api/runs/${runId}/tick`, { method: "POST" });
      await load();
    }, 1000);
    return () => clearTimeout(timer);
  }, [data?.run.status, runId, load]);

  async function post(path: string, body?: unknown) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/runs/${runId}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      const parsed = await response.json();
      if (!response.ok) throw new Error(parsed?.error?.message ?? "Request failed.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (error && !data) {
    return <p className="mt-6 rounded-md bg-rose-50 p-4 text-sm text-rose-700">{error}</p>;
  }
  if (!data) {
    return <p className="mt-6 text-sm text-slate-500">Loading run…</p>;
  }

  const pendingApproval = data.steps.find((s) => s.status === "AWAITING_APPROVAL");
  const failedStep = data.steps.find((s) => s.status === "FAILED");
  const isActive = data.run.status === "RUNNING";

  return (
    <div className="mt-2">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">
            {data.workflow.name} · v{data.version.version}
          </h1>
          <p className="font-mono text-xs text-slate-500">{data.run.id}</p>
        </div>
        <StatusBadge status={data.run.status} />
      </div>

      {data.run.error ? (
        <p className="mt-4 rounded-md bg-rose-50 p-3 text-sm text-rose-700">
          {data.run.error}
        </p>
      ) : null}
      {error ? (
        <p className="mt-4 rounded-md bg-rose-50 p-3 text-sm text-rose-700">{error}</p>
      ) : null}
      {isActive ? (
        <p className="mt-4 rounded-md bg-blue-50 p-3 text-sm text-blue-700">
          Run in progress — advancing automatically.
        </p>
      ) : null}

      {pendingApproval ? (
        <section className="mt-6 rounded-md border border-amber-300 bg-amber-50 p-4">
          <h2 className="font-medium text-amber-900">Approval required</h2>
          <p className="mt-1 text-sm text-amber-800">
            Step <code>{pendingApproval.stepId}</code> is waiting for a decision.
          </p>
          <div className="mt-3 flex gap-2">
            <button
              disabled={busy}
              onClick={() =>
                post("/approve", {
                  stepExecutionId: pendingApproval.id,
                  decision: "APPROVED",
                  reason: "Approved from run detail view.",
                })
              }
              className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              Approve
            </button>
            <button
              disabled={busy}
              onClick={() =>
                post("/approve", {
                  stepExecutionId: pendingApproval.id,
                  decision: "REJECTED",
                  reason: "Rejected from run detail view.",
                })
              }
              className="rounded-md bg-rose-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-rose-700 disabled:opacity-50"
            >
              Reject
            </button>
          </div>
        </section>
      ) : null}

      <div className="mt-6 flex gap-2">
        {(["timeline", "ai", "audit"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded-md px-3 py-1.5 text-sm ${
              tab === t ? "bg-slate-900 text-white" : "bg-white text-slate-700 ring-1 ring-slate-200"
            }`}
          >
            {t === "timeline" ? "Steps" : t === "ai" ? `AI calls (${data.llmCalls.length})` : `Audit (${data.audit.length})`}
          </button>
        ))}

        <div className="ml-auto flex gap-2">
          {failedStep ? (
            <button
              disabled={busy}
              onClick={() => post("/retry", { stepExecutionId: failedStep.id })}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              Retry failed step
            </button>
          ) : null}
          {data.run.status === "CANCELLED" || data.run.status === "FAILED" ? (
            <button
              disabled={busy}
              onClick={() => post("/resume")}
              className="rounded-md bg-slate-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-900 disabled:opacity-50"
            >
              Resume
            </button>
          ) : null}
          {isActive || data.run.status === "AWAITING_APPROVAL" ? (
            <button
              disabled={busy}
              onClick={() => post("/cancel")}
              className="rounded-md bg-white px-3 py-1.5 text-sm font-medium text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50 disabled:opacity-50"
            >
              Cancel
            </button>
          ) : null}
        </div>
      </div>

      {tab === "timeline" ? (
        <ol className="mt-4 space-y-3">
          {data.steps.length === 0 ? (
            <li className="rounded-md border border-dashed border-slate-300 p-6 text-sm text-slate-500">
              No steps executed yet.
            </li>
          ) : null}
          {data.steps.map((step) => (
            <li key={step.id} className="rounded-md border border-slate-200 bg-white p-4">
              <div className="flex items-center justify-between">
                <div>
                  <span className="font-medium">{step.stepId}</span>
                  <span className="ml-2 font-mono text-xs text-slate-500">
                    {step.stepType}
                  </span>
                  {step.attempt > 1 ? (
                    <span className="ml-2 text-xs text-slate-500">
                      attempt {step.attempt}
                    </span>
                  ) : null}
                  {!step.retrySafe ? (
                    <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">
                      not auto-retryable
                    </span>
                  ) : null}
                </div>
                <StatusBadge status={step.status} />
              </div>

              {step.error ? (
                <p className="mt-2 rounded bg-rose-50 p-2 text-sm text-rose-700">
                  {step.error}
                </p>
              ) : null}

              {(step.explanation as { description?: string })?.description ? (
                <p className="mt-2 rounded bg-slate-50 p-2 text-sm text-slate-700">
                  Took branch{" "}
                  <code>{(step.explanation as { branchTaken?: string }).branchTaken}</code>{" "}
                  because {(step.explanation as { description: string }).description}
                </p>
              ) : null}

              <JsonBlock value={step.output} label="output" />
            </li>
          ))}
        </ol>
      ) : null}

      {tab === "ai" ? (
        <ul className="mt-4 space-y-2">
          {data.llmCalls.length === 0 ? (
            <li className="rounded-md border border-dashed border-slate-300 p-6 text-sm text-slate-500">
              No AI calls recorded for this run.
            </li>
          ) : null}
          {data.llmCalls.map((call) => (
            <li key={call.id} className="rounded-md border border-slate-200 bg-white p-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="font-medium">
                  {call.provider} · {call.model}
                </span>
                <StatusBadge status={call.status === "SUCCESS" ? "SUCCEEDED" : "FAILED"} />
              </div>
              <div className="mt-1 text-xs text-slate-500">
                {call.latencyMs} ms · in {call.inputTokens ?? "—"} · out {call.outputTokens ?? "—"}
              </div>
              {call.error ? (
                <p className="mt-1 text-xs text-rose-700">{call.error}</p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {tab === "audit" ? (
        <ul className="mt-4 divide-y divide-slate-200 rounded-md border border-slate-200 bg-white">
          {data.audit.map((event) => (
            <li key={event.id} className="p-3">
              <div className="flex items-baseline justify-between">
                <span className="font-mono text-xs font-medium text-slate-800">
                  {event.type}
                </span>
                <span className="text-xs text-slate-500">
                  {new Date(event.createdAt).toLocaleTimeString()}
                </span>
              </div>
              <JsonBlock value={event.payload} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 3: Verify the flow end to end**

Run: `npm run dev`

1. Open the seeded completed run — steps, AI calls, and audit tabs all populate.
2. From the workflow page, start a run with `amount: 7400` — it reaches the approval gate.
3. Approve — the run completes and the external action posts.
4. Start another run with the same input and approve again — the audit tab shows a fresh `TOOL_CALL`, and retrying that step shows `DUPLICATE_WRITE_PREVENTED`.
5. Start a run with `amount: 320` — it skips approval and completes.

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/app/runs
git commit -m "feat: add run detail page with approval, retry, and audit views"
```

---

## Task 18: Deployment and submission documentation

**Files:**
- Create: `README.md`
- Create: `AGENT_USAGE.md`
- Modify: `.env.example` (confirm complete)

**Interfaces:**
- Consumes: everything
- Produces: a live URL plus the two documents the brief requires

- [ ] **Step 1: Push to GitHub**

```bash
git remote add origin https://github.com/<user>/workflow-automation-platform.git
git push -u origin main
```

- [ ] **Step 2: Deploy to Vercel**

1. Import the repository at https://vercel.com/new.
2. Set environment variables: `DATABASE_URL`, `LLM_PROVIDER`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `MAX_LLM_CALLS_PER_RUN`.
3. Deploy.
4. Run `npx prisma db push` and `npm run db:seed` against the production `DATABASE_URL` from your machine.

- [ ] **Step 3: Verify the live deployment**

Confirm on the deployed URL:
- The home page lists the seeded workflow and runs.
- A seeded completed run renders steps, AI calls, and audit trail.
- A new run reaches the approval gate, and approving completes it.
- The AI steps produce real output (proving the live LLM integration works).

- [ ] **Step 4: Write README.md**

Sections, in this order:

1. **What it is** — one paragraph.
2. **Live application** — the URL.
3. **Setup** — clone, `npm install`, copy `.env.example` to `.env`, `npx prisma db push`, `npm run db:seed`, `npm run dev`.
4. **Architecture** — the no-in-memory-state rule, the tick loop, the `RunStore` boundary, the module map from the spec's §4.
5. **Step types** — the eight-row table from the spec's §5, including the retry-safety column.
6. **How each requirement is met** — the mapping table from the spec's §7.
7. **Design decisions** — why no agent framework (spec §3), why single-repo Next.js, why forward-only branching.
8. **Tests** — `npm test`, the ten-row table from the spec's §11, and the note that the suite needs no database or network.
9. **Known limitations** — the six items from the spec's §14.
10. **Deployment** — Vercel plus Neon, environment variables by name.

Do not reproduce the assignment text.

- [ ] **Step 5: Write AGENT_USAGE.md**

Sections:

1. **Tools used** — Claude Code (Opus), with what each phase was used for.
2. **Workflow** — brainstormed design → committed spec → generated implementation plan → executed task-by-task with tests first.
3. **Representative prompts** — three or four real prompts used.
4. **What was delegated** — scaffolding, test-first module implementation, Prisma schema, UI components.
5. **Agent mistakes and rejected suggestions** — record these honestly as they occur during the build. Include at least: the initial suggestion to run the Claude CLI on the server, rejected because a subscription does not grant API access and reviewer traffic would consume a personal quota.
6. **How output was verified** — every engine module built test-first; the full suite runs with no database or network; the live deployment was exercised manually through approval, rejection, retry, and duplicate-write paths.

- [ ] **Step 6: Final verification and commit**

Run: `npm test`
Expected: PASS, all tests.

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npm run build`
Expected: build succeeds.

Confirm no secrets are tracked:

```bash
git ls-files | grep -E "^\.env$"
```

Expected: no output.

```bash
git add README.md AGENT_USAGE.md .env.example
git commit -m "docs: add README and agent usage documentation"
git push
```

---

## Self-Review

**Spec coverage.** Every section of the design spec maps to a task:

| Spec section | Task |
|---|---|
| §3 Stack | 1, 3 |
| §4 Architecture, tick loop, RunStore boundary | 8, 11, 12 |
| §5 Step registry, conditions, forward-only branching | 4, 5, 7, 10 |
| §6 Data model | 3, 8 |
| §7 Requirement mapping (all 13 bullets) | 5, 6, 7, 10, 11, 14 |
| §8 LLM adapter, fallback, budget, mock | 9, 13 |
| §9 API surface | 14 |
| §10 Error taxonomy | 2, 14 |
| §11 Tests 1–10 | 7 (1, 2), 11 (3–9), 9 (10) |
| §12 Seeded demo | 15 |
| §13 Deployment | 18 |
| §14 Known limitations | 18 |

**Type consistency.** `RunStore` method names in Task 8 match every call site in Tasks 9–12.
`StepHandlerDeps` in Task 10 matches the object the runner constructs in Task 11.
`ConditionResult.description` from Task 4 is the field the handler surfaces in Task 10 and
the UI renders in Task 17. `parseJsonStrict` is defined once in Task 13's Gemini module and
imported by OpenRouter.

**Known deviation from strict TDD.** Tasks 12 and 14 (Prisma store, API routes) are covered
by manual verification and the type checker rather than unit tests, because both are thin
adapters over Prisma and Next.js whose meaningful behaviour is already tested through the
in-memory store. Tasks 16–18 are UI and documentation, verified by running the flow. This
is a deliberate trade against the time budget: the graded engine core is test-first, the
adapters are not.
