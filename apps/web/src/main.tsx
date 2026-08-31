import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './app/App.js'
import {
  CatalogPage, CustomerOrdersPage, DashboardPage, FinancialReportPage, InventoryPage,
  LoginPage, NewPurchasePage, NewSalePage, ProductReportPage, PurchasesPage, SalesPage, SettingsPage,
} from './features/OperationalPages.js'

const rootRoute = createRootRoute({ component: () => <App><Outlet /></App> })
const routePaths = [
  '/login',
  '/inicio', '/vendas', '/vendas/nova', '/estoque', '/estoque/entrada', '/compras', '/compras/nova',
  '/encomendas', '/relatorios/financeiro', '/relatorios/produtos', '/catalogo', '/configuracoes',
] as const
const routes = routePaths.map((path) => createRoute({
  getParentRoute: () => rootRoute,
  path,
  component: () => <RoutePage path={path} />,
}))
const routeTree = rootRoute.addChildren(routes)
const router = createRouter({ routeTree })
const queryClient = new QueryClient()

declare module '@tanstack/react-router' {
  interface Register { router: typeof router }
}

function RoutePage({ path }: { path: typeof routePaths[number] }) {
  const pages: Record<typeof path, React.ReactNode> = {
    '/login': <LoginPage />, '/inicio': <DashboardPage />, '/vendas': <SalesPage />, '/vendas/nova': <NewSalePage />,
    '/estoque': <InventoryPage />, '/estoque/entrada': <InventoryPage />,
    '/compras': <PurchasesPage />, '/compras/nova': <NewPurchasePage />,
    '/encomendas': <CustomerOrdersPage />, '/relatorios/financeiro': <FinancialReportPage />,
    '/relatorios/produtos': <ProductReportPage />, '/catalogo': <CatalogPage />, '/configuracoes': <SettingsPage />,
  }
  return pages[path]
}

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Elemento raiz não encontrado.')

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
)
