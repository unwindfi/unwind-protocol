/*
 * What a failed transaction says, in words a trader can act on.
 *
 * The program's errors arrive as Anchor custom codes ("custom program error:
 * 0x1771"), as their variant names, or as their `#[msg]` text once the
 * server has explained them. Every one of those maps to one short line here.
 * Raw text never reaches the page; it goes to `console.debug` instead.
 *
 * PROGRAM_ERRORS is PerpError (programs/unwind/src/errors.rs) in order, so an
 * entry's code is 6000 plus its index. `npm run check:errors` (also run by
 * the build) fails when the two drift apart.
 */

/// [variant, the program's #[msg], what the page says].
export const PROGRAM_ERRORS: readonly (readonly [string, string, string])[] = [
  ["MathOverflow", "Math overflow", "Amount too large to work out"],
  ["PoolPaused", "Pool is paused", "The pool is paused"],
  ["MarketPaused", "Market is paused", "This market is paused"],
  ["Unauthorized", "Caller is not the pool authority", "Not allowed for this wallet"],
  ["StaleOracle", "Oracle price is stale", "Price feed is behind, try again shortly"],
  ["InvalidOraclePrice", "Oracle price is not positive", "Price feed is not usable right now"],
  ["OracleConfidenceTooWide", "Oracle confidence interval is too wide to trade against", "Price is too uncertain to trade, try again shortly"],
  ["WrongOracleFeed", "Oracle feed id does not match the market", "Wrong price feed for this market"],
  ["WrongOracleOwner", "Price update account is not owned by the Pyth receiver program", "Price feed account is not valid"],
  ["InvalidOracleAccount", "Price update account is malformed", "Price feed account is not valid"],
  ["InsufficientOracleVerification", "Price update is only partially verified", "Price update is not fully verified, try again"],
  ["PositionTooSmall", "Position size is below the market minimum", "Below the minimum size"],
  ["LeverageTooHigh", "Leverage exceeds the maximum for this market and session", "Leverage is above this market's maximum"],
  ["OpenInterestCapExceeded", "Open interest cap for this side would be exceeded", "This side of the market is full, lower the size"],
  ["UtilizationCapExceeded", "Pool utilization cap would be exceeded", "The pool is at capacity, lower the size"],
  ["PositionHealthy", "Position is not liquidatable", "Position is not liquidatable"],
  ["PositionCovered", "Position's profit is still covered by the liquidity reserved against it", "Position is still covered by the pool"],
  ["PositionUnhealthy", "Position is already liquidatable and cannot be increased", "Position is near liquidation and can't grow"],
  ["PositionAlreadyOpen", "Position is already open; close it before opening a new one", "Close the open position first"],
  ["PositionEmpty", "Position is empty", "No open position"],
  ["InsufficientLiquidity", "Pool has insufficient free liquidity", "Not enough free liquidity in the pool"],
  ["MarketBudgetExhausted", "market has spent the loss budget it was listed with", "This market has used its loss budget"],
  ["OracleNotSeasoned", "observed mark has too little history to trade against", "This market's price is too new to trade"],
  ["BatchSealed", "batch is sealed and awaiting settlement", "Batch is settling, try again in a second"],
  ["BatchFull", "batch is full; the next one opens shortly", "Batch is full, try again in a second"],
  ["BatchNotDue", "batch has not reached its clearing time", "Batch is not ready to clear yet"],
  ["BelowMinimumLiquidity", "Withdrawal would take the pool below its minimum liquidity", "Would take the pool below its minimum"],
  ["SlippageExceeded", "Slippage tolerance exceeded", "Price moved, try again"],
  ["ZeroAmount", "Amount must be greater than zero", "Enter an amount above zero"],
  ["CorporateActionPending", "A corporate action is pending; the position must be settled first", "A corporate action is pending, settle the position first"],
  ["IncompleteMarketList", "Market list passed in remaining_accounts is incomplete", "Market list was incomplete, try again"],
  ["IncompleteCustodyList", "Every custody the pool has must be passed, in index order", "Token list was incomplete, try again"],
  ["UnknownCustody", "That token is not one backing can be held in", "That token can't be used for backing"],
  ["MarketPoolMismatch", "Market does not belong to this pool", "Market is not in this pool"],
  ["InvalidParameter", "Invalid parameter", "One of the values is not valid"],
  ["OrderKindUnsupported", "Order kind is not supported yet", "That order type is not supported yet"],
  ["OrderNotTriggered", "Price has not reached the order's trigger", "Price has not reached the trigger"],
  ["SessionClosed", "Market is closed for new positions in the current session", "Market is closed for new positions"],
  ["ListingOutOfBounds", "A listing's parameters are outside what a permissionless listing may set", "Listing settings are outside the allowed range"],
  ["ObservedFeedMismatch", "An observed market's feed id must be the hash of the pool it observes", "Price feed does not match the pool"],
  ["OraclePriceRegressed", "That price is older than one this market has already used", "Price update was out of date, try again"],
  ["TooManyOrders", "This wallet already has the most orders a batch allows it", "Too many orders in this batch"],
  ["InvalidReferralCode", "Referral codes are 3 to 16 characters of a-z, 0-9, _ and -", "Codes are 3 to 16 of a-z, 0-9, _ and -"],
  ["ReferralCodeTaken", "This wallet already has a referral code", "This wallet already has a code"],
  ["ReferrerLocked", "A referrer can only be set once, before the first trade", "Referrer is already set"],
  ["SelfReferral", "A wallet cannot refer itself", "You can't refer yourself"],
  ["NothingToClaim", "Nothing to claim", "Nothing to claim"],
  ["BackingWipedOut", "This market's backing is worth nothing while its shares are still held; it cannot take new backing until a gain restores it", "This market's backing is wiped out for now"],
  ["PoolUnderwater", "Traders are up more than the pool holds; it cannot take new liquidity until that turns", "Pool is underwater, deposits are paused"],
  ["NotMarkKeeper", "Only the pool's mark keeper may push a mark", "Only the mark keeper can do that"],
  ["BudgetOnlyLowers", "The authority can only lower a market's budget; backing raises it", "Budget can only be lowered"],
  ["RewardsPoolMismatch", "These rewards were earned in another pool and are paid only from it", "These rewards belong to another pool"],
  ["LpAccountRequired", "This wallet holds an LP stake; show its LP token account", "LP token account missing, try again"],
  ["AumCheckpointStale", "The pool's valuation checkpoint is stale or incomplete; run checkpoint_aum and try again", "Pool value is updating, try again"],
  ["WithdrawCooling", "This withdrawal is still in its cooldown; claim it once the wait is over", "Withdrawal is still cooling down"],
  ["OracleFromFuture", "That price's publish time is ahead of the chain's clock", "Price update is ahead of the chain, try again"],
  ["OraclePriceConflict", "A different price was already used under this publish time", "Conflicting price update, try again"],
  ["MarginEnvelope", "Maintenance margin must cover the risk price's largest step plus the liquidation fee", "Margin settings are outside the allowed range"],
  ["WrongGeneration", "That is not the next generation of this market; read its MarketGenerations account and list the one after `latest`", "Market version changed, reload and try again"],
  ["NotMarketDeployer", "Only the market's lister may create its observation", "Only the lister can do that"],
  ["PoolEarnsNoPoints", "This pool earns no points: it was not created by the program's upgrade authority", "This pool earns no points"],
];

