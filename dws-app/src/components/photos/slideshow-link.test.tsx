// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PhotoRow } from '@/lib/photos/types';
import { PlayButton, SlideshowLink, useSlideshowStart } from './slideshow-link';

let root: Root;
let container: HTMLDivElement;
let shown: { openId: string | null; autoplay: boolean } = { openId: null, autoplay: false };
let started: () => void = () => {};
let openTile: (id: string | null) => void = () => {};

const photo = (id: string, kind: PhotoRow['kind']) => ({ id, kind }) as PhotoRow;

// Stands in for PhotoBrowser: no viewer is mounted at all, as before its
// code has downloaded.
function Grid({ photos }: { photos: PhotoRow[] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const { autoplay, autoplayStarted } = useSlideshowStart(photos, setOpenId, openId !== null);
  shown = { openId, autoplay };
  started = autoplayStarted;
  openTile = setOpenId;
  return null;
}

function Page({ photos }: { photos: PhotoRow[] }) {
  return (
    <SlideshowLink>
      <PlayButton />
      <Grid photos={photos} />
    </SlideshowLink>
  );
}

const play = () => container.querySelector('button');

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

it('shows Play as soon as the grid has a still, without the viewer', async () => {
  await act(async () => root.render(<Page photos={[photo('v1', 'video'), photo('p1', 'image')]} />));
  expect(play()?.textContent).toBe('Play');
});

it('hides Play when only videos are loaded', async () => {
  await act(async () => root.render(<Page photos={[photo('v1', 'video')]} />));
  expect(play()).toBeNull();
});

it('opens the first still with autoplay until the viewer has started', async () => {
  await act(async () => root.render(<Page photos={[photo('v1', 'video'), photo('p1', 'image'), photo('p2', 'image')]} />));
  await act(async () => play()!.click());
  expect(shown).toEqual({ openId: 'p1', autoplay: true });

  // The viewer has started playing: the ask is done.
  await act(async () => started());
  expect(shown).toEqual({ openId: 'p1', autoplay: false });
});

it('forgets a Play whose viewer closed before it started', async () => {
  await act(async () => root.render(<Page photos={[photo('p1', 'image'), photo('p2', 'image')]} />));
  await act(async () => play()!.click());
  await act(async () => openTile(null));
  await act(async () => openTile('p2'));
  expect(shown).toEqual({ openId: 'p2', autoplay: false });
});
