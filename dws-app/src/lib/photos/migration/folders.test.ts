import { describe, expect, it } from 'vitest';
import { folderOf, isInsideFolder, projectNumbersIn, suggestFolderProjects, topLevelFolder } from './folders';

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
