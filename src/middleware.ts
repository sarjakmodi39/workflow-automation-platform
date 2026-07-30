import { NextResponse, type NextRequest } from "next/server";

/* Optional shared-password gate, deliberately fail-open: unset APP_PASSWORD leaves the site
 * public, since one forgotten Vercel setting locking everyone out is the worse failure. */

export const config = {
  // Everything except Next's static assets and the favicon.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

const COOKIE = "wap_access";

/** Constant-time-ish compare, so a wrong password does not leak its prefix by timing. */
function matches(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function loginPage(message: string | null, status: number): NextResponse {
  const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in — Workflow Automation Platform</title>
<style>
 body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f8fafc;
   color:#0f172a;font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
 form{background:#fff;padding:28px;border:1px solid #e2e8f0;border-radius:12px;
   width:min(92vw,380px);box-shadow:0 1px 2px rgb(15 23 42 / .06)}
 h1{margin:0 0 18px;font-size:18px}
 input{width:100%;box-sizing:border-box;padding:10px;border:1px solid #cbd5e1;
   border-radius:8px;font-size:15px}
 button{margin-top:14px;width:100%;padding:10px;border:0;border-radius:8px;
   background:#2563eb;color:#fff;font-size:15px;font-weight:600;cursor:pointer}
 button:hover{background:#1d4ed8}
 .err{margin:0 0 14px;padding:10px;border:1px solid #fda4af;background:#fff1f2;
   color:#9f1239;border-radius:8px;font-size:13px}
</style></head><body>
<form method="POST" action="/">
  <h1>Workflow Automation Platform</h1>
  ${message ? `<p class="err">${message}</p>` : ""}
  <input id="p" name="password" type="password" autofocus autocomplete="current-password"
         aria-label="Access password" placeholder="Password">
  <button type="submit">Sign in</button>
</form></body></html>`;

  return new NextResponse(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

export async function middleware(request: NextRequest) {
  const password = (process.env.APP_PASSWORD ?? "").trim();
  if (password === "") return NextResponse.next();

  if (request.cookies.get(COOKIE)?.value === password) return NextResponse.next();

  // The form posts to "/" form-encoded; a JSON POST is an API call and must not be
  // swallowed by the login form.
  const contentType = request.headers.get("content-type") ?? "";
  if (
    request.method === "POST" &&
    request.nextUrl.pathname === "/" &&
    contentType.includes("application/x-www-form-urlencoded")
  ) {
    const submitted = (await request.formData()).get("password");
    if (typeof submitted === "string" && matches(submitted, password)) {
      const response = NextResponse.redirect(new URL("/", request.url), 303);
      response.cookies.set(COOKIE, password, {
        httpOnly: true,
        sameSite: "lax",
        secure: request.nextUrl.protocol === "https:",
        path: "/",
        maxAge: 60 * 60 * 12,
      });
      return response;
    }
    return loginPage("That password is not correct.", 401);
  }

  // Same error body shape as every other failure, so the client never has to parse an
  // HTML login page where it expected JSON.
  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json(
      {
        error: {
          code: "UNAUTHORIZED",
          message: "This deployment is password protected. Sign in on the site first.",
          retryable: false,
          details: null,
        },
      },
      { status: 401 },
    );
  }

  return loginPage(null, 401);
}
