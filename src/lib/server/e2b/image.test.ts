import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
	claudeFirstRunFiles,
	CLAUDE_CONFIG_DIR,
	hcInstallCommands,
	MATE_WORKDIR,
	parseHcPin,
	parseRalphPin,
	ralphInstallCommands,
	RALPH_DIR,
	readHcPin,
	readRalphPin,
	SANDBOX_HOME,
	WORK_DIR
} from './image.js';
import { ANTHROPIC_PLACEHOLDER } from './sandbox.js';

const CARRIER = fileURLToPath(new URL('../../../../sandbox/e2b/beadsmith-hc.cjs', import.meta.url));
const HASH = 'a'.repeat(64);

function pin(overrides: Record<string, unknown> = {}, entry: Record<string, unknown> = {}) {
	return JSON.stringify({
		version: '0.1.20',
		generation: 1,
		'linux-x86_64': {
			url: 'https://releases.herdr.dev/core/0.1.20/herdr-core-linux-x86_64.tar.gz',
			sha256: HASH,
			...entry
		},
		...overrides
	});
}

describe('ralph pin', () => {
	const REV = 'b'.repeat(40);
	const ralph = (overrides: Record<string, unknown> = {}) =>
		JSON.stringify({
			repository: 'https://github.com/Vonshlovens/von-ralph',
			rev: REV,
			version: '0.6.0',
			pnpm: '10.34.8',
			...overrides
		});

	it('reads the repository pin', () => {
		const pin = readRalphPin();
		expect(pin.repository).toBe('https://github.com/Vonshlovens/von-ralph');
		expect(pin.rev).toMatch(/^[0-9a-f]{40}$/);
	});

	it('refuses a pin a build should not trust', () => {
		expect(() => parseRalphPin(ralph({ repository: 'https://github.com/someone/ralph' }))).toThrow(
			/repository/
		);
		expect(() => parseRalphPin(ralph({ rev: 'main' }))).toThrow(/40-character/);
		expect(() => parseRalphPin(ralph({ rev: 'b'.repeat(7) }))).toThrow(/40-character/);
		expect(() => parseRalphPin(ralph({ version: 'latest' }))).toThrow(/version/);
		expect(() => parseRalphPin(ralph({ pnpm: '10' }))).toThrow(/pnpm/);
	});

	it('installs exactly the pinned commit, from its lockfile, and checks the version', () => {
		const commands = ralphInstallCommands(parseRalphPin(ralph()));
		const fetch = commands.findIndex((c) => c.includes(' fetch '));
		const verify = commands.findIndex((c) => c.includes('rev-parse HEAD'));
		const install = commands.findIndex((c) => c.includes(' install '));
		expect(commands[fetch]).toContain(`'https://github.com/Vonshlovens/von-ralph.git' '${REV}'`);
		expect(verify).toBeGreaterThan(fetch);
		expect(install).toBeGreaterThan(verify);
		expect(commands[install]).toContain('--frozen-lockfile');
		expect(commands[install]).toContain("'pnpm@10.34.8'");
		expect(commands).toContain(`ln -sf '${RALPH_DIR}/bin/ralph' /usr/local/bin/ralph`);
		expect(commands.at(-1)).toBe("ralph --version | grep -qxF 'ralph v0.6.0'");
	});
});

describe('hc pin', () => {
	it('reads the repository pin', () => {
		const release = readHcPin();
		expect(release.generation).toBe(1);
		expect(release.url).toBe(
			`https://releases.herdr.dev/core/${release.version}/herdr-core-linux-x86_64.tar.gz`
		);
		expect(release.sha256).toMatch(/^[0-9a-f]{64}$/);
	});

	it('refuses a pin a build should not trust', () => {
		expect(() => parseHcPin(pin({ version: 'latest' }))).toThrow(/version/);
		expect(() => parseHcPin(pin({ generation: 2 }))).toThrow(/generation 1/);
		expect(() => parseHcPin(pin({}, { sha256: 'ABC' }))).toThrow(/sha256/);
		expect(() =>
			parseHcPin(pin({}, { url: 'https://example.com/herdr-core-linux-x86_64.tar.gz' }))
		).toThrow(/url/);
		expect(() => parseHcPin(pin(), 'linux-aarch64')).toThrow(/no linux-aarch64/);
	});

	it('installs only after the pinned hash checks', () => {
		const commands = hcInstallCommands(parseHcPin(pin()));
		const check = commands.findIndex((c) => c.includes('sha256sum -c'));
		const install = commands.findIndex((c) => c.includes('/usr/local/bin/hc'));
		expect(commands[check]).toContain(HASH);
		expect(check).toBeGreaterThan(-1);
		expect(install).toBeGreaterThan(check);
	});
});

