import { requirePhotoActor } from '@/lib/photos/server/authority';
import { photoJson, photoRoute, readPhotoJson } from '@/lib/photos/server/http';
import { OriginalUploadMismatch, probeUploadOriginal } from '@/lib/photos/server/uploads';
export async function POST(request: Request) {
  return photoRoute(async () => {
    const actor = await requirePhotoActor(request, { mutation: true });
    try {
      return photoJson(await probeUploadOriginal(actor, await readPhotoJson(request)));
    } catch (error) {
      if (error instanceof OriginalUploadMismatch) return photoJson({ error: { code: 'conflict', retryable: false,
        message: 'Stored upload differs from this file. Remove this upload from the tray and add the file again.' } }, 409);
      throw error;
    }
  });
}