const FIRST_CODE = 6000;
const byName = new Map(PROGRAM_ERRORS.map(([n, , c]) => [n, c]));
const byMsg = PROGRAM_ERRORS.map(([, m, c]) => [m.toLowerCase(), c] as const);

export const REJECTED = "Rejected in wallet";
const NO_SOL = "Not enough SOL";
const EXPIRED = "Took too long, try again";
const GENERIC = "Not accepted. Check your balance and try again.";

/// The last SOL price this page read, for putting a dollar figure beside a
/// shortfall in SOL.
let solUsd = 0;
export const noteSolPrice = (usd: number) => { if (usd > 0) solUsd = usd; };

/// "Not enough SOL: about 9.96 SOL more ($1,106.59)". The shortfall is SOL,
/// and may be most of what is being sent (backing in SOL), so it says neither
/// "fees" nor a bare dollar figure.
export function solShortfall(sol: number): string {
  const amount = sol.toFixed(sol < 0.1 ? 3 : 2);
  const usd = sol * solUsd;
  const worth = usd >= 0.01
    ? ` (${usd.toLocaleString("en-US", { style: "currency", currency: "USD" })})` : "";
  return `${NO_SOL}: about ${amount} SOL more${worth}`;
}

/// A program error's copy by its custom code, or null when it is not one.
function byCode(code: number): string | null {
  if (code >= FIRST_CODE && code < FIRST_CODE + PROGRAM_ERRORS.length) {
    return PROGRAM_ERRORS[code - FIRST_CODE][2];
  }
  // The token program's own: 0x1 is insufficient funds, 0x11 a frozen account.
  if (code === 1) return "Not enough funds in the wallet";
  if (code === 0x11) return "That token account is frozen";
  // Anchor's framework errors (account and constraint checks, 100 to 5999).
  if (code >= 100 && code < FIRST_CODE) return "Not accepted by the program, try again";
  return null;
}

