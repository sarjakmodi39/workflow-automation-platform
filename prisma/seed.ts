import { prisma } from "@/lib/db";
import { requiredJson } from "@/lib/engine/store.prisma";
import { validateWorkflow } from "@/lib/engine/validator";
import { SEED_WORKFLOWS } from "@/seed/workflows";

/*
 * Seeds the demo workflows. Run with `npm run db:seed` after `npm run db:push`.
 *
 * Idempotent by construction: every row carries a fixed id and is written with
 * `upsert`, so running it twice leaves the same workflows behind rather than a
 * second copy of each. That matters because the natural time to re-run a seed
 * is after a schema change, when duplicate fixtures are the last thing wanted.
 *
 * It does not seed runs. A run is the engine's own output, and fabricating one
 * row by row would put history in the database that no execution ever produced
 * — the audit trail would describe events that did not happen. Runs are created
 * by pressing Run.
 */

async function main() {
  console.log(`Seeding ${SEED_WORKFLOWS.length} workflows…\n`);

  for (const workflow of SEED_WORKFLOWS) {
    await prisma.workflow.upsert({
      where: { id: workflow.id },
      update: { name: workflow.name },
      create: { id: workflow.id, name: workflow.name },
    });

    console.log(`  ${workflow.name}`);

    for (const version of workflow.versions) {
      // Re-validate at write time. The test suite already asserts this, but the
      // suite runs against the fixtures and this runs against the database — and
      // the whole point of validating before persisting is that a version which
      // cannot execute should never reach a row. The one deliberate exception
      // declares itself with `expectInvalid`.
      const issues = validateWorkflow(version.definition, version.grantedPermissions);

      if (version.expectInvalid) {
        const unexpected = issues.filter((i) => i.code !== version.expectInvalid);
        if (issues.length === 0 || unexpected.length > 0) {
          throw new Error(
            `${workflow.name} v${version.version} was expected to be invalid only with ` +
              `${version.expectInvalid}, but produced: ${JSON.stringify(issues)}`,
          );
        }
      } else if (issues.length > 0) {
        throw new Error(
          `${workflow.name} v${version.version} is not valid: ${JSON.stringify(issues)}`,
        );
      }

      const data = {
        version: version.version,
        definition: requiredJson(version.definition),
        grantedPermissions: requiredJson(version.grantedPermissions),
      };

      await prisma.workflowVersion.upsert({
        where: { id: version.id },
        update: data,
        create: { id: version.id, workflowId: workflow.id, ...data },
      });

      const flag = version.expectInvalid ? " [invalid by design]" : "";
      console.log(`    v${version.version}${flag} — ${version.note}`);
    }

    console.log(`    sample input: ${JSON.stringify(workflow.sampleInput)}\n`);
  }

  const counts = {
    workflows: await prisma.workflow.count(),
    versions: await prisma.workflowVersion.count(),
    runs: await prisma.run.count(),
  };
  console.log(
    `Done. ${counts.workflows} workflows, ${counts.versions} versions, ${counts.runs} runs in the database.`,
  );
}

main()
  .catch((error) => {
    console.error("\nSeed failed:", error);
    // A seed that fails must not exit 0. `npm run db:seed && vercel deploy`
    // should stop here, not carry on with an empty database.
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
