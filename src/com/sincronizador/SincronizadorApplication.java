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
import javafx.application.Application;
import javafx.fxml.FXMLLoader;
import javafx.scene.Parent;
import javafx.scene.Scene;
import javafx.scene.control.Alert;
import javafx.stage.Stage;

import java.io.InputStream;
import java.nio.file.Path;
import java.util.Objects;
import java.util.Properties;

public class SincronizadorApplication extends Application {

    private static final String FXML_MAIN_VIEW = "/interfaces/ui/MainView.fxml";
    private static final String PROPERTIES_PATH = "/app.properties";
    private static final String KEY_FOLDER_ID = "catalogo.folderId";
    private static final Path CATALOGO_LOCAL_DIR = Path.of(
            "C:\\Users\\Vitinho\\Desktop\\Vitinho Artigos Esportivos\\Pronta Entrega"
    );
    private static final Path CATALOGO_DATA_DIR = CatalogoDataConfig.resolverCatalogoDataDir();

    @Override
    public void start(Stage stage) {
        try {
            // 1) Carrega configuração centralizada
            String folderId = carregarFolderIdObrigatorio();

            // 2) Cria client do Drive (OAuth já configurado no DriveConfig)
            Drive drive = DriveConfig.criarDrive();

            // 3) Infra (implementações das portas)
            var estoqueReader = new ErpEstoqueReader();
            var catalogoReader = new DriveCatalogoReader(drive, folderId);
            var catalogoWriter = new DriveCatalogoWriter(drive, folderId);
            var catalogoLocalWriter = new LocalCatalogoWriter(
                    CATALOGO_LOCAL_DIR,
                    CatalogoDataConfig.resolverCatalogoLocalIndexFile()
            );

            // 4) Repositório local de imagem (associação permanente)
            var imagemRepo = new PropertiesImagemRepository(CATALOGO_DATA_DIR);

            // 5) Use cases (regras de aplicação)
            // ✅ aqui é estoqueReader + catalogoReader (não imagemRepo)
            var gerarStatus = new GerarStatusDoCatalogoUseCase(estoqueReader, catalogoReader);

            // ✅ sincronização precisa de ERP + Drive + repo local
            var sincronizar = new SincronizarCatalogoUseCase(
                    estoqueReader,
                    catalogoReader,
                    catalogoWriter,
                    imagemRepo,
                    catalogoLocalWriter
            );

            // ✅ associar imagem salva localmente (não publica no drive diretamente)
            var associarImagem = new AssociarImagemAoCatalogoUseCase(imagemRepo);

            // 6) UI (FXML + Controller)
            FXMLLoader loader = new FXMLLoader(getClass().getResource(FXML_MAIN_VIEW));
            Parent root = loader.load();

            MainController controller = loader.getController();

            // Ordem de injeção:
            controller.setSincronizarCatalogoUseCase(sincronizar);
            controller.setAssociarImagemUseCase(associarImagem);

            // ✅ NOVO: injeta o repo de imagens pro painel lateral (preview)
            controller.setImagemRepository(imagemRepo);

            // Por último, injeta o use case que carrega a tabela
            controller.setGerarStatusUseCase(gerarStatus);

            // 7) Stage
            stage.setTitle("Sincronizador de Catálogo");
            stage.setScene(new Scene(root));
            stage.show();

        } catch (Exception e) {
            e.printStackTrace();
            mostrarErroInicializacao(e);
        }
    }

    private String carregarFolderIdObrigatorio() {
        Properties props = new Properties();

        try (InputStream in = SincronizadorApplication.class.getResourceAsStream(PROPERTIES_PATH)) {
            if (in == null) {
                throw new IllegalStateException(
                        "Arquivo " + PROPERTIES_PATH + " não encontrado. " +
                                "Crie em src/main/resources/app.properties e defina " + KEY_FOLDER_ID + "."
                );
            }
            props.load(in);
        } catch (Exception e) {
            throw new RuntimeException("Falha ao carregar " + PROPERTIES_PATH, e);
        }

        String folderId = props.getProperty(KEY_FOLDER_ID);
        if (folderId == null || folderId.trim().isEmpty() || folderId.contains("COLE_AQUI")) {
            throw new IllegalStateException(
                    "Configuração inválida: " + KEY_FOLDER_ID + " não está preenchido em " + PROPERTIES_PATH + "."
            );
        }

        return folderId.trim();
    }

    private void mostrarErroInicializacao(Exception e) {
        Alert alert = new Alert(Alert.AlertType.ERROR);
        alert.setTitle("Erro ao iniciar");
        alert.setHeaderText("Falha ao iniciar o Sincronizador de Catálogo");
        alert.setContentText(Objects.toString(e.getMessage(), "Erro desconhecido"));
        alert.showAndWait();
    }
}
