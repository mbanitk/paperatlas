/**
 * Tables that never make the page scroll sideways (docs/ux-review.md §3.8).
 *
 * - <TableScroll>  `relative overflow-x-auto` wrapper (the `relative` keeps `sr-only` header text inside it —
 *                  the OV-21 bug), edge shadows while there is more to scroll, a "Scroll →" hint, keyboard
 *                  scrolling (tabIndex=0) and an optional sticky first column. Use for data tables.
 * - <DataTable>    column-priority table that turns into cards below 768 px (list tables: experiments, jobs).
 *                  priority 1 = always, 2 = hidden below md in scroll mode, 3 = hidden below lg and in cards.
 *                  `rowHref` makes the whole row a link with the keyboard-reachable stretched-link pattern.
 * - <ResponsiveList> alias of DataTable with mobile="cards".
 */
import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { ArrowRightIcon } from './Icons'

const cx = (...classes: (string | false | null | undefined)[]) => classes.filter(Boolean).join(' ')

const STICKY_FIRST =
  '[&_tr>*:first-child]:sticky [&_tr>*:first-child]:left-0 [&_tr>*:first-child]:z-[1] [&_td:first-child]:bg-canvas [&_th:first-child]:bg-canvas-subtle'

export function TableScroll({ children, label, stickyFirstColumn = false, hint = true, className }: {
  children: ReactNode
  /** Accessible name of the scroll region ("Tuning rounds"). */
  label: string
  /** Keep the first column visible while scrolling sideways. */
  stickyFirstColumn?: boolean
  /** Show "Scroll →" when the table is wider than its box. */
  hint?: boolean
  className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState({ overflow: false, left: false, right: false })

  const update = useCallback(() => {
    const element = ref.current
    if (!element) return
    const overflow = element.scrollWidth > element.clientWidth + 1
    const left = overflow && element.scrollLeft > 1
    const right = overflow && element.scrollLeft + element.clientWidth < element.scrollWidth - 1
    setEdges((previous) => (previous.overflow === overflow && previous.left === left && previous.right === right ? previous : { overflow, left, right }))
  }, [])

  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    if (element.firstElementChild) observer.observe(element.firstElementChild)
    return () => observer.disconnect()
  }, [update, children])

  return (
    <div className={cx('relative min-w-0', className)}>
      {hint && edges.overflow && (
        <div className="mb-1 flex items-center justify-end gap-1 text-xs text-muted" aria-hidden="true">
          Scroll <ArrowRightIcon size={12} />
        </div>
      )}
      <div className="relative">
        <div
          ref={ref}
          role="region"
          aria-label={label}
          tabIndex={edges.overflow ? 0 : undefined}
          onScroll={update}
          data-table-scroll=""
          className={cx('relative overflow-x-auto overscroll-x-contain', stickyFirstColumn && STICKY_FIRST)}
        >
          {children}
        </div>
        <div
          aria-hidden="true"
          className={cx(
            'pointer-events-none absolute inset-y-0 left-0 z-[2] w-5 bg-linear-to-r from-fg/10 to-transparent transition-opacity',
            edges.left && !stickyFirstColumn ? 'opacity-100' : 'opacity-0',
          )}
        />
        <div
          aria-hidden="true"
          className={cx('pointer-events-none absolute inset-y-0 right-0 z-[2] w-5 bg-linear-to-l from-fg/10 to-transparent transition-opacity', edges.right ? 'opacity-100' : 'opacity-0')}
        />
      </div>
    </div>
  )
}

export interface Column<T> {
  key: string
  header: ReactNode
  cell: (row: T, index: number) => ReactNode
  /** 1 = always shown (default) · 2 = hidden below 768px in scroll mode · 3 = hidden below 1024px. */
  priority?: 1 | 2 | 3
  /** Right-aligned, tabular figures. */
  numeric?: boolean
  align?: 'left' | 'right' | 'center'
  /** Keep on one line (status, outcome, Δ). */
  nowrap?: boolean
  /** Visually hidden header (the text stays for screen readers). */
  srOnlyHeader?: boolean
  className?: string
  headerClassName?: string
  /**
   * Where the column goes in card view (< 768px): `title` (the first column by default), `badge` (top
   * right: status/outcome), `body` (label: value list, default), `footer` (CTA) or `hidden`.
   */
  cardSlot?: 'title' | 'badge' | 'body' | 'footer' | 'hidden'
  /** Label in card view; defaults to the header. */
  cardLabel?: ReactNode
}

