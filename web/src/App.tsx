import { lazy } from 'react'
import { Navigate, Route, Routes } from 'react-router'
import Layout from './components/Layout'
import { LiveEventsProvider } from './components/LiveEvents'
import NotFound from './pages/NotFound'
import Overview from './pages/Overview'
import ResearchLayout from './pages/research/ResearchLayout'

// Route-level code splitting keeps the first load small; Layout / ResearchLayout wrap <Outlet> in <Suspense>.
const Recommendations = lazy(() => import('./pages/Recommendations'))
const Experiments = lazy(() => import('./pages/Experiments'))
const ExperimentDetail = lazy(() => import('./pages/ExperimentDetail'))
const Topics = lazy(() => import('./pages/research/Topics'))
const TopicDetail = lazy(() => import('./pages/research/TopicDetail'))
const Papers = lazy(() => import('./pages/research/Papers'))
const PaperDetailPage = lazy(() => import('./pages/research/PaperDetail'))
const Claims = lazy(() => import('./pages/research/Claims'))
const ClaimDetailPage = lazy(() => import('./pages/research/ClaimDetail'))
const Projects = lazy(() => import('./pages/Projects'))
const System = lazy(() => import('./pages/System'))
// Dev-only UX lab with every shared primitive (used by `npm run ux:check`); dropped from production builds.
const UxLab = import.meta.env.DEV ? lazy(() => import('../dev/UxLab')) : null

export default function App() {
  return (
    <LiveEventsProvider>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Overview />} />
          <Route path="recommendations" element={<Recommendations />} />
          <Route path="experiments" element={<Experiments />} />
          <Route path="experiments/:id" element={<ExperimentDetail />} />
          <Route path="research" element={<ResearchLayout />}>
            <Route index element={<Navigate to="topics" replace />} />
            <Route path="topics" element={<Topics />} />
            <Route path="topics/:slug" element={<TopicDetail />} />
            <Route path="papers" element={<Papers />} />
            <Route path="papers/*" element={<PaperDetailPage />} />
            <Route path="claims" element={<Claims />} />
            <Route path="claims/:id" element={<ClaimDetailPage />} />
          </Route>
          <Route path="projects" element={<Projects />} />
          <Route path="system" element={<System />} />
          {UxLab && <Route path="__ux" element={<UxLab />} />}
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </LiveEventsProvider>
  )
}
