import { NextRequest, NextResponse } from 'next/server';
import { rewritePath } from 'fumadocs-core/negotiation';
import { docsContentRoute } from '@/lib/shared';

// /mechanism/auction.md serves the page as markdown, for agents.
const { rewrite } = rewritePath('{/*path}.md', `${docsContentRoute}{/*path}/content.md`);

export default function proxy(request: NextRequest) {
  const result = rewrite(request.nextUrl.pathname);
  if (result) return NextResponse.rewrite(new URL(result, request.nextUrl));
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next|api|llms|assets).*\\.md)'],
};
