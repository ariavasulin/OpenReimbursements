import type { PhotoKind, PhotoRow } from './types';

export type PhotoAction = 'move' | 'trash' | 'restore';
export type PhotoReference = { photo_id: string } | { photo_url: string } | { job_number: string; original_filename: string };
export type PhotoSelector = { photos: PhotoReference[] } | { job_number: string; scope: 'active' | 'trash' };
export interface ActionPhoto {
  id: string; job_id: string | null; uploader_id: string; original_name: string | null; display_name?: string | null;
  deleted_at: string | null; purge_after: string | null; duplicate_of: string | null;
  thumb_path: string | null; kind: PhotoKind;
  /** deleted_at is set when the project itself is in Trash or gone. */
  job: (NonNullable<PhotoRow['job']> & { deleted_at?: string | null }) | null;
}
export interface PhotoActionBatch {
  id: string; created_by: string; origin: 'ui' | 'ordinary' | 'mcp'; action: PhotoAction;
  selector: PhotoSelector; destination_job_id: string | null;
  destination_job: PhotoRow['job'];
  status: 'draft'|'approved'|'running'|'interrupted'|'completed'|'cancelled';
  approved_by: string|null; approved_at: string|null; created_at:string; updated_at:string;
  materialization_complete:boolean; materialization_cursor:string|null;
}
export interface PhotoActionItem {
  photo_id:string; requested_photo_id:string|null; expected_job_id:string|null; expected_deleted_at:string|null;
  status:'pending'|'running'|'applied'|'retryable_failed'|'conflict'|'skipped'|'cancelled';
  error:{code:string}|null; result:{status:string;photo_id:string;action?:PhotoAction}|null;
  photo:ActionPhoto|null;
}
export interface UnresolvedPhotoReference {
  reference_index:number; reference:PhotoReference; reason:'not_found'|'ambiguous'; candidates:ActionPhoto[]; total:number;
}
export interface PhotoActionBatchResponse {
  batch:PhotoActionBatch; items:PhotoActionItem[]; total:number; can_mutate:boolean;
  unresolved:UnresolvedPhotoReference[];
}
export interface TrashPhoto extends ActionPhoto {can_restore:boolean;canonical_photo:ActionPhoto|null;remedy:string|null}
/** What a delete-forever request marked: photos (legacy copies included), albums, projects. */
export type PurgeMarked = { photos: number; albums: number; projects: number };
export interface TrashResponse {photos:TrashPhoto[];next_cursor:string|null;
  /** Photos marked for deletion forever whose files are not yet removed; any purge call finishes them. */
  pending_purge:number}
