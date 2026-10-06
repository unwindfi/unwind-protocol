import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import Image from 'next/image';
import { Wordmark } from '@/components/wordmark';
import { ThemeToggle } from '@/components/theme-toggle';
import { ArrowSquareOut, XLogo } from '@phosphor-icons/react/ssr';
import { appUrl, xUrl } from './shared';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="flex items-center gap-2" aria-label="unwind docs">
          <Image src="/logo-mark.webp" alt="" width={24} height={24} priority />
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
        icon: <ArrowSquareOut weight="duotone" className="text-fd-primary" />,
      },
      {
        text: 'X',
        url: xUrl,
        external: true,
        icon: <XLogo weight="duotone" className="text-fd-primary" />,
      },
    ],
  };
}
