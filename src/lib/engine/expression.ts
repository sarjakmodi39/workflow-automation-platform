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
