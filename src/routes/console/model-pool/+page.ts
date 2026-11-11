/**
 * The Underclass model pool (ADR-0022). The first read happens here so the
 * page arrives with data; the page keeps it fresh while it is open.
 */
import { api } from '#lib/client/api.js';
import { toFailure, type PoolFailure } from '#lib/client/model-pool.js';
import type { ModelPoolResponse } from '#lib/types.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch }) => {
	let response: ModelPoolResponse | null = null;
	let failure: PoolFailure | null = null;
	try {
		response = await api.modelPool({ fetch });
	} catch (thrown) {
		failure = toFailure(thrown);
	}
	return { response, failure };
};
