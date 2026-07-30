import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApiErrorNotice } from "@/components/ApiErrorNotice";
import type { ApiFailure } from "@/lib/client-api";

/*
 * Every failure in this UI is rendered by this one component, and the property
 * being tested is that it does not render them all the same way.
 *
 * A 409 and a 500 arrive through identical code paths and differ only in a
 * number, but they call for opposite responses from the reader: a 409 means the
 * server is healthy and the run simply moved on, a 500 means something broke.
 * Rendering both as red "Error" text would satisfy a typechecker and tell the
 * reader nothing, so the distinction is asserted rather than assumed.
 *
 * `renderToStaticMarkup` needs no DOM and no test renderer — `react-dom/server`
 * is already a dependency of the framework.
 */

/** The visible text, with entities decoded and whitespace collapsed. */
function visibleText(element: React.ReactElement): string {
  return renderToStaticMarkup(element)
    .replace(/<[^>]+>/g, " ")
    .replace(/&apos;|&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function failure(status: number, code: string, details: unknown = null): ApiFailure {
  return {
    status,
    error: { code, message: `Message for ${code}.`, retryable: false, details },
  };
}

describe("ApiErrorNotice", () => {
  it("tells the reader a 409 is not a malfunction", () => {
    const text = visibleText(
      <ApiErrorNotice failure={failure(409, "CONFLICT")} context="approving" />,
    );
    expect(text).toContain("Not possible in the current state");
    expect(text).toContain("Nothing is broken");
    expect(text).toContain("HTTP 409");
    expect(text).toContain("while approving");
  });

  it("tells the reader a 500 is a malfunction", () => {
    const text = visibleText(<ApiErrorNotice failure={failure(500, "INTERNAL_ERROR")} />);
    expect(text).toContain("Something broke on the server");
    expect(text).not.toContain("Nothing is broken");
  });

  it("does not describe a 409 and a 500 identically", () => {
    expect(visibleText(<ApiErrorNotice failure={failure(409, "CONFLICT")} />)).not.toBe(
      visibleText(<ApiErrorNotice failure={failure(500, "INTERNAL_ERROR")} />),
    );
  });

  it("names the usual local cause of a 500, which is an unset DATABASE_URL", () => {
    const text = visibleText(<ApiErrorNotice failure={failure(500, "INTERNAL_ERROR")} />);
    expect(text).toContain("DATABASE_URL");
  });

  it("explains that a 403 is fixed by a new version, not by retrying", () => {
    const text = visibleText(<ApiErrorNotice failure={failure(403, "PERMISSION_DENIED")} />);
    expect(text).toContain("Permission not granted");
    expect(text).toContain("saving a new version");
  });

  it("renders a transport failure with no status as its own case", () => {
    const text = visibleText(<ApiErrorNotice failure={failure(0, "NETWORK_ERROR")} />);
    expect(text).toContain("Could not reach the server");
    // "HTTP 0" would be a lie: there was no response to have a status.
    expect(text).toContain("no response");
    expect(text).not.toContain("HTTP 0");
  });

  it("lists validator issues legibly instead of dumping JSON", () => {
    const text = visibleText(
      <ApiErrorNotice
        failure={failure(400, "VALIDATION_ERROR", {
          issues: [
            {
              stepId: "post_payment",
              code: "PERMISSION_NOT_GRANTED",
              message: "Step requires external.write, which this version does not grant.",
            },
          ],
        })}
      />,
    );
    expect(text).toContain("post_payment");
    expect(text).toContain("external.write");
    // The raw `details` block is the fallback for shapes it cannot read; an
    // issues array must not trigger it.
    expect(text).not.toContain('"issues"');
  });

  it("lists request-body issues, which are keyed by path rather than step", () => {
    const text = visibleText(
      <ApiErrorNotice
        failure={failure(400, "VALIDATION_ERROR", {
          issues: [{ path: "definition.steps.0.id", message: "Required." }],
        })}
      />,
    );
    expect(text).toContain("definition.steps.0.id");
  });

  it("renders unreadable details as JSON rather than dropping them", () => {
    const text = visibleText(
      <ApiErrorNotice failure={failure(500, "INTERNAL_ERROR", { unexpected: "shape" })} />,
    );
    expect(text).toContain("unexpected");
    expect(text).toContain("shape");
  });

  it("escapes markup in a server message instead of interpreting it", () => {
    const hostile: ApiFailure = {
      status: 500,
      error: {
        code: "INTERNAL_ERROR",
        message: "<img src=x onerror=alert(1)>",
        retryable: false,
        details: null,
      },
    };
    const markup = renderToStaticMarkup(<ApiErrorNotice failure={hostile} />);
    expect(markup).not.toContain("<img");
    expect(markup).toContain("&lt;img");
  });
});
