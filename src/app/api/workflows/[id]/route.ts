import { fail, ok } from "@/lib/api";
import { prisma } from "@/lib/db";
import { NotFoundError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    // Next 15: params is a Promise. Awaiting it is not optional.
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
