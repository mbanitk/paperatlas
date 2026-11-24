import { Suspense, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router'
import { useServices, useStats } from '../api/queries'
import { LiveDot } from './Badges'
import { AlertIcon, GateIcon, MenuIcon, XIcon } from './Icons'
import { useLiveEvents } from './LiveEvents'
import { Counter, cx, Loading } from './ui'

const NAV = [
  { to: '/', label: 'Overview', end: true },
  { to: '/recommendations', label: 'Recommendations' },
  { to: '/experiments', label: 'Experiments' },
  { to: '/research', label: 'Research' },
  { to: '/projects', label: 'Projects' },
  { to: '/system', label: 'System' },
]

function currentSection(pathname: string) {
  return NAV.find((item) => (item.end ? pathname === item.to : pathname === item.to || pathname.startsWith(`${item.to}/`)))
}

function ServicesBanner() {
  const services = useServices()
  if (services.isLoading) return null
  if (services.isError) {
    return (
      <div role="alert" className="border-b border-negative/30 bg-negative-subtle">
        <div className="mx-auto flex max-w-7xl items-start gap-2 px-4 py-2 text-sm sm:px-6">
          <AlertIcon className="mt-0.5 shrink-0 text-negative-fg" />
          <span className="text-fg">
            <strong className="text-negative-fg">The gateway isn’t responding.</strong> What you see may be out of date. Start the services with{' '}
            <code className="code-inline">paperatlas services up</code>.
          </span>
        </div>
      </div>
    )
  }
  const down = Object.entries(services.data ?? {}).filter(([, health]) => health.status !== 'ok')
  if (!down.length) return null
  return (
    <div role="alert" className="border-b border-caution-emphasis/40 bg-caution-subtle">
      <div className="mx-auto flex max-w-7xl items-start gap-2 px-4 py-2 text-sm sm:px-6">
        <AlertIcon className="mt-0.5 shrink-0 text-caution-fg" />
        <span>
          <strong className="text-caution-fg">Some services are down:</strong> {down.map(([name, health]) => `${name} (${health.status})`).join(', ')}. Some
          panels won’t load until they’re back.
        </span>
      </div>
    </div>
  )
}

/** "Needs you 5": persistent pill on small screens, where the nav counter is inside the menu. */
function NeedsYouPill({ count }: { count: number }) {
  if (count <= 0) return null
  return (
    <Link
      to="/experiments?tab=needs_you"
      aria-label={`${count} ${count === 1 ? 'decision needs' : 'decisions need'} you`}
      className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-caution-emphasis bg-caution-subtle px-2.5 text-xs font-semibold whitespace-nowrap text-caution-fg hover:no-underline"
    >
      <GateIcon size={12} />
      Needs you
      <span className="tabular-nums">{count}</span>
    </Link>
  )
}

function navClass(isActive: boolean, compact = false) {
  return cx(
    'inline-flex items-center gap-1.5 text-sm whitespace-nowrap hover:no-underline',
    compact ? 'min-h-11 rounded-md px-3' : 'border-b-2 px-2.5 py-4',
    compact
      ? isActive
        ? 'bg-canvas-subtle font-semibold text-fg'
        : 'text-fg hover:bg-canvas-subtle'
      : isActive
        ? 'border-[#fd8c73] font-semibold text-fg'
        : 'border-transparent text-muted hover:border-line hover:text-fg',
  )
}

export default function Layout() {
  const stats = useStats()
  const live = useLiveEvents()
  const location = useLocation()
  const awaiting = stats.data?.awaiting_you ?? 0
  const headerRef = useRef<HTMLElement>(null)
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuId = useId()
  const section = currentSection(location.pathname)

  useEffect(() => {
    if (location.hash) {
      const target = document.getElementById(decodeURIComponent(location.hash.slice(1)))
      if (target) {
        target.scrollIntoView()
        return
      }
    }
    window.scrollTo({ top: 0 })
  }, [location.pathname, location.hash])

  useEffect(() => setMenuOpen(false), [location.pathname, location.search])

  // Publish the sticky header's height so anchors, popovers and toasts stay below it.
  useLayoutEffect(() => {
    const header = headerRef.current
    if (!header) return
    const publish = () => document.documentElement.style.setProperty('--header-h', `${Math.ceil(header.getBoundingClientRect().height)}px`)
    publish()
    const observer = new ResizeObserver(publish)
    observer.observe(header)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!menuOpen) return
    menuRef.current?.querySelector<HTMLElement>('a')?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false)
        menuButtonRef.current?.focus()
      }
    }
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node
      if (!menuRef.current?.contains(target) && !menuButtonRef.current?.contains(target)) setMenuOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointer)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointer)
    }
  }, [menuOpen])

  const counter = (to: string) =>
    to === '/experiments' && awaiting > 0 ? (
      <span aria-label={`${awaiting} waiting for you`} className="inline-flex">
        <Counter value={awaiting} tone="attention" />
      </span>
    ) : null

  return (
    <div className="min-h-screen">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-(--z-toast) focus:rounded focus:bg-canvas focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <header ref={headerRef} className="sticky top-0 z-(--z-header) border-b border-line bg-canvas/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 sm:px-6 md:gap-4">
          <NavLink to="/" className="flex shrink-0 items-center gap-2 py-3 text-fg hover:no-underline" aria-label="PaperAtlas home">
            <img src="/favicon.svg" alt="" className="size-7" />
            <span className="hidden leading-tight lg:block">
              <span className="block text-sm font-semibold">PaperAtlas</span>
              <span className="block text-xs text-muted">Research → Experiment</span>
            </span>
          </NavLink>

          {/* Compact header below 768px: current section, "Needs you", and a menu with every section. */}
          <div className="flex min-w-0 flex-1 items-center gap-2 md:hidden">
            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-fg">{section?.label ?? 'PaperAtlas'}</span>
            <NeedsYouPill count={awaiting} />
            <button
              ref={menuButtonRef}
              type="button"
              aria-expanded={menuOpen}
              aria-controls={menuId}
              onClick={() => setMenuOpen((value) => !value)}
              className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md border border-line bg-canvas px-2.5 text-sm font-medium text-fg hover:bg-canvas-subtle"
            >
              {menuOpen ? <XIcon size={16} /> : <MenuIcon size={16} />}
              Menu
            </button>
          </div>

          <nav aria-label="Main" className="-mb-px hidden flex-1 gap-1 md:flex">
            {NAV.map((item) => (
              <NavLink key={item.to} to={item.to} end={item.end} className={({ isActive }) => navClass(isActive)}>
                {item.label}
                {counter(item.to)}
              </NavLink>
            ))}
          </nav>
          <div className="hidden shrink-0 md:block">
            <LiveDot status={live.status} />
          </div>
        </div>

        {menuOpen && (
          <div ref={menuRef} id={menuId} className="border-t border-line-muted bg-canvas shadow-lg md:hidden">
            <nav aria-label="Main" className="mx-auto flex max-w-7xl flex-col gap-0.5 px-2 py-2 sm:px-4">
              {NAV.map((item) => (
                <NavLink key={item.to} to={item.to} end={item.end} className={({ isActive }) => navClass(isActive, true)}>
                  <span className="flex-1">{item.label}</span>
                  {counter(item.to)}
                </NavLink>
              ))}
              <div className="px-3 pt-2 pb-1">
                <LiveDot status={live.status} />
              </div>
            </nav>
          </div>
        )}
      </header>
      <ServicesBanner />
      <main id="main" tabIndex={-1} className="mx-auto max-w-7xl px-4 py-6 outline-none sm:px-6">
        <Suspense fallback={<Loading />}>
          <Outlet />
        </Suspense>
      </main>
      <footer className="mx-auto max-w-7xl px-4 text-xs text-muted sm:px-6" style={{ paddingBottom: 'calc(2rem + var(--action-bar-h))' }}>
        PaperAtlas · live data ·{' '}
        <Link to="/system" className="text-muted underline hover:text-accent">
          System status
        </Link>
      </footer>
    </div>
  )
}
