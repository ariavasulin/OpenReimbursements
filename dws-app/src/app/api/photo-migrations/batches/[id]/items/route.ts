import { requirePhotoActor } from '@/lib/photos/server/authority';
import { photoJson, photoRoute } from '@/lib/photos/server/http';
import { photoId } from '@/lib/photos/server/reads';
import { readMigrationItems } from '@/lib/photos/server/migrations';
export async function GET(request:Request,context:{params:Promise<{id:string}>}) { return photoRoute(async()=>photoJson(await readMigrationItems(await requirePhotoActor(request),photoId((await context.params).id),request))); }
