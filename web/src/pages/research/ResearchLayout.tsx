import { Suspense } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router'
import { useStats } from '../../api/queries'
import { PageHeader, Skeleton, cx } from '../../components/ui'
import { formatNumber } from '../../lib/format'

const TABS = [
  { to: '/research/topics', label: 'Topics', short: 'Topics', count: 'topics' },
  { to: '/research/papers', label: 'Papers & patents', short: 'Papers', count: 'papers' },
  { to: '/research/claims', label: 'Claim cards', short: 'Claims', count: 'claims' },
] as const

/** Topic and paper pages show their own breadcrumb and title (h1) instead of the section header. */
const OWN_HEADER = /^\/research\/(topics|papers)\/.+/

export default function ResearchLayout() {
  const { pathname } = useLocation()
  const detail = OWN_HEADER.test(pathname)
  const stats = useStats()
  return (
    // Any research page that renders its own breadcrumb (e.g. a claim page) hides the section header too.
    <div className="group/research">
      {!detail && (
        <div className="group-has-[nav[aria-label=Breadcrumb]]/research:hidden">
          <PageHeader title="Research" description="What’s trending in your seed areas, the papers behind it, and the claims worth testing on your hardware." />
          <nav aria-label="Research sections" className="-mt-2 mb-6 flex overflow-x-auto border-b border-line">
            {TABS.map((tab) => {
              const count = stats.data?.[tab.count]
              return (
                <NavLink
                  key={tab.to}
                  to={tab.to}
                  className={({ isActive }) =>
                    cx(
                      '-mb-px inline-flex min-h-11 shrink-0 items-center gap-1.5 border-b-2 px-3 text-sm whitespace-nowrap hover:no-underline focus-visible:rounded-t-md',
                      isActive ? 'border-[#fd8c73] font-semibold text-fg' : 'border-transparent text-muted hover:border-line hover:text-fg',
                    )
                  }
                >
                  <span className="sm:hidden">{tab.short}</span>
                  <span className="hidden sm:inline">{tab.label}</span>
                  {typeof count === 'number' && (
                    <span className="hidden rounded-full bg-neutral-subtle px-1.5 text-xs leading-5 font-medium text-muted tabular-nums sm:inline">
                      {formatNumber(count, 0)}
                    </span>
                  )}
                </NavLink>
              )
            })}
          </nav>
        </div>
      )}
      <Suspense fallback={<Skeleton variant="card" count={3} />}>
        <Outlet />
      </Suspense>
    </div>
  )
}
