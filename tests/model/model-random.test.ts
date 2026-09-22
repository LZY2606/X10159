// Deterministic model-based fuzzing: a fixed seed drives a generator of legal
// edit sequences; each sequence is replayed against both magic-string and an
// independent character-provenance reference model, and toString(), clone
// isolation and the decoded sourcemap (all three hires modes) are compared at
// every step.
//
// On failure the case is delta-debugged and printed as a self-contained test
// that can be pasted straight into the suite as a regression test.

import { assert, describe, it } from 'vitest'
import { checkCase, Mismatch, renderRegressionTest, shrink } from './checker.ts'
import { generateCase } from './generator.ts'

// Bump COUNT locally to stress the model; the checked-in value finishes in a
// few seconds and is fully deterministic.
const COUNT = 400
const BASE_SEED = 20260923

describe('model-based edit sequences (deterministic seed)', () => {
  const failures: Array<{ seed: number, error: Mismatch }> = []

  for (let i = 0; i < COUNT; i += 1) {
    const seed = (BASE_SEED + i) >>> 0
    it(`seed ${seed}`, () => {
      const generated = generateCase(seed, i % 2 === 0)
      const testCase = {
        source: generated.source,
        ops: generated.ops,
        cloneAt: generated.cloneAt,
        cloneOps: generated.cloneOps,
      }
      try {
        checkCase(testCase)
      }
      catch (error) {
        // Unexpected library crashes (not contract mismatches) fail at once;
        // contract mismatches are gathered, shrunk and reported by the summary
        // test below.
        if (!(error instanceof Mismatch))
          throw error
        failures.push({ seed, error })
      }
    })
  }

  it('matches the reference model; on failure it prints a minimised regression case', () => {
    if (failures.length === 0)
      return

    const rendered: string[] = []
    for (const failure of failures) {
      const generated = generateCase(failure.seed, true)
      const minimised = shrink({
        source: generated.source,
        ops: generated.ops,
        cloneAt: generated.cloneAt,
        cloneOps: generated.cloneOps,
      })
      rendered.push(
        `// seed ${failure.seed}\n// ${failure.error.detail.split('\n').join('\n// ')}\n${renderRegressionTest(minimised, `seed ${failure.seed}`)}`,
      )
    }
    assert.fail(
      `\n${failures.length} model mismatch(es). Paste the minimised case(s) into the suite:\n\n${rendered.join('\n\n')}`,
    )
  })
})
