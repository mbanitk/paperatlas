import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import type { ExperimentSearchResult, FacetCount } from '../../api/types'
import { CheckIcon, ChevronDown, SearchIcon, XIcon } from '../../components/Icons'
import { Button, cx, useDebounced } from '../../components/ui'
import { pluralize } from '../../lib/format'
import {
  ADOPTION_ORDER,
  STATUS_ORDER,
  TAB_LABEL,
  VERDICT_ORDER,
  adoptionLabel,
  categoryLabel,
  checkLabel,
  filterChips,
  hasActiveFilters,
  statusLabel,
  toggleValue,
  verdictLabel,
  type ChangeCheck,
  type ChangeDirection,
  type ExperimentFilters,
  type ExperimentTab,
} from '../../lib/experimentFilters'

const OPEN_KEY = 'paperatlas.experiments.filtersOpen'

interface Option {
  value: string
  label: string
  count?: number
}

/** Options in a fixed order with their counts; `all` keeps zero-count values (fixed vocabularies). */
function optionsFor(order: readonly string[], facet: FacetCount[] | undefined, selected: string[], label: (value: string) => string, all = false): Option[] {
  const counts = new Map((facet ?? []).map((entry) => [entry.value, entry.count]))
  const values = [...order, ...(facet ?? []).map((entry) => entry.value).filter((value) => !order.includes(value))]
  return values
    .filter((value) => all || (counts.get(value) ?? 0) > 0 || selected.includes(value))
    .map((value) => ({ value, label: label(value), count: facet ? (counts.get(value) ?? 0) : undefined }))
}

const PILL =
  'relative inline-flex min-h-7 cursor-pointer items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium select-none has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent'

/** A pill that is a real checkbox or radio (keyboard and screen-reader native), with its match count. */
function Pill({ type, name, checked, onChange, label, count }: { type: 'checkbox' | 'radio'; name: string; checked: boolean; onChange: () => void; label: string; count?: number }) {
  return (
    <label className={cx(PILL, checked ? 'border-accent bg-info-subtle text-info-fg' : 'border-line bg-canvas hover:border-fg', !checked && count === 0 ? 'text-muted' : !checked && 'text-fg')}>
      <input type={type} name={name} checked={checked} onChange={onChange} className="sr-only" />
      {checked && type === 'checkbox' && <CheckIcon size={12} aria-hidden="true" />}
      {label}
      {count !== undefined && (
        <span className="text-muted tabular-nums">
          {count}
          <span className="sr-only"> {count === 1 ? 'experiment' : 'experiments'}</span>
        </span>
      )}
    </label>
  )
}

function Group({ legend, hint, children }: { legend: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <fieldset className="min-w-0">
      <legend className="label">{legend}</legend>
      {hint && <p className="-mt-0.5 mb-1.5 text-xs text-muted">{hint}</p>}
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </fieldset>
  )
}

function OptionGroup({ legend, hint, name, options, selected, onToggle }: {
  legend: string
  hint?: ReactNode
  name: string
  options: Option[]
  selected: string[]
  onToggle: (value: string) => void
}) {
  return (
    <Group legend={legend} hint={hint}>
      {options.length ? (
        options.map((option) => (
          <Pill key={option.value} type="checkbox" name={name} checked={selected.includes(option.value)} onChange={() => onToggle(option.value)} label={option.label} count={option.count} />
        ))
      ) : (
        <span className="text-xs text-muted">None in this view</span>
      )}
    </Group>
  )
}

