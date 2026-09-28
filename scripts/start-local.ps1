$ErrorActionPreference = 'Stop'
$erpRoot = Split-Path $PSScriptRoot -Parent
Set-Location $erpRoot
$env:DATABASE_URL = 'postgresql://postgres@127.0.0.1:55432/erp2_homolog_test'
$env:HOST = '127.0.0.1'
$env:PORT = '3333'
$env:CORS_ORIGINS = 'http://127.0.0.1:5173'
$env:NODE_ENV = 'development'
$env:MEDIA_STORAGE_DIR = Join-Path $erpRoot 'e2e-artifacts/local-media'
New-Item -ItemType Directory -Force -Path $env:MEDIA_STORAGE_DIR | Out-Null
pnpm --dir apps/api exec tsx scripts/prepare-local.ts
if ($LASTEXITCODE -ne 0) { throw 'Falha preparando acesso local. Verifique o PostgreSQL na porta 55432.' }
$erpNode = (Get-Command node).Source
if (-not (Get-NetTCPConnection -State Listen -LocalPort 3333 -ErrorAction SilentlyContinue)) {
  Start-Process -FilePath $erpNode -ArgumentList '--watch --import tsx src/server.ts' -WorkingDirectory (Join-Path $erpRoot 'apps/api') -WindowStyle Hidden -RedirectStandardOutput (Join-Path $erpRoot 'e2e-artifacts/local-api.log') -RedirectStandardError (Join-Path $erpRoot 'e2e-artifacts/local-api.err')
}
if (-not (Get-NetTCPConnection -State Listen -LocalPort 5173 -ErrorAction SilentlyContinue)) {
  Start-Process -FilePath $erpNode -ArgumentList 'node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5173 --strictPort' -WorkingDirectory (Join-Path $erpRoot 'apps/web') -WindowStyle Hidden -RedirectStandardOutput (Join-Path $erpRoot 'e2e-artifacts/local-web.log') -RedirectStandardError (Join-Path $erpRoot 'e2e-artifacts/local-web.err')
}
Write-Output 'Aplicação local: http://127.0.0.1:5173 (base de homologação; não substitui produção).'
