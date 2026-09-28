package com.sincronizador;

import com.google.api.services.drive.Drive;
import com.sincronizador.application.usecase.AssociarImagemAoCatalogoUseCase;
import com.sincronizador.application.usecase.GerarStatusDoCatalogoUseCase;
import com.sincronizador.application.usecase.SincronizarCatalogoUseCase;
import com.sincronizador.config.CatalogoDataConfig;
import com.sincronizador.config.DriveConfig;
import com.sincronizador.infrastructure.drive.DriveCatalogoReader;
import com.sincronizador.infrastructure.drive.DriveCatalogoWriter;
import com.sincronizador.infrastructure.erp.ErpEstoqueReader;
import com.sincronizador.infrastructure.local.LocalCatalogoWriter;
import com.sincronizador.infrastructure.local.PropertiesImagemRepository;
import com.sincronizador.interfaces.controller.MainController;
import javafx.fxml.FXMLLoader;
import javafx.scene.Parent;

import java.io.InputStream;
import java.nio.file.Path;
import java.util.Properties;

public final class SincronizadorEmbeddedFactory {

    private static final String FXML_MAIN_VIEW = "/interfaces/ui/MainView.fxml";
    private static final String PROPERTIES_PATH = "/app.properties";
    private static final String KEY_FOLDER_ID = "catalogo.folderId";
    private static final Path CATALOGO_LOCAL_DIR = Path.of(
            "C:\\Users\\Vitinho\\Desktop\\Vitinho Artigos Esportivos\\Pronta Entrega"
    );
    private static final Path CATALOGO_DATA_DIR = CatalogoDataConfig.resolverCatalogoDataDir();

    private SincronizadorEmbeddedFactory() {}

    public static Parent criar() {
        try {
            String folderId = carregarFolderIdObrigatorio();
            Drive drive = DriveConfig.criarDrive();

            var estoqueReader = new ErpEstoqueReader();
            var catalogoReader = new DriveCatalogoReader(drive, folderId);
            var catalogoWriter = new DriveCatalogoWriter(drive, folderId);
            var catalogoLocalWriter = new LocalCatalogoWriter(
                    CATALOGO_LOCAL_DIR,
                    CatalogoDataConfig.resolverCatalogoLocalIndexFile()
            );
            var imagemRepo = new PropertiesImagemRepository(CATALOGO_DATA_DIR);

            var gerarStatus = new GerarStatusDoCatalogoUseCase(estoqueReader, catalogoReader);
            var sincronizar = new SincronizarCatalogoUseCase(
                    estoqueReader,
                    catalogoReader,
                    catalogoWriter,
                    imagemRepo,
                    catalogoLocalWriter
            );
            var associarImagem = new AssociarImagemAoCatalogoUseCase(imagemRepo);

            FXMLLoader loader = new FXMLLoader(SincronizadorEmbeddedFactory.class.getResource(FXML_MAIN_VIEW));
            Parent root = loader.load();

            MainController controller = loader.getController();
            controller.setSincronizarCatalogoUseCase(sincronizar);
            controller.setAssociarImagemUseCase(associarImagem);
            controller.setImagemRepository(imagemRepo);
            controller.setGerarStatusUseCase(gerarStatus);

            return root;
        } catch (Exception e) {
            throw new RuntimeException("Falha ao carregar pagina do sincronizador", e);
        }
    }

    private static String carregarFolderIdObrigatorio() {
        Properties props = new Properties();

        try (InputStream in = SincronizadorEmbeddedFactory.class.getResourceAsStream(PROPERTIES_PATH)) {
            if (in == null) {
                throw new IllegalStateException("Arquivo " + PROPERTIES_PATH + " nao encontrado.");
            }
            props.load(in);
        } catch (Exception e) {
            throw new RuntimeException("Falha ao carregar " + PROPERTIES_PATH, e);
        }

        String folderId = props.getProperty(KEY_FOLDER_ID);
        if (folderId == null || folderId.trim().isEmpty() || folderId.contains("COLE_AQUI")) {
            throw new IllegalStateException("Configuracao invalida: " + KEY_FOLDER_ID + " nao esta preenchido.");
        }

        return folderId.trim();
    }

}