/** Measured change: direction, minimum size and which check it applies to. */
function ChangeGroup({ filters, onChange }: { filters: ExperimentFilters; onChange: (next: ExperimentFilters) => void }) {
  const id = useId()
  const [min, setMin] = useState(filters.minChange === null ? '' : String(filters.minChange))
  const debounced = useDebounced(min.trim(), 400)
  // The last value sent to the URL: only a different URL value (chip removed, "Clear all") rewrites the box.
  const sent = useRef(filters.minChange)
  useEffect(() => {
    const value = debounced === '' ? null : Number(debounced)
    if (value !== null && (!Number.isFinite(value) || value < 0)) return
    if (value === sent.current) return
    sent.current = value
    if (value !== filters.minChange) onChange({ ...filters, minChange: value })
  }, [debounced])
  useEffect(() => {
    if (filters.minChange === sent.current) return
    sent.current = filters.minChange
    setMin(filters.minChange === null ? '' : String(filters.minChange))
  }, [filters.minChange])
  const invalid = min.trim() !== '' && (!Number.isFinite(Number(min)) || Number(min) < 0)

  const directions: { value: ChangeDirection | null; label: string }[] = [
    { value: null, label: 'Any' },
    { value: 'gain', label: 'Gains only' },
    { value: 'loss', label: 'Losses only' },
  ]
  const checks: ChangeCheck[] = ['claim', 'adoption']
  return (
    <Group legend="Measured change" hint="The median change measured in the A/B test. Positive is better.">
      <div className="flex w-full flex-wrap gap-1.5" role="radiogroup" aria-label="Direction">
        {directions.map((direction) => (
          <Pill
            key={direction.label}
            type="radio"
            name={`${id}-direction`}
            checked={filters.change === direction.value}
            onChange={() => onChange({ ...filters, change: direction.value })}
            label={direction.label}
          />
        ))}
      </div>
      <div className="mt-1 flex w-full flex-wrap items-center gap-x-2 gap-y-1">
        <label htmlFor={`${id}-min`} className="text-xs text-fg">
          At least
        </label>
        <span className="inline-flex items-center gap-1">
          <input
            id={`${id}-min`}
            type="number"
            inputMode="decimal"
            min={0}
            step={1}
            placeholder="e.g. 5"
            className={cx('input h-7 w-20 py-0.5', invalid && 'border-danger')}
            value={min}
            aria-invalid={invalid || undefined}
            aria-describedby={invalid ? `${id}-min-error` : undefined}
            onChange={(event) => setMin(event.target.value)}
          />
          <span className="text-xs text-muted">%</span>
        </span>
        {invalid && (
          <span id={`${id}-min-error`} className="text-xs text-negative-fg">
            Enter a size of 0 or more
          </span>
        )}
      </div>
      <div className="mt-1 flex w-full flex-wrap items-center gap-1.5" role="radiogroup" aria-label="Measured in">
        <span className="text-xs text-fg">In the</span>
        {checks.map((check) => (
          <Pill key={check} type="radio" name={`${id}-check`} checked={filters.changeOf === check} onChange={() => onChange({ ...filters, changeOf: check })} label={checkLabel(check)} />
        ))}
      </div>
    </Group>
  )
}

/**
 * Search (always visible), a "Filters (n)" disclosure with the five filter groups, and the active filters as
 * removable chips with "Clear all" (docs/ux-review.md R-5). Counts next to each value come from the API and
 * say how many experiments that value would match, given the other filters and the tab.
 */
