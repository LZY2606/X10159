import { assert, describe, it } from 'vitest'
import { MagicString } from '../../src/index.ts'
import { applyOps, generateCase, renderCase } from './generator.ts'
import { expectedMappings, expectedNames } from './mapOracle.ts'
import { SourceModel } from './sourceModel.ts'

describe('smoke differential', () => {
  for (let seed = 1; seed <= 3000; seed += 1) {
    it(`seed ${seed}`, () => {
      const testCase = generateCase(seed, 14, SourceModel)
      const model = new SourceModel(testCase.source)
      applyOps(model, testCase.ops)

      const actual = new MagicString(testCase.source)
      applyOps(actual as any, testCase.ops)

      assert.strictEqual(
        actual.toString(),
        model.toString(),
        `toString mismatch\n${renderCase(testCase)}`,
      )

      for (const hires of [true, 'boundary' as const, false]) {
        const map = actual.generateDecodedMap({ hires })
        try {
          assert.deepEqual(map.mappings, expectedMappings(model, hires))
          assert.deepEqual(map.names, expectedNames(model))
        }
        catch (e) {
          throw new Error(
            `map mismatch hires=${hires}\n${renderCase(testCase)}\n\n`
            + `expected: ${JSON.stringify(expectedMappings(model, hires))}\n`
            + `actual:   ${JSON.stringify(map.mappings)}`,
          )
        }
      }
    })
  }
})
