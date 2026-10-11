import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { Wordmark } from '@/components/wordmark';
import { ThemeToggle } from '@/components/theme-toggle';
import { ArrowSquareOut, XLogo } from '@phosphor-icons/react/ssr';
import { appUrl, xUrl } from './shared';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="flex items-center gap-2" aria-label="unwind docs">
          {/* The final flat mark as a mask over the text colour, so it follows
              the theme: white on dark, near-black on light. */}
          <span aria-hidden className="inline-block size-6 bg-current"
            style={{ WebkitMask: 'url(/logo-mark.png) center / contain no-repeat',
                     mask: 'url(/logo-mark.png) center / contain no-repeat' }} />
          <Wordmark height={15} />
          <span className="text-sm font-medium text-fd-muted-foreground">docs</span>
        </span>
      ),
      url: '/',
    },
    themeSwitch: { component: <ThemeToggle /> },
    links: [
      {
        text: 'App',
        url: appUrl,
        external: true,
        icon: <ArrowSquareOut weight="duotone" className="text-fd-foreground" />,
      },
      {
        text: 'X',
        url: xUrl,
        external: true,
        icon: <XLogo weight="duotone" className="text-fd-foreground" />,
      },
    ],
  };
}