export interface DataTableProps<T> {
  columns: Column<T>[]
  rows: readonly T[]
  rowKey: (row: T, index: number) => string | number
  /** Accessible name for the table / list. */
  label: string
  /** Whole row (or card) becomes a link to this URL (stretched link on the title cell). */
  rowHref?: (row: T) => string | null | undefined
  /** Below 768px: `cards` (list tables, default) or `scroll` (data tables, sticky first column). */
  mobile?: 'cards' | 'scroll'
  stickyFirstColumn?: boolean
  rowClassName?: (row: T) => string | undefined
  caption?: ReactNode
  /** Rendered instead of the table when there are no rows. */
  empty?: ReactNode
  className?: string
}

const alignClass = (column: Column<unknown>) =>
  column.numeric || column.align === 'right' ? 'text-right tabular-nums' : column.align === 'center' ? 'text-center' : 'text-left'

const priorityClass = (column: Column<unknown>, mobile: 'cards' | 'scroll') =>
  column.priority === 3 ? 'hidden lg:table-cell' : column.priority === 2 && mobile === 'scroll' ? 'hidden md:table-cell' : undefined

function TitleCell({ href, children }: { href: string | null | undefined; children: ReactNode }) {
  if (!href) return <>{children}</>
  return (
    <Link to={href} className="link-quiet font-medium after:absolute after:inset-0 after:content-['']">
      {children}
    </Link>
  )
}

export function DataTable<T>({ columns, rows, rowKey, label, rowHref, mobile = 'cards', stickyFirstColumn, rowClassName, caption, empty, className }: DataTableProps<T>) {
  if (!rows.length && empty) return <>{empty}</>
  const titleColumn = columns.find((column) => column.cardSlot === 'title') ?? columns[0]
  // Cards show priority 1–2 columns; a priority-3 column appears only if it asks for a card slot explicitly.
  const slot = (column: Column<T>) => (column === titleColumn ? 'title' : (column.cardSlot ?? (column.priority === 3 ? 'hidden' : 'body')))

  const table = (
    <TableScroll label={label} stickyFirstColumn={stickyFirstColumn ?? mobile === 'scroll'}>
      <table className="w-full border-collapse text-sm">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr className="border-b border-line">
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={cx(
                  'bg-canvas-subtle px-3 py-2 text-xs font-medium whitespace-nowrap text-muted',
                  alignClass(column as Column<unknown>),
                  priorityClass(column as Column<unknown>, mobile),
                  column.headerClassName,
                )}
              >
                {column.srOnlyHeader ? <span className="sr-only">{column.header}</span> : column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const href = rowHref?.(row)
            return (
              <tr
                key={rowKey(row, index)}
                className={cx('border-b border-line-muted last:border-b-0', href && 'relative hover:bg-canvas-subtle', rowClassName?.(row))}
              >
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={cx(
                      'h-10 px-3 py-2 align-middle',
                      alignClass(column as Column<unknown>),
                      priorityClass(column as Column<unknown>, mobile),
                      column.nowrap && 'whitespace-nowrap',
                      column.className,
                    )}
                  >
                    {column === titleColumn ? <TitleCell href={href}>{column.cell(row, index)}</TitleCell> : column.cell(row, index)}
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
    </TableScroll>
  )

  if (mobile === 'scroll') return <div className={className}>{table}</div>

  return (
    <div className={className}>
      <div className="hidden md:block">{table}</div>
      <ul className="space-y-2 md:hidden" aria-label={label}>
        {rows.map((row, index) => {
          const href = rowHref?.(row)
          const of = (name: string) => columns.filter((column) => slot(column) === name)
          return (
            <li key={rowKey(row, index)} className={cx('relative rounded-lg border border-line bg-canvas p-3', href && 'hover:border-accent', rowClassName?.(row))}>
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1 text-body-lg [overflow-wrap:anywhere]">
                  <TitleCell href={href}>{titleColumn.cell(row, index)}</TitleCell>
                </div>
                {of('badge').length > 0 && (
                  <div className="relative z-[1] flex shrink-0 flex-col items-end gap-1">
                    {of('badge').map((column) => (
                      <div key={column.key}>{column.cell(row, index)}</div>
                    ))}
                  </div>
                )}
              </div>
              {of('body').length > 0 && (
                <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                  {of('body').map((column) => (
                    <div key={column.key} className="contents">
                      <dt className="text-xs leading-5 text-muted">{column.cardLabel ?? column.header}</dt>
                      <dd className="min-w-0 [overflow-wrap:anywhere]">{column.cell(row, index)}</dd>
                    </div>
                  ))}
                </dl>
              )}
              {of('footer').length > 0 && (
                <div className="relative z-[1] mt-3 flex flex-wrap items-center justify-end gap-2">
                  {of('footer').map((column) => (
                    <div key={column.key}>{column.cell(row, index)}</div>
                  ))}
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/** List table that becomes cards below 768px (same props as DataTable). */
export function ResponsiveList<T>(props: Omit<DataTableProps<T>, 'mobile'>) {
  return <DataTable {...props} mobile="cards" />
}
