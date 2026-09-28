import { randomUUID } from 'node:crypto'

import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { applyMigrations } from '../../shared/db/migrate.js'
import { normalizeGeminiDump } from './gemini-dump.js'
import { migrateLegacyCustomerOrders } from './legacy-customer-orders.js'
import { migrateLegacyPurchases } from './legacy-purchases.js'
import { migrateLegacyProducts } from './legacy-products.js'
import { migrateLegacySales } from './legacy-sales.js'
import { parseMysqlDump } from './mysql-dump.js'
import { buildReconciliationReport } from './reconcile.js'

const connectionString = process.env['TEST_DATABASE_URL']
if (!connectionString) throw new Error('TEST_DATABASE_URL is required for PostgreSQL integration tests.')

const sourceName = 'gemini_teste'

const miniDump = `
CREATE TABLE \`clientes\` (
  \`ClienteID\` int NOT NULL AUTO_INCREMENT,
  \`NomeCliente\` varchar(255) NOT NULL,
  \`ContatoCliente\` varchar(255) DEFAULT NULL,
  PRIMARY KEY (\`ClienteID\`)
);
INSERT INTO \`clientes\` VALUES (1,'Cliente Um',NULL),(2,'Cliente Dois',NULL);

CREATE TABLE \`produtos\` (
  \`ProdutoID\` int NOT NULL AUTO_INCREMENT,
  \`Modelo\` varchar(150) NOT NULL,
  \`Clube\` varchar(150) NOT NULL,
  \`Tipo\` enum('Masculina','Feminina','Infantil') NOT NULL,
  \`Tamanho\` varchar(20) NOT NULL,
  \`DescricaoCompleta\` varchar(500) DEFAULT NULL,
  \`PrecoVendaAtual\` decimal(10,2) NOT NULL,
  \`QuantidadeEstoque\` int NOT NULL,
  \`CustoMedioPonderado\` decimal(10,2) NOT NULL,
  \`DataCadastro\` datetime DEFAULT NULL,
  \`DataUltimaEntradaEstoque\` datetime DEFAULT NULL,
  \`CaminhoImagem\` varchar(500) DEFAULT NULL,
  PRIMARY KEY (\`ProdutoID\`)
);
INSERT INTO \`produtos\` VALUES (1,'Home 2025','Flamengo','Masculina','M',NULL,150.00,5,80.00,'2026-01-10 10:00:00',NULL,NULL),(2,'Home 2025','Flamengo','Masculina','G',NULL,160.00,3,80.00,'2026-01-10 10:00:00',NULL,NULL),(3,'Third 2025','Botafogo','Feminina','P',NULL,90.00,0,50.00,'2026-01-11 10:00:00',NULL,NULL);

CREATE TABLE \`vendas\` (
  \`VendaID\` int NOT NULL AUTO_INCREMENT,
  \`ClienteID\` int DEFAULT NULL,
  \`DataVenda\` datetime DEFAULT NULL,
  \`ValorTotalItens\` decimal(10,2) NOT NULL,
  \`ValorDesconto\` decimal(10,2) NOT NULL,
  \`ValorFinalVenda\` decimal(10,2) NOT NULL,
  \`StatusPagamento\` enum('Pago','Pendente') NOT NULL,
  \`DataPrometidaPagamento\` date DEFAULT NULL,
  \`MetodoPagamento\` varchar(50) DEFAULT NULL,
  \`ValorPago\` decimal(10,2) NOT NULL,
  PRIMARY KEY (\`VendaID\`)
);
INSERT INTO \`vendas\` VALUES (1,1,'2026-04-22 10:00:00',150.00,0.00,150.00,'Pago',NULL,'Pix',150.00),(2,2,'2026-05-01 11:00:00',160.00,10.00,150.00,'Pendente','2026-12-20','Pix',50.00),(3,NULL,'2026-05-02 12:00:00',90.00,0.00,90.00,'Pendente','2026-12-25','Dinheiro',0.00),(4,1,'2026-05-03 12:00:00',70.00,0.00,70.00,'Pago',NULL,'Pix',80.00);

CREATE TABLE \`itensvenda\` (
  \`ItemVendaID\` int NOT NULL AUTO_INCREMENT,
  \`VendaID\` int NOT NULL,
  \`ProdutoID\` int NOT NULL,
  \`Quantidade\` int NOT NULL,
  \`PrecoVendaUnitarioRegistrado\` decimal(10,2) NOT NULL,
  \`CustoMedioUnitarioRegistrado\` decimal(10,2) NOT NULL,
  PRIMARY KEY (\`ItemVendaID\`)
);
INSERT INTO \`itensvenda\` VALUES (1,1,1,1,150.00,80.00),(2,2,2,1,160.00,80.00),(3,3,3,1,90.00,50.00),(4,4,1,1,70.00,80.00);

CREATE TABLE \`pedidosfornecedor\` (
  \`PedidoFornecedorID\` int NOT NULL AUTO_INCREMENT,
  \`DataPedido\` date DEFAULT NULL,
  \`NomeFornecedor\` varchar(255) DEFAULT NULL,
  \`CustoTotalEstimadoItens\` decimal(10,2) NOT NULL,
  \`TaxaImportacaoTotal\` decimal(10,2) NOT NULL,
  \`CustoTotalFinalPedido\` decimal(10,2) NOT NULL,
  \`StatusPedido\` enum('Realizado','Recebido Parcialmente','Recebido Integralmente') NOT NULL,
  PRIMARY KEY (\`PedidoFornecedorID\`)
);
INSERT INTO \`pedidosfornecedor\` VALUES (2,'2026-04-21','FORNECEDOR A',300.00,0.00,300.00,'Recebido Parcialmente'),(3,'2026-05-01',NULL,0.00,0.00,0.00,'Realizado');

CREATE TABLE \`itenspedidofornecedor\` (
  \`ItemPedidoFornecedorID\` int NOT NULL AUTO_INCREMENT,
  \`PedidoFornecedorID\` int NOT NULL,
  \`ProdutoID\` int NOT NULL,
  \`QuantidadePedida\` int NOT NULL,
  \`CustoUnitarioFornecedor\` decimal(10,2) NOT NULL,
  \`CustoUnitarioComTaxas\` decimal(10,2) NOT NULL,
  \`QuantidadeRecebida\` int NOT NULL,
  \`DataRecebimento\` date DEFAULT NULL,
  \`Chegou\` tinyint(1) NOT NULL,
  PRIMARY KEY (\`ItemPedidoFornecedorID\`)
);
INSERT INTO \`itenspedidofornecedor\` VALUES (57,2,1,2,150.00,150.00,2,'2026-04-25',1),(58,2,2,3,50.00,50.00,1,'2026-04-25',1);

CREATE TABLE \`encomendascliente\` (
  \`EncomendaClienteID\` int NOT NULL AUTO_INCREMENT,
  \`ClienteID\` int NOT NULL,
  \`DataEncomenda\` date DEFAULT NULL,
  \`Clube\` varchar(150) NOT NULL,
  \`Modelo\` varchar(150) NOT NULL,
  \`Tipo\` enum('Masculina','Feminina','Infantil') NOT NULL,
  \`Tamanho\` varchar(20) NOT NULL,
  \`Observacao\` text,
  \`StatusEncomenda\` enum('Pendente','PedidoAoFornecedorFeito','ProdutoChegou','EntregueAoCliente','Cancelada') NOT NULL,
  \`ProdutoIDAssociado\` int DEFAULT NULL,
  PRIMARY KEY (\`EncomendaClienteID\`)
);
INSERT INTO \`encomendascliente\` VALUES (1,1,'2026-06-01','Flamengo','Home 2025','Masculina','M','Observacao teste','Pendente',NULL),(2,2,'2026-06-02','Botafogo','Third 2025','Feminina','P',NULL,'Cancelada',3),(3,999,'2026-06-03','Flamengo','Home 2025','Masculina','M',NULL,'Pendente',NULL);
`

