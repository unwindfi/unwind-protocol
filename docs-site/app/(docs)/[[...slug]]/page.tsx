import { source } from '@/lib/source';
import {
  DocsBody,
  DocsPage,
  DocsTitle,
  MarkdownCopyButton,
} from 'fumadocs-ui/layouts/docs/page';
import { notFound } from 'next/navigation';
import { getMDXComponents } from '@/components/mdx';
import type { Metadata } from 'next';
import Image from 'next/image';
import { createRelativeLink } from 'fumadocs-ui/mdx';
import { getPageMarkdownUrl, siteName } from '@/lib/shared';

export default async function Page(props: PageProps<'/[[...slug]]'>) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  const MDX = page.data.body;
  const { cover } = page.data;

  return (
    <DocsPage toc={page.data.toc} full={page.data.full}>
      {cover && (
        <Image
          src={cover}
          alt=""
          width={1990}
          height={796}
          priority
          className="mb-2 w-full rounded-xl border object-cover"
        />
      )}
      <DocsTitle>{page.data.title}</DocsTitle>
      <div className="flex flex-row gap-2 items-center border-b pb-6">
        <MarkdownCopyButton markdownUrl={getPageMarkdownUrl(page).url} />
      </div>
      <DocsBody>
        <MDX
          components={getMDXComponents({
            a: createRelativeLink(source, page),
          })}
        />
      </DocsBody>
    </DocsPage>
  );
}

export async function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata(props: PageProps<'/[[...slug]]'>): Promise<Metadata> {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  const isIndex = page.slugs.length === 0;
  return {
    title: isIndex ? { absolute: siteName } : page.data.title,
    description: page.data.description,
    alternates: { canonical: page.url },
  };
}
