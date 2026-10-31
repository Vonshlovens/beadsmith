import { DOCS, docTitle } from '#lib/server/docs.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = () => {
	const groups: { name: string; docs: { slug: string; title: string; summary: string }[] }[] = [];
	for (const entry of DOCS) {
		let group = groups.find((g) => g.name === entry.group);
		if (!group) {
			group = { name: entry.group, docs: [] };
			groups.push(group);
		}
		group.docs.push({ slug: entry.slug, title: docTitle(entry), summary: entry.summary });
	}
	return { groups };
};
