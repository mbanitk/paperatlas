/**
 * Floating UI that never overlaps the sticky header, never clips and never goes off-screen
 * (docs/ux-review.md §3.5). Everything renders in a portal with collision detection (flip + shift + size),
 * so it escapes `overflow` containers, container queries and the header's stacking context.
 *
 * - <Tooltip>      one short, non-interactive sentence. Hover (300 ms) · keyboard focus · tap. Esc closes.
 * - <InfoPopover>  definitions, reasons, formulas. Click/tap/Enter/Space (pins it), hover previews for mouse
 *                  users, Esc/outside click closes and focus returns to the trigger. role="dialog".
 * - <Term>         inline glossary word (dotted underline, button semantics) wrapping an InfoPopover.
 * - <Truncate>     one- or multi-line clamp that shows the full text in a Tooltip only when it's cut.
 *
 * Never use the native `title` attribute for information people need: it never shows on touch or keyboard.
 */
import {
  arrow,
  autoUpdate,
  flip,
  FloatingArrow,
  FloatingFocusManager,
  FloatingPortal,
  hide,
  offset,
  safePolygon,
  shift,
  size,
  useClick,
  useDismiss,
  useFloating,
  useFocus,
  useHover,
  useInteractions,
  useMergeRefs,
  useRole,
  type Middleware,
  type OpenChangeReason,
  type Placement,
} from '@floating-ui/react'
import {
  cloneElement,
  isValidElement,
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type HTMLProps,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
} from 'react'
import { InfoIcon } from './Icons'

const cx = (...classes: (string | false | null | undefined)[]) => classes.filter(Boolean).join(' ')

function cssPx(name: string, fallback: number): number {
  if (typeof document === 'undefined') return fallback
  const value = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name))
  return Number.isFinite(value) ? value : fallback
}

/** Space floating UI keeps free: the sticky header on top, the sticky action bar at the bottom, 8 px at the sides. */
export function edgePadding(): { top: number; right: number; bottom: number; left: number } {
  return { top: cssPx('--header-h', 64) + 8, right: 8, bottom: cssPx('--action-bar-h', 0) + 8, left: 8 }
}

/** The mandatory middleware stack for every floating element (§3.5). Exported for custom floating UI. */
export function floatingMiddleware(arrowRef: { current: Element | null }, maxWidth = 320): Middleware[] {
  return [
    offset(8),
    flip(() => ({ padding: edgePadding(), fallbackAxisSideDirection: 'start', crossAxis: false })),
    shift(() => ({ padding: edgePadding() })),
    size(() => ({
      padding: edgePadding(),
      apply({ availableWidth, availableHeight, elements }) {
        Object.assign(elements.floating.style, {
          maxWidth: `${Math.max(120, Math.min(maxWidth, availableWidth))}px`,
          maxHeight: `${Math.max(48, availableHeight)}px`,
        })
      },
    })),
    arrow({ element: arrowRef, padding: 8 }),
    // Hide when the trigger has scrolled under the sticky header (or the action bar).
    hide(() => ({ strategy: 'referenceHidden', padding: { top: cssPx('--header-h', 64), bottom: cssPx('--action-bar-h', 0) } })),
  ]
}

/** Floating content inside a modal <dialog> must render inside it (the dialog sits in the top layer). */
function portalRootFor(element: Element | null | undefined): HTMLElement | null {
  return (element?.closest('dialog') as HTMLElement | null) ?? null
}

const FOCUSABLE = 'a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"])'

// ---- Tooltip ---------------------------------------------------------------------------------------

export interface TooltipProps {
  /** One short sentence. Empty content renders the children alone. */
  content: ReactNode
  children: ReactNode
  placement?: Placement
  /**
   * Attach to the child element itself instead of wrapping it in a span. The child must accept `ref` and
   * spread DOM props (native elements, Link, Button).
   */
  asChild?: boolean
  /**
   * Make the wrapper focusable so keyboard users can reach the tooltip. Default: true unless the children
   * already contain a focusable element (then that element gets `aria-describedby`).
   */
  focusable?: boolean
  /** Class for the wrapping span (ignored with `asChild`). */
  className?: string
  delay?: { open: number; close: number }
  disabled?: boolean
}

