/*
 * /api/* -- everything the testnet server answers, forwarded to it.
 *
 * The app calls its API on its own origin, and on Vercel there is no chain
 * behind that origin: the crank, the keeper and the price relay run on our
 * own machine, next to the relay key. This forwards every API path that has
 * no function of its own here (the waitlist's /api/x, /api/me, /api/code,
 * and the mainnet pool preview all do, and Vercel routes them first) to that
 * server, so the browser never needs CORS and the site never needs to know
 * where the server lives.
 *
 * Unset `TESTNET_API_URL` and this answers 404, which the app already reads
 * as "no chain connected" and falls back to its read-only pages.
 */
import { forward } from "./_forward";

const route = async (req: Request) =>
  (await forward(req)) ?? new Response("Not found", { status: 404 });

export { route as GET, route as POST };
