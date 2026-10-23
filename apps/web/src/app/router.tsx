import { createBrowserRouter, Outlet } from "react-router-dom";
import { AuthProvider } from "../features/auth/AuthContext";
import { LoginPage, RegisterPage, RequireAuth } from "../features/auth/AuthPages";
import { AppLayout } from "../components/layout/AppLayout";
import { BrowsePage } from "../pages/BrowsePage";
import { DeckPage } from "../pages/DeckPage";
import { HomePage } from "../pages/HomePage";
import { LibraryPage } from "../pages/LibraryPage";
import { NewSourcePage } from "../pages/NewSourcePage";
import { SourcePage } from "../pages/SourcePage";
import { ProgressPage } from "../pages/ProgressPage";
import { ReviewPage } from "../pages/ReviewPage";
import { SettingsPage } from "../pages/SettingsPage";
import { StudyPage } from "../pages/StudyPage";
import { EmptyState } from "../components/feedback/Feedback";

export const router = createBrowserRouter([
  {
    element: (
      <AuthProvider>
        <Outlet />
      </AuthProvider>
    ),
    children: [
      { path: "/login", element: <LoginPage /> },
      { path: "/register", element: <RegisterPage /> },
      {
        element: (
          <RequireAuth>
            <AppLayout />
          </RequireAuth>
        ),
        children: [
      { path: "/", element: <HomePage /> },
      { path: "/library", element: <LibraryPage /> },
      { path: "/browse", element: <BrowsePage /> },
      { path: "/progress", element: <ProgressPage /> },
      { path: "/settings", element: <SettingsPage /> },
      { path: "/review", element: <ReviewPage /> },
      { path: "/sources/new", element: <NewSourcePage /> },
      { path: "/sources/:sourceId", element: <SourcePage /> },
      { path: "/decks/:deckId", element: <DeckPage /> },
      { path: "/study/:sessionId", element: <StudyPage /> },
      { path: "*", element: <EmptyState title="Page not found">That address does not exist.</EmptyState> },
        ],
      },
    ],
  },
]);
