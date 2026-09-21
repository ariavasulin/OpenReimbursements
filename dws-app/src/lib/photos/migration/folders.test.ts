import { describe, expect, it } from 'vitest';
import { cleanAlbumName, folderOf, groupFolders, isInsideFolder, projectNumbersIn, sharedChoice, suggestFolderProjects, topLevelFolder, type MigrationFolder } from './folders';

// photo-albums plan, AC-17: a project is pre-suggested from a folder name containing an
// existing project number as a whole word; sub-folders inherit from the nearest parent.
const jobs = [
  { id: 'job-3612', job_number: '3612' }, { id: 'job-4170', job_number: '4170' },
  { id: 'job-24-015', job_number: '24-015' }, { id: 'job-015', job_number: '015' },
  { id: 'job-p7', job_number: 'P-7' }, { id: 'job-12', job_number: '12' },
];
const suggest = (folders: string[], label = 'Office drive') => Object.fromEntries(suggestFolderProjects(folders, jobs, label));

describe('folder paths', () => {
  it('names the folder that directly holds a file', () => {
    expect(folderOf('Smith Residence/Finished/IMG_1.jpg')).toBe('Smith Residence/Finished');
    expect(folderOf('IMG_1.jpg')).toBe('');
  });
  it('groups rows by their top-level folder', () => {
    expect(topLevelFolder('Smith Residence/Finished')).toBe('Smith Residence');
    expect(topLevelFolder('Smith Residence')).toBe('Smith Residence');
    expect(topLevelFolder('')).toBe('');
  });
  it('knows which folders a top-level choice reaches', () => {
    expect(isInsideFolder('Smith/Finished', 'Smith')).toBe(true);
    expect(isInsideFolder('Smith', 'Smith')).toBe(true);
    expect(isInsideFolder('Smithson/Finished', 'Smith')).toBe(false);
    expect(isInsideFolder('anything/at/all', '')).toBe(true);
  });
});

// photo-albums § Screens: rows grouped under each picked folder, collapsed by top-level folder with counts.
describe('review groups', () => {
  const row = (folder: string, photo_count = 1, extra: Partial<MigrationFolder> = {}): MigrationFolder =>
    ({ id: `row-${folder}`, source_id: 'source', folder, album_name: folder.replaceAll('/', ' – ') || 'Office drive', album_id: null, job_id: null, tags: [], photo_count, ...extra });
  it('puts the picked folder’s own photos first, then top-level folders by name with their counts', () => {
    const groups = groupFolders([row('Job 10/Finished', 4), row('Job 2', 1), row('', 3), row('Job 10', 2), row('Job 10/Before', 5), row('job 2/Kitchen', 7)]);
    expect(groups.map(group => [group.topLevel, group.rows.map(r => r.folder), group.photos])).toEqual([
      ['', [''], 3],
      // Numbers sort as numbers ("Job 2" before "Job 10"); "Job 2" and "job 2" are different folders on disk.
      ['Job 2', ['Job 2'], 1],
      ['job 2', ['job 2/Kitchen'], 7],
      ['Job 10', ['Job 10', 'Job 10/Before', 'Job 10/Finished'], 11],
    ]);
  });
  it('finds folders by path or album name, ignoring case, and drops groups with no match', () => {
    const rows = [row('Smith/Finished'), row('Smith/Before'), row('Jones/Finished', 1, { album_name: 'Jones kitchen done' }), row('Party')];
    expect(groupFolders(rows, 'finished').map(group => [group.topLevel, group.rows.length])).toEqual([['Jones', 1], ['Smith', 1]]);
    expect(groupFolders(rows, ' KITCHEN ').map(group => group.topLevel)).toEqual(['Jones']);
    expect(groupFolders(rows, 'nothing like this')).toEqual([]);
  });
  it('groups 5,000 rows quickly', () => {
    const rows = Array.from({ length: 5000 }, (_, n) => row(`Top ${Math.floor(n / 100)}/Folder ${n}`, 2));
    const started = performance.now();
    const groups = groupFolders(rows);
    expect(groups).toHaveLength(50); expect(groups[0].rows).toHaveLength(100); expect(groups[0].photos).toBe(200);
    expect(groupFolders(rows, 'folder 4999')[0].rows.map(r => r.folder)).toEqual(['Top 49/Folder 4999']);
    expect(performance.now() - started).toBeLessThan(1000);
  });
  it('shows a whole-folder control the shared value, or that the rows differ', () => {
    expect(sharedChoice([row('a', 1, { job_id: 'j', tags: ['x', 'y'] }), row('b', 1, { job_id: 'j', tags: ['y', 'x'] })])).toEqual({ jobId: 'j', tags: ['x', 'y'], tagsDiffer: false });
    expect(sharedChoice([row('a', 1, { job_id: 'j', tags: ['x', 'y'] }), row('b', 1, { job_id: null, tags: ['y'] })])).toEqual({ jobId: undefined, tags: ['y'], tagsDiffer: true });
    expect(sharedChoice([row('a'), row('b')])).toEqual({ jobId: null, tags: [], tagsDiffer: false });
    expect(sharedChoice([])).toEqual({ jobId: null, tags: [], tagsDiffer: false });
  });
  it('cleans an album name the way the server will', () => {
    expect(cleanAlbumName('  Smith   kitchen,\tdone ')).toBe('Smith kitchen, done');
    expect(cleanAlbumName('   ')).toBe('');
  });
});

