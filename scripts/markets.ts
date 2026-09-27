/// The markets the local product runs, and the live feeds behind them.
///
/// Every price in this file is fetched, not typed. `feedId` is the real Pyth
/// feed for the xStock token, `mint` is the real Backed mint that trades on
/// Solana, and `underlyingFeedId` is the equity the token tracks -- used only
/// for its trading calendar, since the token trades 24/7 but the underlying
/// does not.

export interface MarketDef {
  symbol: string;
  name: string;
  /// Backed's xStock SPL mint. The price source quotes this.
  mint: string;
  /// Pyth feed id for `Crypto.<SYM>X/USD`, hex. The market keys off this, so
  /// pointing the product at the real receiver later is a config change and
  /// not a migration.
  feedId: string;
  /// Pyth feed id for `Equity.US.<SYM>/USD`, hex. Read for its market hours,
  /// which drive the market's `Session`.
  underlyingFeedId: string;
  maxLeverageBps: number;
  /// Confidence above which the market stops quoting, in bps.
  ///
  /// Set per market, because the basis a token carries against its underlying
  /// is structural rather than incidental: MSTRx sits ~2% above the last equity
  /// print most of the time. A single global threshold either halts that market
  /// permanently or is too loose to catch a real decoupling anywhere else.
  maxConfBps: number;
  /// Must sit below the initial margin implied by `maxLeverageBps`, or a
  /// position would open already liquidatable -- the program rejects that.
  maintenanceMarginBps: number;
  /// Brand colour and monogram for the ticker badge. The UI prefers a real
  /// logo at `app/logos/<SYMBOL>.svg` and falls back to this.
  color: string;
  mono: string;
}

