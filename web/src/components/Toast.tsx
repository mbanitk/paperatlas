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
  show: (message: ReactNode, tone?: ToastTone) => void
  success: (message: ReactNode) => void
  error: (message: ReactNode) => void
}

const ToastContext = createContext<ToastApi | null>(null)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const nextId = useRef(1)

  const dismiss = useCallback((id: number) => setToasts((items) => items.filter((toast) => toast.id !== id)), [])

  const show = useCallback(
    (message: ReactNode, tone: ToastTone = 'info') => {
      const id = nextId.current++
      setToasts((items) => [...items.slice(-3), { id, tone, message }])
      setTimeout(() => dismiss(id), tone === 'error' ? 9000 : 5000)
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
      <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2" aria-live="polite" role="status">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={cx(
              'pointer-events-auto flex items-start gap-2 rounded-lg border bg-canvas px-3 py-2.5 text-sm shadow-lg',
              toast.tone === 'success' && 'border-success/40',
              toast.tone === 'error' && 'border-danger/40',
              toast.tone === 'info' && 'border-line',
            )}
          >
            <span className={cx('mt-0.5 shrink-0', toast.tone === 'success' ? 'text-success' : toast.tone === 'error' ? 'text-danger' : 'text-accent')}>
              {toast.tone === 'success' ? <CheckIcon /> : toast.tone === 'error' ? <AlertIcon /> : <InfoIcon />}
            </span>
            <div className="min-w-0 flex-1 break-words text-fg">{toast.message}</div>
            <button type="button" onClick={() => dismiss(toast.id)} className="shrink-0 rounded p-0.5 text-muted hover:bg-canvas-inset" aria-label="Dismiss notification">
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
