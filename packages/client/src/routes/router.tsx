import {
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { AppShell } from "@/components/shell/AppShell";
import { LoginPage } from "@/components/shell/LoginPage";
import { validateWorkspaceSearch } from "@/lib/search-params";
import { AppProviders } from "@/app/AppProviders";
import { PwaRegistration } from "@/components/pwa/PwaRegistration";
import { SelectedSessionProvider } from "@/runtime";
import { ServerPreferenceSync } from "@/features/preferences/ServerPreferenceSync";

const rootRoute = createRootRoute({
  component: function RootLayout() {
    return (
      <AppProviders>
        <Outlet />
        <PwaRegistration />
      </AppProviders>
    );
  },
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  validateSearch: validateWorkspaceSearch,
  component: function IndexPage() {
    const search = indexRoute.useSearch();
    // Route-agnostic selection wiring (4A.3.2b1a): the validated router boundary
    // declares the selected sessionId to the tree via SelectedSessionProvider.
    // `search.session` is already the validated active session selector (file
    // wins over session when both are present, so a file selector yields null);
    // home/new/file map to null. RuntimeProvider stays router-free in
    // AppProviders — this provider ONLY injects the selection context; it never
    // attaches/admits/opens a session.
    return (
      <ServerPreferenceSync>
        <SelectedSessionProvider sessionId={search.session ?? null}>
          <AppShell search={search} />
        </SelectedSessionProvider>
      </ServerPreferenceSync>
    );
  },
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  validateSearch: validateWorkspaceSearch,
  component: function LoginRoutePage() {
    const search = loginRoute.useSearch();
    return search.next === undefined ? <LoginPage /> : <LoginPage next={search.next} />;
  },
});

const routeTree = rootRoute.addChildren([indexRoute, loginRoute]);

export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
