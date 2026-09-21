'use client';

import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, Folder } from 'lucide-react';
import type { MigrationRequest, MigrationSource } from '@/lib/photos/migration/client';
import { cleanAlbumName, groupFolders, sharedChoice, type FolderGroup, type MigrationFolder } from '@/lib/photos/migration/folders';
import FolderTags from './folder-tags';
import ProjectChoice, { type ProjectRef } from './project-choice';
import { button, card, field, hint, label as labelClass } from './styles';

// "Your folders": one row per folder, grouped under each picked folder and collapsed by
// top-level folder with counts (plan § Screens, Decision 10). Built to stay usable at 5,000
// rows: a collapsed group is one button, and an open group shows 100 rows at a time.

/** One review edit. `includeSubfolders` is how a choice on a folder reaches the folders inside it. */
export type FolderPatch = { job?: ProjectRef | null; tags?: string[]; album_name?: string };
const ROWS_PER_PAGE = 100;
const plural = (count: number, one: string, many = `${one}s`) => `${count.toLocaleString()} ${count === 1 ? one : many}`;

interface FolderReviewProps {
  request: MigrationRequest;
  sources: MigrationSource[];
  folders: MigrationFolder[];
  /** False once the import has started: the rows are then a record of what was chosen. */
  editable: boolean;
  knownTags: string[];
  busy: boolean;
  /** Picked folders this page can still read. After a reload the browser forgets them. */
  isConnected(sourceId: string): boolean;
  onReconnect?(source: MigrationSource): void;
  onPatch(source: MigrationSource, folder: string, includeSubfolders: boolean, patch: FolderPatch): void;
  /** Extra controls for one picked folder (the page adds "New project" here). */
  sourceActions?(source: MigrationSource): React.ReactNode;
}

export default function FolderReview(props: FolderReviewProps) {
  const { sources, folders } = props;
  const [find, setFind] = useState('');
  const bySource = useMemo(() => {
    const map = new Map<string, MigrationFolder[]>();
    for (const row of folders) { const rows = map.get(row.source_id); if (rows) rows.push(row); else map.set(row.source_id, [row]); }
    return map;
  }, [folders]);
  const directories = sources.filter(source => source.kind === 'directory');
  if (!directories.length) return null;
  return (
    <section aria-labelledby="your-folders" className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="your-folders" className="text-xl font-semibold">Your folders</h2>
          <p className={hint}>
            {props.editable
              ? 'Each folder becomes an album with the same name. You can change a name, and add a project or tags, before you start. Nothing here is required.'
              : 'This is what was chosen for each folder. It cannot be changed once an import has started.'}
          </p>
        </div>
        {folders.length > 12 && (
          <label className="block w-full sm:w-72"><span className="sr-only">Find a folder</span>
            <input type="search" value={find} onChange={event => setFind(event.target.value)} className={field} placeholder="Find a folder" />
          </label>
        )}
      </div>
      {directories.map(source => <PickedFolder key={source.id} {...props} source={source} rows={bySource.get(source.id) ?? []} find={find} />)}
    </section>
  );
}

function PickedFolder({ source, rows, find, ...props }: FolderReviewProps & { source: MigrationSource; rows: MigrationFolder[]; find: string }) {
  const groups = useMemo(() => groupFolders(rows, find), [rows, find]);
  const photos = rows.reduce((total, row) => total + row.photo_count, 0);
  const connected = props.isConnected(source.id);
  const shared = useMemo(() => sharedChoice(rows), [rows]);
  return (
    <div className={card} data-testid="migration-source">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <Folder className="mt-1 h-6 w-6 shrink-0 text-[#8bbaff]" aria-hidden />
          <div className="min-w-0">
            <h3 className="break-words text-lg font-semibold">{source.label}</h3>
            <p className={hint} data-testid="source-counts">
              {rows.length ? `${plural(rows.length, 'folder')} with photos · ${plural(photos, 'photo')}` : connected ? 'No photos were found in this folder.' : 'Not read yet.'}
            </p>
          </div>
        </div>
        {!connected && props.onReconnect && (
          <div className="w-full sm:w-auto">
            <button type="button" className={`${button} w-full sm:w-auto`} disabled={props.busy} onClick={() => props.onReconnect!(source)}>Choose {source.label} again</button>
            <p className={`${hint} mt-1`}>The browser forgets a folder when the page is closed. Choose the same one to carry on; nothing is imported twice.</p>
          </div>
        )}
      </div>
      {props.editable && rows.length > 1 && (
        <WholeFolderChoice {...props} source={source} folder="" scope={`every folder in ${source.label}`} shared={shared} rows={rows} />
      )}
      {props.editable && props.sourceActions?.(source)}
      {find.trim() && rows.length > 0 && groups.length === 0 && <p className={`${hint} mt-4`}>No folder in {source.label} matches “{find.trim()}”.</p>}
      <ul className="mt-4 space-y-2">
        {groups.map(group => <li key={group.topLevel}><Group {...props} source={source} group={group} forceOpen={Boolean(find.trim())} /></li>)}
      </ul>
    </div>
  );
}

