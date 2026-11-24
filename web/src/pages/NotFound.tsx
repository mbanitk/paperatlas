import { Link } from 'react-router'
import { EmptyState } from '../components/ui'

export default function NotFound() {
  return (
    <EmptyState title="Page not found" action={<Link to="/">Back to the overview</Link>}>
      This page does not exist in the PaperAtlas console.
    </EmptyState>
  )
}
