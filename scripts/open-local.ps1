$ErrorActionPreference = 'Stop'
$erpRoot = Split-Path $PSScriptRoot -Parent

function Wait-ErpUrl([string]$Url) {
    $erpDeadline = (Get-Date).AddSeconds(60)
    do {
        try {
            $erpResponse = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3
            if ($erpResponse.StatusCode -eq 200) { return }
        } catch {
            Start-Sleep -Seconds 1
        }
    } while ((Get-Date) -lt $erpDeadline)
    throw "O ERP nao respondeu em $Url. Consulte os logs em $erpRoot\e2e-artifacts."
}

try {
    Set-Location -LiteralPath $erpRoot
    Write-Host 'Iniciando ERP Novo...'

    # Inicia o mesmo cluster local usado pelo ERP, inclusive apos reiniciar o PC.
    & wsl.exe -d football-mart-storage -u postgres -e /usr/lib/postgresql/16/bin/pg_ctl status -D /tmp/erp2_pgdata
    if ($LASTEXITCODE -eq 3) {
        & wsl.exe -d football-mart-storage -u postgres -e /usr/lib/postgresql/16/bin/pg_ctl start -D /tmp/erp2_pgdata -l /tmp/erp2_pgdata/startup.log -o '-p 55432 -h 127.0.0.1 -k /tmp' -w -t 60
        if ($LASTEXITCODE -ne 0) { throw 'Nao foi possivel iniciar o banco de dados local.' }
    } elseif ($LASTEXITCODE -ne 0) {
        throw 'Nao foi possivel acessar o banco de dados local no WSL.'
    }

    $erpDatabaseDeadline = (Get-Date).AddSeconds(30)
    while (-not (Get-NetTCPConnection -State Listen -LocalPort 55432 -ErrorAction SilentlyContinue)) {
        if ((Get-Date) -ge $erpDatabaseDeadline) { throw 'O banco de dados nao ficou disponivel na porta 55432.' }
        Start-Sleep -Seconds 1
    }

    & (Join-Path $PSScriptRoot 'start-local.ps1')
    Wait-ErpUrl 'http://127.0.0.1:3333/health/ready'
    Wait-ErpUrl 'http://127.0.0.1:5173/'
    Start-Process 'http://127.0.0.1:5173/'
    Write-Host 'ERP aberto no navegador. Os servicos continuam em segundo plano.'
} catch {
    Write-Host "Nao foi possivel abrir o ERP: $($_.Exception.Message)" -ForegroundColor Red
    Read-Host 'Pressione Enter para fechar'
    exit 1
}
