import { assert, describe, it } from 'vitest'
import {
  formatRegression,
  generateTrace,
  runTrace,
  shrinkTrace,
  traceFails,
} from '../__utils/fuzzHarness.ts'

/**
 * Deterministic, model-based differential tests for edit sequences.
 *
 * Every trace is produced from a fixed seed by `generateTrace`, which pre-filters
 * operations the public contract considers illegal (splitting inside a non-empty
 * replacement, moving into/through a range an earlier move broke, ...). The
 * independent character-provenance model (tests/__utils/charModel.ts) predicts
 * both `toString()` and the fully decoded sourcemap:
 *
 * - unchanged characters map back to their original index,
 * - inserted characters forge no source segment,
 * - moved characters still point at their original location,
 * - removed characters leave no generated segment.
 *
 * Clones run as separate worlds, so edits to one lineage cannot leak into another.
 */
describe('model-based edit sequences', () => {
  const SEED = 0x5EED_1234
  const TRACE_COUNT = 240
  const STEP_COUNT = 14

  for (let i = 0; i < TRACE_COUNT; i += 1) {
    const seed = SEED + i
    it(`trace ${i} (seed ${seed})`, () => {
      const generated = generateTrace(seed, STEP_COUNT)
      try {
        runTrace(generated.source, generated.trace)
      }
      catch (error) {
        const minimal = traceFails(generated.source, generated.trace)
          ? shrinkTrace(generated.source, generated.trace)
          : generated.trace
        const regression = formatRegression(generated.source, minimal)
        const message = error instanceof Error ? error.message : String(error)
        assert.fail(
          `seed ${seed}: ${message}\n\n`
            + `Reproduce with generateTrace(${seed}, ${STEP_COUNT}).\n`
            + `Minimal ${minimal.length}-op regression:\n\n${regression}\n`,
        )
      }
    })
  }
})
