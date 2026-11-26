/**
 * Pre-screen helpers (lab/assets.py): what a claim needs that the project doesn't have. The matcher records
 * it as one blocker, `needs assets: <item>; <item>`, plus the full check (`asset_check`) on the match.
 */
import type { AssetCategory, AssetCheck, ProjectCapabilities } from '../api/types'

const PREFIX = 'needs assets:'

export const isAssetBlocker = (blocker: string): boolean => blocker.trim().toLowerCase().startsWith(PREFIX)

/** The missing items of a `needs assets: …` blocker. */
export function assetBlockerItems(blocker: string): string[] {
  if (!isAssetBlocker(blocker)) return []
  return blocker
    .trim()
    .slice(PREFIX.length)
    .split(';')
    .map((item) => item.trim())
    .filter(Boolean)
}

/** What's missing: from the stored check, else parsed from the blocker. */
export function missingAssets(item: { asset_check?: AssetCheck | null; blockers?: string[] }): string[] {
  const fromCheck = item.asset_check?.status === 'needs_assets' ? item.asset_check.missing.map((m) => m.label) : []
  if (fromCheck.length) return fromCheck
  return (item.blockers ?? []).flatMap(assetBlockerItems)
}

/** Blocked only because it lacks assets: including it is a deliberate choice, not a lost cause. */
export function blockedOnlyByAssets(item: { blockers: string[] }): boolean {
  return item.blockers.length > 0 && item.blockers.every(isAssetBlocker)
}

/** "a, b and c" */
export function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/** "Needs a trained EAGLE-3 draft head and a calibration dataset." */
export function needsSentence(missing: string[]): string {
  return missing.length ? `Needs ${joinList(missing)}.` : ''
}

export const ASSET_CATEGORY: Record<AssetCategory, string> = {
  draft_model: 'Trained drafter',
  mtp_heads: 'MTP heads',
  offline_artifact: 'Offline artifact',
  calibration_data: 'Calibration data',
  architecture: 'Model architecture',
  custom_kernels: 'CUDA/Triton kernels',
  multi_gpu: 'Multiple GPUs',
  min_context: 'Context length',
  training: 'Training',
  trained_adapter: 'Trained adapter',
  other: 'Other',
}

const yesNo = (value: boolean) => (value ? 'yes' : 'none')
const list = (values: string[]) => (values.length ? values.join(', ') : 'none')

/** One row per capability for the project page; `assumed` marks defaults lab.yaml doesn't declare. */
export function capabilityRows(caps: ProjectCapabilities): { key: string; label: string; value: string; assumed: boolean }[] {
  const rows: [string, string, string][] = [
    ['architecture', 'Architecture', caps.architecture === 'moe' ? 'MoE' : caps.architecture],
    ['draft_models', 'Draft models', list(caps.draft_models)],
    ['mtp_heads', 'MTP heads', yesNo(caps.mtp_heads)],
    ['offline_artifacts', 'Offline artifacts', list(caps.offline_artifacts)],
    ['calibration_data', 'Calibration data', yesNo(caps.calibration_data)],
    ['max_context_tokens', 'Max context', `${Math.round(caps.max_context_tokens / 1024)}K tokens`],
    ['trained_adapters', 'Trained adapters', list(caps.trained_adapters)],
    ['accelerator', 'Accelerator', caps.accelerator],
  ]
  const assumed = new Set(caps.assumed)
  return rows.map(([key, label, value]) => ({ key, label, value, assumed: assumed.has(key) }))
}
