// Main process of one transient user service. All workload descendants stay
// in this service's cgroup, including processes that create new sessions.
// Exiting the main process makes systemd stop the entire cgroup.
import { spawn } from 'node:child_process';
const [command, ...args] = process.argv.slice(2);
const child = spawn(command, args, { stdio: ['pipe', 'inherit', 'inherit'] });
const finish = () => process.exit(0);
process.stdin.on('end', finish);
process.stdin.on('error', finish);
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, finish);
child.on('error', () => process.exit(1));
child.on('exit', (code) => process.exit(code ?? 1));
child.stdin.on('error', finish);
process.stdin.pipe(child.stdin);
