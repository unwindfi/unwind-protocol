/*
 * Says what this deploy is, once, where it cannot be missed.
 *
 * The prices, spreads and charts here are the real thing — the same Jupiter and
 * Pyth sources the server reads. What is missing is the chain: no pool, no
 * position, no keeper, so open interest and funding are zero and an order has
 * nowhere to settle. Leaving that unsaid would make a working page look broken;
 * saying it turns the same page into an honest demo of the pricing layer.
 */
export function ReadOnlyNotice() {
  return (
    /*
     * Opaque, and in the page's own greys.
     *
     * The bar is part of the page's sticky chrome, so the table scrolls
     * underneath it; a see-through fill would let a row of prices read
     * straight through the sentence. The second panel colour is the one /list
     * uses for everything secondary, and the bold lead is what marks it out,
     * without an icon or a tint to do it.
     */
    <div className="flex flex-none items-start border-b border-line bg-panel2 px-5 py-2.5
                    text-[12.5px] text-muted-foreground md:items-center">
      <span>
        <span className="font-medium text-foreground">Live prices, read-only.</span>{" "}
        Trading opens with devnet.
      </span>
    </div>
  );
}
