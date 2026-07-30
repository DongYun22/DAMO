import { useCallback, useEffect, useMemo, useState } from "react";
import type { HomeData } from "@damo/contracts";
import {
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation
} from "react-router-dom";
import { api } from "./api";
import { AuthProvider, useAuth } from "./auth";
import { BottomNav, Loading, Toast } from "./components";
import type { ShellContext } from "./shell";
import {
  CandidateSelectPage,
  CandidateMapPage,
  CreateMeetingPage,
  HomePage,
  JoinMeetingPage,
  LoginPage,
  MapPage,
  MeetingDetailPage,
  MeetingRecurrencePage,
  MyPlacesPage,
  NotFoundPage,
  OAuthCallbackPage,
  RepeatMeetingPage,
  ResultsPage,
  VotePage
} from "./pages";

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [pathname]);
  return null;
}

function ProtectedShell() {
  const { user, loading } = useAuth();
  const location = useLocation();
  const [home, setHome] = useState<HomeData | null>(null);
  const [toast, setToast] = useState("");

  const refreshHome = useCallback(async () => {
    if (!user) return;
    setHome(await api<HomeData>("/me/home"));
  }, [user]);

  useEffect(() => {
    if (!user) return;
    void refreshHome();
    const timer = window.setInterval(() => void refreshHome(), 5000);
    return () => window.clearInterval(timer);
  }, [refreshHome, user]);

  const context = useMemo<ShellContext>(
    () => ({ home, refreshHome, showToast: setToast }),
    [home, refreshHome]
  );

  if (loading) return <Loading label="계정 확인 중" />;
  if (!user) return <Navigate to="/login" state={{ from: location }} replace />;

  return (
    <div className="app-shell">
      <main className="app-main">
        <Outlet context={context} />
      </main>
      <BottomNav hasVoteAlert={Boolean(home?.hasVoteAlert)} />
      {toast ? <Toast message={toast} onDone={() => setToast("")} /> : null}
    </div>
  );
}

export function App() {
  return (
    <AuthProvider>
      <ScrollToTop />
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/oauth/callback" element={<OAuthCallbackPage />} />
        <Route element={<ProtectedShell />}>
          <Route index element={<HomePage />} />
          <Route path="/map" element={<MapPage />} />
          <Route path="/places" element={<MyPlacesPage />} />
          <Route path="/meetings/new" element={<CreateMeetingPage />} />
          <Route path="/meetings/join" element={<JoinMeetingPage />} />
          <Route path="/meetings/:meetingId" element={<MeetingDetailPage />} />
          <Route
            path="/meetings/:meetingId/repeat"
            element={<RepeatMeetingPage />}
          />
          <Route
            path="/meetings/:meetingId/recurrence"
            element={<MeetingRecurrencePage />}
          />
          <Route
            path="/meetings/:meetingId/candidates"
            element={<CandidateSelectPage />}
          />
          <Route
            path="/meetings/:meetingId/candidates/:candidateId/map"
            element={<CandidateMapPage />}
          />
          <Route path="/meetings/:meetingId/vote" element={<VotePage />} />
          <Route path="/meetings/:meetingId/results" element={<ResultsPage />} />
        </Route>
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </AuthProvider>
  );
}
