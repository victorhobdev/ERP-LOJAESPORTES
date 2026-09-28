package com.sincronizador.infrastructure.local;

import com.sincronizador.application.port.ImagemRepository;
import com.sincronizador.config.PostgresCatalogoConfig;
import com.sincronizador.domain.model.SKU;

import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.regex.Pattern;

/**
 * Repositório somente leitura para as mídias do ERP 2.0.
 * O sincronizador usa o arquivo já persistido pelo storage do novo ERP.
 */
public final class PostgresImagemRepository implements ImagemRepository {

    private static final Pattern STORAGE_KEY = Pattern.compile(
            "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
    );
    private static final String SQL_IMAGENS = """
            SELECT lower(p.club) AS club, lower(p.model) AS model, m.storage_key
            FROM media m
            JOIN products p ON p.id = m.product_id
            WHERE p.active = true AND m.active = true
              AND 1 = (
                  SELECT count(DISTINCT lower(trim(v.type)))
                  FROM product_variants v
                  WHERE v.product_id = p.id AND v.stock_quantity > 0
              )
            ORDER BY m.created_at DESC
            """;

    private final PostgresCatalogoConfig.Conexao conexao;
    private final Path storageDir;
    private Map<String, Path> imagensPorProduto;

    public PostgresImagemRepository() {
        this(PostgresCatalogoConfig.conexao(), PostgresCatalogoConfig.mediaStorageDir());
    }

    public PostgresImagemRepository(PostgresCatalogoConfig.Conexao conexao, Path storageDir) {
        this.conexao = conexao;
        this.storageDir = storageDir.toAbsolutePath().normalize();
    }

    @Override
    public boolean possuiImagem(SKU sku) {
        return obterImagem(sku).isPresent();
    }

    @Override
    public Optional<File> obterImagem(SKU sku) {
        if (sku == null) return Optional.empty();
        carregarImagensSeNecessario();
        Path file = imagensPorProduto.get(chave(sku.getClube(), sku.getModelo()));
        return file == null ? Optional.empty() : Optional.of(file.toFile());
    }

    @Override
    public File salvarAssociacao(SKU sku, File imagemOrigem) {
        throw new UnsupportedOperationException("O repositório de imagens do PostgreSQL é somente leitura.");
    }

    @Override
    public void removerAssociacao(SKU sku) {
        throw new UnsupportedOperationException("O repositório de imagens do PostgreSQL é somente leitura.");
    }

    private synchronized void carregarImagensSeNecessario() {
        if (imagensPorProduto != null) return;
        Map<String, Path> carregadas = new HashMap<>();
        try {
            Class.forName("org.postgresql.Driver");
            try (Connection connection = abrirConexao();
                 PreparedStatement statement = connection.prepareStatement(SQL_IMAGENS);
                 ResultSet resultSet = statement.executeQuery()) {
                while (resultSet.next()) {
                    String storageKey = resultSet.getString("storage_key");
                    if (storageKey == null || !STORAGE_KEY.matcher(storageKey).matches()) continue;
                    Path file = storageDir.resolve(storageKey).normalize();
                    if (!file.startsWith(storageDir) || !Files.isRegularFile(file)) continue;
                    String key = chave(resultSet.getString("club"), resultSet.getString("model"));
                    carregadas.putIfAbsent(key, file);
                }
            }
            imagensPorProduto = carregadas;
        } catch (ClassNotFoundException e) {
            throw new IllegalStateException("Driver JDBC do PostgreSQL não está disponível.", e);
        } catch (Exception e) {
            throw new RuntimeException("Erro ao localizar imagens do ERP 2.0.", e);
        }
    }

    private String chave(String clube, String modelo) {
        return (clube == null ? "" : clube.trim().toLowerCase(Locale.ROOT)) + "|"
                + (modelo == null ? "" : modelo.trim().toLowerCase(Locale.ROOT));
    }

    private Connection abrirConexao() throws Exception {
        if (conexao.user() == null) return DriverManager.getConnection(conexao.jdbcUrl());
        return DriverManager.getConnection(conexao.jdbcUrl(), conexao.user(), conexao.password() == null ? "" : conexao.password());
    }
}
