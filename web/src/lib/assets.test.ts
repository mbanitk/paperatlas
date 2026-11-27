import { describe, expect, it } from 'vitest'
import type { ProjectCapabilities } from '../api/types'
import { assetBlockerItems, blockedOnlyByAssets, capabilityRows, isAssetBlocker, missingAssets, needsSentence } from './assets'

describe('pre-screen helpers', () => {
  it('parses the needs-assets blocker', () => {
    const blocker = 'needs assets: a trained EAGLE-3 draft head; a calibration dataset'
    expect(isAssetBlocker(blocker)).toBe(true)
    expect(isAssetBlocker('needs CUDA')).toBe(false)
    expect(assetBlockerItems(blocker)).toEqual(['a trained EAGLE-3 draft head', 'a calibration dataset'])
    expect(needsSentence(assetBlockerItems(blocker))).toBe('Needs a trained EAGLE-3 draft head and a calibration dataset.')
  })

  it('prefers the stored check and tells asset-only blocks from others', () => {
    const check = {
      status: 'needs_assets' as const,
      missing: [{ category: 'architecture' as const, key: 'moe', label: 'an MoE model' }],
      needs: [],
      source: 'llm' as const,
      assumed: [],
      classified_at: null,
    }
    expect(missingAssets({ asset_check: check, blockers: ['needs assets: stale'] })).toEqual(['an MoE model'])
    expect(missingAssets({ asset_check: null, blockers: ['needs CUDA', 'needs assets: x'] })).toEqual(['x'])
    expect(blockedOnlyByAssets({ blockers: ['needs assets: x'] })).toBe(true)
    expect(blockedOnlyByAssets({ blockers: ['needs assets: x', 'needs CUDA'] })).toBe(false)
    expect(blockedOnlyByAssets({ blockers: [] })).toBe(false)
  })

  it('marks capabilities lab.yaml does not declare as assumed', () => {
    const caps: ProjectCapabilities = {
      architecture: 'dense',
      draft_models: [],
      mtp_heads: false,
      offline_artifacts: ['awq_calibration'],
      calibration_data: false,
      max_context_tokens: 32768,
      trained_adapters: [],
      accelerator: 'apple-gpu-mlx',
      multi_gpu: false,
      cuda: false,
      assumed: ['draft_models'],
    }
    const rows = capabilityRows(caps)
    expect(rows.find((row) => row.key === 'draft_models')).toMatchObject({ value: 'none', assumed: true })
    expect(rows.find((row) => row.key === 'offline_artifacts')).toMatchObject({ value: 'awq_calibration', assumed: false })
    expect(rows.find((row) => row.key === 'max_context_tokens')?.value).toBe('32K tokens')
  })
})
