use anchor_lang::prelude::*;

#[error_code]
pub enum PerpError {
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Pool is paused")]
    PoolPaused,
    #[msg("Market is paused")]
    MarketPaused,
    #[msg("Caller is not the pool authority")]
    Unauthorized,
    #[msg("Oracle price is stale")]
    StaleOracle,
    #[msg("Oracle price is not positive")]
    InvalidOraclePrice,
    #[msg("Oracle confidence interval is too wide to trade against")]
    OracleConfidenceTooWide,
    #[msg("Oracle feed id does not match the market")]
    WrongOracleFeed,
    #[msg("Price update account is not owned by the Pyth receiver program")]
    WrongOracleOwner,
    #[msg("Price update account is malformed")]
    InvalidOracleAccount,
    #[msg("Price update is only partially verified")]
    InsufficientOracleVerification,
    #[msg("Position size is below the market minimum")]
    PositionTooSmall,
    #[msg("Leverage exceeds the maximum for this market and session")]
    LeverageTooHigh,
    #[msg("Open interest cap for this side would be exceeded")]
    OpenInterestCapExceeded,
    #[msg("Pool utilization cap would be exceeded")]
    UtilizationCapExceeded,
    #[msg("Position is not liquidatable")]
    PositionHealthy,
    #[msg("Position's profit is still covered by the liquidity reserved against it")]
    PositionCovered,
    #[msg("Position is already liquidatable and cannot be increased")]
    PositionUnhealthy,
    #[msg("Position is already open; close it before opening a new one")]
    PositionAlreadyOpen,
    #[msg("Position is empty")]
    PositionEmpty,
    #[msg("Pool has insufficient free liquidity")]
    InsufficientLiquidity,
    #[msg("market has spent the loss budget it was listed with")]
    MarketBudgetExhausted,
    #[msg("observed mark has too little history to trade against")]
    OracleNotSeasoned,
    #[msg("batch is sealed and awaiting settlement")]
    BatchSealed,
    #[msg("batch is full; the next one opens shortly")]
    BatchFull,
    #[msg("batch has not reached its clearing time")]
    BatchNotDue,
    #[msg("Withdrawal would take the pool below its minimum liquidity")]
    BelowMinimumLiquidity,
    #[msg("Slippage tolerance exceeded")]
    SlippageExceeded,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("A corporate action is pending; the position must be settled first")]
    CorporateActionPending,
    #[msg("Market list passed in remaining_accounts is incomplete")]
    IncompleteMarketList,
    #[msg("Every custody the pool has must be passed, in index order")]
    IncompleteCustodyList,
    #[msg("That token is not one backing can be held in")]
    UnknownCustody,
    #[msg("Market does not belong to this pool")]
    MarketPoolMismatch,
    #[msg("Invalid parameter")]
    InvalidParameter,
    #[msg("Order kind is not supported yet")]
    OrderKindUnsupported,
    #[msg("Price has not reached the order's trigger")]
    OrderNotTriggered,
    #[msg("Market is closed for new positions in the current session")]
    SessionClosed,
    #[msg("A listing's parameters are outside what a permissionless listing may set")]
    ListingOutOfBounds,
    #[msg("An observed market's feed id must be the hash of the pool it observes")]
    ObservedFeedMismatch,
    #[msg("That price is older than one this market has already used")]
    OraclePriceRegressed,
    #[msg("This wallet already has the most orders a batch allows it")]
    TooManyOrders,
    #[msg("Referral codes are 3 to 16 characters of a-z, 0-9, _ and -")]
    InvalidReferralCode,
    #[msg("This wallet already has a referral code")]
    ReferralCodeTaken,
    #[msg("A referrer can only be set once, before the first trade")]
    ReferrerLocked,
    #[msg("A wallet cannot refer itself")]
    SelfReferral,
    #[msg("Nothing to claim")]
    NothingToClaim,
    #[msg("This market's backing is worth nothing while its shares are still held; it cannot take new backing until a gain restores it")]
    BackingWipedOut,
    #[msg("Traders are up more than the pool holds; it cannot take new liquidity until that turns")]
    PoolUnderwater,
    #[msg("Only the pool's mark keeper may push a mark")]
    NotMarkKeeper,
    #[msg("The authority can only lower a market's budget; backing raises it")]
    BudgetOnlyLowers,
}