describe('Claude Code first-run state', () => {
	const files = claudeFirstRunFiles();
	const state = JSON.parse(files[`${SANDBOX_HOME}/.claude.json`]);
	const settings = JSON.parse(files[`${CLAUDE_CONFIG_DIR}/settings.json`]);

	it('completes onboarding and trusts both agent working directories', () => {
		expect(state.hasCompletedOnboarding).toBe(true);
		expect(state.projects[WORK_DIR].hasTrustDialogAccepted).toBe(true);
		expect(state.projects[MATE_WORKDIR].hasTrustDialogAccepted).toBe(true);
	});

	it('pre-approves only the egress placeholder key, by its last 20 characters', () => {
		expect(state.customApiKeyResponses.approved).toEqual([ANTHROPIC_PLACEHOLDER.slice(-20)]);
	});

	it('accepts the bypass-permissions warning', () => {
		expect(settings.skipDangerousModePermissionPrompt).toBe(true);
	});
});

describe('beadsmith-hc carrier', () => {
	const dir = mkdtempSync(join(tmpdir(), 'beadsmith-hc-'));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	/** A fake `hc` on PATH: `connect` runs the given shell body. */
	function fakeHc(body: string): string {
		const bin = mkdtempSync(join(dir, 'bin-'));
		const hc = join(bin, 'hc');
		writeFileSync(hc, `#!/bin/sh\n[ "$1" = connect ] || exit 9\n${body}\n`);
		chmodSync(hc, 0o755);
		return bin;
	}

	function run(bin: string, args: string[], input: string[]) {
		return new Promise<{ code: number | null; lines: string[]; stderr: string }>((resolve) => {
			const child = spawn(process.execPath, [CARRIER, ...args], {
				env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }
			});
			let stdout = '';
			let stderr = '';
			child.stdout.on('data', (d) => (stdout += d));
			child.stderr.on('data', (d) => (stderr += d));
			child.on('close', (code) =>
				resolve({ code, lines: stdout.split('\n').filter(Boolean), stderr })
			);
			for (const line of input) child.stdin.write(`${line}\n`);
			child.stdin.end();
		});
	}

	it('carries arbitrary bytes both ways as base64 lines', async () => {
		const bytes = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7) % 256));
		const halves = [bytes.subarray(0, 1000), bytes.subarray(1000)];
		const result = await run(
			fakeHc('exec cat'),
			['connect'],
			halves.map((h) => h.toString('base64'))
		);
		expect(result.code).toBe(0);
		for (const line of result.lines) expect(line).toMatch(/^[A-Za-z0-9+/]*=*$/);
		const echoed = Buffer.concat(result.lines.map((line) => Buffer.from(line, 'base64')));
		expect(echoed.equals(bytes)).toBe(true);
	});

	it("exits with hc's status", async () => {
		const result = await run(fakeHc('cat >/dev/null; exit 3'), ['connect'], []);
		expect(result.code).toBe(3);
	});

	it('stops on a line that is not base64 instead of sending a corrupt frame', async () => {
		const result = await run(fakeHc('exec cat'), ['connect'], ['aGVsbG8=', 'not base64!']);
		expect(result.code).toBe(2);
		expect(result.stderr).toContain('not base64');
	});

	it('refuses anything but connect', async () => {
		const result = await run(fakeHc('exec cat'), ['exec', 'id'], []);
		expect(result.code).toBe(2);
	});
});
