import { prisma } from "@/lib/db";

/* Reproduces a crash between an external write and the step being recorded, which the API
 * cannot reach. Usage: npx tsx scripts/probe-duplicate-write.ts <runId>, then resume. */

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
