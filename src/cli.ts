import { parseArgs } from 'node:util';
import { isMainThread, workerData } from 'node:worker_threads';

const knownCommands = [
  'setup',
  'doctor',
  'hook',
  'capture',
  'inject',
  'observe',
  'search',
  'timeline',
  'get',
  'why',
  'pin',
  'unpin',
  'delete',
  'pause',
  'resume',
  'export',
  'import',
  'mcp',
  'view',
  'fixture',
];

const commands: Record<string, () => Promise<(argv: string[]) => Promise<number>>> = {
  // hook: () => import('./capture.js').then((m) => m.runHook),
};

function usage(): string {
  return `Usage: oboete <command> [options]\n\nCommands: ${knownCommands.join(', ')}.\n`;
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      help: { type: 'boolean' },
      version: { type: 'boolean' },
    },
  });

  if (values.version) {
    process.stdout.write(`${OBOETE_VERSION}\n`);
    return 0;
  }

  const name = positionals[0];
  if (values.help || name === undefined) {
    process.stdout.write(usage());
    return 0;
  }

  const load = commands[name];
  if (load) {
    const run = await load();
    const from = argv.indexOf(name);
    return run(argv.slice(from === -1 ? 1 : from + 1));
  }

  if (knownCommands.includes(name)) {
    process.stderr.write(`oboete ${name} is not implemented yet\n`);
    return 2;
  }

  process.stderr.write(usage());
  return 2;
}

// The detector Worker runs this same bundle (R4), so the CLI dispatch must not run inside it: any
// worker on this bundle stays silent, even one carrying a role this build does not know.
if (!isMainThread) {
  if (workerData?.role === 'oboete-detector') {
    await (await import('./privacy/detect.js')).detectorWorkerMain();
  }
} else {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message.split('\n')[0]}\n`);
    process.exitCode = 3;
  }
}
