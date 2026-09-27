/*
 * Vercel Blob, by hand.
 *
 * The SDK would do this, but the functions are built without installing the
 * repo's dependencies, so this is the two requests it would make -- put and
 * list -- with the headers it would send. Blob authenticates one of two ways,
 * and a store made today uses the second: a read-write token, or the
 * deployment's OIDC token with the store's id. Inside a running function the
 * OIDC token arrives on the request as the x-vercel-oidc-token header; the
 * environment variable of the same name exists only at build time and in
 * local dev. The store id travels in its own header because the token does
 * not carry it.
 *
 * Nothing here reads a blob's contents. Everything a page needs to know
 * about a record is in its pathname, so a listing is the whole query.
 */
const API = "https://vercel.com/api/blob";

function auth(req: Request) {
  const rw = process.env.BLOB_READ_WRITE_TOKEN;
  const oidc = req.headers.get("x-vercel-oidc-token") ?? process.env.VERCEL_OIDC_TOKEN;
  const store = (process.env.BLOB_STORE_ID ?? "").replace(/^store_/, "");
  const token = rw ?? oidc;
  if (!token) throw new Error("no Blob credentials: set BLOB_READ_WRITE_TOKEN or enable OIDC");
  if (!rw && !store) throw new Error("BLOB_STORE_ID is not set");
  return {
    authorization: `Bearer ${token}`,
    "x-api-version": "12",
    ...(store ? { "x-vercel-blob-store-id": store } : {}),
  };
}

/// Write a small private JSON record, overwriting any at the same path.
export async function put(req: Request, pathname: string, data: unknown) {
  const r = await fetch(`${API}/?pathname=${encodeURIComponent(pathname)}`, {
    method: "PUT",
    headers: {
      ...auth(req),
      "x-content-type": "application/json",
      "x-add-random-suffix": "0",
      "x-allow-overwrite": "1",
      "x-vercel-blob-access": "private",
    },
    body: JSON.stringify(data),
  });
  if (!r.ok) throw new Error(`blob put ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

export type Listed = { pathname: string; uploadedAt: string };

/// Every record under a prefix. Pages through, so a prefix with more than
/// one page of records still comes back whole.
export async function list(req: Request, prefix: string): Promise<Listed[]> {
  const out: Listed[] = [];
  let cursor: string | undefined;
  do {
    const q = new URLSearchParams({ prefix, limit: "1000" });
    if (cursor) q.set("cursor", cursor);
    const r = await fetch(`${API}?${q}`, { headers: auth(req) });
    if (!r.ok) throw new Error(`blob list ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = (await r.json()) as { blobs: Listed[]; cursor?: string; hasMore: boolean };
    out.push(...j.blobs);
    cursor = j.hasMore ? j.cursor : undefined;
  } while (cursor);
  return out;
}
