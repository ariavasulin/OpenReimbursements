import { Suspense } from 'react';
import PhotoActions from '@/components/photos/photo-actions';

export default function PhotoActionsPage() {
  return <main className="h-dvh overflow-y-auto bg-[#222222] text-white"><Suspense fallback={<p className="p-6">Loading photo action…</p>}><PhotoActions /></Suspense></main>;
}
