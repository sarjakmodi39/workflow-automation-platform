import type { WorkflowDefinition } from "@/lib/types";

/*
 * Seed workflows.
 *
 * These live here rather than inline in `prisma/seed.ts` for one reason: this
 * module imports nothing that touches a database, so the test suite can assert
 * that every fixture is valid without needing one. A seed that only fails when
 * you run it against Postgres is a seed nobody checks.
 *
 * Ids are fixed strings rather than generated cuids so the seed can upsert.
 * Running `npm run db:seed` twice must leave the same three workflows behind,
 * not six.
 */

export interface SeedVersion {
  id: string;
  version: number;
  definition: WorkflowDefinition;
  grantedPermissions: string[];
  /** What this version is for, shown when the seed runs. */
  note: string;
  /**
   * Set only on the fixture that is deliberately under-granted. Holds the
   * validation code it is expected to produce, so the test asserts the fixture
   * is invalid *for the stated reason* rather than merely invalid.
   */
  expectInvalid?: string;
}

export interface SeedWorkflow {
  id: string;
  name: string;
  versions: SeedVersion[];
  /** A run input that satisfies the workflow's structured_input step. */
  sampleInput: Record<string, unknown>;
}

/**
 * The invoice workflow, parameterised by approval threshold so v1 and v2 differ
 * in exactly one meaningful way. A run pins the version it started on, so
 * lowering the threshold in v2 must not change what an in-flight v1 run does —
 * that is the property the two versions exist to make observable.
 */
function invoiceDefinition(threshold: number): WorkflowDefinition {
  return {
    steps: [
      {
        id: "collect_invoice",
        type: "structured_input",
        name: "Collect invoice",
        config: {
          fields: [
            { name: "invoiceId", kind: "string" },
            { name: "vendor", kind: "string" },
            { name: "amount", kind: "number" },
          ],
        },
      },
      {
        id: "retrieve_policy",
        type: "document_retrieval",
        name: "Retrieve approval policy",
        config: {
          query: "invoice approval threshold vendor risk payment terms",
          topK: 3,
        },
      },
      {
        // Retrieved separately from the policy, and by a *path* rather than a
        // literal, so the documents the classifier sees actually depend on the
        // run input. Classifying the generic policy text instead would make the
        // vendor-risk half of the condition below dead: every run would come
        // back low_risk regardless of who the invoice was from.
        id: "retrieve_vendor",
        type: "document_retrieval",
        name: "Retrieve vendor profile",
        config: { query: "$.steps.collect_invoice.vendor", topK: 2 },
      },
      {
        id: "classify_vendor_risk",
        type: "ai_classification",
        name: "Classify vendor risk",
        config: {
          source: "$.steps.retrieve_vendor.documents",
          labels: ["low_risk", "high_risk"],
        },
      },
      {
        // The control point of the whole design: the model classifies, but a
        // declarative comparator decides. Nothing the model returns can route
        // the run past the approval gate on its own — it can only supply one of
        // two fixed labels to a rule written by a person.
        id: "check_threshold",
        type: "deterministic_condition",
        name: "Does this need a human?",
        config: {},
        condition: {
          anyOf: [
            { left: "$.steps.collect_invoice.amount", op: "gt", right: threshold },
            {
              left: "$.steps.classify_vendor_risk.label",
              op: "eq",
              right: "high_risk",
            },
          ],
        },
        onTrue: "approve_payment",
        onFalse: "post_payment",
      },
      {
        id: "approve_payment",
        type: "human_approval",
        name: "Approve payment",
        config: {
          prompt: `This invoice exceeds ${threshold} USD or the vendor is rated high risk. Approve the payment, or reject to stop the run permanently.`,
        },
      },
      {
        id: "post_payment",
        type: "mock_external_action",
        name: "Issue payment",
        config: {
          action: "issue_payment",
          payload: {
            invoiceId: "$.steps.collect_invoice.invoiceId",
            vendor: "$.steps.collect_invoice.vendor",
            amount: "$.steps.collect_invoice.amount",
          },
        },
      },
      {
        id: "final_summary",
        type: "final_report",
        name: "Summarise the outcome",
        config: { title: "Invoice processing report", summarize: true },
      },
    ],
  };
}

const INVOICE_GRANTS = ["tool:document_search", "tool:llm", "action:issue_payment"];