export function Tooltip({ content, children, placement = 'top', asChild = false, focusable, className, delay = { open: 300, close: 100 }, disabled }: TooltipProps) {
  const [open, setOpen] = useState(false)
  const [root, setRoot] = useState<HTMLElement | null>(null)
  const arrowRef = useRef<SVGSVGElement>(null)
  const wrapperRef = useRef<HTMLElement | null>(null)
  const [innerFocusable, setInnerFocusable] = useState<HTMLElement | null>(null)
  const descriptionId = useId()
  const tooltipId = useId()
  const empty = content === null || content === undefined || content === '' || content === false

  const { refs, floatingStyles, context, middlewareData } = useFloating({
    open: open && !disabled && !empty,
    onOpenChange: (next) => {
      if (next) setRoot(portalRootFor(refs.domReference.current))
      setOpen(next)
    },
    placement,
    strategy: 'fixed',
    whileElementsMounted: autoUpdate,
    middleware: floatingMiddleware(arrowRef),
  })

  const { getReferenceProps, getFloatingProps } = useInteractions([
    useHover(context, { mouseOnly: true, delay, move: false }),
    useFocus(context),
    useClick(context, { ignoreMouse: true, keyboardHandlers: false }),
    useDismiss(context, { referencePress: false }),
  ])

  // In wrap mode, describe the focusable element inside (e.g. a button) rather than the wrapper.
  useLayoutEffect(() => {
    if (asChild) return
    const inner = wrapperRef.current?.querySelector<HTMLElement>(FOCUSABLE) ?? null
    setInnerFocusable(inner)
    if (!inner || empty) return
    const previous = inner.getAttribute('aria-describedby')
    inner.setAttribute('aria-describedby', [previous, descriptionId].filter(Boolean).join(' '))
    return () => {
      if (previous) inner.setAttribute('aria-describedby', previous)
      else inner.removeAttribute('aria-describedby')
    }
  }, [asChild, descriptionId, empty, children])

  // Esc closes the tooltip only: consume it so an enclosing <dialog> doesn't close too.
  const onEscape = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || !open) return
    event.preventDefault()
    event.stopPropagation()
    setOpen(false)
  }

  const mergedWrapperRef = useMergeRefs([refs.setReference, wrapperRef])
  const childRef = isValidElement(children) ? ((children.props as { ref?: Ref<unknown> }).ref ?? null) : null
  const mergedChildRef = useMergeRefs([refs.setReference, childRef as Ref<Element>])

  if (empty) return <>{children}</>

  const description = (
    <span id={descriptionId} hidden>
      {content}
    </span>
  )

  let trigger: ReactNode
  if (asChild && isValidElement(children)) {
    const child = children as ReactElement<HTMLAttributes<HTMLElement> & { ref?: Ref<unknown> }>
    const existing = child.props['aria-describedby']
    trigger = cloneElement(child, {
      ...getReferenceProps({
        ...(child.props as HTMLProps<Element>),
        onKeyDown: (event: KeyboardEvent<Element>) => {
          onEscape(event as KeyboardEvent<HTMLElement>)
          child.props.onKeyDown?.(event as KeyboardEvent<HTMLElement>)
        },
      }),
      ref: mergedChildRef,
      'aria-describedby': [existing, descriptionId].filter(Boolean).join(' '),
    } as HTMLAttributes<HTMLElement> & { ref: Ref<unknown> })
  } else {
    const tabbable = focusable ?? !innerFocusable
    trigger = (
      <span
        ref={mergedWrapperRef}
        className={className}
        tabIndex={tabbable ? 0 : undefined}
        aria-describedby={tabbable ? descriptionId : undefined}
        {...getReferenceProps({ onKeyDown: onEscape })}
      >
        {children}
      </span>
    )
  }

  const hidden = middlewareData.hide?.referenceHidden
  return (
    <>
      {trigger}
      {description}
      {open && !disabled && (
        <FloatingPortal root={root ?? undefined}>
          <div
            ref={refs.setFloating}
            id={tooltipId}
            role="tooltip"
            data-floating="tooltip"
            style={{ ...floatingStyles, zIndex: 'var(--z-popover)', visibility: hidden ? 'hidden' : undefined }}
            className="pointer-events-none w-max overflow-auto rounded-md bg-fg px-2.5 py-1.5 text-xs font-medium whitespace-pre-line break-words text-white shadow-lg"
            {...getFloatingProps()}
          >
            {content}
            <FloatingArrow ref={arrowRef} context={context} width={10} height={5} fill="var(--color-fg)" />
          </div>
        </FloatingPortal>
      )}
    </>
  )
}

