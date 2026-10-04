import { readFile, writeFile, mkdir, copyFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const source = dirname(dirname(fileURLToPath(import.meta.url)));
const files = ['copilot/hook.mjs', 'copilot/intent.mjs', 'copilot/decider.mjs', 'hooks/lib.ts'];

async function optionalText(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function install(projectRoot) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (!(major >= 24 || major === 22 && minor >= 18)) throw new Error('sieve Copilot requires Node 22.18+ or 24+');
  const project = await realpath(projectRoot);
  const destination = join(project, '.github', 'sieve');
  const config = join(project, '.github', 'hooks', 'sieve-copilot.json');
  const entry = join(destination, 'copilot', 'hook.mjs');
  const existing = await optionalText(config);
  if (existing !== undefined) {
    const previous = JSON.parse(existing);
    const kinds = { sessionStart: 'start', userPromptSubmitted: 'prompt', postToolUse: 'result' };
    if (previous?.version !== 1 || Object.keys(previous).some(key => !['version', 'hooks'].includes(key))
      || !previous.hooks || Object.keys(previous.hooks).length !== Object.keys(kinds).length
      || !Object.entries(kinds).every(([name, kind]) => {
        const hooks = previous.hooks[name];
        const hook = hooks?.[0];
        return Array.isArray(hooks) && hooks.length === 1 && hook?.type === 'command'
          && Array.isArray(hook.args) && hook.args.length === 4
          && hook.args[0] === '--experimental-strip-types' && hook.args[1] === entry
          && hook.args[2] === kind && hook.args[3] === project;
      })) {
      throw new Error(`refusing to overwrite unrelated or extended hook configuration: ${config}`);
    }
  }
  if (existing === undefined) {
    try {
      await realpath(destination);
      throw new Error(`refusing to overwrite an existing runtime directory: ${destination}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const command = kind => ({ type: 'command', exec: process.execPath,
    args: ['--experimental-strip-types', entry, kind, project], cwd: project, timeoutSec: 10 });
  const hooks = {
    version: 1,
    hooks: {
      sessionStart: [command('start')],
      userPromptSubmitted: [command('prompt')],
      postToolUse: [{ ...command('result'), matcher: 'bash|powershell' }],
    },
  };
  for (const file of files) {
    const target = join(destination, file);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(source, file), target);
  }
  const ignorePath = join(project, '.gitignore');
  const ignore = await optionalText(ignorePath) ?? '';
  if (!ignore.split(/\r?\n/).includes('/.sieve/')) {
    await writeFile(ignorePath, `${ignore}${ignore && !ignore.endsWith('\n') ? '\n' : ''}/.sieve/\n`);
  }
  await mkdir(dirname(config), { recursive: true });
  await writeFile(config, `${JSON.stringify(hooks, null, 2)}\n`);
  return config;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    console.log(`Installed sieve Copilot hooks: ${await install(resolve(process.argv[2] ?? process.cwd()))}`);
  } catch (error) {
    console.error(`sieve install: ${String(error)}`);
    process.exitCode = 1;
  }
}
