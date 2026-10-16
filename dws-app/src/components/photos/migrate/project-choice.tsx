'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { usePhotoJobs } from '@/lib/photos/api';
import { filterJobs } from '@/lib/photos/job-filter';
import { chooserButton, field } from './styles';

// Choose a project, or "No project", for one import row or for a whole folder of rows.
// Closed, it is a single button, so a list of thousands of folders stays light; open, it
// searches projects by number or name. A project is optional (plan Decision 1).
//
// Every chooser on the page, and the rest of Photos, share one cached list of projects
// (audit CODE-2): the first one opened loads it, and the rest open at once and search it
// as you type, with no request per keystroke. The office has a few dozen projects.

/** Projects listed at once; typing narrows the list. */
export const PROJECTS_SHOWN = 50;

export type ProjectRef = { id: string; job_number: string; name: string };
export const projectLabel = (project: ProjectRef) => `${project.job_number} · ${project.name}`;

interface ProjectChoiceProps {
  /** The current project; null is "No project". `undefined` means "several different ones". */
  value: ProjectRef | null | undefined;
  onChange(project: ProjectRef | null): void;
  /** Names what this applies to, for screen readers: "Project for Smith Residence – Finished". */
  ariaLabel: string;
  disabled?: boolean;
}

export default function ProjectChoice({ value, onChange, ariaLabel, disabled }: ProjectChoiceProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const search = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const jobs = usePhotoJobs(open);
  const state = jobs.data ? 'ready' : jobs.isError ? 'failed' : 'loading';
  // Best match first: a project number, then words of a name (the search box's rules).
  const projects = useMemo(
    () => filterJobs(jobs.data ?? [], query, PROJECTS_SHOWN).map(({ id, job_number, name }): ProjectRef => ({ id, job_number, name })),
    [jobs.data, query]
  );
  useEffect(() => { if (open) search.current?.focus(); }, [open]);

  const close = () => { setOpen(false); setQuery(''); opener.current?.focus(); };
  const choose = (project: ProjectRef | null) => { onChange(project); close(); };
  const shown = value === undefined ? 'Different projects' : value ? projectLabel(value) : 'No project';

  if (disabled) return <p className="text-base text-[#c4c4c4]" aria-label={ariaLabel}>{shown}</p>;
  return (
    <div onKeyDown={event => { if (event.key === 'Escape' && open) { event.stopPropagation(); close(); } }}>
      <button ref={opener} type="button" aria-label={`${ariaLabel}: ${shown}`} aria-expanded={open} aria-controls={open ? listId : undefined}
        onClick={() => (open ? close() : setOpen(true))} className={chooserButton}>
        <span className={`break-words ${value ? '' : 'text-[#c4c4c4]'}`}>{shown}</span>
        <ChevronDown className={`h-5 w-5 shrink-0 text-[#c4c4c4] transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden />
      </button>
      {open && (
        <div id={listId} className="mt-2 rounded-lg border border-[#555] bg-[#262626] p-2">
          <input ref={search} type="search" value={query} onChange={event => setQuery(event.target.value)} className={field}
            aria-label="Find a project by number or name" placeholder="Find a project by number or name" />
          <ul className="mt-2 max-h-64 overflow-y-auto" role="listbox" aria-label={ariaLabel}>
            <li role="option" aria-selected={value === null}>
              <button type="button" onClick={() => choose(null)} className="flex min-h-11 w-full items-center rounded-md px-3 text-left text-base text-white hover:bg-[#3a3a3a] focus-visible:outline-2 focus-visible:outline-[#2680FC]">
                No project
              </button>
            </li>
            {projects.map(project => (
              <li key={project.id} role="option" aria-selected={value?.id === project.id}>
                <button type="button" onClick={() => choose(project)} className="flex min-h-11 w-full items-center rounded-md px-3 py-2 text-left text-base text-white hover:bg-[#3a3a3a] focus-visible:outline-2 focus-visible:outline-[#2680FC]">
                  <span className="break-words">{projectLabel(project)}</span>
                </button>
              </li>
            ))}
          </ul>
          <p className="px-3 py-2 text-base text-[#c4c4c4]" role="status">
            {state === 'loading' ? 'Looking for projects…' : state === 'failed' ? 'Projects could not be loaded. Close this and try again.'
              : projects.length === 0 ? (query.trim() ? `No project matches “${query.trim()}”.` : 'There are no projects yet.')
              : projects.length === PROJECTS_SHOWN ? `Showing the first ${PROJECTS_SHOWN}. Type to narrow the list.` : ''}
          </p>
        </div>
      )}
    </div>
  );
}
