import { describe, expect, it } from 'vitest'
import {
  EMPTY_FILTERS,
  changePhrase,
  filterChips,
  hasActiveFilters,
  parseFilters,
  parseTab,
  searchParams,
  toggleValue,
  writeFilters,
  type ExperimentFilters,
} from './experimentFilters'

const url = (query: string) => new URLSearchParams(query)

describe('experiment list filters', () => {
  it('reads the URL and drops unknown values from old or hand-edited links', () => {
    const filters = parseFilters(url('q=%20kv%20&status=merged,bogus&status=failed&verdict=partial,worth_adopting&adoption=regression&category=kv_cache,kv_cache&change=up&min_change=-3'))
    expect(filters).toEqual({
      ...EMPTY_FILTERS,
      q: 'kv',
      status: ['merged', 'failed'],
      verdict: ['partial'],
      adoption: ['regression'],
      category: ['kv_cache'],
    })
    expect(parseFilters(url('change=loss&min_change=2.5&change_of=adoption'))).toMatchObject({ change: 'loss', minChange: 2.5, changeOf: 'adoption' })
    expect(parseTab(url('tab=all'))).toBe('all')
    expect(parseTab(url('tab=nope'))).toBe('needs_you')
  })

  it('writes filters to the URL, keeps other keys and goes back to page 1', () => {
    const filters: ExperimentFilters = { ...EMPTY_FILTERS, status: ['building', 'failed'], change: 'gain', minChange: 5, changeOf: 'adoption' }
    const next = writeFilters(url('tab=all&project=2&offset=50&verdict=partial'), filters)
    expect(next.toString()).toBe('tab=all&project=2&status=building%2Cfailed&change=gain&min_change=5&change_of=adoption')
    expect(parseFilters(next)).toEqual(filters)
    expect(writeFilters(next, EMPTY_FILTERS).toString()).toBe('tab=all&project=2')
  })

  it('sends the tab as the scope and comma-joined values to the API', () => {
    const filters: ExperimentFilters = { ...EMPTY_FILTERS, q: '#12', verdict: ['reproduced', 'partial'], category: ['quantization'] }
    expect(searchParams(filters, 'needs_you', { project_id: 1, limit: 50, offset: 0 })).toEqual({
      project_id: 1,
      scope: 'needs_you',
      q: '#12',
      status: undefined,
      verdict: 'reproduced,partial',
      adoption: undefined,
      category: 'quantization',
      change: undefined,
      min_change: undefined,
      change_of: undefined,
      limit: 50,
      offset: 0,
    })
    // Which check the change applies to only matters with a change filter.
    expect(searchParams({ ...EMPTY_FILTERS, changeOf: 'adoption' }, 'all', { limit: 50, offset: 0 }).change_of).toBeUndefined()
    expect(searchParams({ ...EMPTY_FILTERS, minChange: 0, changeOf: 'adoption' }, 'all', { limit: 50, offset: 0 })).toMatchObject({ min_change: 0, change_of: 'adoption' })
  })

  it('describes the measured change in words', () => {
    expect(changePhrase({ change: 'gain', minChange: null })).toBe('gains only')
    expect(changePhrase({ change: 'gain', minChange: 5 })).toBe('gains of +5% or more')
    expect(changePhrase({ change: 'loss', minChange: 2.5 })).toBe('losses of −2.5% or more')
    expect(changePhrase({ change: null, minChange: 10 })).toBe('10% or more either way')
    expect(changePhrase({ change: null, minChange: null })).toBeNull()
  })

  it('has one removable chip per value, in the console’s words', () => {
    const filters: ExperimentFilters = {
      ...EMPTY_FILTERS,
      q: 'draft',
      status: ['running'],
      verdict: ['regression'],
      adoption: ['worth_adopting'],
      category: ['kv_cache'],
      change: 'loss',
      changeOf: 'adoption',
    }
    const chips = filterChips(filters)
    expect(chips.map((chip) => chip.label)).toEqual([
      'Status: Running A/B test',
      'Claim check: Worse than baseline',
      'Adoption check: Worth adopting',
      'Category: KV cache',
      'Measured change: losses only (adoption check)',
    ])
    expect(chips[0].without.status).toEqual([])
    expect(chips[0].without.q).toBe('draft')
    expect(chips[4].without).toMatchObject({ change: null, minChange: null, changeOf: 'claim', verdict: ['regression'] })
    expect(hasActiveFilters({ ...EMPTY_FILTERS, q: 'x' })).toBe(true)
    expect(hasActiveFilters({ ...EMPTY_FILTERS, changeOf: 'adoption' })).toBe(false)
  })

  it('toggles a value on and off', () => {
    const on = toggleValue(EMPTY_FILTERS, 'status', 'merged')
    expect(on.status).toEqual(['merged'])
    expect(toggleValue(on, 'status', 'merged').status).toEqual([])
  })
})