describe('whole-word project number match', () => {
  const byNumber = new Map(jobs.map(job => [job.job_number.toLowerCase(), job.id]));
  const find = (name: string) => projectNumbersIn(name, byNumber, 6);
  it('matches a number bounded by spaces, punctuation, or the ends of the name', () => {
    for (const name of ['3612', '3612 Smith Residence', 'Smith Residence 3612', 'Smith-3612', 'Smith_3612_final', '(3612) Smith', 'Job #3612.']) {
      expect(find(name), name).toEqual(['job-3612']);
    }
  });
  it('does not match a number inside a longer number or word', () => {
    for (const name of ['13612 Smith', '36120', '3612b', 'x3612', 'Smith', '']) expect(find(name), name).toEqual([]);
  });
  it('ignores letter case and keeps a number that contains punctuation', () => {
    expect(find('p-7 shop photos')).toEqual(['job-p7']);
  });
  it('prefers the longer number when one sits inside another', () => {
    expect(find('24-015 Smith')).toEqual(['job-24-015']);
    expect(find('015 Smith')).toEqual(['job-015']);
  });
  it('reports every number when a name holds two different ones', () => {
    expect(find('3612 and 4170 shared').sort()).toEqual(['job-3612', 'job-4170']);
  });
});

describe('project suggestion for folder rows', () => {
  it('suggests from the folder’s own name', () => {
    expect(suggest(['3612 Smith Residence'])).toEqual({ '3612 Smith Residence': 'job-3612' });
  });
  it('lets sub-folders inherit from the nearest parent that has a number', () => {
    expect(suggest(['3612 Smith Residence/Finished', '3612 Smith Residence/Finished/Kitchen'])).toEqual({
      '3612 Smith Residence/Finished': 'job-3612', '3612 Smith Residence/Finished/Kitchen': 'job-3612',
    });
  });
  it('inherits from a parent folder that holds no photos itself, and so has no row', () => {
    // Only the sub-folder is a row; its parent exists only as part of the path.
    expect(suggest(['Projects/4170 Jones/Before'])).toEqual({ 'Projects/4170 Jones/Before': 'job-4170' });
  });
  it('prefers the nearest number over one further up', () => {
    expect(suggest(['3612 Smith Residence/4170 annex'])).toEqual({ '3612 Smith Residence/4170 annex': 'job-4170' });
  });
  it('falls back to the picked folder’s own name, including for photos directly inside it', () => {
    expect(suggest(['', 'Finished'], '3612 Smith Residence')).toEqual({ '': 'job-3612', Finished: 'job-3612' });
  });
  it('suggests nothing where no name holds a project number', () => {
    expect(suggest(['Christmas Party 2015', 'Marketing', ''])).toEqual({});
  });
  it('suggests nothing when the nearest numbered name is ambiguous, rather than guessing from further up', () => {
    expect(suggest(['3612 Smith Residence/3612 and 4170 shared'])).toEqual({});
  });
  it('never suggests from a project number shorter than three characters', () => {
    expect(suggest(['Day 12', '12'])).toEqual({});
  });
  it('stays fast at the size of a real library', () => {
    const many = Array.from({ length: 2000 }, (_, n) => ({ id: `job-${n}`, job_number: String(10_000 + n) }));
    const folders = Array.from({ length: 5000 }, (_, n) => `${10_000 + (n % 2000)} Residence/Phase ${n % 7}/Room ${n}`);
    const started = performance.now();
    const result = suggestFolderProjects(folders, many, 'Office drive');
    expect(result.size).toBe(5000);
    expect(result.get(folders[4999])).toBe(`job-${4999 % 2000}`);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
