import type { RequestHandler } from './$types';
import { resolveProject } from '$lib/server/discovery.js';
import { loadTackleRepositoriesFromEnv } from '$lib/server/dispatch/repositories.js';
import {
	ENV_LOCKED_TACKLE_MAP_MESSAGE,
	INVALID_CONSOLE_TACKLE_MAP_MESSAGE
} from '$lib/server/dispatch/tackle-maps.js';
import { getTackleMapStore } from '$lib/server/state/db.js';
import { errorFromException, errorResponse, jsonResponse } from '$lib/server/security.js';
import {
	parseJsonBody,
	parseTackleMapBody,
	parseValue,
	project_id_schema,
	tackle_map_schema
} from '$lib/server/validation.js';
import type { ConsoleProjectRow } from '$lib/types.js';

function envLocked(project_id: string): boolean {
	const env_maps = loadTackleRepositoriesFromEnv();
	if (env_maps.error === 'invalid') {
		return false;
	}
	return env_maps.mappings[project_id] !== undefined;
}

function sqliteRow(mapping: {
	url: string;
	ref: string;
	auto_create_pr: boolean;
}): ConsoleProjectRow['tackle'] {
	return {
		mapped: true,
		url: mapping.url,
		ref: mapping.ref,
		auto_create_pr: mapping.auto_create_pr,
		source: 'sqlite'
	};
}

export const PUT: RequestHandler = async ({ params, request }) => {
	const id = parseValue(project_id_schema, params.id);
	if (!id.ok) {
		return id.response;
	}
	const body = await parseJsonBody(request, tackle_map_schema);
	if (!body.ok) {
		return body.response;
	}
	const mapping = parseTackleMapBody(body.data);
	if (mapping === undefined) {
		return errorResponse('bad_request', INVALID_CONSOLE_TACKLE_MAP_MESSAGE);
	}

	try {
		const project = await resolveProject(id.data);
		if (project === undefined) {
			return errorResponse('not_found', 'project not found');
		}
		if (envLocked(id.data)) {
			return errorResponse('conflict', ENV_LOCKED_TACKLE_MAP_MESSAGE);
		}
		const store = await getTackleMapStore();
		await store.put(id.data, mapping);
		return jsonResponse({ project_id: id.data, tackle: sqliteRow(mapping) });
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
		if (envLocked(id.data)) {
			return errorResponse('conflict', ENV_LOCKED_TACKLE_MAP_MESSAGE);
		}
		const store = await getTackleMapStore();
		await store.delete(id.data);
		return jsonResponse({ project_id: id.data, tackle: { mapped: false } });
	} catch (error) {
		return errorFromException(error, 'unavailable');
	}
};
