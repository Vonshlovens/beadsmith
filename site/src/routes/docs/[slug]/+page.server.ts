import { error } from '@sveltejs/kit';
import { DOCS, docTitle, renderDoc } from '#lib/server/docs.js';
import type { EntryGenerator, PageServerLoad } from './$types';

export const entries: EntryGenerator = () => DOCS.map(({ slug }) => ({ slug }));

export const load: PageServerLoad = ({ params }) => {
	const index = DOCS.findIndex((entry) => entry.slug === params.slug);
	if (index === -1) {
		error(404, 'No such doc');
	}
	const doc = renderDoc(DOCS[index]);
	const neighbour = (i: number) =>
		DOCS[i] ? { slug: DOCS[i].slug, title: docTitle(DOCS[i]) } : null;

	return {
		title: doc.title,
		group: doc.entry.group,
		html: doc.html,
		sections: doc.sections,
		sourceUrl: doc.sourceUrl,
		sourcePath: doc.entry.path,
		prev: neighbour(index - 1),
		next: neighbour(index + 1)
	};
};
