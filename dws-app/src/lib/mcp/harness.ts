import 'server-only';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load, JSON_SCHEMA } from 'js-yaml';
import { z } from 'zod';

const metadataSchema = z.object({
  name: z.string().min(1),
  description: z.string().trim().min(1),
}).strict();

/** Delimit Markdown frontmatter; the YAML parser owns its syntax and scalar types. */
export function parseSkill(source: string, expectedName: string) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(source);
  if (!match) throw new Error(`Missing DWS skill frontmatter: ${expectedName}`);
  const metadata = metadataSchema.parse(load(match[1], { schema: JSON_SCHEMA }));
  if (metadata.name !== expectedName || !match[2].trim()) throw new Error(`Invalid DWS skill content: ${expectedName}`);
  return Object.freeze({ ...metadata, instructions: match[2].trim() });
}

// Explicit assets only. Next tracing ships these paths relative to the function root.
const directory = join(process.cwd(), 'src/lib/mcp/harness');
const read = (file: string) => readFileSync(join(directory, file), 'utf8');
export const harnessInstructions = read('AGENTS.md').trim();
if (!harnessInstructions) throw new Error('Missing DWS harness instructions');
export const skills = Object.freeze({
  photos: parseSkill(read('skills/photos/SKILL.md'), 'photos'),
  report_issue: parseSkill(read('skills/report_issue/SKILL.md'), 'report_issue'),
});
export type SkillName = keyof typeof skills;
export const skillNames = Object.keys(skills) as [SkillName, ...SkillName[]];
export const skillDiscovery = [
  'Load the relevant DWS skill before using its workflow. Match the employee’s intent to the skills below; explicit skill names are not required. Returns the skill instructions and its available scripts with complete argument schemas.',
  ...Object.values(skills).map(skill => `\n<skill name="${skill.name}">\n${skill.description}\n</skill>`),
].join('\n');