/// Lines this file writes, so translating twice changes nothing.
const OURS = new Set([...PROGRAM_ERRORS.map(([, , c]) => c), REJECTED, EXPIRED, GENERIC]);

function translate(raw: string): string {
  const s = raw.trim();
  if (!s) return GENERIC;
  // Not enough SOL: the server's own line carries how much more is needed.
  // Read before the pass-through below, which its first words would match.
  const short = s.match(/about ([\d.]+) SOL more needed/i);
  if (short) return solShortfall(Number(short[1]));
  if (OURS.has(s) || s.startsWith(NO_SOL)) return s;
  if (s === REJECTED || /user rejected|rejected the request|denied|cancell?ed by user/i.test(s)) return REJECTED;

  if (/insufficient lamports|insufficient funds for (fee|rent)|InsufficientFundsFor(Fee|Rent)|no record of a prior credit|Not enough SOL/i.test(s)) {
    return NO_SOL;
  }
  if (/blockhash not found|BlockhashNotFound|block ?height exceeded|has expired|TransactionExpired|timed? ?out/i.test(s)) {
    return EXPIRED;
  }
  if (/already been processed|AlreadyProcessed/i.test(s)) return "Already sent. Refresh to see it";
  if (/^InsufficientFunds$|insufficient funds/i.test(s)) return "Not enough funds in the wallet";
  if (/exceeded CUs meter|ComputationalBudgetExceeded|Computational budget exceeded|ran out of compute/i.test(s)) {
    return "Ran out of compute, try again";
  }
  if (/AccountInUse|account in use|WouldExceed\w*Limit/i.test(s)) return "The network is busy, try again";

  const hex = s.match(/custom program error: (0x[0-9a-f]+)/i);
  const dec = s.match(/"Custom":\s*(\d+)|Error Number: (\d+)/);
  const code = hex ? parseInt(hex[1], 16) : dec ? Number(dec[1] ?? dec[2]) : null;
  if (code != null) return byCode(code) ?? GENERIC;

  const name = s.match(/Error Code: (\w+)/)?.[1] ?? (byName.has(s) ? s : null);
  if (name && byName.has(name)) return byName.get(name)!;

  const lower = s.toLowerCase();
  const msg = byMsg.find(([m]) => lower.includes(m));
  if (msg) return msg[1];

  // Anything still shaped like a log line is not for the page.
  if (/simulation failed|0x[0-9a-f]+|InstructionError|Program log|Error:|\{|\bat \w+ \(/i.test(s)) return GENERIC;
  // The server's own sentences, already written for a reader.
  return s;
}

/// What the page says for a failure. The raw text goes to the console.
export function humanError(raw: unknown): string {
  const s = typeof raw === "string" ? raw : String((raw as any)?.message ?? raw ?? "");
  const out = translate(s);
  if (out !== s) console.debug("[unwind] error:", s);
  return out;
}
