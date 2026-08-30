import type { PropsWithChildren } from 'react'

import './app.css'

const navigation = [
  ['Início', '/inicio'],
  ['Vendas', '/vendas'],
  ['Estoque', '/estoque'],
  ['Compras', '/compras'],
  ['Encomendas', '/encomendas'],
  ['Relatórios', '/relatorios/financeiro'],
  ['Catálogo', '/catalogo'],
  ['Configurações', '/configuracoes'],
] as const

export function App({ children }: PropsWithChildren) {
  return (
    <div className="app-shell">
      <a className="skip-link" href="#conteudo">
        Pular para o conteúdo
      </a>

      <aside className="sidebar" aria-label="Navegação principal">
        <a className="brand" href="/inicio" aria-label="ERP 2.0 — Início">
          <span className="brand-mark" aria-hidden="true">E2</span>
          <span>
            <strong>ERP 2.0</strong>
            <small>Operação da loja</small>
          </span>
        </a>

        <nav>
          {navigation.map(([label, href]) => (
            <a href={href} key={href}>{label}</a>
          ))}
        </nav>

        <div className="sync-state" role="status">
          <span aria-hidden="true" />
          Dados locais atualizados
        </div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <label className="global-search">
            <span className="sr-only">Busca global</span>
            <input type="search" placeholder="Buscar produto, venda ou cliente" />
            <kbd>Ctrl K</kbd>
          </label>
          <a className="primary-action" href="/vendas/nova">Nova venda</a>
          <button className="user-menu" type="button" aria-label="Abrir menu de usuário">VH</button>
        </header>

        <main id="conteudo" tabIndex={-1}>
          {children ?? <DashboardPrototype />}
        </main>
      </div>
    </div>
  )
}

function DashboardPrototype() {
  return (
    <div className="page-stack">
      <header className="page-header">
        <div>
          <p className="eyebrow">Domingo, 30 de agosto</p>
          <h1>Visão da operação</h1>
          <p>Acompanhe o que precisa de atenção antes de abrir o caixa.</p>
        </div>
        <span className="demo-badge">Dados de demonstração</span>
      </header>

      <section className="metrics" aria-label="Indicadores de demonstração">
        <Metric label="Recebido hoje" value="R$ 1.840,00" detail="12 vendas confirmadas" tone="brand" />
        <Metric label="Pagamentos pendentes" value="R$ 480,00" detail="2 vencem nesta semana" tone="warning" />
        <Metric label="Estoque baixo" value="7 variantes" detail="3 sem reposição aberta" tone="danger" />
        <Metric label="Compras a receber" value="18 peças" detail="2 pedidos em andamento" tone="neutral" />
      </section>

      <div className="dashboard-grid">
        <section className="panel">
          <div className="panel-heading">
            <div><p className="eyebrow">Fila de trabalho</p><h2>Prioridades de hoje</h2></div>
            <a href="/inicio">Ver todas</a>
          </div>
          <ul className="task-list">
            <Task title="Confirmar pagamento da venda #1048" meta="Maria Oliveira · vencido ontem" badge="Vencido" />
            <Task title="Receber pedido Fornecedor Express" meta="8 de 14 peças já recebidas" badge="Parcial" />
            <Task title="Separar encomenda do Flamengo Home" meta="Carlos Souza · tamanho G" badge="Chegou" />
          </ul>
        </section>

        <section className="panel stock-panel">
          <div className="panel-heading"><div><p className="eyebrow">Estoque</p><h2>Reposição necessária</h2></div></div>
          <div className="stock-row"><span>Flamengo · Home 2025 · M</span><strong>1</strong></div>
          <div className="stock-row"><span>Botafogo · Third 2025 · G</span><strong>0</strong></div>
          <div className="stock-row"><span>Brasil · Seleção · 10</span><strong>2</strong></div>
          <a className="secondary-action" href="/estoque?availability=low">Revisar estoque baixo</a>
        </section>
      </div>
    </div>
  )
}

function Metric({ label, value, detail, tone }: { label: string; value: string; detail: string; tone: string }) {
  return <article className={`metric metric-${tone}`}><p>{label}</p><strong>{value}</strong><small>{detail}</small></article>
}

function Task({ title, meta, badge }: { title: string; meta: string; badge: string }) {
  return <li><span><strong>{title}</strong><small>{meta}</small></span><span className="status-badge">{badge}</span></li>
}