describe('gemini dump migration pipeline', () => {
  const adminPool = new Pool({ connectionString, max: 1 })
  const schema = `erp2_test_${randomUUID().replaceAll('-', '')}`
  const actorUserId = randomUUID()
  let pool: Pool
  const normalized = normalizeGeminiDump(parseMysqlDump(miniDump))

  async function migrateAll() {
    const products = await migrateLegacyProducts(pool, { sourceName, actorUserId, rows: normalized.products })
    const sales = await migrateLegacySales(pool, { sourceName, actorUserId, rows: normalized.sales })
    const purchases = await migrateLegacyPurchases(pool, { sourceName, actorUserId, rows: normalized.purchases })
    const customerOrders = await migrateLegacyCustomerOrders(pool, {
      sourceName,
      actorUserId,
      rows: normalized.customerOrders.map((order) => ({
        ...order,
        customer: normalized.customers.find((candidate) => candidate.legacyId === order.customerLegacyId) ?? null,
      })),
    })
    return { products, sales, purchases, customerOrders }
  }

  beforeAll(async () => {
    const current = await adminPool.query<{ current_database: string }>('SELECT current_database()')
    if (current.rows[0]?.current_database !== 'erp2_test') {
      throw new Error('Integration tests refuse to run outside the dedicated erp2_test database.')
    }
    await adminPool.query(`CREATE SCHEMA "${schema}"`)
    pool = new Pool({ connectionString, max: 4, options: `-c search_path=${schema}` })
    await applyMigrations(pool)
    await pool.query(
      `INSERT INTO users (id, username, display_name, password_hash, role_id)
       VALUES ($1, 'migrador.gemini', 'Migrador Gemini', 'unused-in-this-test', '00000000-0000-4000-8000-000000000001')`,
       [actorUserId],
    )
  }, 120_000)

  afterAll(async () => {
    await pool.end()
    await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`)
    await adminPool.end()
  }, 120_000)

  it('parseia o dump MySQL em linhas estruturadas', () => {
    const tables = parseMysqlDump(miniDump)
    const byName = new Map(tables.map((table) => [table.name, table]))
    expect(byName.get('clientes')?.rows).toHaveLength(2)
    expect(byName.get('produtos')?.rows).toHaveLength(3)
    expect(byName.get('vendas')?.rows[0]).toMatchObject({ VendaID: 1, StatusPagamento: 'Pago', ValorPago: 150.0 })
    expect(normalized.products).toHaveLength(3)
    expect(normalized.sales).toHaveLength(4)
    expect(normalized.purchases).toHaveLength(2)
    expect(normalized.customerOrders).toHaveLength(3)
    expect(normalized.sales[1]).toMatchObject({
      legacyId: 2,
      promisedDueDate: '2026-12-20',
      paymentStatus: 'Pendente',
      customer: { legacyId: 2 },
    })
  })

  it('migra produtos, vendas, compras e encomendas com rejeições tipadas e sem linhas parciais', async () => {
    const results = await migrateAll()
    expect(results.products).toMatchObject({ reused: false, counts: { sourceRows: 3, products: 2, acceptedVariants: 3, rejectedRows: 0 } })
    expect(results.sales).toMatchObject({ reused: false, counts: { sourceRows: 4, sales: 3, saleItems: 3, payments: 3, rejectedRows: 1 } })
    expect(results.purchases).toMatchObject({ reused: false, counts: { sourceRows: 2, purchaseOrders: 1, purchaseOrderItems: 2, receipts: 1, receiptItems: 2, rejectedRows: 1 } })
    expect(results.customerOrders).toMatchObject({ reused: false, counts: { sourceRows: 3, customerOrders: 2, events: 2, rejectedRows: 1 } })

    const saleRejections = await pool.query<{ reason_code: string }>(
      `SELECT reason_code FROM migration_rejections WHERE source_table = 'vendas' ORDER BY reason_code`,
    )
    expect(saleRejections.rows.map((row) => row.reason_code)).toEqual(['PENDING_SALE_MISSING_CUSTOMER'])

    const purchaseRejections = await pool.query<{ reason_code: string }>(
      `SELECT reason_code FROM migration_rejections WHERE source_table = 'pedidosfornecedor'`,
    )
    expect(purchaseRejections.rows[0]).toMatchObject({ reason_code: 'LEGACY_SUPPLIER_NAME_MISSING' })

    const orderRejections = await pool.query<{ reason_code: string }>(
      `SELECT reason_code FROM migration_rejections WHERE source_table = 'encomendascliente'`,
    )
    expect(orderRejections.rows[0]).toMatchObject({ reason_code: 'LEGACY_CUSTOMER_NOT_MIGRATED' })

    // Venda parcialmente paga: pagamento de 50.00 confirmado e saldo 100.00.
    const partial = await pool.query<{ status: string; due: string; paid: string }>(
      `SELECT s.status, (s.final_amount - (SELECT coalesce(sum(p.amount), 0) FROM payments p WHERE p.sale_id = s.id AND p.status = 'confirmed'))::text AS due,
              (SELECT p.amount::text FROM payments p WHERE p.sale_id = s.id LIMIT 1) AS paid
       FROM sales s WHERE s.legacy_id = 2`,
    )
    expect(partial.rows[0]).toEqual({ status: 'partially_paid', due: '100.00', paid: '50.00' })

    // Compra parcialmente recebida: 3 de 5 unidades recebidas e 1 recebimento com 2 itens.
    const purchase = await pool.query<{ status: string; receipts: string; receipt_items: string; received: string; ordered: string }>(
      `SELECT po.status,
              (SELECT count(*) FROM goods_receipts gr WHERE gr.purchase_order_id = po.id)::text AS receipts,
              (SELECT count(*) FROM goods_receipt_items gri JOIN goods_receipts gr ON gr.id = gri.goods_receipt_id WHERE gr.purchase_order_id = po.id)::text AS receipt_items,
              (SELECT sum(received_quantity)::text FROM purchase_order_items poi WHERE poi.purchase_order_id = po.id) AS received,
              (SELECT sum(ordered_quantity)::text FROM purchase_order_items poi WHERE poi.purchase_order_id = po.id) AS ordered
       FROM purchase_orders po WHERE po.legacy_id = 2`,
    )
    expect(purchase.rows[0]).toEqual({ status: 'partially_received', receipts: '1', receipt_items: '2', received: '3', ordered: '5' })

    // Encomenda cancelada sem observação recebe motivo padrão (CHECK exige motivo).
    const cancelled = await pool.query<{ cancellation_reason: string }>(
      'SELECT cancellation_reason FROM customer_orders WHERE legacy_id = 2',
    )
    expect(cancelled.rows[0]?.cancellation_reason).toContain('Cancelada no legado')
  })

  it('replay idempotente: mesma fonte responde reused e não duplica linhas', async () => {
    const before = await pool.query<{ sales: string; orders: string; po: string; variants: string }>(
      `SELECT (SELECT count(*) FROM sales)::text AS sales,
              (SELECT count(*) FROM customer_orders)::text AS orders,
              (SELECT count(*) FROM purchase_orders)::text AS po,
              (SELECT count(*) FROM product_variants)::text AS variants`,
    )
    const results = await migrateAll()
    expect(results.products.reused).toBe(true)
    expect(results.sales.reused).toBe(true)
    expect(results.purchases.reused).toBe(true)
    expect(results.customerOrders.reused).toBe(true)
    const after = await pool.query<{ sales: string; orders: string; po: string; variants: string }>(
      `SELECT (SELECT count(*) FROM sales)::text AS sales,
              (SELECT count(*) FROM customer_orders)::text AS orders,
              (SELECT count(*) FROM purchase_orders)::text AS po,
              (SELECT count(*) FROM product_variants)::text AS variants`,
    )
    expect(after.rows[0]).toEqual(before.rows[0])
  })

  it('relatório de reconciliação determinístico com divergências explicadas por rejeições', async () => {
    const report = await buildReconciliationReport(pool, normalized)
    expect(report.products).toMatchObject({ legacyRows: 3, migratedProducts: 2, migratedVariants: 3, rejected: 0 })
    for (const code of ['SALES_REJECTED_TOTAL', 'PAID_STATUS_AUTHORITATIVE', 'RECEIVABLES_REJECTED_TOTAL']) {
      expect(report.knownDivergences.some((line) => line.startsWith(code + ':') && line.endsWith('residual=0.00'))).toBe(true)
    }
    expect(report.stockBySku.matched).toBe(3)
    expect(report.stockBySku.divergent).toEqual([])
    expect(report.sales).toMatchObject({ legacyRows: 4, migratedRows: 3, legacyTotal: '460.00', migratedTotal: '370.00' })
    expect(report.payments).toMatchObject({ legacyPaidTotal: '280.00', migratedPaidTotal: '270.00' })
    expect(report.unitsSold.legacyTotal).toBe(4)
    expect(report.unitsSold.migratedTotal).toBe(3)
    expect(report.unitsSold.divergent.map((row) => row.sku)).toHaveLength(1)
    expect(report.purchases).toMatchObject({ legacyOrders: 2, migratedOrders: 1, receivedUnits: 3, pendingUnits: 2 })
    expect(report.customerOrders).toMatchObject({ legacyRows: 3, migratedOrders: 2 })
    expect(report.images).toEqual({ referenced: 0, linked: 0, pendingFiles: 0 })
    expect(report.knownDivergences.some((line) => line.includes('PENDING_SALE_MISSING_CUSTOMER'))).toBe(true)
    expect(report.knownDivergences.some((line) => line.includes('PAYMENT_INCONSISTENT'))).toBe(false)
    expect(report.knownDivergences.some((line) => line.includes('LEGACY_SUPPLIER_NAME_MISSING'))).toBe(true)
    expect(report.knownDivergences.some((line) => line.includes('LEGACY_CUSTOMER_NOT_MIGRATED'))).toBe(true)

    const replayed = await buildReconciliationReport(pool, normalized)
    expect(replayed).toEqual({ ...report, generatedAt: replayed.generatedAt })
    await pool.query("UPDATE payments SET amount = amount + 1 WHERE id = (SELECT id FROM payments LIMIT 1)")
    const corrupted = await buildReconciliationReport(pool, normalized)
    expect(corrupted.knownDivergences.some((line) => line.startsWith('UNEXPLAINED_PAID_STATUS_AUTHORITATIVE:'))).toBe(true)
  })
})