/** A project and tags for a folder and everything inside it. It sets them; any one folder can differ afterwards. */
function WholeFolderChoice({ source, folder, scope, shared, rows, ...props }: FolderReviewProps & {
  source: MigrationSource; folder: string; scope: string; rows: MigrationFolder[]; shared: ReturnType<typeof sharedChoice>;
}) {
  const project = shared.jobId === undefined ? undefined : shared.jobId === null ? null : rows.find(row => row.job_id === shared.jobId)?.jobs ?? undefined;
  return (
    <fieldset className="mt-4 rounded-lg border border-[#484848] p-3" disabled={props.busy}>
      <legend className="px-1 text-base font-medium text-white">For {scope}</legend>
      <div className="grid gap-4 md:grid-cols-2">
        <div><span className={labelClass}>Project</span>
          <div className="mt-1"><ProjectChoice request={props.request} value={project} ariaLabel={`Project for ${scope}`}
            onChange={job => props.onPatch(source, folder, true, { job })} /></div>
        </div>
        <div><span className={labelClass}>Tags</span>
          <div className="mt-1"><FolderTags tags={shared.tags} known={props.knownTags} ariaLabel={`Tags for ${scope}`}
            onChange={tags => props.onPatch(source, folder, true, { tags })} /></div>
        </div>
      </div>
      <p className={`${hint} mt-3`}>
        This sets the project and tags for {plural(rows.length, 'folder')}. You can still change any one folder afterwards.
        {shared.tagsDiffer && ' Some of them have other tags of their own: changing the tags here replaces those.'}
      </p>
    </fieldset>
  );
}

function Group({ source, group, forceOpen, ...props }: FolderReviewProps & { source: MigrationSource; group: FolderGroup; forceOpen: boolean }) {
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(ROWS_PER_PAGE);
  const shared = useMemo(() => sharedChoice(group.rows), [group.rows]);
  // A top-level folder holding photos only directly needs no group around its single row.
  if (group.rows.length === 1) return <Row {...props} source={source} row={group.rows[0]} />;
  const expanded = open || forceOpen;
  return (
    <div className="rounded-lg border border-[#484848]" data-testid="folder-group">
      <button type="button" aria-expanded={expanded} onClick={() => setOpen(!expanded)}
        className="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-[#383838] focus-visible:outline-2 focus-visible:outline-[#2680FC]">
        <ChevronRight className={`h-5 w-5 shrink-0 text-[#c4c4c4] transition-transform ${expanded ? 'rotate-90' : ''}`} aria-hidden />
        <span className="min-w-0 flex-1"><span className="block break-words text-base font-semibold">{group.topLevel}</span>
          <span className="block text-base text-[#c4c4c4]">{plural(group.rows.length, 'folder')} · {plural(group.photos, 'photo')}</span></span>
      </button>
      {expanded && (
        <div className="border-t border-[#484848] p-3">
          {props.editable && <WholeFolderChoice {...props} source={source} folder={group.topLevel} scope={`every folder in ${group.topLevel}`} shared={shared} rows={group.rows} />}
          <ul className="mt-3 space-y-2">
            {group.rows.slice(0, shown).map(row => <li key={row.id}><Row {...props} source={source} row={row} /></li>)}
          </ul>
          {group.rows.length > shown && (
            <button type="button" className={`${button} mt-3`} onClick={() => setShown(count => count + ROWS_PER_PAGE)}>
              Show {Math.min(ROWS_PER_PAGE, group.rows.length - shown)} more ({(group.rows.length - shown).toLocaleString()} left)
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Row({ source, row, ...props }: FolderReviewProps & { source: MigrationSource; row: MigrationFolder }) {
  const [name, setName] = useState(row.album_name ?? '');
  useEffect(() => { setName(row.album_name ?? ''); }, [row.album_name]);
  const where = row.folder === '' ? `Photos directly in ${source.label}` : row.folder.replaceAll('/', ' / ');
  const album = row.album_name ?? source.label;
  const commit = () => { if (cleanAlbumName(name) !== (row.album_name ?? '')) props.onPatch(source, row.folder, false, { album_name: name }); };
  return (
    <div className="rounded-lg bg-[#262626] p-3" data-testid="folder-row">
      <p className="break-words text-base text-[#c4c4c4]"><span className="sr-only">Folder: </span>{where} · {plural(row.photo_count, 'photo')}</p>
      <div className="mt-2 grid gap-4 lg:grid-cols-3">
        <label className="block"><span className={labelClass}>Album name</span>
          {props.editable
            ? <input aria-label={`Album name for ${where}`} value={name} maxLength={120} disabled={props.busy} className={`${field} mt-1`}
                onChange={event => setName(event.target.value)} onBlur={commit}
                onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } }} />
            : <span className="mt-1 block break-words text-base text-white">{album}</span>}
          {props.editable && <span className={`${hint} mt-1 block`}>Leave it empty to use the folder’s name.</span>}
        </label>
        <div><span className={labelClass}>Project</span>
          <div className="mt-1"><ProjectChoice request={props.request} value={row.jobs ?? null} disabled={!props.editable || props.busy}
            ariaLabel={`Project for ${album}`} onChange={job => props.onPatch(source, row.folder, false, { job })} /></div>
        </div>
        <div><span className={labelClass}>Tags</span>
          <div className="mt-1"><FolderTags tags={row.tags} known={props.knownTags} disabled={!props.editable || props.busy}
            ariaLabel={`Tags for ${album}`} onChange={tags => props.onPatch(source, row.folder, false, { tags })} /></div>
        </div>
      </div>
    </div>
  );
}
