/** Pretty-printed JSON for values this app did not author. Passed as a text child so React
 *  escapes it — no `dangerouslySetInnerHTML`, no highlighter that re-emits markup. */
export function JsonBlock({ value, label }: { value: unknown; label?: string }) {
  if (value === null || value === undefined) return null;

  let text: string;
  try {
    text = JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    // Reachable for a BigInt or a circular structure. Showing something is
    // better than throwing out of a render.
    text = String(value);
  }

  return (
    <div className="mt-2">
      {label ? (
        <div className="mb-1 text-xs font-medium tracking-wide text-slate-500 uppercase">
          {label}
        </div>
      ) : null}
      <pre className="max-h-64 overflow-auto rounded-md bg-slate-900 p-3 font-mono text-xs leading-relaxed text-slate-100">
        {text}
      </pre>
    </div>
  );
}
