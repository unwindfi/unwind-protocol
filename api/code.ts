/// POST /api/code -- trade the password for the cookie that opens the site.
import { codeCookie, passes } from "./_code";

export async function POST(req: Request) {
  const form = await req.formData().catch(() => null);
  const ok = passes(String(form?.get("password") ?? ""));
  const to = new URL(ok ? "/markets" : "/code?wrong=1", req.url);
  const r = new Response(null, { status: 303, headers: { location: to.href } });
  if (ok) r.headers.set("Set-Cookie", await codeCookie());
  return r;
}
