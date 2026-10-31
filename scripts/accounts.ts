/**
 * Recover an account when nobody can sign in as an admin (ADR-0011): set a
 * new password, or promote an account to admin. Both also sign that account
 * out everywhere. It edits state.db directly, so it needs no secret and no
 * Dolt, and it is safe while Beadsmith is running.
 *
 *   node scripts/accounts.ts list
 *   node scripts/accounts.ts set-password you@example.com
 *   node scripts/accounts.ts promote you@example.com
 *
 * Docker Compose (the image carries this script):
 *   docker compose exec beadsmith node scripts/accounts.ts set-password you@example.com
 *   docker compose exec -T beadsmith node scripts/accounts.ts set-password you@example.com < password-file
 *
 * The password is typed at a prompt with echo off (twice), or read from the
 * first line of stdin when it is piped. It is never an argument: arguments
 * land in shell history and process listings.
 *
 * State directory: BDX_STATE_DIR, else the server's default
 * (~/.local/state/beads-web). The container sets it to /state.
 */
import {
	assertAccountExists,
	checkPassword,
	describeOutcome,
	listAccounts,
	openAccounts,
	parseRecoveryArgs,
	passwordFromInput,
	promoteAccount,
	RecoveryError,
	RECOVERY_USAGE,
	setAccountPassword
} from '../src/lib/server/auth/recovery.ts';
import { resolveStateDir } from '../src/lib/server/state/dir.ts';

function fail(message: string): never {
	console.error(`accounts: ${message}`);
	process.exit(1);
}

/** One line from the terminal with echo off; Backspace edits, Ctrl-C quits. */
async function promptHidden(label: string): Promise<string> {
	process.stderr.write(label);
	const bytes: number[] = [];
	process.stdin.setRawMode(true);
	try {
		read: for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
			for (const byte of chunk) {
				if (byte === 0x0d || byte === 0x0a || byte === 0x04) break read;
				if (byte === 0x03) {
					process.stdin.setRawMode(false);
					process.stderr.write('\n');
					process.exit(130);
				}
				if (byte === 0x7f || byte === 0x08) {
					// Drop one character: its continuation bytes, then its first byte.
					while (bytes.length > 0 && (bytes[bytes.length - 1] & 0xc0) === 0x80) bytes.pop();
					bytes.pop();
				} else {
					bytes.push(byte);
				}
			}
		}
	} finally {
		process.stdin.setRawMode(false);
		process.stderr.write('\n');
	}
	return new TextDecoder().decode(Uint8Array.from(bytes));
}

/** All of stdin, when it is piped. */
async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin as AsyncIterable<Buffer>) chunks.push(chunk);
	return Buffer.concat(chunks).toString('utf8');
}

/** The new password: prompted for twice at a terminal, else piped in on stdin. */
async function readPassword(): Promise<string> {
	if (!process.stdin.isTTY) {
		return passwordFromInput(await readStdin());
	}
	const password = await promptHidden('New password: ');
	if (password === '') throw new RecoveryError('The password is empty.');
	checkPassword(password);
	if ((await promptHidden('Repeat it: ')) !== password) {
		throw new RecoveryError('The two passwords differ. Nothing was changed.');
	}
	return password;
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (args[0] === '--help' || args[0] === '-h') {
		console.log(RECOVERY_USAGE);
		return;
	}
	const command = parseRecoveryArgs(args);
	const client = await openAccounts(resolveStateDir(process.env));
	try {
		if (command.action === 'list') {
			const accounts = await listAccounts(client);
			if (accounts.length === 0) console.log('No accounts yet.');
			for (const account of accounts) {
				console.log(`${account.email}\t${account.role}\t${account.name}`);
			}
			return;
		}
		await assertAccountExists(client, command.email);
		const outcome =
			command.action === 'promote'
				? await promoteAccount(client, command.email)
				: await setAccountPassword(client, command.email, await readPassword());
		for (const line of describeOutcome(outcome)) console.log(line);
	} finally {
		client.close();
	}
}

try {
	await main();
} catch (error) {
	if ((error as { code?: string }).code === 'SQLITE_BUSY') {
		fail(
			'state.db stayed locked by another process for 5 seconds. Nothing was changed; try again.'
		);
	}
	fail(error instanceof Error ? error.message : String(error));
}
