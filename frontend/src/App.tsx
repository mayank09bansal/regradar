import { BrowserRouter, Route, Routes } from "react-router-dom";
import Layout from "./components/Layout";
import AnalyzePage from "./pages/AnalyzePage";
import ArchitecturePage from "./pages/ArchitecturePage";
import ControlsPage from "./pages/ControlsPage";
import CoveragePage from "./pages/CoveragePage";
import DashboardPage from "./pages/DashboardPage";
import FeedbackLoopPage from "./pages/FeedbackLoopPage";
import GapsPage from "./pages/GapsPage";
import N8nWorkflowPage from "./pages/N8nWorkflowPage";
import NotFoundPage from "./pages/NotFoundPage";
import RegulationsPage from "./pages/RegulationsPage";
import RemediationPage from "./pages/RemediationPage";
import ReportPage from "./pages/ReportPage";
import RunOverviewPage from "./pages/RunOverviewPage";
import RunsPage from "./pages/RunsPage";
import SettingsPage from "./pages/SettingsPage";
import TracePage from "./pages/TracePage";

// Run-scoped pages work at /<page> (latest run or ?run=<id>) and at /runs/:runId/<page>.
const RUN_PAGES = [
  { path: "trace", element: <TracePage /> },
  { path: "feedback-loop", element: <FeedbackLoopPage /> },
  { path: "coverage", element: <CoveragePage /> },
  { path: "gaps", element: <GapsPage /> },
  { path: "remediation", element: <RemediationPage /> },
  { path: "report", element: <ReportPage /> },
];

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<DashboardPage />} />
          <Route path="analyze" element={<AnalyzePage />} />
          <Route path="runs" element={<RunsPage />} />
          <Route path="runs/:runId" element={<RunOverviewPage />} />
          {RUN_PAGES.map((p) => <Route key={p.path} path={p.path} element={p.element} />)}
          {RUN_PAGES.map((p) => <Route key={`run-${p.path}`} path={`runs/:runId/${p.path}`} element={p.element} />)}
          <Route path="regulations" element={<RegulationsPage />} />
          <Route path="controls" element={<ControlsPage />} />
          <Route path="architecture" element={<ArchitecturePage />} />
          <Route path="n8n-workflow" element={<N8nWorkflowPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
