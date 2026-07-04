import { Command } from 'commander';

const PACKAGE_VERSION = '0.1.0';

const program = new Command()
  .name('elisym-eval')
  .description('Eval harness for payment-enabled AI agents')
  .version(PACKAGE_VERSION);

program.parse();
