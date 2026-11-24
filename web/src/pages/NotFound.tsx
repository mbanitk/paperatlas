import { Link, useLocation } from 'react-router'
import { EmptyState } from '../components/ui'

export default function NotFound() {
  const location = useLocation()
  return (
    <EmptyState
      title="Page not found"
      action={
        <Link to="/" className="inline-flex h-8 items-center rounded-md border border-line bg-canvas-subtle px-3 text-sm font-medium text-fg hover:bg-canvas-inset hover:no-underline">
          Go to the overview
        </Link>
      }
      secondaryAction={
        <Link to="/experiments?tab=needs_you" className="text-sm">
          See what needs you
        </Link>
      }
    >
      There’s no page at <code className="code-inline break-all">{location.pathname}</code>. The link may be out of date.
    </EmptyState>
  )
}
