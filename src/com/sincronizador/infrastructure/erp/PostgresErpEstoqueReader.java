package com.sincronizador.infrastructure.erp;

import com.sincronizador.application.port.EstoqueReader;
import com.sincronizador.config.PostgresCatalogoConfig;
import com.sincronizador.domain.model.Disponibilidade;
import com.sincronizador.domain.model.Estoque;
import com.sincronizador.domain.model.Produto;
import com.sincronizador.domain.model.SKU;
import com.sincronizador.domain.valueobject.Tamanho;
import com.sincronizador.domain.valueobject.Tipo;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.util.ArrayList;
import java.util.EnumMap;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/** Le estoque positivo do modelo normalizado do ERP 2.0. */
public final class PostgresErpEstoqueReader implements EstoqueReader {

    private static final String SQL_ESTOQUE = """
            SELECT p.club, p.model, v.type, v.size, v.stock_quantity
            FROM product_variants v
            JOIN products p ON p.id = v.product_id
            WHERE p.active = true AND v.stock_quantity > 0
            ORDER BY p.club, p.model, v.type, v.size
            """;

    private final PostgresCatalogoConfig.Conexao conexao;

    public PostgresErpEstoqueReader() {
        this(PostgresCatalogoConfig.conexao());
    }

    public PostgresErpEstoqueReader(PostgresCatalogoConfig.Conexao conexao) {
        this.conexao = conexao;
    }

    @Override
    public List<Disponibilidade> obterDisponibilidades() {
        Map<SKU, Map<Tamanho, Integer>> estoqueAgrupado = new HashMap<>();

        try {
            Class.forName("org.postgresql.Driver");
            try (Connection connection = abrirConexao();
                 PreparedStatement statement = connection.prepareStatement(SQL_ESTOQUE);
                 ResultSet resultSet = statement.executeQuery()) {

                while (resultSet.next()) {
                    String clube = resultSet.getString("club");
                    String modelo = resultSet.getString("model");
                    Tipo tipo = mapearTipo(resultSet.getString("type"));
                    Tamanho tamanho = mapearTamanho(resultSet.getString("size"));
                    int quantidade = resultSet.getInt("stock_quantity");

                    if (quantidade <= 0 || clube == null || modelo == null || tipo == null || tamanho == null) {
                        continue;
                    }

                    SKU sku = new SKU(new Produto(clube, modelo, tipo));
                    estoqueAgrupado
                            .computeIfAbsent(sku, ignored -> new EnumMap<>(Tamanho.class))
                            .merge(tamanho, quantidade, Integer::sum);
                }
            }
        } catch (ClassNotFoundException e) {
            throw new IllegalStateException("Driver JDBC do PostgreSQL não está disponível.", e);
        } catch (Exception e) {
            throw new RuntimeException("Erro ao ler estoque do PostgreSQL do ERP 2.0.", e);
        }

        List<Disponibilidade> disponibilidades = new ArrayList<>();
        for (Map.Entry<SKU, Map<Tamanho, Integer>> entry : estoqueAgrupado.entrySet()) {
            Disponibilidade disponibilidade = Disponibilidade.aPartirDoEstoque(
                    new Estoque(entry.getKey(), entry.getValue())
            );
            if (disponibilidade != null && disponibilidade.estaDisponivel()) {
                disponibilidades.add(disponibilidade);
            }
        }
        return disponibilidades;
    }

    private Connection abrirConexao() throws Exception {
        if (conexao.user() == null) return DriverManager.getConnection(conexao.jdbcUrl());
        return DriverManager.getConnection(conexao.jdbcUrl(), conexao.user(), conexao.password() == null ? "" : conexao.password());
    }

    private Tipo mapearTipo(String valor) {
        if (valor == null) return null;
        return switch (valor.trim().toLowerCase(Locale.ROOT)) {
            case "masculina", "masculino", "m" -> Tipo.MASCULINO;
            case "feminina", "feminino", "f" -> Tipo.FEMININO;
            case "infantil", "i" -> Tipo.INFANTIL;
            default -> null;
        };
    }

    private Tamanho mapearTamanho(String valor) {
        if (valor == null) return null;
        String normalizado = valor.trim().toUpperCase(Locale.ROOT);
        if (normalizado.startsWith("_")) normalizado = normalizado.substring(1);
        try {
            String enumName = !normalizado.isEmpty() && Character.isDigit(normalizado.charAt(0))
                    ? "_" + normalizado
                    : normalizado;
            return Tamanho.valueOf(enumName);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }
}
