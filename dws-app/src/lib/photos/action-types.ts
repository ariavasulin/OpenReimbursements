export type PhotoAction = 'move' | 'trash' | 'restore';
export type PhotoReference = { photo_id: string } | { photo_url: string } | { job_number: string; original_filename: string };
export type PhotoSelector = { photos: PhotoReference[] } | { job_number: string; scope: 'active' | 'trash' };
export interface ActionPhoto {
  id: string; job_id: string; uploader_id: string; original_name: string | null;
  deleted_at: string | null; purge_after: string | null; duplicate_of: string | null;
  thumb_path: string | null; kind: string; job: {id:string;job_number:string;name:string}|null;
}
export interface PhotoActionBatch {
  id: string; created_by: string; origin: 'ui' | 'ordinary' | 'mcp'; action: PhotoAction;
  selector: PhotoSelector; destination_job_id: string | null;
  destination_job: {id:string;job_number:string;name:string}|null;
  status: 'draft'|'approved'|'running'|'interrupted'|'completed'|'cancelled';
  approved_by: string|null; approved_at: string|null; created_at:string; updated_at:string;
  materialization_complete:boolean; materialization_cursor:string|null;
}
export interface PhotoActionItem {
  photo_id:string; requested_photo_id:string|null; expected_job_id:string; expected_deleted_at:string|null;
  status:'pending'|'running'|'applied'|'retryable_failed'|'conflict'|'skipped'|'cancelled';
  error:{code:string}|null; result:{status:string;photo_id:string;action?:PhotoAction}|null;
  photo:ActionPhoto|null;
}
export interface UnresolvedPhotoReference {
  reference_index:number; reference:PhotoReference; reason:'not_found'|'ambiguous'; candidates:ActionPhoto[]; total:number;
}
export interface PhotoActionBatchResponse {
  batch:PhotoActionBatch; items:PhotoActionItem[]; total:number; can_mutate:boolean;
  materialization_complete:boolean; unresolved:UnresolvedPhotoReference[];
}
export interface PhotoActionApplyResponse { outcomes: Array<{status:string;photo_id:string;code?:string;action?:PhotoAction}> }
export interface TrashPhoto extends ActionPhoto {can_restore:boolean;canonical_photo:ActionPhoto|null;remedy:string|null}
export interface TrashResponse {photos:TrashPhoto[];next_cursor:string|null}
