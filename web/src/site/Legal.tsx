import type { ReactNode } from "react";
import { DOCS, LEGAL, RISKS, Shell, SiteFooter, SiteHeader, X_URL } from "@/site/Chrome";

/*
 * The privacy policy, the terms and the risk disclosures, one page each at
 * /privacy, /terms and /disclosures.
 *
 * They describe what unwind actually does: what the site and its server
 * keep (docs/devnet.md says the same), that every action is a transaction the
 * user signs, and that devnet carries no value. There is no company behind
 * unwind yet, so nothing here names one; when there is, these name it.
 */
const UPDATED = "7 October 2026";

type Doc = { title: string; lede: ReactNode; sections: { h: string; body: ReactNode[] }[] };

const out = { target: "_blank", rel: "noreferrer" } as const;
const A = ({ href, children }: { href: string; children: ReactNode }) => (
  <a href={href} {...(href.startsWith("http") ? out : {})}
    className="text-foreground underline underline-offset-2 hover:opacity-80">{children}</a>
);
const contact = <>Send a direct message to <A href={X_URL}>@unwindfi on X</A>.</>;

const DOCS_BY_PATH: Record<string, Doc> = {
  "/privacy": {
    title: "Privacy Policy",
    lede: <>What the unwind site and its server collect, why, and for how long. unwind is a
      project run by its contributors; there is no company behind it yet. Where this says
      "we", it means them.</>,
    sections: [
      { h: "What we collect", body: [
        <><b className="font-medium text-foreground">Wallet addresses.</b> When you connect a
          wallet, the site sends its public address to our server, which keeps the address and
          when it was first and last seen, so we can count wallets. If you sign the welcome
          message, the server checks the signature and records when you signed. We never see
          or hold a private key.</>,
        <><b className="font-medium text-foreground">IP addresses.</b> Our server uses your IP
          address to apply rate limits. Faucet claims and devnet market copies keep the
          address for a day, to enforce their daily limits. A request over a
          limit may be logged with its address.</>,
        <><b className="font-medium text-foreground">The waitlist.</b> If you joined the waitlist
          with X, we keep your X handle and who referred you. We do not keep your X password
          or post on your behalf.</>,
        <><b className="font-medium text-foreground">Usage.</b> The site uses Vercel Web Analytics,
          which counts page views without cookies and without identifying you.</>,
        <><b className="font-medium text-foreground">In your browser.</b> The site stores your
          settings, your accepted welcome, a referral code you arrived with and recent data in
          your browser's local storage, so pages load fast. It stays on your device; clearing
          your site data removes it.</>,
      ] },
      { h: "On-chain data", body: [
        <>Every order, deposit, backing and listing is a Solana transaction signed by your wallet.
          Transactions are public, permanent and readable by anyone, and are not data we can
          change or delete. Anyone can link activity to your wallet address.</>,
      ] },
      { h: "How we use it", body: [
        <>To run the venue: build the transactions you sign, show your positions and rewards,
          rank the leaderboard, and pay referral and creator rewards. To protect it: rate
          limits, faucet limits and abuse checks. To understand use: counting wallets and page
          views. We do not sell personal information or use it for advertising.</>,
      ] },
      { h: "Who else handles it", body: [
        <>Services that run parts of unwind see what they need to: Vercel hosts the site and its
          analytics; our API server runs on a VPS from Hostinger; Cloudflare Turnstile checks
          faucet requests for a human; Solana RPC providers (such as Helius, Alchemy, QuickNode,
          Chainstack and Ankr) carry reads and transactions; GitBook hosts the documentation;
          your wallet app handles your keys. Each has its own privacy policy. We may disclose
          information if the law requires it.</>,
      ] },
      { h: "How long we keep it", body: [
        <>IP addresses on faucet claims and devnet copies: a day. Wallet records and waitlist
          entries: for as long as the project runs, or until you ask us to delete them.
          Rate-limit counters: one minute. Server logs: until the server's system log rotates
          them out.</>,
      ] },
      { h: "Your choices", body: [
        <>You can use the site without connecting a wallet. You can ask us to delete the wallet
          record or waitlist entry we hold for you, or ask what we hold. We cannot delete
          anything on the blockchain. Depending on where you live (for example under the GDPR or
          the CCPA) you may have further rights, and you can complain to your data protection
          authority. {contact}</>,
      ] },
      { h: "Children", body: [
        <>unwind is not for anyone under 18. If we learn we hold information from someone
          under 18, we delete it.</>,
      ] },
      { h: "Security and transfers", body: [
        <>We keep what we hold to the minimum above and protect it with reasonable measures, but
          no system is completely secure. The services above may process data outside your
          country.</>,
      ] },
      { h: "Changes and contact", body: [
        <>We will update this page when what we collect changes, and change the date at the top.
          Questions or requests: {contact}</>,
      ] },
    ],
  },

  "/terms": {
    title: "Terms of Service",
    lede: <>The terms for using the unwind site and the tools it offers. By using them you agree
      to these terms. If you do not agree, do not use them.</>,
    sections: [
      { h: "What unwind is", body: [
        <>unwind is an interface to a program on Solana that runs perpetual futures markets,
          each cleared by batch auction, which anyone can open. The site shows data, prepares
          transactions and sends the ones you sign. It never holds your funds or keys: every
          action is a transaction signed by your own wallet and settled by the program.</>,
        <>unwind is run by its contributors. There is no company behind it yet; these terms will
          name one when there is.</>,
      ] },
      { h: "Devnet", body: [
        <>unwind currently runs on Solana devnet. Its USDC, tokens and positions are test assets
          with no value, and cannot be exchanged for anything that has value. Devnet can be
          reset: markets, pools, balances and positions may be replaced or removed without
          notice.</>,
      ] },
      { h: "Who can use it", body: [
        <>You must be at least 18 and able to agree to these terms. You may not use unwind if you
          are subject to sanctions, or located, resident or organised in a country or region
          under comprehensive sanctions, or anywhere using it is against the law. Tokenised
          stocks are not offered to US persons. You are responsible for following the laws that
          apply to you, including on taxes.</>,
      ] },
      { h: "What you may not do", body: [
        <>Break the law or help anyone else do so; manipulate prices, markets, listings or
          oracles; use many wallets to claim faucet funds, points or rewards meant for one
          person; attack, overload or exploit the site, its API or the program; scrape it in a
          way that degrades it for others; or misrepresent who you are.</>,
        <>We may limit or refuse access to the site or API for anyone who does, without notice.
          We cannot stop transactions sent to the program directly.</>,
      ] },
      { h: "Markets and listings", body: [
        <>Anyone can list a market. A market being listed is not an endorsement of its token, its
          issuer or its price source. Read what a market tracks before trading it. See the{" "}
          <A href="/disclosures">risk disclosures</A>.</>,
      ] },
      { h: "Fees, points and rewards", body: [
        <>Fees are set by the program and shown before you sign. Points, referral rewards,
          creator rewards and any mainnet discount are described in the{" "}
          <A href={DOCS}>documentation</A>. Their rules can change going forward. Points are not a
          token or a security, have no cash value, and do not promise any future token or
          payment.</>,
      ] },
      { h: "No advice", body: [
        <>Nothing on unwind is investment, financial, legal or tax advice, or a recommendation to
          trade. You decide what to do with your wallet.</>,
      ] },
      { h: "Your wallet", body: [
        <>You alone control your wallet and its keys. We cannot recover a lost key, reverse a
          transaction or undo a liquidation.</>,
      ] },
      { h: "Ownership", body: [
        <>The unwind name, logo and site are ours. You may use the site for its purpose; you may
          not copy its design or brand to suggest you are unwind. Feedback you send us we may
          use freely.</>,
      ] },
      { h: "Disclaimers", body: [
        <>unwind is experimental and provided as is and as available, without warranties of any
          kind, including that it is accurate, secure, uninterrupted or fit for any purpose.
          The program is unaudited. Prices, data and third-party services it relies on can be
          wrong or unavailable.</>,
      ] },
      { h: "Limitation of liability", body: [
        <>To the fullest extent the law allows, unwind's contributors are not liable for any
          loss arising from your use of unwind, including losses from trading, liquidation,
          price feeds, bugs, network failures or third-party services, and any liability is
          limited to USD 100.</>,
      ] },
      { h: "Indemnity", body: [
        <>You agree to cover unwind's contributors against claims that arise from your breach of
          these terms or your misuse of unwind.</>,
      ] },
      { h: "Changes and contact", body: [
        <>We may change these terms. The date at the top says when they last changed; using
          unwind after a change means you accept it. If any part is unenforceable, the rest
          still applies. Questions: {contact}</>,
      ] },
    ],
  },

  "/disclosures": {
    title: "Disclosures",
    lede: <>The risks of trading perpetual futures, backing markets and depositing on unwind.
      The full detail, with numbers, is in the <A href={RISKS}>risk notes</A>.</>,
    sections: [
      { h: "Leverage and liquidation", body: [
        <>Perpetual futures are leveraged. A small move against a position can lose its whole
          margin. A position below its maintenance margin is liquidated by a keeper, at a
          price you do not choose, with a fee.</>,
      ] },
      { h: "Batch auction pricing", body: [
        <>Orders do not fill on arrival. They wait for their market's batch and fill at that
          batch's single clearing price, which can differ from the price shown when you sent
          the order, within the limit you set. An order may fill in part or not at all.</>,
      ] },
      { h: "Price sources", body: [
        <>Markets are marked from oracles, from the market's source pool, or by a keeper. A
          source can be wrong, late or moved by trading in a thin pool; the program limits how
          fast a mark can move, which can leave it behind a fast market. On devnet, equity
          prices come from a relay posting Jupiter quotes, and devnet token copies follow
          mainnet prices.</>,
      ] },
      { h: "Listed markets", body: [
        <>Anyone can list a market on a token's pool, including tokens that are illiquid,
          volatile or worthless. Listing is not review or endorsement. A new market runs an
          opening auction before it trades.</>,
      ] },
      { h: "Backing and the pool", body: [
        <>Backing a market takes that market's trader profits first, up to everything you post.
          Depositing in the pool takes losses that backing does not cover. Withdrawals can be
          delayed and are priced when they settle.</>,
      ] },
      { h: "Profit limits", body: [
        <>What a market can pay out is limited by its backing and budget. A profit larger than
          the market can pay may be reduced when it is closed.</>,
      ] },
      { h: "Smart contracts and keepers", body: [
        <>The unwind program is unaudited and may have bugs that lose funds. Batches clear,
          liquidations run and prices update only while keepers run; a stalled keeper leaves
          orders resting and positions unmarked until one runs again. Solana itself can slow,
          halt or reorder transactions.</>,
      ] },
      { h: "Tokenised stocks", body: [
        <>Markets on tokenised stocks (such as xStocks) track tokens issued by third parties,
          not the shares themselves, and are not offered to US persons. unwind is not
          affiliated with their issuers, or with Jupiter, Pyth, Meteora, Raydium or the
          issuers of any asset its markets track.</>,
      ] },
      { h: "Regulation and taxes", body: [
        <>unwind is not registered with any financial regulator, and its markets are not
          protected by any investor compensation scheme. Trading may be restricted where you
          live, and may be taxable.</>,
      ] },
      { h: "Devnet", body: [
        <>Devnet settles in test USDC against test copies of tokens. Nothing on devnet has value,
          and devnet can be reset at any time. Results on devnet say nothing about results on
          mainnet.</>,
      ] },
    ],
  },
};

