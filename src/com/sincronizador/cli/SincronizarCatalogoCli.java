package com.sincronizador.cli;

import com.google.api.services.drive.Drive;
import com.sincronizador.application.dto.ProdutoCatalogoStatusDTO;
import com.sincronizador.application.dto.ResultadoSincronizacaoDTO;
import com.sincronizador.application.usecase.GerarStatusDoCatalogoUseCase;
import com.sincronizador.application.usecase.SincronizarCatalogoUseCase;
import com.sincronizador.config.CatalogoDataConfig;
import com.sincronizador.config.DriveConfig;
import com.sincronizador.config.PostgresCatalogoConfig;
import com.sincronizador.infrastructure.drive.DriveCatalogoReader;
import com.sincronizador.infrastructure.drive.DriveCatalogoWriter;
import com.sincronizador.infrastructure.erp.PostgresErpEstoqueReader;
import com.sincronizador.infrastructure.local.ImagemRepositoryComFallback;
import com.sincronizador.infrastructure.local.LocalCatalogoWriter;
import com.sincronizador.infrastructure.local.PostgresImagemRepository;
import com.sincronizador.infrastructure.local.PropertiesImagemRepository;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.Base64;
import java.util.Properties;

/** Publica no Drive e mantém a cópia local do catálogo do ERP 2.0 atual. */
public final class SincronizarCatalogoCli {

    private static final String PROPERTIES_PATH = "/app.properties";
    private static final String KEY_FOLDER_ID = "catalogo.folderId";
    private static final Path CATALOGO_LOCAL_DIR = Path.of(
            "C:\\Users\\Vitinho\\Desktop\\Vitinho Artigos Esportivos\\Pronta Entrega"
    );

    private SincronizarCatalogoCli() {}

    public static void main(String[] args) {
        if (!PostgresCatalogoConfig.usarPostgres()) {
            throw new IllegalStateException("Defina CATALOG_SYNC_SOURCE=postgres para usar o ERP 2.0 atual.");
        }

        String folderId = carregarFolderIdObrigatorio();
        Drive drive = DriveConfig.criarDrive();
        var estoqueReader = new PostgresErpEstoqueReader();
        var catalogoReader = new DriveCatalogoReader(drive, folderId);
        var catalogoWriter = new DriveCatalogoWriter(drive, folderId);
        var imagemRepository = new ImagemRepositoryComFallback(
                new PropertiesImagemRepository(),
                new PostgresImagemRepository()
        );
        var catalogoLocalWriter = new LocalCatalogoWriter(
                CATALOGO_LOCAL_DIR,
                CatalogoDataConfig.resolverCatalogoLocalIndexFile()
        );

        if (Arrays.asList(args).contains("--preview")) {
            var itens = new GerarStatusDoCatalogoUseCase(estoqueReader, catalogoReader).executar();
            for (ProdutoCatalogoStatusDTO item : itens) {
                var sku = item.getSku();
                String clube = sku == null || sku.getClube() == null ? "" : sku.getClube();
                String modelo = sku == null || sku.getModelo() == null ? "" : sku.getModelo();
                String tipo = sku == null || sku.getTipo() == null ? "" : sku.getTipo().name();
                boolean temImagemLocal = sku != null && imagemRepository.obterImagem(sku).isPresent();
                System.out.printf(
                        "catalog_preview_item status=%s has_local_image=%s club_b64=%s model_b64=%s type_b64=%s name_b64=%s sizes_b64=%s%n",
                        item.getEstado().name(),
                        temImagemLocal,
                        encode(clube),
                        encode(modelo),
                        encode(tipo),
                        encode(item.getNomeProduto()),
                        encode(item.getTamanhosResumo())
                );
            }
            System.out.printf("catalog_preview_done count=%d%n", itens.size());
            return;
        }

        ResultadoSincronizacaoDTO resultado = new SincronizarCatalogoUseCase(
                estoqueReader,
                catalogoReader,
                catalogoWriter,
                imagemRepository,
                catalogoLocalWriter
        ).executar((atual, total, mensagem) -> {
            System.out.printf(
                    "catalog_progress current=%d total=%d message_b64=%s%n",
                    atual,
                    total,
                    encode(mensagem)
            );
            System.out.flush();
        });

        System.out.printf(
                "catalog_sync source=postgres created=%d updated=%d removed=%d pending_without_image=%d errors=%d%n",
                resultado.getCriados(),
                resultado.getAtualizados(),
                resultado.getRemovidos(),
                resultado.getPendentesCriacaoSemimagem(),
                resultado.getErros().size()
        );
        resultado.getErros().forEach(error -> System.err.println("catalog_sync_error=" + error));
        if (resultado.temErros()) System.exit(2);
    }

    private static String encode(String value) {
        String safe = value == null ? "" : value;
        return Base64.getUrlEncoder().withoutPadding()
                .encodeToString(safe.getBytes(StandardCharsets.UTF_8));
    }

    private static String carregarFolderIdObrigatorio() {
        Properties props = new Properties();
        try (InputStream in = SincronizarCatalogoCli.class.getResourceAsStream(PROPERTIES_PATH)) {
            if (in == null) throw new IllegalStateException("Arquivo " + PROPERTIES_PATH + " não encontrado.");
            props.load(in);
        } catch (Exception e) {
            throw new RuntimeException("Falha ao carregar " + PROPERTIES_PATH, e);
        }

        String folderId = props.getProperty(KEY_FOLDER_ID);
        if (folderId == null || folderId.isBlank() || folderId.contains("COLE_AQUI")) {
            throw new IllegalStateException("Configuração inválida: " + KEY_FOLDER_ID + " não está preenchido.");
        }
        return folderId.trim();
    }
}
