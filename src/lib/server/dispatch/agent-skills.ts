/**
 * The skills the dispatch prompts point at (`prompts.ts`), bundled from
 * `.agents/skills/` at build time. They are part of Beadsmith, not of the
 * repository an agent checks out, so a provider whose workspace may be some
 * other repository (or none) installs them itself (docs/sand-e2b.md).
 */
const FILES = import.meta.glob('/.agents/skills/{file,tackle,comment,discuss}/SKILL.md', {
	query: '?raw',
	import: 'default',
	eager: true
}) as Record<string, string>;

/** Skill name → SKILL.md text, for the skills dispatch prompts name. */
export const DISPATCH_SKILLS: Readonly<Record<string, string>> = Object.fromEntries(
	Object.entries(FILES).map(([path, text]) => [path.split('/').at(-2) as string, text])
);
