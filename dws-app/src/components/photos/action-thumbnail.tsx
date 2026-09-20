'use client';

import { useState } from 'react';
import { publicUrl } from '@/lib/photos/urls';
import type { ActionPhoto } from '@/lib/photos/action-types';

/** Only the current page's small derivatives load during action review. */
export default function ActionThumbnail({ photo }: { photo: ActionPhoto | null }) {
  const [failed, setFailed] = useState(false);
  if (!photo?.thumb_path || failed) return <span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-lg bg-[#3e3e3e] px-2 text-center text-[10px] text-[#bbb]">No preview</span>;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={publicUrl(photo.thumb_path)} alt={`${photo.original_name ?? 'Photo'} thumbnail`} loading="lazy" width={64} height={64} onError={() => setFailed(true)} className="h-16 w-16 shrink-0 rounded-lg object-cover" />;
}
