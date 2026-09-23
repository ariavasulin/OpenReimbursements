'use client';

import { useState } from 'react';
import { publicUrl } from '@/lib/photos/urls';
import { photoName } from '@/lib/photos/format';
import type { ActionPhoto } from '@/lib/photos/action-types';

/**
 * Only the current page's small derivatives load on the confirm and trash pages.
 * `fill`: a square as wide as its card, for the confirm page's photo grid;
 * otherwise a 64px thumbnail beside a row of text.
 */
export default function ActionThumbnail({ photo, fill = false }: { photo: ActionPhoto | null; fill?: boolean }) {
  const [failed, setFailed] = useState(false);
  const box = fill ? 'aspect-square w-full' : 'h-16 w-16 shrink-0';
  if (!photo?.thumb_path || failed) return <span className={`flex ${box} items-center justify-center rounded-lg bg-[#3e3e3e] px-2 text-center text-sm text-[#bbb]`}>No preview</span>;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={publicUrl(photo.thumb_path)} alt={`${photoName(photo) ?? 'Photo'} thumbnail`} loading="lazy" width={fill ? 320 : 64} height={fill ? 320 : 64} onError={() => setFailed(true)} className={`${box} rounded-lg object-cover`} />;
}
