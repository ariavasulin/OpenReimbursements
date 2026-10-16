// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PhotosSearchProvider, usePhotosSearch, useSetPhotosQuery } from './photos-shell-context';

let root: Root;
let container: HTMLDivElement;
let setQuery: (value: string) => void = () => {};
const renders = { page: 0, box: 0 };
let boxQuery = '';

// Stands in for a page: it only needs the setter (as the search page does).
function Page() {
  renders.page += 1;
  setQuery = useSetPhotosQuery();
  return <Box />;
}

// Stands in for the search box.
function Box() {
  renders.box += 1;
  boxQuery = usePhotosSearch().query;
  return null;
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  renders.page = 0;
  renders.box = 0;
  container = document.createElement('div');
  root = createRoot(container);
  await act(async () => root.render(<PhotosSearchProvider><Page /></PhotosSearchProvider>));
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

it('re-renders the search text readers on a keystroke, not the rest of the tree', async () => {
  expect(renders).toEqual({ page: 1, box: 1 });
  await act(async () => setQuery('kitchen'));
  expect(boxQuery).toBe('kitchen');
  expect(renders.page).toBe(1);
  expect(renders.box).toBe(2);
});
