$ErrorActionPreference = 'Stop'

# Publica o catálogo do PostgreSQL atual do ERP 2.0 no Google Drive.
# Exemplo:
#   $env:CATALOG_SYNC_DATABASE_URL = 'postgresql://postgres@127.0.0.1:55432/erp2_homolog_test'
#   $env:CATALOG_SYNC_MEDIA_STORAGE_DIR = 'e2e-artifacts/local-media'
#   powershell -ExecutionPolicy Bypass -File scripts/sync-catalog-drive.ps1

$erpRoot = Split-Path $PSScriptRoot -Parent
Set-Location $erpRoot

$databaseUrl = $env:CATALOG_SYNC_DATABASE_URL
if ([string]::IsNullOrWhiteSpace($databaseUrl)) { $databaseUrl = $env:DATABASE_URL }
if ([string]::IsNullOrWhiteSpace($databaseUrl)) {
    throw 'Defina CATALOG_SYNC_DATABASE_URL (ou DATABASE_URL) com o PostgreSQL do ERP 2.0.'
}

$mediaStorageDir = $env:CATALOG_SYNC_MEDIA_STORAGE_DIR
if ([string]::IsNullOrWhiteSpace($mediaStorageDir)) { $mediaStorageDir = $env:MEDIA_STORAGE_DIR }
if ([string]::IsNullOrWhiteSpace($mediaStorageDir)) {
    throw 'Defina CATALOG_SYNC_MEDIA_STORAGE_DIR (ou MEDIA_STORAGE_DIR) com o storage de mídias do ERP 2.0.'
}

$jar = Join-Path $erpRoot 'build/jpackage-input/ERP-2.0.jar'
if (-not (Test-Path -LiteralPath $jar -PathType Leaf)) {
    throw 'ERP-2.0.jar não encontrado em build/jpackage-input. Execute scripts/build-portable.ps1 antes.'
}

$env:CATALOG_SYNC_SOURCE = 'postgres'
$env:CATALOG_SYNC_DATABASE_URL = $databaseUrl
$env:CATALOG_SYNC_MEDIA_STORAGE_DIR = $mediaStorageDir

$jdkBin = 'C:\Program Files\Java\jdk-24\bin'
$classes = Join-Path $erpRoot ('e2e-artifacts/catalog-sync-classes-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $classes -Force | Out-Null

$sourceFiles = @(
    'src/com/sincronizador/config/PostgresCatalogoConfig.java',
    'src/com/sincronizador/infrastructure/erp/PostgresErpEstoqueReader.java',
    'src/com/sincronizador/infrastructure/local/ImagemRepositoryComFallback.java',
    'src/com/sincronizador/infrastructure/local/PostgresImagemRepository.java',
    'src/com/sincronizador/infrastructure/local/PropertiesImagemRepository.java',
    'src/com/sincronizador/infrastructure/drive/DriveCatalogoWriter.java',
    'src/com/sincronizador/cli/SincronizarCatalogoCli.java'
)

$syncExitCode = 0
try {
    & (Join-Path $jdkBin 'javac.exe') -encoding UTF-8 `
        -cp 'lib\*;lib\sincronizador\*;build\jpackage-input\ERP-2.0.jar' `
        -d $classes `
        $sourceFiles
    if ($LASTEXITCODE -ne 0) { throw 'Falha compilando a ponte PostgreSQL do sincronizador.' }

    $runtimeClasspath = "$classes;$jar;lib\*;lib\sincronizador\*"
    & (Join-Path $jdkBin 'java.exe') -cp $runtimeClasspath com.sincronizador.cli.SincronizarCatalogoCli @args
    $syncExitCode = $LASTEXITCODE
    if ($syncExitCode -notin @(0, 2)) { throw "A sincronização terminou com código $syncExitCode." }
} finally {
    if (Test-Path -LiteralPath $classes) {
        Remove-Item -LiteralPath $classes -Recurse -Force
    }
}
if ($syncExitCode -eq 2) { exit 2 }
