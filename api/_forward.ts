/*
 * Forwarding to the testnet server, shared by the API routes that defer to it.
 *
 * Underscored, so Vercel does not serve it as a route of its own.
 */
export const TESTNET = process.env.TESTNET_API_URL?.replace(/\/$/, "");
const TIMEOUT_MS = 30_000;

/// The testnet server's answer to this request, or null when no testnet is
/// connected. Only the headers the server reads are passed on.
export async function forward(req: Request): Promise<Response | null> {
  if (!TESTNET) return null;
  const url = new URL(req.url);
  // Deeper paths reach the catch-all through a rewrite in vercel.json, which
  // carries the path they came in on. Vercel's catch-all only matches one
  // segment outside Next.js, and a function per path runs into the plan's cap.
  const original = url.searchParams.get("__path");
  if (original) {
    for (const k of ["__path", "first", "rest"]) url.searchParams.delete(k);
    url.pathname = "/api/" + original;
  }
  const headers = new Headers({ accept: req.headers.get("accept") ?? "*/*" });
  const type = req.headers.get("content-type");
  if (type) headers.set("content-type", type);
  // The server rate-limits the faucet by caller, and without this every
  // caller would be Vercel.
  const ip = req.headers.get("x-real-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0];
  if (ip) headers.set("x-forwarded-for", ip.trim());

  try {
    const r = await fetch(TESTNET + url.pathname + url.search, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const out = new Headers({ "cache-control": r.headers.get("cache-control") ?? "no-store" });
    const outType = r.headers.get("content-type");
    if (outType) out.set("content-type", outType);
    // Streamed through as is. The cast is only for the server, which imports
    // this module under Node's types, where the two stream types differ.
    return new Response(r.body as any, { status: r.status, headers: out });
  } catch {
    return Response.json({ ok: false, error: "testnet server unreachable" }, { status: 502 });
  }
}
