import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './app/App.js'

const rootRoute = createRootRoute({ component: () => <App><Outlet /></App> })
const routePaths = [
  '/inicio', '/vendas', '/vendas/nova', '/estoque', '/estoque/entrada', '/compras', '/compras/nova',
  '/encomendas', '/relatorios/financeiro', '/relatorios/produtos', '/catalogo', '/configuracoes',
] as const
const routes = routePaths.map((path) => createRoute({
  getParentRoute: () => rootRoute,
  path,
  component: () => <RoutePlaceholder path={path} />,
}))
const routeTree = rootRoute.addChildren(routes)
const router = createRouter({ routeTree })
const queryClient = new QueryClient()

declare module '@tanstack/react-router' {
  interface Register { router: typeof router }
}

function RoutePlaceholder({ path }: { path: string }) {
  if (path === '/inicio') return null
  return <section className="panel"><p className="eyebrow">Fundação em construção</p><h1>{path}</h1><p>O fluxo desta rota será conectado à API no bloco correspondente.</p></section>
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
