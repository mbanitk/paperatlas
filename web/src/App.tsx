import { Navigate, Route, Routes } from 'react-router'
import Layout from './components/Layout'
import { LiveEventsProvider } from './components/LiveEvents'
import ExperimentDetail from './pages/ExperimentDetail'
import Experiments from './pages/Experiments'
import NotFound from './pages/NotFound'
import Overview from './pages/Overview'
import Recommendations from './pages/Recommendations'
import System from './pages/System'
import ClaimDetailPage from './pages/research/ClaimDetail'
import Claims from './pages/research/Claims'
import PaperDetailPage from './pages/research/PaperDetail'
import Papers from './pages/research/Papers'
import ResearchLayout from './pages/research/ResearchLayout'
import Topics from './pages/research/Topics'

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
            <Route path="papers" element={<Papers />} />
            <Route path="papers/*" element={<PaperDetailPage />} />
            <Route path="claims" element={<Claims />} />
            <Route path="claims/:id" element={<ClaimDetailPage />} />
          </Route>
          <Route path="system" element={<System />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </LiveEventsProvider>
  )
}
