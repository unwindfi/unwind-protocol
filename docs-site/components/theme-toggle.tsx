'use client';

import { Moon, Sun } from '@phosphor-icons/react';
import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';

/*
 * One switch in place of the sun and moon pill: the icon and word name the
 * theme a click moves to. Rendered after mount, since the server cannot know
 * the visitor's theme.
 */
export function ThemeToggle({ className = '' }: { className?: string }) {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const next = resolvedTheme === 'dark' ? 'light' : 'dark';
  const Icon = next === 'dark' ? Moon : Sun;
  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-fd-muted-foreground transition-colors hover:text-fd-foreground ${className}`}
      aria-label={mounted ? `Switch to ${next} theme` : 'Switch theme'}
    >
      {mounted && <Icon size={16} weight="duotone" className="text-fd-foreground" aria-hidden />}
      {mounted ? (next === 'dark' ? 'Dark' : 'Light') : 'Theme'}
    </button>
  );
}