export const SEED_WORKFLOWS: SeedWorkflow[] = [
  {
    id: "seed_invoice_approval",
    name: "Invoice Approval and Payment",
    sampleInput: {
      invoiceId: "INV-2026-0184",
      vendor: "Globex Industrial",
      amount: 7400,
    },
    versions: [
      {
        id: "seed_invoice_approval_v1",
        version: 1,
        definition: invoiceDefinition(5000),
        grantedPermissions: INVOICE_GRANTS,
        note: "Approval required above 5000 USD, matching the seeded policy corpus.",
      },
      {
        id: "seed_invoice_approval_v2",
        version: 2,
        definition: invoiceDefinition(1000),
        grantedPermissions: INVOICE_GRANTS,
        note: "Threshold lowered to 1000 USD. Runs already started on v1 keep v1's rule.",
      },
    ],
  },
  {
    // Deliberately has no approval gate and no external write: it is the
    // workflow to run first, because it reaches a completed state without
    // needing anyone to make a decision.
    id: "seed_vendor_review",
    name: "Vendor Onboarding Review",
    sampleInput: {
      vendor: "Acme Supplies",
      country: "United Kingdom",
      requestedBy: "procurement@example.com",
    },
    versions: [
      {
        id: "seed_vendor_review_v1",
        version: 1,
        definition: {
          steps: [
            {
              id: "onboarding_request",
              type: "structured_input",
              name: "Onboarding request",
              config: {
                fields: [
                  { name: "vendor", kind: "string" },
                  { name: "country", kind: "string" },
                  { name: "requestedBy", kind: "string" },
                ],
              },
            },
            {
              // The query is a path, not a literal, so the retrieval actually
              // depends on the run input rather than being the same every time.
              id: "vendor_documents",
              type: "document_retrieval",
              name: "Find vendor documents",
              config: { query: "$.steps.onboarding_request.vendor", topK: 2 },
            },
            {
              id: "extract_vendor_facts",
              type: "ai_extraction",
              name: "Extract vendor facts",
              config: {
                source: "$.steps.vendor_documents.documents",
                fields: [
                  { name: "riskRating", kind: "string" },
                  { name: "paymentTerms", kind: "string" },
                ],
              },
            },
            {
              id: "review_report",
              type: "final_report",
              name: "Review report",
              config: { title: "Vendor onboarding review", summarize: true },
            },
          ],
        },
        grantedPermissions: ["tool:document_search", "tool:llm"],
        note: "Analytical only: no approval gate and no external write, so it runs to completion unattended.",
      },
    ],
  },
  {
    /*
     * This fixture exists to make a claim observable rather than asserted.
     *
     * Permissions are checked twice: once by the validator before a version is
     * saved, and again by the runner immediately before a step executes. The
     * API can only ever demonstrate the first, because it refuses to persist a
     * version that fails validation. Writing this one straight to the database
     * is the only way to reach the second check, which is the one that would
     * matter if a version were ever created by any route other than the API.
     *
     * It is expected to fail at `post_payment` with PERMISSION_DENIED, and to
     * leave a PERMISSION_DENIED audit event behind.
     */
    id: "seed_permission_demo",
    name: "Permission Enforcement Demo (fails by design)",
    sampleInput: { invoiceId: "INV-2026-0900", amount: 250 },
    versions: [
      {
        id: "seed_permission_demo_v1",
        version: 1,
        definition: {
          steps: [
            {
              id: "collect_invoice",
              type: "structured_input",
              name: "Collect invoice",
              config: {
                fields: [
                  { name: "invoiceId", kind: "string" },
                  { name: "amount", kind: "number" },
                ],
              },
            },
            {
              id: "post_payment",
              type: "mock_external_action",
              name: "Issue payment without a grant",
              config: {
                action: "issue_payment",
                payload: { invoiceId: "$.steps.collect_invoice.invoiceId" },
              },
            },
          ],
        },
        // The missing grant is `action:issue_payment`. That omission is the
        // entire point of the fixture; do not "fix" it.
        grantedPermissions: [],
        note: "Under-granted on purpose. Running it fails at post_payment with PERMISSION_DENIED.",
        expectInvalid: "PERMISSION_NOT_GRANTED",
      },
    ],
  },
];
