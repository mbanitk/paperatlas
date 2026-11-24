import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import { AlertIcon, CheckIcon, InfoIcon, XIcon } from './Icons'
import { cx } from './ui'

type ToastTone = 'success' | 'error' | 'info'
interface Toast {
  id: number
  tone: ToastTone
  message: ReactNode
}

interface ToastApi {
  /** Errors stay until dismissed; success/info disappear after 5 s. */
  show: (message: ReactNode, tone?: ToastTone) => void
  success: (message: ReactNode) => void
  error: (message: ReactNode) => void
}

const ToastContext = createContext<ToastApi | null>(null)

/**
 * Toasts never cover primary actions (docs/ux-review.md G-3): below 640px they drop in at the top, under the
 * sticky header; from 640px they sit bottom-right, above the sticky action bar (`--action-bar-h`).
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const nextId = useRef(1)

  const dismiss = useCallback((id: number) => setToasts((items) => items.filter((toast) => toast.id !== id)), [])

  const show = useCallback(
    (message: ReactNode, tone: ToastTone = 'info') => {
      const id = nextId.current++
      setToasts((items) => [...items.slice(-2), { id, tone, message }])
      if (tone !== 'error') setTimeout(() => dismiss(id), 5000)
    },
    [dismiss],
  )

  const value = useMemo<ToastApi>(
    () => ({ show, success: (message) => show(message, 'success'), error: (message) => show(message, 'error') }),
    [show],
  )

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        data-toast-region=""
        aria-live="polite"
        role="status"
        className={cx(
          'pointer-events-none fixed z-(--z-toast) flex w-[min(380px,calc(100vw-1.5rem))] flex-col gap-2',
          'max-sm:top-[calc(var(--header-h)+8px)] max-sm:left-1/2 max-sm:-translate-x-1/2',
          'sm:right-4 sm:bottom-[calc(var(--action-bar-h)+16px)]',
        )}
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role={toast.tone === 'error' ? 'alert' : undefined}
            className={cx(
              'pointer-events-auto flex items-start gap-2 rounded-lg border bg-canvas px-3 py-2.5 text-sm shadow-lg',
              toast.tone === 'success' && 'border-positive/40',
              toast.tone === 'error' && 'border-negative/40',
              toast.tone === 'info' && 'border-line',
            )}
          >
            <span className={cx('mt-0.5 shrink-0', toast.tone === 'success' ? 'text-positive-fg' : toast.tone === 'error' ? 'text-negative-fg' : 'text-info-fg')}>
              {toast.tone === 'success' ? <CheckIcon /> : toast.tone === 'error' ? <AlertIcon /> : <InfoIcon />}
            </span>
            <div className="min-w-0 flex-1 break-words text-fg">{toast.message}</div>
            <button
              type="button"
              onClick={() => dismiss(toast.id)}
              className="-my-1 -mr-1 inline-flex size-7 shrink-0 items-center justify-center rounded text-muted hover:bg-canvas-inset"
              aria-label="Dismiss notification"
            >
              <XIcon size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast(): ToastApi {
  const context = useContext(ToastContext)
  if (!context) throw new Error('useToast must be used inside <ToastProvider>')
  return context
}
