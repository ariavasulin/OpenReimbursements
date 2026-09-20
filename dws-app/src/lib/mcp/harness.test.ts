import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { harnessInstructions, parseSkill, skillDiscovery, skills } from './harness';

describe('packaged DWS harness', () => {
  it('parses YAML strings and folded invocation descriptions while keeping Markdown separate', () => {
    expect(parseSkill('---\nname: photos\ndescription: >-\n  Use when selecting\n  local photos.\n---\n# Workflow\n\nKeep this body.', 'photos')).toEqual({
      name: 'photos', description: 'Use when selecting local photos.', instructions: '# Workflow\n\nKeep this body.',
    });
  });

  it.each([
    'name: photos\n# no frontmatter',
    '---\nname: other\ndescription: Use photos\n---\nBody',
    '---\nname: photos\ndescription: 123\n---\nBody',
    '---\nname: photos\ndescription: [photos]\n---\nBody',
    '---\nname: photos\ndescription: first\ndescription: second\n---\nBody',
    '---\nname: photos\ndescription: !!js/function "function() {}"\n---\nBody',
    '---\nname: photos\ndescription: Use photos\n---\n  ',
  ])('fails closed on invalid packaged metadata/body', source => {
    expect(() => parseSkill(source, 'photos')).toThrow();
  });

  it('builds discovery from the same packaged metadata used by skill loading', () => {
    expect(harnessInstructions).not.toBe('');
    for (const skill of Object.values(skills)) {
      expect(skillDiscovery).toContain(skill.name);
      expect(skillDiscovery).toContain(skill.description);
      expect(skill.instructions.startsWith('---')).toBe(false);
    }
  });
});