// ---- InfoPopover -------------------------------------------------------------------------------------

export interface InfoPopoverProps {
  /** Definition, reasons or formula. May contain links. */
  content: ReactNode
  /** Bold first line of the popover (also its accessible name). */
  title?: ReactNode
  /** Optional "Learn more" link at the bottom. */
  learnMore?: { href: string; label?: string; external?: boolean }
  /**
   * The trigger. Text/inline content is wrapped in a <button>; omit it for a small ⓘ icon button (24 px hit
   * area). With `asChild`, the single child element is used as the trigger.
   */
  children?: ReactNode
  asChild?: boolean
  /** Accessible name for the trigger ("Why this estimate?"). Required for the icon-only trigger. */
  label?: string
  placement?: Placement
  triggerClassName?: string
  /** Preview on hover for mouse users (default true). Click/tap pins it. */
  hover?: boolean
  /** Popover max width in px (default 320). */
  maxWidth?: number
}

export function InfoPopover({
  content,
  title,
  learnMore,
  children,
  asChild = false,
  label,
  placement = 'top',
  triggerClassName,
  hover = true,
  maxWidth = 320,
}: InfoPopoverProps) {
  const [open, setOpen] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [root, setRoot] = useState<HTMLElement | null>(null)
  const arrowRef = useRef<SVGSVGElement>(null)
  const titleId = useId()

  const onOpenChange = useCallback(
    (next: boolean, _event?: Event, reason?: OpenChangeReason) => {
      if (reason === 'hover' || reason === 'safe-polygon') {
        if (!pinned) setOpen(next)
        return
      }
      if (reason === 'click' && !next && !pinned) {
        // Opened by hovering, then clicked: keep it open (pinned) instead of toggling it shut.
        setPinned(true)
        return
      }
      setOpen(next)
      setPinned(next)
    },
    [pinned],
  )

  const { refs, floatingStyles, context, middlewareData } = useFloating({
    open,
    onOpenChange: (next, event, reason) => {
      if (next) setRoot(portalRootFor(refs.domReference.current))
      onOpenChange(next, event, reason)
    },
    placement,
    strategy: 'fixed',
    whileElementsMounted: autoUpdate,
    middleware: floatingMiddleware(arrowRef, maxWidth),
  })

  const { getReferenceProps, getFloatingProps } = useInteractions([
    useHover(context, { enabled: hover, mouseOnly: true, delay: { open: 300, close: 150 }, handleClose: safePolygon() }),
    useClick(context),
    useDismiss(context),
    useRole(context, { role: 'dialog' }),
  ])

  const childRef = isValidElement(children) ? ((children.props as { ref?: Ref<unknown> }).ref ?? null) : null
  const mergedChildRef = useMergeRefs([refs.setReference, childRef as Ref<Element>])

  // Esc closes the popover only: consume it so an enclosing <dialog> stays open.
  const onEscape = (event: KeyboardEvent<Element>) => {
    if (event.key !== 'Escape' || !open) return
    event.preventDefault()
    event.stopPropagation()
    setOpen(false)
    setPinned(false)
    ;(refs.domReference.current as HTMLElement | null)?.focus()
  }

  let trigger: ReactNode
  if (asChild && isValidElement(children)) {
    const child = children as ReactElement<HTMLAttributes<HTMLElement> & { ref?: Ref<unknown> }>
    trigger = cloneElement(child, {
      ...getReferenceProps({
        ...(child.props as HTMLProps<Element>),
        onKeyDown: (event: KeyboardEvent<Element>) => {
          onEscape(event)
          child.props.onKeyDown?.(event as KeyboardEvent<HTMLElement>)
        },
      }),
      ref: mergedChildRef,
    } as HTMLAttributes<HTMLElement> & { ref: Ref<unknown> })
  } else if (children === undefined || children === null) {
    trigger = (
      <button
        ref={refs.setReference}
        type="button"
        aria-label={label ?? 'More information'}
        className={cx('inline-flex size-6 shrink-0 items-center justify-center rounded-full align-middle text-muted hover:bg-canvas-inset hover:text-fg', triggerClassName)}
        {...getReferenceProps({ onKeyDown: onEscape })}
      >
        <InfoIcon size={14} />
      </button>
    )
  } else {
    trigger = (
      <button ref={refs.setReference} type="button" aria-label={label} className={triggerClassName} {...getReferenceProps({ onKeyDown: onEscape })}>
        {children}
      </button>
    )
  }

  const hidden = middlewareData.hide?.referenceHidden
  return (
    <>
      {trigger}
      {open && (
        <FloatingPortal root={root ?? undefined}>
          <FloatingFocusManager context={context} modal={false} initialFocus={-1} returnFocus>
            <div
              ref={refs.setFloating}
              aria-labelledby={title ? titleId : undefined}
              aria-label={!title ? label : undefined}
              data-floating="popover"
              style={{ ...floatingStyles, zIndex: 'var(--z-popover)', visibility: hidden ? 'hidden' : undefined }}
              className="w-max overflow-auto rounded-lg border border-line bg-canvas px-3 py-2.5 text-sm text-fg shadow-lg"
              {...getFloatingProps({ onKeyDown: onEscape })}
            >
              {title && (
                <div id={titleId} className="mb-1 font-semibold">
                  {title}
                </div>
              )}
              <div className="break-words whitespace-pre-line text-fg">{content}</div>
              {learnMore && (
                <a
                  href={learnMore.href}
                  className="mt-2 inline-block text-sm font-medium"
                  {...(learnMore.external ? { target: '_blank', rel: 'noreferrer noopener' } : {})}
                >
                  {learnMore.label ?? 'Learn more'}
                </a>
              )}
              <FloatingArrow ref={arrowRef} context={context} width={12} height={6} fill="var(--color-canvas)" stroke="var(--color-line)" strokeWidth={1} />
            </div>
          </FloatingFocusManager>
        </FloatingPortal>
      )}
    </>
  )
}

