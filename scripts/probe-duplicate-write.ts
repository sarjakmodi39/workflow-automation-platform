import { prisma } from "@/lib/db";

/*
 * Probe: does the idempotency ledger actually stop a second external write?
 *
 * The failure this guards against is a crash in the window between the external
 * effect happening and the step being recorded as succeeded. On resume the
 * engine cannot tell that window from "never ran", so it re-executes the step —
 * and without a ledger the payment goes out twice.
 *
 * That window cannot be reached through the API, so this reproduces it directly:
 * take a completed run, rewind the external-action step to FAILED and the run to
 * FAILED, and leave the ExternalAction ledger row in place, which is exactly the
 * state a crash after the write would have left behind. Then resume and read
 * back what the second execution did.
 *
 * Run with: npx tsx scripts/probe-duplicate-write.ts <runId>
 */

async function main() {
  const runId = process.argv[2];
  if (!runId) throw new Error("usage: probe-duplicate-write.ts <runId>");

  const before = await prisma.externalAction.findMany({ where: { runId } });
  console.log(`ledger rows before: ${before.length}`);
  for (const row of before) {
    console.log(`  ${row.stepId} key=${row.idempotencyKey.slice(0, 12)}… ref=${(row.response as { ref?: string })?.ref}`);
  }
  if (before.length === 0) throw new Error("run wrote no external action; nothing to duplicate");

  const step = await prisma.stepExecution.findFirst({
    where: { runId, stepType: "mock_external_action" },
    orderBy: { attempt: "desc" },
  });
  if (!step) throw new Error("no external action step execution found");

  // The crash window: the effect happened (ledger row exists) but the step is
  // not recorded as succeeded.
  await prisma.stepExecution.update({
    where: { id: step.id },
    data: { status: "FAILED", error: "simulated crash after external write", finishedAt: null },
  });
  await prisma.run.update({
    where: { id: runId },
    data: { status: "FAILED", error: "simulated crash", cursor: step.stepId },
  });
  console.log(`\nrewound step ${step.stepId} (attempt ${step.attempt}) and run to FAILED`);
  console.log("now resume the run and re-read the ledger.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