export default function Legal() {
  const path = location.pathname.replace(/(.)\/$/, "$1");
  const doc = DOCS_BY_PATH[path] ?? DOCS_BY_PATH["/terms"];
  return (
    <div className="site flex min-h-full flex-col">
      <SiteHeader />
      <Shell main className="pb-14 pt-6 sm:pt-10">
        <div className="grid gap-8 lg:grid-cols-[200px_minmax(0,1fr)]">
          <nav aria-label="Legal" className="flex gap-1 overflow-x-auto lg:sticky lg:top-24 lg:flex-col lg:self-start">
            {LEGAL.map((n) => (
              <a key={n.href} href={n.href} aria-current={n.href === path ? "page" : undefined}
                className="whitespace-nowrap rounded-[10px] px-3 py-2 text-[14px] text-muted-foreground
                           transition-colors hover:text-foreground aria-[current=page]:bg-panel2
                           aria-[current=page]:text-foreground">
                {n.label}
              </a>
            ))}
          </nav>
          <article className="max-w-[72ch]">
            <h1 className="text-balance text-[clamp(1.8rem,3.4vw,2.4rem)] font-semibold leading-[1.1] tracking-[-.02em]">
              {doc.title}
            </h1>
            <p className="mt-2 text-[13px] text-dim">Last updated {UPDATED}</p>
            <p className="text-pretty mt-5 text-[15px] leading-[1.65] text-muted-foreground">{doc.lede}</p>
            <ol className="mt-8 flex flex-col">
              {doc.sections.map((s, i) => (
                <li key={s.h} id={s.h.toLowerCase().replace(/[^a-z]+/g, "-")}
                  className="border-t border-line py-6">
                  <h2 className="text-[16px] font-semibold tracking-[-.01em]">
                    <span className="n mr-3 text-dim">{String(i + 1).padStart(2, "0")}</span>{s.h}
                  </h2>
                  {s.body.map((b, j) => (
                    <p key={j} className="text-pretty mt-3 text-[14.5px] leading-[1.7] text-muted-foreground">{b}</p>
                  ))}
                </li>
              ))}
            </ol>
          </article>
        </div>
      </Shell>
      <SiteFooter />
    </div>
  );
}
