/**
 * Compact sticky action bar for selections and pending decisions (docs/ux-review.md §3.5, R-4).
 *
 * One line, ≤ 64 px tall at every width. It publishes its height as `--action-bar-h` on <html>, which
 * - pads the page (<Layout> adds it to <main>) so nothing is permanently hidden under the bar,
 * - lifts toasts above it, and
 * - keeps tooltips/popovers and scrolled-to anchors clear of it.
 *
 * Put the details (e.g. the list of selected titles) in the dialog the primary action opens, not in the bar.
 */
import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

const heights = new Map<symbol, number>()

function publish() {
  const max = Math.max(0, ...heights.values())
  if (max > 0) document.documentElement.style.setProperty('--action-bar-h', `${Math.ceil(max)}px`)
  else document.documentElement.style.removeProperty('--action-bar-h')
}

export function StickyActionBar({ summary, actions, children, label = 'Actions', open = true, className }: {
  /** Left side, one line: "2 selected", "3 unsaved changes". */
  summary?: ReactNode
  /** Right side: secondary actions first, the primary (recommended) action last. */
  actions?: ReactNode
  /** Custom content instead of summary + actions. */
  children?: ReactNode
  /** Accessible name of the region. */
  label?: string
  /** Render the bar (e.g. only while something is selected). */
  open?: boolean
  className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const element = ref.current
    if (!open || !element) return
    const key = Symbol('action-bar')
    const measure = () => {
      heights.set(key, element.getBoundingClientRect().height)
      publish()
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => {
      observer.disconnect()
      heights.delete(key)
      publish()
    }
  }, [open])

  if (!open) return null
  // Portalled to <body> so no ancestor (margins from space-y-*, transforms, stacking contexts) can move it.
  return createPortal(
    <div
      ref={ref}
      role="region"
      aria-label={label}
      data-action-bar=""
      className={[
        'fixed inset-x-0 bottom-0 z-(--z-actionbar) m-0 border-t border-line bg-canvas/95 shadow-[0_-4px_16px_rgb(31_35_40/0.08)] backdrop-blur',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="mx-auto flex min-h-14 max-w-7xl items-center gap-3 px-4 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:px-6">
        {children ?? (
          <>
            <div className="min-w-0 flex-1 truncate text-sm text-fg">{summary}</div>
            {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
          </>
        )}
      </div>
    </div>,
    document.body,
  )
}
