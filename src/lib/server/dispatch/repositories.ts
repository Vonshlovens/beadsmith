import { readFileSync } from 'node:fs';

/**
 * Operator-configured GitHub checkout for Tackle.
 *
 * Mapping is control-plane config, not inferred from Dolt database names and
 * not accepted from the browser.
 */
export interface TackleRepositoryMapping {
	url: string;
	ref: string;
	auto_create_pr: boolean;
}

export interface TackleRepositoryConfig {
	mappings: Record<string, TackleRepositoryMapping>;
	error?: 'invalid';
}

export const BDX_TACKLE_REPOSITORIES_ENV = 'BDX_TACKLE_REPOSITORIES';
export const BDX_TACKLE_REPOSITORIES_FILE_ENV = 'BDX_TACKLE_REPOSITORIES_FILE';

export const UNMAPPED_TACKLE_MESSAGE =
	'This project has no configured repository mapping for Tackle.';
export const INVALID_TACKLE_MAPPING_MESSAGE =
	'Tackle repository mapping is unavailable. Check the service configuration.';

const PROJECT_ID_PATTERN = /^d_[a-z0-9_]{1,64}$/;
const GIT_REF_PATTERN = /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,254}$/;
const MAPPING_KEYS = new Set(['url', 'ref', 'auto_create_pr']);

const EMPTY_CONFIG: TackleRepositoryConfig = { mappings: {} };

/**
 * Accept only an https GitHub owner/repo URL. Credentials, query, fragment,
 * extra path, and non-github hosts are rejected.
 * @param raw Candidate repository URL.
 */
export function parseGitHubRepositoryUrl(raw: string): string | undefined {
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		return undefined;
	}
	if (url.protocol !== 'https:') {
		return undefined;
	}
	if (url.username !== '' || url.password !== '') {
		return undefined;
	}
	if (url.search !== '' || url.hash !== '') {
		return undefined;
	}
	const hostname = url.hostname.toLowerCase();
	if (hostname !== 'github.com' && hostname !== 'www.github.com') {
		return undefined;
	}
	const parts = url.pathname
		.replace(/\/+$/, '')
		.replace(/\.git$/i, '')
		.split('/')
		.filter((part) => {
			return part.length > 0;
		});
	if (parts.length !== 2) {
		return undefined;
	}
	if (!/^[A-Za-z0-9._-]+$/.test(parts[0]) || !/^[A-Za-z0-9._-]+$/.test(parts[1])) {
		return undefined;
	}
	return `https://github.com/${parts[0]}/${parts[1]}`;
}

/**
 * Accept a git starting ref such as `main` or `release/1.2`.
 * @param raw Candidate ref.
 */
export function parseGitRef(raw: string): string | undefined {
	const value = raw.trim();
	if (!GIT_REF_PATTERN.test(value) || value.includes('..')) {
		return undefined;
	}
	return value;
}

function parseMappingValue(value: unknown): TackleRepositoryMapping | undefined {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		if (!MAPPING_KEYS.has(key)) {
			return undefined;
		}
	}
	if (typeof record.url !== 'string') {
		return undefined;
	}
	const url = parseGitHubRepositoryUrl(record.url);
	if (url === undefined) {
		return undefined;
	}
	let ref = 'main';
	if (record.ref !== undefined) {
		if (typeof record.ref !== 'string') {
			return undefined;
		}
		const parsed_ref = parseGitRef(record.ref);
		if (parsed_ref === undefined) {
			return undefined;
		}
		ref = parsed_ref;
	}
	let auto_create_pr = true;
	if (record.auto_create_pr !== undefined) {
		if (typeof record.auto_create_pr !== 'boolean') {
			return undefined;
		}
		auto_create_pr = record.auto_create_pr;
	}
	return { url, ref, auto_create_pr };
}

/**
 * Parse the operator JSON object keyed by project id (`d_…`).
 * @param raw JSON text.
 */
export function parseTackleRepositoriesJson(raw: string): TackleRepositoryConfig {
	const text = raw.trim();
	if (text.length === 0) {
		return EMPTY_CONFIG;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { mappings: {}, error: 'invalid' };
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return { mappings: {}, error: 'invalid' };
	}
	const mappings: Record<string, TackleRepositoryMapping> = {};
	for (const [project_id, value] of Object.entries(parsed as Record<string, unknown>)) {
		if (!PROJECT_ID_PATTERN.test(project_id)) {
			return { mappings: {}, error: 'invalid' };
		}
		const mapping = parseMappingValue(value);
		if (mapping === undefined) {
			return { mappings: {}, error: 'invalid' };
		}
		mappings[project_id] = mapping;
	}
	return { mappings };
}

/**
 * Load Tackle repository maps from a file path (preferred) or inline JSON.
 * @param source Process environment.
 */
export function loadTackleRepositoriesFromEnv(
	source: NodeJS.ProcessEnv = process.env
): TackleRepositoryConfig {
	const file_path = source[BDX_TACKLE_REPOSITORIES_FILE_ENV]?.trim();
	if (file_path !== undefined && file_path.length > 0) {
		try {
			return parseTackleRepositoriesJson(readFileSync(file_path, 'utf8'));
		} catch {
			return { mappings: {}, error: 'invalid' };
		}
	}
	const inline = source[BDX_TACKLE_REPOSITORIES_ENV]?.trim();
	if (inline === undefined || inline.length === 0) {
		return EMPTY_CONFIG;
	}
	return parseTackleRepositoriesJson(inline);
}
