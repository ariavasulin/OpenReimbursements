import { fetchJson } from './api';

/** Authenticated action requests never contain original photo bytes. */
export function actionRequest<T>(path: string, body?: unknown, method?: string): Promise<T> {
  return fetchJson<T>(`/api/photo-actions/${path}`, 'Photo action failed', {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    credentials: 'same-origin', cache: 'no-store',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export const actionButton = 'rounded-lg border border-[#555] px-4 py-2 text-sm font-medium hover:bg-[#444] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2680FC] disabled:opacity-40';
export const actionPrimary = `${actionButton} border-transparent bg-[#2680FC] text-white hover:bg-[#1a6fd8]`;
export const actionField = 'w-full rounded-lg border border-[#555] bg-[#222222] px-3 py-2 text-sm text-white focus:outline-2 focus:outline-[#2680FC]';
export const trashDisclosure = 'Photos stay recoverable in trash for 30 days. Anyone with a known public file URL may still access it during retention.';
