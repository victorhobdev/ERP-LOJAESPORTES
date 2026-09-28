package com.sincronizador.config;

import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.nio.file.Paths;

/**
 * Configuracao da ponte do sincronizador para o ERP 2.0 (PostgreSQL).
 *
 * A fonte antiga continua sendo selecionada pelo fluxo MySQL existente. O
 * modo PostgreSQL so e ativado explicitamente por CATALOG_SYNC_SOURCE=postgres.
 */
public final class PostgresCatalogoConfig {

    private static final String SOURCE_PROPERTY = "sincronizador.catalogo.source";
    private static final String DATABASE_PROPERTY = "sincronizador.postgres.url";
    private static final String USER_PROPERTY = "sincronizador.postgres.user";
    private static final String PASSWORD_PROPERTY = "sincronizador.postgres.password";
    private static final String MEDIA_PROPERTY = "sincronizador.media.storage.dir";

    private PostgresCatalogoConfig() {}

    public static boolean usarPostgres() {
        String source = primeiroConfigurado(System.getProperty(SOURCE_PROPERTY),
                System.getenv("CATALOG_SYNC_SOURCE"));
        return "postgres".equalsIgnoreCase(source) || "postgresql".equalsIgnoreCase(source);
    }

    public static Conexao conexao() {
        String rawUrl = primeiroConfigurado(
                System.getProperty(DATABASE_PROPERTY),
                System.getenv("CATALOG_SYNC_POSTGRES_URL"),
                System.getenv("CATALOG_SYNC_DATABASE_URL"),
                System.getenv("ERP2_DATABASE_URL"),
                System.getenv("DATABASE_URL")
        );
        if (rawUrl == null) {
            throw new IllegalStateException(
                    "Banco PostgreSQL não configurado. Defina CATALOG_SYNC_DATABASE_URL ou DATABASE_URL."
            );
        }

        String normalized = rawUrl.trim();
        if (normalized.startsWith("jdbc:postgresql://")) {
            return new Conexao(normalized,
                    primeiroConfigurado(System.getProperty(USER_PROPERTY), System.getenv("CATALOG_SYNC_POSTGRES_USER")),
                    primeiroConfigurado(System.getProperty(PASSWORD_PROPERTY), System.getenv("CATALOG_SYNC_POSTGRES_PASSWORD")));
        }
        if (!normalized.startsWith("postgresql://") && !normalized.startsWith("postgres://")) {
            throw new IllegalStateException("URL do banco do catálogo deve usar PostgreSQL.");
        }

        URI uri;
        try {
            uri = URI.create(normalized);
        } catch (IllegalArgumentException e) {
            throw new IllegalStateException("URL do banco PostgreSQL inválida.", e);
        }

        String authority = uri.getRawAuthority();
        if (authority == null || authority.isBlank()) {
            throw new IllegalStateException("URL do banco PostgreSQL sem host.");
        }
        int userInfoEnd = authority.lastIndexOf('@');
        String userInfo = userInfoEnd >= 0 ? authority.substring(0, userInfoEnd) : null;
        String hostAuthority = userInfoEnd >= 0 ? authority.substring(userInfoEnd + 1) : authority;
        StringBuilder jdbcUrl = new StringBuilder("jdbc:postgresql://").append(hostAuthority);
        if (uri.getRawPath() != null) jdbcUrl.append(uri.getRawPath());
        if (uri.getRawQuery() != null && !uri.getRawQuery().isBlank()) jdbcUrl.append('?').append(uri.getRawQuery());

        String user = primeiroConfigurado(
                System.getProperty(USER_PROPERTY),
                System.getenv("CATALOG_SYNC_POSTGRES_USER"),
                extrairUsuario(userInfo)
        );
        String password = primeiroConfigurado(
                System.getProperty(PASSWORD_PROPERTY),
                System.getenv("CATALOG_SYNC_POSTGRES_PASSWORD"),
                extrairSenha(userInfo)
        );
        return new Conexao(jdbcUrl.toString(), user, password);
    }

    public static Path mediaStorageDir() {
        String raw = primeiroConfigurado(
                System.getProperty(MEDIA_PROPERTY),
                System.getenv("CATALOG_SYNC_MEDIA_STORAGE_DIR"),
                System.getenv("MEDIA_STORAGE_DIR")
        );
        if (raw == null) {
            throw new IllegalStateException(
                    "Armazenamento de mídia não configurado. Defina CATALOG_SYNC_MEDIA_STORAGE_DIR ou MEDIA_STORAGE_DIR."
            );
        }
        return Paths.get(raw).toAbsolutePath().normalize();
    }

    private static String extrairUsuario(String userInfo) {
        if (userInfo == null || userInfo.isBlank()) return null;
        int separator = userInfo.indexOf(':');
        String rawUser = separator >= 0 ? userInfo.substring(0, separator) : userInfo;
        return decodificar(rawUser);
    }

    private static String extrairSenha(String userInfo) {
        if (userInfo == null || userInfo.isBlank()) return null;
        int separator = userInfo.indexOf(':');
        return separator >= 0 ? decodificar(userInfo.substring(separator + 1)) : null;
    }

    private static String decodificar(String value) {
        return URLDecoder.decode(value, StandardCharsets.UTF_8);
    }

    private static String primeiroConfigurado(String... values) {
        for (String value : values) {
            if (value != null && !value.isBlank()) return value.trim();
        }
        return null;
    }

    public record Conexao(String jdbcUrl, String user, String password) {}
}
