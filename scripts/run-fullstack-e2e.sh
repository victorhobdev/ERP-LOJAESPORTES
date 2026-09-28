#!/usr/bin/env bash
# Runner oficial das suites E2E full-stack (todas as 9, com seed nova por suite).
#
# Uso:
#   TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55432/erp2_test bash scripts/run-fullstack-e2e.sh
#
# Requisitos:
#   - TEST_DATABASE_URL apontando exclusivamente para um banco de teste/homologacao
#     (os seeds recusam URLs que nao sejam de teste);
#   - ports 3333 (API) e 4173 (preview web) livres; em caso de servidor presado de uma
#     execucao anterior derrubada, encerre-o antes (o Playwright falha rapido se ocupado).
#
# Cada suite roda com E2E_FULLSTACK=1 contra API real + PostgreSQL de teste, e o efeito
# no banco e conferido pelo script verify-* correspondente. Nenhum skip e aceito: a saida
# de cada suite precisa conter "1 passed" e "0 skipped".
set -euo pipefail
cd "$(dirname "$0")/.."

: "${TEST_DATABASE_URL:?TEST_DATABASE_URL obrigatoria (somente banco de teste)}"
export E2E_DATABASE_URL="$TEST_DATABASE_URL"
export E2E_FULLSTACK=1
export E2E_MEDIA_DIR="${E2E_MEDIA_DIR:-$PWD/e2e-artifacts/media}"
export E2E_SYNC_DIR="${E2E_SYNC_DIR:-$PWD/e2e-artifacts/catalog-sync}"
mkdir -p e2e-artifacts

FAILURES=0
PASS_COUNT=0

run_suite() {
  local name="$1" spec="$2" seed="$3" verify="$4"
  echo "=== fullstack: $name (seed $seed) ==="
  if [ -n "$seed" ]; then
    (cd apps/api && E2E_DATABASE_URL="$E2E_DATABASE_URL" node --import tsx "scripts/$seed") > e2e-artifacts/seed-current.json 2> e2e-artifacts/seed-current.err
    if [ -s e2e-artifacts/seed-current.err ]; then
      echo "SEED FAIL ($name)"; cat e2e-artifacts/seed-current.err; FAILURES=$((FAILURES + 1)); return
    fi
    # Exporta cada chave do seed como E2E_<CHAVE_EM_SNAKE_CASE> + aliases SEED_* do relatorio financeiro.
    eval "$(node -e "
      const j = JSON.parse(require('fs').readFileSync('e2e-artifacts/seed-current.json','utf8'))
      const snake = (k) => k.replace(/([a-z0-9])([A-Z])/g, '\$1_\$2').toUpperCase()
      for (const [k, v] of Object.entries(j)) console.log('export E2E_' + snake(k) + '=' + JSON.stringify(String(v)))
      if ('sales' in j) {
        console.log('export E2E_SEED_SALES=' + JSON.stringify(String(j.sales)))
        console.log('export E2E_SEED_PAYMENTS=' + JSON.stringify(String(j.payments)))
        console.log('export E2E_SEED_AUDITS=' + JSON.stringify(String(j.audits)))
      }
    ")"
  fi
  local log="e2e-artifacts/fullstack-$name.log"
  # Nenhum skip é aceito: o Playwright só imprime linha "N skipped" quando N > 0.
  if node node_modules/@playwright/test/cli.js test "tests/e2e/$spec" > "$log" 2>&1 \
    && grep -q " 1 passed" "$log" && ! grep -qE " [0-9]+ skipped" "$log"; then
    echo "PASS ($name)"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo "FAIL ($name)"; tail -30 "$log"; FAILURES=$((FAILURES + 1)); return
  fi
  if [ -n "$verify" ]; then
    if (cd apps/api && E2E_DATABASE_URL="$E2E_DATABASE_URL" node --import tsx "scripts/$verify") > "e2e-artifacts/verify-$name.log" 2>&1; then
      echo "VERIFY PASS ($name): $(tail -1 "e2e-artifacts/verify-$name.log")"
    else
      echo "VERIFY FAIL ($name)"; cat "e2e-artifacts/verify-$name.log"; FAILURES=$((FAILURES + 1))
    fi
  fi
}

run_suite catalog           catalog-fullstack.spec.ts           seed-inventory-e2e.ts       ''
run_suite inventory         inventory-fullstack.spec.ts         seed-inventory-e2e.ts       verify-inventory-e2e.ts
run_suite purchases         purchases-fullstack.spec.ts         seed-purchases-e2e.ts       verify-purchases-e2e.ts
run_suite paid-sale         paid-sale-fullstack.spec.ts         seed-paid-sale-e2e.ts       verify-paid-sale-e2e.ts
run_suite financial-report  financial-report-fullstack.spec.ts  seed-financial-report-e2e.ts verify-financial-report-e2e.ts
run_suite customer-orders   customer-orders-fullstack.spec.ts   seed-customer-orders-e2e.ts verify-customer-orders-e2e.ts
run_suite sale-creation     sale-creation-fullstack.spec.ts     seed-sales-e2e.ts           verify-sale-creation-e2e.ts
run_suite multi-payments    multi-payments-fullstack.spec.ts    seed-sales-e2e.ts           verify-multi-payments-e2e.ts
run_suite sales             sales-fullstack.spec.ts             seed-sales-e2e.ts           verify-sales-e2e.ts

echo "FULLSTACK RESULT: $PASS_COUNT passed / $FAILURES failed of 9"
[ "$FAILURES" -eq 0 ]
