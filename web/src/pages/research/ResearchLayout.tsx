import { NavLink, Outlet } from 'react-router'
import { PageHeader, cx } from '../../components/ui'

const TABS = [
  { to: '/research/topics', label: 'Topics' },
  { to: '/research/papers', label: 'Papers & patents' },
  { to: '/research/claims', label: 'Claim cards' },
]

export default function ResearchLayout() {
  return (
    <>
      <PageHeader
        title="Research"
        description="What PaperAtlas discovered: the top trending topics in the seed areas, the papers and patents found for them, and the claim cards distilled from each."
      />
      <nav aria-label="Research sections" className="mb-5 flex gap-1 overflow-x-auto border-b border-line">
        {TABS.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            className={({ isActive }) =>
              cx(
                '-mb-px border-b-2 px-3 py-2 text-sm whitespace-nowrap hover:no-underline',
                isActive ? 'border-[#fd8c73] font-semibold text-fg' : 'border-transparent text-muted hover:border-line hover:text-fg',
              )
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </>
  )
}
