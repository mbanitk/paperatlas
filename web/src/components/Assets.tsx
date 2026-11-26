/**
 * Pre-screen (lab/assets.py): what a claim needs that the project doesn't have, shown inline on claim cards and
 * claim pages, plus the project's declared capabilities.
 */
import { Link } from 'react-router'
import type { AssetCheck, ProjectAssets, ProjectCapabilities } from '../api/types'
import { ASSET_CATEGORY, capabilityRows, joinList } from '../lib/assets'
import { pluralize } from '../lib/format'
import { NEEDS_ASSETS } from '../lib/semantics'
import { AlertIcon, CheckIcon, XIcon } from './Icons'
import { cx, DefinitionList } from './ui'

/** "Needs assets inference-lab doesn't have: a trained EAGLE-3 draft head and a calibration dataset" */
export function NeedsAssetsNote({ missing, project, className }: { missing: string[]; project?: string; className?: string }) {
  if (!missing.length) return null
  return (
    <p className={cx('flex items-start gap-1.5 text-sm text-caution-fg', className)}>
      <AlertIcon size={14} className="mt-0.5 shrink-0" />
      <span className="min-w-0 [overflow-wrap:anywhere]">
        <strong className="font-semibold">
          {NEEDS_ASSETS.label}
          {project ? ` ${project} doesn’t have` : ''}:
        </strong>{' '}
        {joinList(missing)}
      </span>
    </p>
  )
}

/** Every prerequisite the pre-screen found, with whether the project provides it. */
export function AssetNeedsList({ check, project }: { check: AssetCheck; project?: string }) {
  if (!check.needs.length) {
    return <p className="text-muted">No special assets needed: no trained drafter, offline artifact, calibration data or particular model.</p>
  }
  return (
    <div className="space-y-2">
      <ul className="space-y-1.5">
        {check.needs.map((need, index) => {
          const state = need.met === true ? 'met' : need.met === false ? 'missing' : 'unchecked'
          return (
            <li key={`${need.category}-${need.key}-${index}`} className="flex min-w-0 items-start gap-2">
              <span
                className={cx(
                  'mt-0.5 shrink-0',
                  state === 'met' ? 'text-positive-fg' : state === 'missing' ? 'text-caution-fg' : 'text-muted',
                )}
                aria-hidden="true"
              >
                {state === 'met' ? <CheckIcon size={14} /> : state === 'missing' ? <XIcon size={14} /> : <span className="inline-block w-3.5 text-center">?</span>}
              </span>
              <span className="min-w-0 [overflow-wrap:anywhere]">
                <span className="sr-text">{state === 'met' ? 'Provided: ' : state === 'missing' ? 'Missing: ' : 'Not checked: '}</span>
                <span className="text-fg">{need.label}</span>
                <span className="text-muted">
                  {' '}
                  · {ASSET_CATEGORY[need.category] ?? need.category}
                  {!need.essential && ' (helps, not required)'}
                </span>
                {need.why && <span className="block text-xs text-muted">{need.why}</span>}
              </span>
            </li>
          )
        })}
      </ul>
      <p className="text-xs text-muted">
        {check.source === 'rules' ? 'Found by keyword rules' : 'Classified by the LLM'}, compared with {project ?? 'the project'}’s{' '}
        <code className="code-inline">capabilities</code> in lab.yaml
        {check.assumed.length > 0 && ` (not declared there, so assumed: ${check.assumed.join(', ')})`}.
      </p>
    </div>
  )
}

/** The project's capabilities and how many claims the pre-screen holds back. */
export function CapabilitiesList({ capabilities, assets, projectId }: { capabilities: ProjectCapabilities; assets?: ProjectAssets; projectId: number }) {
  const rows = capabilityRows(capabilities)
  return (
    <div className="space-y-2">
      <DefinitionList
        items={rows.map((row) => [
          row.label,
          <span key={row.key} className="[overflow-wrap:anywhere]">
            {row.value}
            {row.assumed && <span className="text-muted"> · assumed (not in lab.yaml)</span>}
          </span>,
        ])}
      />
      {assets && assets.checked > 0 && (
        <p className="text-sm text-muted">
          {assets.needs_assets > 0 ? (
            <>
              {pluralize(assets.needs_assets, 'matched claim')} need assets this project doesn’t have.{' '}
              <Link to={`/recommendations?project=${projectId}&assets=1`}>{pluralize(assets.held_back, 'claim')}</Link>{' '}
              {assets.held_back === 1 ? 'is' : 'are'} held back only for that: left out of recommendations and the batch until lab.yaml declares the
              assets.
            </>
          ) : (
            'No matched claim needs assets this project lacks.'
          )}
        </p>
      )}
    </div>
  )
}
