import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import Image from 'next/image';
import { Wordmark } from '@/components/wordmark';
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
    links: [
      { text: 'App', url: appUrl, external: true },
      { text: 'X', url: xUrl, external: true },
    ],
  };
}
