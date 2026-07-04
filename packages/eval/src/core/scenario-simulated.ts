import { NotImplementedError } from './errors.js';

/**
 * The simulated (user-simulator) scenario variant is declared in the schema so
 * datasets stay forward-compatible, but v1 does not implement it.
 */
export function runSimulatedScenario(): never {
  throw new NotImplementedError('simulated scenarios');
}
