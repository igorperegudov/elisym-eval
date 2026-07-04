import { Command } from 'commander';
import { VERSION } from '../index.js';

const program = new Command()
  .name('elisym-eval')
  .description('Eval harness for payment-enabled AI agents')
  .version(VERSION);

program.parse();
