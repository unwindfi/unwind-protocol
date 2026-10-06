# Third-party notices

## sales-crm by Kargul Studio (MIT)

Parts of the web app's interface are adapted from the sales-crm template by
Kargul Studio, used under the MIT License below. Each derived file names its
source in a comment on its first line.

| File in this repo | Adapted from |
| --- | --- |
| `web/src/components/ui/command.tsx` | `components/_ui/command.tsx` |
| `web/src/components/CommandMenu.tsx` | `components/companies/command-menu/command-menu.tsx` |

```
MIT License

Copyright (c) 2026 Kargul Studio

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## beUI by Saurabh Chauhan (MIT)

The components under `web/src/components/beui/` are adapted from beUI
(beui.dev, github.com/starc007/beui), used under the MIT License below. They
were restyled to the site's tokens and moved off Next.js APIs. Each file names
its beUI source in a comment on its first line.

The earlier beUI pieces vendored in `web/src/components/motion/` and `web/src/lib/` (each marked with a `beui.dev/...` comment) are under the same license:
`web/src/components/motion/animated-number.tsx`, `web/src/components/motion/animated-toast-stack.tsx`, `web/src/components/motion/digit-swap.tsx`, `web/src/components/motion/number-ticker.tsx`, `web/src/components/motion/range-slider.tsx`, `web/src/components/motion/switch.tsx`, `web/src/components/motion/table/index.tsx`, `web/src/components/motion/tabs.tsx`, `web/src/components/motion/tooltip.tsx`.

| File in this repo | Adapted from |
| --- | --- |
| `web/src/components/beui/_shared/tooltip-surface.tsx` | `components/motion/tooltip-surface.tsx` |
| `web/src/components/beui/_shared/tooltip.tsx` | `components/motion/tooltip.tsx` |
| `web/src/components/beui/_shared/tooltip/positioner.tsx` | `components/motion/tooltip/positioner.tsx` |
| `web/src/components/beui/_shared/tooltip/use-position.ts` | `components/motion/tooltip/use-position.ts` |
| `web/src/components/beui/_shared/use-hover-capable.ts` | `lib/hooks/use-hover-capable.ts` |
| `web/src/components/beui/status-bar.tsx` | `components/charts/status-bar.tsx` |
| `web/src/components/beui/status-bar/context.ts` | `components/charts/status-bar/context.ts` |
| `web/src/components/beui/status-bar/legend.tsx` | `components/charts/status-bar/legend.tsx` |
| `web/src/components/beui/status-bar/plot.tsx` | `components/charts/status-bar/plot.tsx` |
| `web/src/components/beui/status-bar/tooltip.tsx` | `components/charts/status-bar/tooltip.tsx` |

```
MIT License

Copyright (c) 2026 Saurabh Chauhan

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
