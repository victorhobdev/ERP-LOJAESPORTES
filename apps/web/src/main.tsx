import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { ApiError } from './lib/api.js'
import { App } from './app/App.js'
import {
  CatalogPage, DashboardPage, FinancialReportPage,
  LoginPage, NewSalePage, ProductReportPage, SettingsPage,
} from './features/OperationalPages.js'
import { CustomerOrderDetailPage, CustomerOrdersPage } from './features/CustomerOrderPages.js'
import { NewPurchasePage, PurchaseDetailPage, PurchasesPage } from './features/PurchasePages.js'
import { SaleDetailPage, SalesPage } from './features/SalesPages.js'
import { InventoryPage, ProductDetailPage, StockEntryPage } from './features/InventoryPages.js'
import { registerServiceWorker } from './pwa.js'

const rootRoute = createRootRoute({ component: () => <App><Outlet /></App> })
const routePaths = [
  '/login',
  '/inicio', '/vendas', '/vendas/nova', '/vendas/$vendaId', '/estoque', '/estoque/entrada', '/estoque/produtos/$produtoId', '/compras', '/compras/nova', '/compras/$pedidoId',
  '/encomendas', '/encomendas/$encomendaId', '/relatorios/financeiro', '/relatorios/produtos', '/catalogo', '/configuracoes',
] as const
const routes = routePaths.map((path) => createRoute({
  getParentRoute: () => rootRoute,
  path,
  component: () => <RoutePage path={path} />,
}))
const routeTree = rootRoute.addChildren(routes)
const router = createRouter({ routeTree })
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, error) => !(error instanceof ApiError && error.status === 401) && count < 2,
    },
  },
})
queryClient.getQueryCache().subscribe((event) => {
  if (event?.type === 'updated' && event.query.state.error instanceof ApiError && event.query.state.error.status === 401) {
    void queryClient.removeQueries({ queryKey: ['session'] })
  }
})

declare module '@tanstack/react-router' {
  interface Register { router: typeof router }
}

function RoutePage({ path }: { path: typeof routePaths[number] }) {
  const pages: Record<typeof path, React.ReactNode> = {
    '/login': <LoginPage />, '/inicio': <DashboardPage />, '/vendas': <SalesPage />, '/vendas/nova': <NewSalePage />, '/vendas/$vendaId': <SaleDetailPage />,
    '/estoque': <InventoryPage />, '/estoque/entrada': <StockEntryPage />, '/estoque/produtos/$produtoId': <ProductDetailPage />,
    '/compras': <PurchasesPage />, '/compras/nova': <NewPurchasePage />, '/compras/$pedidoId': <PurchaseDetailPage />,
    '/encomendas': <CustomerOrdersPage />, '/encomendas/$encomendaId': <CustomerOrderDetailPage />, '/relatorios/financeiro': <FinancialReportPage />,
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

const serviceWorkerRegistration = registerServiceWorker()
if (serviceWorkerRegistration) void serviceWorkerRegistration.catch(() => undefined)
