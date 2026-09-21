import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { readSharedPage } from '@/lib/photos/server/sharing';
import SharedGallery from '@/components/photos/shared-gallery';

// THE ONLY PAGE IN THE APP THAT WORKS WITHOUT A LOGIN (photo-albums plan, Phase 7). One shared
// album or project: its name, a count, a grid, a viewer, and download. No app chrome, and nothing
// about who took a photo, how it is tagged, or what else exists.
//
// It is rendered on the server so that a link that is unknown, turned off, or switched off for
// everyone is a REAL 404 (the same one for all three), not a 200 that later shows an error.
// There must be no loading.tsx above this page: a streamed shell would send 200 first.
// The no-store, noindex, and no-referrer headers for /s/* are set in next.config.ts.

export const dynamic = 'force-dynamic';
// The album's name stays out of the title, so it is not written into browser history on a shared computer.
export const metadata: Metadata = { title: 'Shared photos · DWS Photos', robots: { index: false, follow: false, nocache: true } };

export default async function SharedPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const first = await readSharedPage(token, null);
  if (!first) notFound();
  return <SharedGallery token={token} first={first} />;
}