export function ExperimentListFilters({ filters, onChange, onClear, search, onSearch, facets, total, tab, onShowAll }: {
  filters: ExperimentFilters
  onChange: (next: ExperimentFilters) => void
  /** Clears every filter and the search box. */
  onClear: () => void
  search: string
  onSearch: (value: string) => void
  facets: ExperimentSearchResult['facets'] | undefined
  /** Matches with the current filters (for the phone-only "Show n experiments" that closes the panel). */
  total: number | undefined
  tab: ExperimentTab
  onShowAll: () => void
}) {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(OPEN_KEY) === '1'
    } catch {
      return false
    }
  })
  const toggleOpen = () =>
    setOpen((value) => {
      try {
        localStorage.setItem(OPEN_KEY, value ? '0' : '1')
      } catch {
        // storage unavailable (private mode): the panel just won't remember its state
      }
      return !value
    })
  const chips = filterChips(filters)
  const active = hasActiveFilters(filters) || search.trim() !== ''

  return (
    <section aria-label="Search and filters" className="mb-3 rounded-lg border border-line bg-canvas p-3">
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <label htmlFor="exp-search" className="label">
            Search title, technique, paper or #id
          </label>
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted" />
            <input
              id="exp-search"
              type="search"
              className="input pl-8"
              placeholder="e.g. KV cache or #42"
              value={search}
              onChange={(event) => onSearch(event.target.value)}
            />
          </div>
        </div>
        <Button
          className="shrink-0"
          onClick={toggleOpen}
          aria-expanded={open}
          aria-controls="exp-filters"
          icon={<ChevronDown size={14} className={cx('transition-transform', open && 'rotate-180')} />}
        >
          Filters
          {chips.length > 0 && (
            <span className="tabular-nums">
              {' '}
              ({chips.length}
              <span className="sr-only"> active</span>)
            </span>
          )}
        </Button>
      </div>

      <div id="exp-filters" hidden={!open} className="mt-3 border-t border-line-muted pt-3">
        {tab !== 'all' && (
          <p className="mb-3 flex flex-wrap items-center gap-x-2 text-xs text-muted">
            Filtering within <strong className="font-semibold text-fg">{TAB_LABEL[tab]}</strong>.
            <Button size="sm" variant="invisible" className="-my-1" onClick={onShowAll}>
              Filter all experiments
            </Button>
          </p>
        )}
        <div className="grid gap-x-6 gap-y-4 md:grid-cols-2 xl:grid-cols-3">
          <OptionGroup
            legend="Status"
            name="status"
            options={optionsFor(STATUS_ORDER, facets?.status, filters.status, statusLabel)}
            selected={filters.status}
            onToggle={(value) => onChange(toggleValue(filters, 'status', value as ExperimentFilters['status'][number]))}
          />
          <OptionGroup
            legend="Claim check"
            hint="Did the paper’s claim hold, against the paper’s setup?"
            name="verdict"
            options={optionsFor(VERDICT_ORDER, facets?.verdict, filters.verdict, verdictLabel, true)}
            selected={filters.verdict}
            onToggle={(value) => onChange(toggleValue(filters, 'verdict', value as ExperimentFilters['verdict'][number]))}
          />
          <OptionGroup
            legend="Adoption check"
            hint="Is it worth adopting on your default workload? Only where it ran separately."
            name="adoption"
            options={optionsFor(ADOPTION_ORDER, facets?.adoption, filters.adoption, adoptionLabel, true)}
            selected={filters.adoption}
            onToggle={(value) => onChange(toggleValue(filters, 'adoption', value as ExperimentFilters['adoption'][number]))}
          />
          <OptionGroup
            legend="Technique category"
            name="category"
            options={optionsFor([], facets?.category, filters.category, categoryLabel)}
            selected={filters.category}
            onToggle={(value) => onChange(toggleValue(filters, 'category', value))}
          />
          <ChangeGroup filters={filters} onChange={onChange} />
        </div>
        {total !== undefined && (
          <Button className="mt-4 w-full md:hidden" onClick={toggleOpen}>
            Show {pluralize(total, 'experiment')}
          </Button>
        )}
      </div>

      {active && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {chips.length > 0 && <span className="text-xs text-muted">Active:</span>}
          {chips.map((chip) => (
            <button key={chip.key} type="button" className="tag min-h-6 text-left whitespace-normal text-fg hover:border-fg" onClick={() => onChange(chip.without)} aria-label={`Remove filter: ${chip.label}`}>
              {chip.label}
              <XIcon size={12} className="shrink-0" />
            </button>
          ))}
          <Button size="sm" variant="invisible" onClick={onClear}>
            Clear all
          </Button>
        </div>
      )}
    </section>
  )
}
