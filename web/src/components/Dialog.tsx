import { useEffect, useId, useRef, type ReactNode } from 'react'
import { XIcon } from './Icons'
import { Button, cx, InlineError } from './ui'

/** Accessible modal built on the native <dialog> element (focus trap + Esc handled by the browser). */
export function Modal({ open, onClose, title, children, footer, size = 'md' }: {
  open: boolean
  onClose: () => void
  title: ReactNode
  children: ReactNode
  footer?: ReactNode
  size?: 'sm' | 'md' | 'lg'
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onClick={(event) => {
        if (event.target === ref.current) onClose()
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
            <button type="button" onClick={onClose} className="rounded-md p-1 text-muted hover:bg-canvas-inset" aria-label="Close dialog">
              <XIcon />
            </button>
          </header>
          <div className="overflow-y-auto px-5 py-4 text-sm">{children}</div>
          {footer && <footer className="flex flex-wrap justify-end gap-2 border-t border-line-muted bg-canvas-subtle px-5 py-3">{footer}</footer>}
        </div>
      )}
    </dialog>
  )
}

export function ConfirmDialog({ open, onClose, onConfirm, title, children, confirmLabel, variant = 'primary', loading, error, confirmDisabled }: {
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
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button
            variant={variant === 'danger' ? 'dangerSolid' : 'primary'}
            onClick={onConfirm}
            loading={loading}
            disabled={confirmDisabled}
            autoFocus
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
      <InlineError error={error} />
    </Modal>
  )
}
