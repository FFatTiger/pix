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
    return <AppShell search={search} />;
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
