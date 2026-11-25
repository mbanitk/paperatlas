import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react'
import { AlertIcon, ClockIcon, XIcon } from './Icons'
import { Button, cx, InlineError } from './ui'

const FIELD = 'input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled])'

/**
 * Where focus goes when a dialog opens (docs/ux-review.md §3.11, G-4):
 * - a ref → that element
 * - 'first-field' → the first input/select/textarea (default when the dialog has fields)
 * - 'none' → the browser default (the first focusable element)
 * Without the prop, the first form field gets focus; dialogs without fields keep the browser default.
 */
export type InitialFocus = RefObject<HTMLElement | null> | 'first-field' | 'none'

/**
 * Accessible modal built on the native <dialog> element (focus trap + Esc handled by the browser; focus
 * returns to the trigger on close). `dismissable={false}` (e.g. while a submit is pending) disables Esc,
 * backdrop click and the close button.
 */
export function Modal({ open, onClose, title, children, footer, size = 'md', dismissable = true, initialFocus }: {
  open: boolean
  onClose: () => void
  title: ReactNode
  children: ReactNode
  footer?: ReactNode
  size?: 'sm' | 'md' | 'lg'
  dismissable?: boolean
  initialFocus?: InitialFocus
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const dismiss = () => {
    if (dismissable) onClose()
  }

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) {
      dialog.showModal()
      // showModal() focuses the first focusable element (the × button); make the initial focus explicit.
      if (initialFocus !== 'none') {
        const target =
          initialFocus && typeof initialFocus === 'object'
            ? initialFocus.current
            : (dialog.querySelector<HTMLElement>(`[data-dialog-body] :is(${FIELD})`) ??
              (initialFocus === 'first-field' ? null : dialog.querySelector<HTMLElement>('[data-initial-focus]')))
        target?.focus()
      }
    }
    if (!open && dialog.open) dialog.close()
  }, [open, initialFocus])

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={() => {
        // The browser may still close a modal whose cancel was prevented (repeated Esc): keep it open while busy.
        if (!dismissable && open) ref.current?.showModal()
        else onClose()
      }}
      onCancel={(event) => {
        event.preventDefault()
        dismiss()
      }}
      onClick={(event) => {
        if (event.target === ref.current) dismiss()
      }}
      className={cx(
        'm-auto w-[calc(100vw-2rem)] rounded-xl border border-line bg-canvas p-0 text-fg shadow-2xl',
        size === 'sm' ? 'max-w-md' : size === 'lg' ? 'max-w-3xl' : 'max-w-xl',
      )}
    >
      {open && (
        <div className="flex max-h-[85vh] flex-col">
          <header className="flex items-center justify-between gap-3 border-b border-line-muted px-5 py-3">
            <h2 id={titleId} className="text-base font-semibold">
              {title}
            </h2>
            <button
              type="button"
              onClick={dismiss}
              disabled={!dismissable}
              className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-canvas-inset disabled:cursor-not-allowed disabled:opacity-55"
              aria-label="Close dialog"
            >
              <XIcon />
            </button>
          </header>
          <div data-dialog-body="" className="overflow-y-auto px-5 py-4 text-sm">
            {children}
          </div>
          {footer && (
            <footer className="flex flex-wrap justify-end gap-2 border-t border-line-muted bg-canvas-subtle px-5 py-3 max-sm:[&>*]:flex-1">{footer}</footer>
          )}
        </div>
      )}
    </dialog>
  )
}

/**
 * Confirmation that restates the decision (§2.9): an optional `recap` of the evidence, a caution `warning`
 * when the action goes against the recommendation, and the `cost` of running it. Focus starts on Cancel for
 * danger/costly confirmations (default whenever there's no form field), never on the costly button.
 */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  children,
  confirmLabel,
  variant = 'primary',
  loading,
  error,
  confirmDisabled,
  initialFocus,
  recap,
  warning,
  cost,
  cancelLabel = 'Cancel',
}: {
  open: boolean
  onClose: () => void
  onConfirm: () => void
  title: ReactNode
  children?: ReactNode
  confirmLabel: string
  variant?: 'primary' | 'danger'
  loading?: boolean
  error?: unknown
  confirmDisabled?: boolean
  /**
   * 'cancel' (default when the dialog has no form field), 'confirm' (only for cheap, reversible actions) or
   * 'first-field' (default when it has one).
   */
  initialFocus?: 'cancel' | 'confirm' | 'first-field'
  /** What's being decided, with the evidence: "Claim: Partly reproduced +2.8% · Here: Worse than default −63.1%". */
  recap?: ReactNode
  /** Caution banner, e.g. when the action goes against the recommendation. */
  warning?: ReactNode
  /** What running it costs: "Runs on the worker · about 20 minutes · uses the GPU". */
  cost?: ReactNode
  cancelLabel?: string
}) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const focus: InitialFocus = initialFocus === 'confirm' ? confirmRef : initialFocus === 'first-field' ? 'first-field' : cancelRef
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      dismissable={!loading}
      initialFocus={initialFocus ? focus : undefined}
      footer={
        <>
          <Button ref={cancelRef} data-initial-focus="" onClick={onClose} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button
            ref={confirmRef}
            variant={variant === 'danger' ? 'dangerSolid' : 'primary'}
            onClick={() => {
              if (!loading) onConfirm()
            }}
            loading={loading}
            disabled={confirmDisabled}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {recap && (
        <div className="mb-3 rounded-md border border-line bg-canvas-subtle px-3 py-2">
          <div className="eyebrow mb-0.5">You’re deciding on</div>
          <div className="text-fg">{recap}</div>
        </div>
      )}
      {warning && (
        <div role="note" className="mb-3 flex items-start gap-2 rounded-md border border-caution-emphasis/60 bg-caution-subtle px-3 py-2 text-fg">
          <AlertIcon size={16} className="mt-0.5 shrink-0 text-caution-fg" />
          <div className="min-w-0">{warning}</div>
        </div>
      )}
      {children}
      {cost && (
        <p className="mt-3 flex items-start gap-1.5 text-xs text-muted">
          <ClockIcon size={14} className="mt-px shrink-0" />
          <span>{cost}</span>
        </p>
      )}
      <InlineError error={error} />
    </Modal>
  )
}
