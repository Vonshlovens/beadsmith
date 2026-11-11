/**
 * The Sand template's layout (docs/sand-e2b.md): the paths Beadsmith and the
 * template agree on, the hc release the template installs, and the state the
 * template seeds so Claude Code starts in an hc terminal without anyone
 * pressing a key (ADR-0021 rule 2).
 *
 * `sandbox/e2b/build-template.ts` imports this module directly with Node, so
 * it imports nothing but relative `.ts` files and Node built-ins.
 */
import { readFileSync } from 'node:fs';
import { ANTHROPIC_PLACEHOLDER } from './sandbox.ts';

/** The template's default user, which every Beadsmith command runs as. */
export const SANDBOX_HOME = '/home/user';
/** Beadsmith's own files in the sandbox. */
export const BEADSMITH_DIR = `${SANDBOX_HOME}/.beadsmith`;
/** Where the template's `beadsmith-run` keeps each run. */
export const RUNS_DIR = `${BEADSMITH_DIR}/runs`;
/** Where `beadsmith-run` finds the dispatch skills to install into the workspace. */
export const SKILLS_DIR = `${BEADSMITH_DIR}/skills`;
/** A mission's checkout, the working directory of its agent. */
export const WORK_DIR = `${BEADSMITH_DIR}/work`;
/** The chat agent's working directory. */
export const MATE_WORKDIR = `${SANDBOX_HOME}/mate`;
/** Claude Code's config directory; its session transcripts live under it. */
export const CLAUDE_CONFIG_DIR = `${SANDBOX_HOME}/.claude`;

/**
 * The template's byte-safe carrier for `hc connect` (`sandbox/e2b/beadsmith-hc`).
 * The E2B SDK hands a command's output to callbacks as decoded text, which
 * would corrupt hc's binary frames, so the carrier writes each chunk hc
 * prints as one base64 line on stdout and decodes base64 lines from stdin.
 */
export const HC_CARRIER = '/usr/local/bin/beadsmith-hc';

/**
 * hc's settings in the sandbox. `notes = false`: Beadsmith terminals have no
 * hc parent, and nothing but Beadsmith should type into the agent (ADR-0021
 * rule 1).
 */
export const HC_CONFIG_PATH = `${SANDBOX_HOME}/.config/herdr-core/config.toml`;
export const HC_CONFIG_TOML = 'notes = false\n';

/** The hc release pinned in `nix/herdr-core.json`, for one target. */
export interface HcRelease {
	version: string;
	/** hc's protocol generation; Beadsmith's client speaks generation 1. */
	generation: number;
	url: string;
	sha256: string;
}

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Parse the pin file both the template build and the Nix overlay read
 * (ADR-0021 rule 5). The hash here, not the release server's manifest, is
 * what a build trusts, so a malformed pin fails the build instead of
 * downloading something unchecked.
 */
export function parseHcPin(text: string, target = 'linux-x86_64'): HcRelease {
	const pin: unknown = JSON.parse(text);
	if (typeof pin !== 'object' || pin === null) throw new Error('hc pin is not an object');
	const { version, generation } = pin as Record<string, unknown>;
	const entry = (pin as Record<string, unknown>)[target];
	if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) {
		throw new Error('hc pin: version must be x.y.z');
	}
	if (generation !== 1) throw new Error('hc pin: Beadsmith speaks hc protocol generation 1');
	if (typeof entry !== 'object' || entry === null) throw new Error(`hc pin: no ${target} entry`);
	const { url, sha256 } = entry as Record<string, unknown>;
	const expected = `https://releases.herdr.dev/core/${version}/herdr-core-${target}.tar.gz`;
	if (url !== expected) throw new Error(`hc pin: ${target} url must be ${expected}`);
	if (typeof sha256 !== 'string' || !SHA256_PATTERN.test(sha256)) {
		throw new Error(`hc pin: ${target} sha256 must be 64 lowercase hex characters`);
	}
	return { version, generation, url, sha256 };
}

/** The pin, read from the repository (for the template build; not bundled into the app). */
export function readHcPin(target = 'linux-x86_64'): HcRelease {
	const file = new URL('../../../../nix/herdr-core.json', import.meta.url);
	return parseHcPin(readFileSync(file, 'utf8'), target);
}

/**
 * Shell commands (run as root) that download the pinned hc, check its
 * SHA-256 and install it as `/usr/local/bin/hc`. The tarball holds the
 * static `herdr-core` executable beside its licenses.
 */
export function hcInstallCommands(release: HcRelease): string[] {
	return [
		`cd /tmp && curl -fsSL -o hc.tgz '${release.url}'`,
		`echo '${release.sha256}  /tmp/hc.tgz' | sha256sum -c -`,
		'mkdir -p /tmp/hc /usr/local/share/doc/herdr-core && tar -xzf /tmp/hc.tgz -C /tmp/hc',
		'install -m 0755 /tmp/hc/herdr-core /usr/local/bin/hc',
		'cp /tmp/hc/LICENSE /tmp/hc/THIRD-PARTY-NOTICES /usr/local/share/doc/herdr-core/',
		'rm -rf /tmp/hc /tmp/hc.tgz'
	];
}

