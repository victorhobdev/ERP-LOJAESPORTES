package com.sincronizador.infrastructure.local;

import com.sincronizador.application.port.ImagemRepository;
import com.sincronizador.domain.model.SKU;

import java.io.File;
import java.util.Objects;
import java.util.Optional;

/** Prioriza associações por SKU completo e usa uma origem secundária quando elas não existem. */
public final class ImagemRepositoryComFallback implements ImagemRepository {

    private final ImagemRepository principal;
    private final ImagemRepository fallback;

    public ImagemRepositoryComFallback(ImagemRepository principal, ImagemRepository fallback) {
        this.principal = Objects.requireNonNull(principal);
        this.fallback = Objects.requireNonNull(fallback);
    }

    @Override
    public boolean possuiImagem(SKU sku) {
        return obterImagem(sku).isPresent();
    }

    @Override
    public Optional<File> obterImagem(SKU sku) {
        Optional<File> imagemPrincipal = principal.obterImagem(sku);
        return imagemPrincipal.isPresent() ? imagemPrincipal : fallback.obterImagem(sku);
    }

    @Override
    public File salvarAssociacao(SKU sku, File imagemOrigem) {
        return principal.salvarAssociacao(sku, imagemOrigem);
    }

    @Override
    public void removerAssociacao(SKU sku) {
        principal.removerAssociacao(sku);
    }
}
