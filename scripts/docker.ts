import { resolve } from 'node:path';

export const dockerExecutable = Bun.which('docker') ? ['docker'] : ['wsl.exe', '--exec', 'docker'];
const nativePath = resolve('compose.distributed.yml');
const composePath = dockerExecutable[0] === 'wsl.exe'
  ? nativePath.replace(/^([A-Za-z]):/, (_, drive: string) => `/mnt/${drive.toLowerCase()}`).replaceAll('\\', '/')
  : nativePath;

export async function command(args: string[], options: { env?: Record<string, string | undefined>; quiet?: boolean; allowFailure?: boolean; outputFile?: string } = {}): Promise<string> {
  const child = Bun.spawn(args, { env: { ...process.env, ...options.env }, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (options.outputFile !== undefined) await Bun.write(options.outputFile, stdout + stderr);
  if (!options.quiet || code !== 0) {
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
  }
  if (code !== 0 && !options.allowFailure) throw new Error(`Command exited ${code}: ${args.join(' ')}`);
  return stdout.trim();
}
export function compose(project: string, args: string[], quiet = false): Promise<string> {
  if (!/^wager-final-[a-z0-9-]+$/.test(project)) throw new Error('Refusing non-test compose project');
  const executable = dockerExecutable[0] === 'wsl.exe' && process.env.POSTGRES_PUBLISHED_PORT
    ? ['wsl.exe', '--exec', 'env', `POSTGRES_PUBLISHED_PORT=${process.env.POSTGRES_PUBLISHED_PORT}`, 'docker']
    : dockerExecutable;
  return command([...executable, 'compose', '-p', project, '-f', composePath, ...args], { quiet });
}
export async function eventually<T>(probe: () => Promise<T>, accept: (value: T) => boolean, timeoutMs = 60000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  do {
    try { const value = await probe(); if (accept(value)) return value; last = value; }
    catch (error) { last = error; }
    await Bun.sleep(200);
  } while (Date.now() < deadline);
  throw new Error(`Condition timed out: ${JSON.stringify(last instanceof Error ? last.message : last)}`);
}
export async function endpoints(project: string): Promise<string[]> {
  return Promise.all(['app-a', 'app-b', 'app-c'].map(async (service) =>
    `http://${await compose(project, ['port', service, '3000'], true)}`));
}