/**
 * ralph as pinned in `nix/ralph.json` (ADR-0019 rule 1): its public
 * repository at one commit. ralph has no releases, so the commit is the
 * integrity check: git verifies the fetched tree against it.
 */
export interface RalphPin {
	repository: string;
	rev: string;
	/** ralph's own version at that commit, for `ralph --version` checks and logs. */
	version: string;
	/** The pnpm ralph's lockfile was written with (its `packageManager`). */
	pnpm: string;
}

const RALPH_REPOSITORY = 'https://github.com/Vonshlovens/von-ralph';

/** Where the template installs ralph; `/usr/local/bin/ralph` links its launcher. */
export const RALPH_DIR = '/opt/ralph';

/**
 * Parse ralph's pin. The repository is fixed: the pin moves the commit, not
 * where it comes from, so a typo cannot fetch someone else's code.
 */
export function parseRalphPin(text: string): RalphPin {
	const pin: unknown = JSON.parse(text);
	if (typeof pin !== 'object' || pin === null) throw new Error('ralph pin is not an object');
	const { repository, rev, version, pnpm } = pin as Record<string, unknown>;
	if (repository !== RALPH_REPOSITORY) {
		throw new Error(`ralph pin: repository must be ${RALPH_REPOSITORY}`);
	}
	if (typeof rev !== 'string' || !/^[0-9a-f]{40}$/.test(rev)) {
		throw new Error('ralph pin: rev must be a full 40-character commit hash');
	}
	if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) {
		throw new Error('ralph pin: version must be x.y.z');
	}
	if (typeof pnpm !== 'string' || !VERSION_PATTERN.test(pnpm)) {
		throw new Error('ralph pin: pnpm must be x.y.z');
	}
	return { repository, rev, version, pnpm };
}

/** The pin, read from the repository (for the template build; not bundled into the app). */
export function readRalphPin(): RalphPin {
	const file = new URL('../../../../nix/ralph.json', import.meta.url);
	return parseRalphPin(readFileSync(file, 'utf8'));
}

/**
 * Shell commands (run as root) that fetch ralph at the pinned commit,
 * install its production dependencies from its lockfile, and put `ralph` on
 * the PATH. ralph runs from source on the image's Node (type stripping), so
 * there is nothing to build; install scripts are off because none of its
 * dependencies needs one. The last command fails the build if the commit
 * does not report the pinned version.
 */
export function ralphInstallCommands(pin: RalphPin): string[] {
	return [
		`git init -q '${RALPH_DIR}'`,
		`git -C '${RALPH_DIR}' fetch -q --depth 1 '${pin.repository}.git' '${pin.rev}'`,
		`git -C '${RALPH_DIR}' checkout -q --detach '${pin.rev}'`,
		`test "$(git -C '${RALPH_DIR}' rev-parse HEAD)" = '${pin.rev}'`,
		`cd '${RALPH_DIR}' && npx -y 'pnpm@${pin.pnpm}' install --prod --frozen-lockfile --filter von-ralph --ignore-scripts`,
		`rm -rf '${RALPH_DIR}/.git'`,
		`ln -sf '${RALPH_DIR}/bin/ralph' /usr/local/bin/ralph`,
		`ralph --version | grep -qxF 'ralph v${pin.version}'`
	];
}

/**
 * Claude Code's first-run choices, answered in advance (ADR-0021 rule 2), as
 * file path → JSON contents. Key names are Claude Code's own, read from the
 * version the template pins:
 *
 * - `~/.claude.json`: onboarding (theme and welcome) done; folder trust for
 *   both agent working directories (trust is looked up per directory and its
 *   ancestors up to the repository root, so each is listed); the egress
 *   placeholder API key pre-approved. Interactive Claude Code asks once
 *   whether to use an `ANTHROPIC_API_KEY` it finds in the environment and
 *   remembers the answer by the key's last 20 characters; the placeholder is
 *   the only key a sandbox ever sees (E2B's egress swaps in the real one).
 * - `~/.claude/settings.json`: the bypass-permissions warning accepted. The
 *   sandbox is the boundary those prompts guard (ADR-0015).
 *
 * Without these, a launch stops on a dialog, hc reports `blocked`, and the
 * session core fails the launch rather than answering blindly.
 */
export function claudeFirstRunFiles(): Record<string, string> {
	const trusted = { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true };
	const state = {
		hasCompletedOnboarding: true,
		theme: 'dark',
		customApiKeyResponses: { approved: [ANTHROPIC_PLACEHOLDER.slice(-20)], rejected: [] },
		projects: { [WORK_DIR]: trusted, [MATE_WORKDIR]: trusted }
	};
	const settings = { skipDangerousModePermissionPrompt: true };
	return {
		[`${SANDBOX_HOME}/.claude.json`]: `${JSON.stringify(state, null, 2)}\n`,
		[`${CLAUDE_CONFIG_DIR}/settings.json`]: `${JSON.stringify(settings, null, 2)}\n`
	};
}
