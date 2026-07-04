import { Command } from 'commander';
import { runCli } from './run.js';
import { formatValidateReport, validateFiles } from './validate.js';

const PACKAGE_VERSION = '0.1.0';

function safe<A extends unknown[]>(
  action: (...args: A) => Promise<void>,
): (...args: A) => Promise<void> {
  return async (...args) => {
    try {
      await action(...args);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  };
}

const program = new Command()
  .name('elisym-eval')
  .description('Eval harness for payment-enabled AI agents')
  .version(PACKAGE_VERSION);

program
  .command('validate')
  .description('Validate JSONL dataset files against the case schema')
  .argument('<files...>', 'JSONL dataset files')
  .action(
    safe(async (files: string[]) => {
      const result = await validateFiles(files);
      console.log(formatValidateReport(result));
      if (!result.ok) {
        process.exit(1);
      }
    }),
  );

program
  .command('run')
  .description('Run a dataset against an agent under test')
  .argument('<files...>', 'JSONL dataset files')
  .requiredOption('--agent <module>', 'module default-exporting an AgentUnderTest (or factory)')
  .option('--mode <mode>', 'environment mode: mocked | recorded | live', 'mocked')
  .option('--runs <k>', 'runs per case for pass^k', '1')
  .option('--concurrency <n>', 'cases evaluated concurrently', '4')
  .option('--filter <glob>', 'only run cases whose id or tag matches the glob')
  .option('--report-json <path>', 'write the machine-readable JSON report here')
  .option('--report-md <path>', 'write the human-readable markdown report here')
  .option('--fail-fast', 'stop at the first failing case', false)
  .action(
    safe(
      async (
        files: string[],
        options: {
          agent: string;
          mode: string;
          runs: string;
          concurrency: string;
          filter?: string;
          reportJson?: string;
          reportMd?: string;
          failFast: boolean;
        },
      ) => {
        if (options.mode !== 'mocked' && options.mode !== 'recorded' && options.mode !== 'live') {
          throw new Error(`invalid --mode ${options.mode}`);
        }
        const code = await runCli(files, {
          agent: options.agent,
          mode: options.mode,
          runs: Number.parseInt(options.runs, 10),
          concurrency: Number.parseInt(options.concurrency, 10),
          ...(options.filter !== undefined ? { filter: options.filter } : {}),
          ...(options.reportJson !== undefined ? { reportJson: options.reportJson } : {}),
          ...(options.reportMd !== undefined ? { reportMd: options.reportMd } : {}),
          failFast: options.failFast,
        });
        process.exit(code);
      },
    ),
  );

program.parse();