// ---- Term --------------------------------------------------------------------------------------------

/**
 * Inline glossary word: dotted underline, opens its meaning in an InfoPopover. Replaces `<abbr title>` and
 * absolutely-positioned glossary chips.
 */
export function Term({ children, definition, term, learnMore, className }: {
  /** The word as it appears in the sentence. */
  children: ReactNode
  /** What it means, in one or two plain sentences. */
  definition: ReactNode
  /** Popover heading; defaults to the children when they're text. */
  term?: ReactNode
  learnMore?: InfoPopoverProps['learnMore']
  className?: string
}) {
  return (
    <InfoPopover
      content={definition}
      title={term ?? (typeof children === 'string' ? children : undefined)}
      learnMore={learnMore}
      triggerClassName={cx(
        'cursor-help rounded-sm text-left text-inherit underline decoration-muted decoration-dotted decoration-1 underline-offset-[3px] hover:decoration-fg aria-expanded:decoration-fg',
        className,
      )}
    >
      {children}
    </InfoPopover>
  )
}

// ---- Truncate ----------------------------------------------------------------------------------------

/**
 * Truncated label that reveals its full text in a Tooltip — but only when it's actually cut. Use for tags,
 * names and titles in dense lists. Never truncate numbers: let them wrap instead.
 */
export function Truncate({ children, lines = 1, className, as: As = 'span' }: { children: string; lines?: number; className?: string; as?: 'span' | 'div' }) {
  const ref = useRef<HTMLElement>(null)
  const [cut, setCut] = useState(false)

  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const measure = () => setCut(lines > 1 ? element.scrollHeight > element.clientHeight + 1 : element.scrollWidth > element.clientWidth + 1)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [children, lines])

  const clampClass = lines > 1 ? 'block overflow-hidden' : cx('truncate', As === 'span' && 'inline-block max-w-full align-bottom')
  const style = lines > 1 ? { display: '-webkit-box', WebkitLineClamp: lines, WebkitBoxOrient: 'vertical' as const } : undefined
  // Always rendered through <Tooltip> (disabled while nothing is cut) so the measured element never remounts.
  return (
    <Tooltip content={children} disabled={!cut} focusable={cut} className={As === 'div' ? 'block min-w-0' : 'inline-block max-w-full min-w-0 align-bottom'}>
      <As ref={ref as never} className={cx(clampClass, className)} style={style}>
        {children}
      </As>
    </Tooltip>
  )
}
