import { Command } from 'commander';
import { calibrateCli } from './calibrate.js';
import { compileCli } from './compile.js';
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
  .option('--judge <provider>', 'default judge: anthropic | openai | openai-compatible')
  .option('--judge-model <id>', 'model id for the judge')
  .option('--judge-base-url <url>', 'endpoint for openai-compatible / custom judges')
  .option('--rubrics <file.json>', 'rubrics file for judge assertions')
  .option('--record', 'capture tool/payment responses to the recordings directory', false)
  .option('--recordings <dir>', 'recordings directory (for --record and --mode recorded)')
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
          judge?: string;
          judgeModel?: string;
          judgeBaseUrl?: string;
          rubrics?: string;
          record: boolean;
          recordings?: string;
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
          ...(options.judge !== undefined ? { judge: options.judge } : {}),
          ...(options.judgeModel !== undefined ? { judgeModel: options.judgeModel } : {}),
          ...(options.judgeBaseUrl !== undefined ? { judgeBaseUrl: options.judgeBaseUrl } : {}),
          ...(options.rubrics !== undefined ? { rubrics: options.rubrics } : {}),
          ...(options.record ? { record: true } : {}),
          ...(options.recordings !== undefined ? { recordings: options.recordings } : {}),
          failFast: options.failFast,
        });
        process.exit(code);
      },
    ),
  );

program
  .command('compile')
  .description(
    'Compile a TS-authored dataset (exports cases + optional modifiers) to canonical JSONL',
  )
  .argument('<entry>', 'dataset entry module (TS entries need the CLI to run under Bun)')
  .requiredOption('--out <file.jsonl>', 'output JSONL path')
  .option('--check', 'verify the output file is up to date instead of writing (CI gate)', false)
  .option('--no-modifiers', 'skip injection modifiers (base cases only)')
  .action(
    safe(async (entry: string, options: { out: string; check: boolean; modifiers: boolean }) => {
      const code = await compileCli(entry, options);
      if (code !== 0) {
        process.exit(code);
      }
    }),
  );

program
  .command('calibrate')
  .description("Run a judge over a human-labeled set and report agreement % + Cohen's kappa")
  .argument('<labeled.jsonl>', 'JSONL with {id, input, output, humanVerdict} rows')
  .requiredOption('--judge <provider>', 'anthropic | openai | openai-compatible')
  .requiredOption('--judge-model <id>', 'model id for the judge')
  .option('--judge-base-url <url>', 'endpoint for openai-compatible / custom judges')
  .requiredOption('--rubric <id>', 'rubric id or id@version to calibrate against')
  .requiredOption('--rubrics <file.json>', 'rubrics file')
  .option('--scale <scale>', 'binary | ternary', 'binary')
  .option('--report-json <path>', 'write the full calibration report here')
  .action(
    safe(
      async (
        labeledFile: string,
        options: {
          judge: string;
          judgeModel: string;
          judgeBaseUrl?: string;
          rubric: string;
          rubrics: string;
          scale: string;
          reportJson?: string;
        },
      ) => {
        if (options.scale !== 'binary' && options.scale !== 'ternary') {
          throw new Error(`invalid --scale ${options.scale}`);
        }
        await calibrateCli(labeledFile, {
          judge: options.judge,
          judgeModel: options.judgeModel,
          ...(options.judgeBaseUrl !== undefined ? { judgeBaseUrl: options.judgeBaseUrl } : {}),
          rubric: options.rubric,
          rubrics: options.rubrics,
          scale: options.scale,
          ...(options.reportJson !== undefined ? { reportJson: options.reportJson } : {}),
        });
      },
    ),
  );

program.parse();
