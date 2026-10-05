import { Component, type ReactNode } from "react";

/// Keeps a chart's failure inside the chart. Without it, one error thrown by
/// the charting library unmounted the whole app and left a blank page.
/// `resetKey` (market and timeframe) gives a failed chart a fresh try when
/// it changes, without remounting a healthy one on every switch.
export class ChartBoundary extends Component<
  { children: ReactNode; resetKey: string }, { failed: boolean; key: string }
> {
  state = { failed: false, key: this.props.resetKey };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  static getDerivedStateFromProps(props: { resetKey: string }, state: { failed: boolean; key: string }) {
    return props.resetKey !== state.key ? { failed: false, key: props.resetKey } : null;
  }

  componentDidCatch(error: unknown) {
    console.error("chart:", error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="grid min-h-0 flex-1 place-items-center px-6 text-center">
        <div>
          <p className="text-[14px] font-medium text-foreground">The chart could not draw</p>
          <p className="mt-1.5 text-[12.5px] text-muted-foreground">
            Pick another timeframe, or reload the page.
          </p>
        </div>
      </div>
    );
  }
}
