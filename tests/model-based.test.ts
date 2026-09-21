import { describe, expect, it } from 'vitest'
import { generateCase } from './model/generator.ts'
import { formatFailure } from './model/shrink.ts'
import { runCase } from './model/replay.ts'

/**
 * Deterministic, model-based differential testing of legal editing sequences.
 *
 * Each case is produced by a fixed-seed generator, validated against the
 * independent character-origin model in tests/model, and compared against the
 * real library on three fronts after every operation:
 *   - toString() matches the predicted generated text
 *   - decoded sourcemaps match exactly for hires false/true/"boundary", plus
 *     character-level origin invariants (unchanged chars map back to their
 *     original index, inserted chars never get a segment, moved chars still
 *     point at their original position, removed chars leave no segment)
 *   - clones are isolated and mirror the cloned state
 *
 * On failure the case is delta-debugged to a minimal sequence and rendered as
 * code that can be pasted straight into a regression test.
 */
describe('model-based editing sequences', () => {
  const SEED_COUNT = 400
  const MAX_OPS = 24

  for (let seed = 1; seed <= SEED_COUNT; seed++) {
    it(`seed ${seed}`, () => {
      const testCase = generateCase(seed * 7919 + 13, MAX_OPS)
      const mismatch = runCase(testCase)
      if (mismatch) {
        // shrink with the prefix that actually failed, then report
        const report = formatFailure(seed, {
          source: testCase.source,
          ops: testCase.ops.slice(0, mismatch.opIndex + 1),
        }, mismatch.message)
        expect.fail(report)
      }
    })
  }
})
