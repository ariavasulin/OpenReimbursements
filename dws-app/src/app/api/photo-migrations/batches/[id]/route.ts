import { requirePhotoActor } from '@/lib/photos/server/authority';
import { photoJson, photoRoute } from '@/lib/photos/server/http';
import { readPhotoBatch } from '@/lib/photos/server/reads';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return photoRoute(async () => {
    const actor = await requirePhotoActor(request);
    return photoJson(await readPhotoBatch(actor, (await context.params).id, 'migration'));
  });
}
