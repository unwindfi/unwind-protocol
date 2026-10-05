/*
 * What a signed-in visitor sees instead of the join button.
 *
 * A waitlist for a permissionless venue cannot dangle much: anyone can open
 * a market and anyone can trade one, so there is no queue to jump and no
 * place to win. The panel confirms who is on the list, hands them a link,
 * and stops.
 *
 * Referrals are still counted, quietly, because a number that exists is
 * worth showing and because whatever comes after this will want the
 * history. It is stated as a fact, never as progress toward anything.
 */
import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { NumberTicker } from "@/components/motion/number-ticker";
import { SiX } from "@icons-pack/react-simple-icons";
import { OUTLINE } from "@/site/Chrome";

export type Me = {
  id: string;
  handle: string;
  link: string;
  referrals: { ts: string; id: string; handle: string }[];
};

export function Joined({ me }: { me: Me }) {
  const [copied, setCopied] = useState(false);
  const joined = me.referrals.length;

  async function copy() {
    try {
      await navigator.clipboard.writeText(me.link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* the link below is selectable, which is the fallback */ }
  }
  const share = "https://x.com/intent/post?text=" + encodeURIComponent(
    `Perps on anything with an on-chain price. One batch, one price. ` +
    `I'm on the unwind waitlist: ${me.link}`);

  return (
    <div className="mx-auto w-full max-w-[480px] text-left">
      {/* Opaque, not tinted glass: the device is drawn behind this and a
          translucent card let it through the type. */}
      <div className="rounded-[24px] border border-line bg-panel2 p-5 sm:p-6">
        <h2 className="text-balance text-[17px] font-medium tracking-[-.01em]">@{me.handle} is on the list.</h2>

        <label htmlFor="waitlist-link" className="mb-2 mt-5 block text-[13px] text-foreground">
          Your link
        </label>
        <input id="waitlist-link" readOnly value={me.link}
          onFocus={(e) => e.currentTarget.select()}
          className="n h-[44px] w-full truncate rounded-[12px] border border-line bg-panel px-3.5
                     text-[12.5px] text-muted-foreground focus:border-foreground/40" />

        <div className="mt-4 grid grid-cols-2 gap-2.5">
          <button type="button" onClick={copy}
            className="press flex h-[48px] items-center justify-center gap-2 whitespace-nowrap rounded-full
                       bg-foreground px-3 text-[14px] font-medium text-background transition-opacity
                       hover:opacity-90">
            {copied ? <Check size={15} /> : <Copy size={15} />}
            {copied ? "Copied" : "Copy your link"}
          </button>
          <a href={share} target="_blank" rel="noreferrer"
            className={`${OUTLINE} flex h-[48px] items-center justify-center gap-2 whitespace-nowrap !px-3 !py-0 !text-[14px]`}>
            <SiX size={15} aria-hidden /> Share on X
          </a>
        </div>

        {joined > 0 && (
          /* The one number on the page, so it rolls in rather than being
             printed. beUI's NumberTicker. */
          <div className="mt-5 flex items-baseline justify-between gap-4 border-t border-line pt-3">
            <span className="text-[12.5px] text-muted-foreground">Joined through your link</span>
            <NumberTicker value={joined} className="n text-[12.5px] font-semibold" />
          </div>
        )}
      </div>
    </div>
  );
}