export const MARKETS: MarketDef[] = [
  {
    symbol: "SPYx", name: "SP500",
    mint: "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W",
    feedId:
      "2817b78438c769357182c04346fddaad1178c82f4048828fe0997c3c64624e14",
    underlyingFeedId:
      "19e09bb805456ada3979a7d1cbb4b6d63babc3a0f8e8a9509f68afa5c4c11cd5",
    maxLeverageBps: 200_000, maintenanceMarginBps: 250,
    maxConfBps: 200,
    color: "hsl(12 42% 42%)", mono: "S",
  },
  {
    symbol: "CRCLx", name: "Circle",
    mint: "XsueG8BtpquVJX9LVLLEGuViXUungE6WmK5YZ3p3bd1",
    feedId:
      "c13184461c0c80d98ffcd89be627c2220b94a96c7c67f0c4b16bc12fd3b17758",
    underlyingFeedId:
      "92b8527aabe59ea2b12230f7b532769b133ffb118dfbd48ff676f14b273f1365",
    maxLeverageBps: 50_000, maintenanceMarginBps: 800,
    maxConfBps: 700,
    color: "hsl(352 42% 42%)", mono: "C",
  },
  {
    symbol: "COINx", name: "Coinbase",
    mint: "Xs7ZdzSHLU9ftNJsii5fCeJhoRWSC32SQGzGQtePxNu",
    feedId:
      "641435d5dffb5311140b480517c79986d8488d5cf08a11eec53b83ad02cab33f",
    underlyingFeedId:
      "fee33f2a978bf32dd6b662b65ba8083c6773b494f8401194ec1870c640860245",
    maxLeverageBps: 50_000, maintenanceMarginBps: 800,
    maxConfBps: 700,
    color: "hsl(327 42% 42%)", mono: "C",
  },
  {
    symbol: "TSLAx", name: "Tesla",
    mint: "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB",
    feedId:
      "47a156470288850a440df3a6ce85a55917b813a19bb5b31128a33a986566a362",
    underlyingFeedId:
      "16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1",
    maxLeverageBps: 50_000, maintenanceMarginBps: 800,
    maxConfBps: 700,
    color: "hsl(188 42% 42%)", mono: "T",
  },
  {
    symbol: "HOODx", name: "Robinhood",
    mint: "XsvNBAYkrDRNhA7wPHQfX3ZUXZyZLdnCQDfHZ56bzpg",
    feedId:
      "dd49a9ac6df5cbfa9d8fc6371f7ae927a74d5c6763c1c01b4220d70314c647f9",
    underlyingFeedId:
      "306736a4035846ba15a3496eed57225b64cc19230a50d14f3ed20fd7219b7849",
    maxLeverageBps: 50_000, maintenanceMarginBps: 800,
    maxConfBps: 700,
    color: "hsl(268 42% 42%)", mono: "H",
  },
  {
    symbol: "MSTRx", name: "MicroStrategy",
    mint: "XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ",
    feedId:
      "53f95ba4e23ed15ea56083e2ee9a5eec48055d6f59033d4bb95f1ca2a2349c28",
    underlyingFeedId:
      "e1e80251e5f5184f2195008382538e847fafc36f751896889dd3d1b1f6111f09",
    maxLeverageBps: 50_000, maintenanceMarginBps: 800,
    maxConfBps: 700,
    color: "hsl(356 42% 42%)", mono: "M",
  },
  {
    symbol: "AAPLx", name: "Apple",
    mint: "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp",
    feedId:
      "978e6cc68a119ce066aa830017318563a9ed04ec3a0a6439010fc11296a58675",
    underlyingFeedId:
      "49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688",
    maxLeverageBps: 100_000, maintenanceMarginBps: 500,
    maxConfBps: 300,
    color: "hsl(76 42% 42%)", mono: "A",
  },
  {
    symbol: "MSFTx", name: "Microsoft",
    mint: "XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX",
    feedId:
      "bb723a70af731ab56b9a650eb7e8ac22b7bc07ea77f8670bd1fa9a37bf6df3f5",
    underlyingFeedId:
      "d0ca23c1cc005e004ccf1db5bf76aeb6a49218f43dac3d4b275e92de12ded4d1",
    maxLeverageBps: 100_000, maintenanceMarginBps: 500,
    maxConfBps: 300,
    color: "hsl(284 42% 42%)", mono: "M",
  },
  {
    symbol: "GOOGLx", name: "Alphabet",
    mint: "XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN",
    feedId:
      "b911b0329028cd0283e4259c33809d62942bd2716a58084e5f31d64c00b5424e",
    underlyingFeedId:
      "5a48c03e9b9cb337801073ed9d166817473697efff0d138874e0f6a33d6d5aa6",
    maxLeverageBps: 100_000, maintenanceMarginBps: 500,
    maxConfBps: 300,
    color: "hsl(76 42% 42%)", mono: "G",
  },
  {
    symbol: "METAx", name: "Meta",
    mint: "Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu",
    feedId:
      "bf3e5871be3f80ab7a4d1f1fd039145179fb58569e159aee1ccd472868ea5900",
    underlyingFeedId:
      "78a3e3b8e676a8f73c439f5d749737034b139bbbe899ba5775216fba596607fe",
    maxLeverageBps: 100_000, maintenanceMarginBps: 500,
    maxConfBps: 300,
    color: "hsl(355 42% 42%)", mono: "M",
  },
  {
    symbol: "AMZNx", name: "Amazon",
    mint: "Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg",
    feedId:
      "7148fbe6e493ff2580305c92a8d7f8628c9943b11b9b253aebc24863fec290e8",
    underlyingFeedId:
      "b5d0e0fa58a1f8b81498ae670ce93c872d14434b72c364885d4fa1b257cbb07a",
    maxLeverageBps: 100_000, maintenanceMarginBps: 500,
    maxConfBps: 300,
    color: "hsl(40 42% 42%)", mono: "A",
  },
  {
    symbol: "NVDAx", name: "NVIDIA",
    mint: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh",
    feedId:
      "4244d07890e4610f46bbde67de8f43a4bf8b569eebe904f136b469f148503b7f",
    underlyingFeedId:
      "b1073854ed24cbc755dc527418f52b7d271f6cc967bbf8d8129112b18860a593",
    maxLeverageBps: 100_000, maintenanceMarginBps: 500,
    maxConfBps: 300,
    color: "hsl(147 42% 42%)", mono: "N",
  },
];

/// `Uint8Array`, not `Buffer`.
///
/// This module is the single source of truth for mints, feed ids and risk
/// params, and the web app imports it too — so it has to hold nothing that only
/// exists in Node. `Buffer` is a `Uint8Array` subclass, so every caller here is
/// unaffected, and the browser gets a module it can actually bundle.
export const feedIdFor = (symbol: string): Uint8Array => {
  const m = MARKETS.find((x) => x.symbol === symbol);
  if (!m) throw new Error(`unknown market ${symbol}`);
  const hex = m.feedId;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};

export const bySymbol = (symbol: string): MarketDef => {
  const m = MARKETS.find((x) => x.symbol === symbol);
  if (!m) throw new Error(`unknown market ${symbol}`);
  return m;
};

/// The exponent the xStock feeds publish at, and the one prices are posted at.
export const EXPONENT = -8;
