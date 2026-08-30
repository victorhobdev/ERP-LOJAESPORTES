import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { App } from './App.js'

describe('operational shell', () => {
  it('shows the unambiguous primary areas and global sale action', () => {
    render(<App />)

    for (const area of ['Início', 'Vendas', 'Estoque', 'Compras', 'Encomendas', 'Relatórios', 'Catálogo', 'Configurações']) {
      expect(screen.getByRole('link', { name: area })).toBeVisible()
    }
    expect(screen.getByRole('link', { name: 'Nova venda' })).toBeVisible()
  })

  it('has a keyboard-reachable skip link and main landmark', () => {
    render(<App />)

    expect(screen.getByRole('link', { name: 'Pular para o conteúdo' })).toHaveAttribute('href', '#conteudo')
    expect(screen.getByRole('main')).toHaveAttribute('id', 'conteudo')
  })
})
