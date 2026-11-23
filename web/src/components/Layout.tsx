import { NavLink, Outlet, useLocation } from 'react-router'
import { useServices, useStats } from '../api/queries'
import { LiveDot } from './Badges'
import { AlertIcon } from './Icons'
import { useLiveEvents } from './LiveEvents'
import { Counter, cx } from './ui'
import { useEffect } from 'react'

const NAV = [
  { to: '/', label: 'Overview', end: true },
  { to: '/recommendations', label: 'Recommendations' },
  { to: '/experiments', label: 'Experiments' },
  { to: '/research', label: 'Research' },
  { to: '/projects', label: 'Projects' },
  { to: '/system', label: 'System' },
]

function ServicesBanner() {
  const services = useServices()
  if (services.isLoading) return null
  if (services.isError) {
    return (
      <div role="alert" className="border-b border-danger/30 bg-danger-subtle">
        <div className="mx-auto flex max-w-7xl items-center gap-2 px-4 py-2 text-sm text-danger sm:px-6">
          <AlertIcon className="shrink-0" />
          <span className="text-fg">
            <strong className="text-danger">Gateway unreachable.</strong> Start the services with{' '}
            <code className="code-inline">paperatlas services up</code> — data shown may be stale.
          </span>
        </div>
      </div>
    )
  }
  const down = Object.entries(services.data ?? {}).filter(([, health]) => health.status !== 'ok')
  if (!down.length) return null
  return (
    <div role="alert" className="border-b border-attention-emphasis/40 bg-attention-subtle">
      <div className="mx-auto flex max-w-7xl items-center gap-2 px-4 py-2 text-sm sm:px-6">
        <AlertIcon className="shrink-0 text-attention" />
        <span>
          <strong className="text-attention">Services down:</strong>{' '}
          {down.map(([name, health]) => `${name} (${health.status})`).join(', ')}. Some panels will not load until they are back.
        </span>
      </div>
    </div>
  )
}

export default function Layout() {
  const stats = useStats()
  const live = useLiveEvents()
  const location = useLocation()
  const awaiting = stats.data?.awaiting_you ?? 0

  useEffect(() => {
    window.scrollTo({ top: 0 })
  }, [location.pathname])

  return (
    <div className="min-h-screen">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded focus:bg-canvas focus:px-3 focus:py-2">
        Skip to content
      </a>
      <header className="sticky top-0 z-30 border-b border-line bg-canvas/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center gap-4 px-4 sm:px-6">
          <NavLink to="/" className="flex shrink-0 items-center gap-2 py-3 text-fg hover:no-underline" aria-label="PaperAtlas home">
            <img src="/favicon.svg" alt="" className="size-7" />
            <span className="hidden leading-tight sm:block">
              <span className="block text-sm font-semibold">PaperAtlas</span>
              <span className="block text-[11px] text-muted">Research → Experiment</span>
            </span>
          </NavLink>
          <nav aria-label="Main" className="-mb-px flex flex-1 gap-1 overflow-x-auto">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cx(
                    'inline-flex items-center gap-1.5 border-b-2 px-2.5 py-4 text-sm whitespace-nowrap hover:no-underline',
                    isActive ? 'border-[#fd8c73] font-semibold text-fg' : 'border-transparent text-muted hover:border-line hover:text-fg',
                  )
                }
              >
                {item.label}
                {item.to === '/experiments' && awaiting > 0 && (
                  <span title={`${awaiting} gate(s) waiting for you`}>
                    <Counter value={awaiting} tone="attention" />
                  </span>
                )}
              </NavLink>
            ))}
          </nav>
          <div className="hidden shrink-0 md:block">
            <LiveDot status={live.status} />
          </div>
        </div>
      </header>
      <ServicesBanner />
      <main id="main" className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
        <Outlet />
      </main>
      <footer className="mx-auto max-w-7xl px-4 pb-8 text-xs text-subtle sm:px-6">
        PaperAtlas web console · data from the research-api and lab-api via the gateway
      </footer>
    </div>
  )
}
