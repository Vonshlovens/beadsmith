import type { RequestHandler } from './$types';
import { resolveProject } from '$lib/server/discovery.js';
import { INVALID_CONSOLE_FILE_MAP_MESSAGE } from '$lib/server/dispatch/file-maps.js';
import { getFileMapStore } from '$lib/server/state/db.js';
import { errorFromException, errorResponse, jsonResponse } from '$lib/server/security.js';
import {
	file_map_schema,
	parseFileMapBody,
	parseJsonBody,
	parseValue,
	project_id_schema
} from '$lib/server/validation.js';
import type { ConsoleProjectRow } from '$lib/types.js';

function sqliteRow(mapping: { url: string; ref: string }): ConsoleProjectRow['file'] {
	return {
		mapped: true,
		url: mapping.url,
		ref: mapping.ref
	};
}

export const PUT: RequestHandler = async ({ params, request }) => {
	const id = parseValue(project_id_schema, params.id);
	if (!id.ok) {
		return id.response;
	}
	const body = await parseJsonBody(request, file_map_schema);
	if (!body.ok) {
		return body.response;
	}
	const mapping = parseFileMapBody(body.data);
	if (mapping === undefined) {
		return errorResponse('bad_request', INVALID_CONSOLE_FILE_MAP_MESSAGE);
	}

	try {
		const project = await resolveProject(id.data);
		if (project === undefined) {
			return errorResponse('not_found', 'project not found');
		}
		const store = await getFileMapStore();
		await store.put(id.data, mapping);
		return jsonResponse({ project_id: id.data, file: sqliteRow(mapping) });
	} catch (error) {
		return errorFromException(error, 'unavailable');
	}
};

export const DELETE: RequestHandler = async ({ params }) => {
	const id = parseValue(project_id_schema, params.id);
	if (!id.ok) {
		return id.response;
	}

	try {
		const project = await resolveProject(id.data);
		if (project === undefined) {
			return errorResponse('not_found', 'project not found');
		}
		const store = await getFileMapStore();
		await store.delete(id.data);
		return jsonResponse({ project_id: id.data, file: { mapped: false } });
	} catch (error) {
		return errorFromException(error, 'unavailable');
	}
};
