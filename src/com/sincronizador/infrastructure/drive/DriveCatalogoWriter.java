package com.sincronizador.infrastructure.drive;

import com.google.api.client.http.FileContent;
import com.google.api.services.drive.Drive;
import com.google.api.services.drive.model.File;
import com.sincronizador.application.port.CatalogoWriter;
import com.sincronizador.domain.model.Disponibilidade;
import com.sincronizador.domain.model.SKU;
import com.sincronizador.domain.service.GeradorDeLegenda;
import com.sincronizador.domain.valueobject.Tamanho;
import java.util.stream.Collectors;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.*;

public class DriveCatalogoWriter implements CatalogoWriter {

    private final Drive drive;
    private final String folderId;

    public DriveCatalogoWriter(Drive drive, String folderId) {
        this.drive = Objects.requireNonNull(drive, "drive não pode ser nulo");
        this.folderId = Objects.requireNonNull(folderId, "folderId não pode ser nulo")
                .trim()
                .replace("\"", "")
                .replace(";", "");
    }

    @Override
    public String criarComImagemLocal(SKU sku, Disponibilidade disponibilidade, java.io.File imagemLocal) {
        Objects.requireNonNull(sku, "sku não pode ser nulo");
        Objects.requireNonNull(disponibilidade, "disponibilidade não pode ser nula");
        validarArquivoImagem(imagemLocal);

        String nome = GeradorDeLegenda.gerarLegenda(disponibilidade);

        File metadata = new File();
        metadata.setName(nome);
        metadata.setParents(Collections.singletonList(folderId));
        // ✅ agora grava também os tamanhos de fábrica (para comparação técnica; nome pode ser por idade)
        metadata.setAppProperties(appPropertiesFromSku(sku, disponibilidade));

        FileContent media = new FileContent(detectarMimeType(imagemLocal), imagemLocal);

        try {
            File created = drive.files()
                    .create(metadata, media)
                    .setFields("id,name,appProperties")
                    .execute();

            return created.getId();
        } catch (IOException e) {
            throw new RuntimeException("Erro ao criar arquivo no Drive para o SKU: " + sku, e);
        }
    }

    @Override
    public boolean atualizarLegenda(String fileId, String novoNome) {
        Objects.requireNonNull(fileId, "fileId não pode ser nulo");
        Objects.requireNonNull(novoNome, "novoNome não pode ser nulo");

        try {
            // ✅ evita "edit" se já estiver igual
            File atual = drive.files().get(fileId).setFields("name").execute();
            return atualizarLegenda(fileId, novoNome, atual.getName());
        } catch (IOException e) {
            throw new RuntimeException("Erro ao renomear arquivo no Drive: " + fileId, e);
        }
    }

    @Override
    public boolean atualizarLegenda(String fileId, String novoNome, String nomeAtual) {
        Objects.requireNonNull(fileId, "fileId não pode ser nulo");
        Objects.requireNonNull(novoNome, "novoNome não pode ser nulo");

        if (novoNome.equals(nomeAtual)) return false;

        File patch = new File();
        patch.setName(novoNome);

        try {
            drive.files()
                    .update(fileId, patch)
                    .setFields("id,name")
                    .execute();

            return true;
        } catch (IOException e) {
            throw new RuntimeException("Erro ao renomear arquivo no Drive: " + fileId, e);
        }
    }

    @Override
    public boolean trocarImagem(String fileId, java.io.File novaImagemLocal) {
        Objects.requireNonNull(fileId, "fileId não pode ser nulo");
        validarArquivoImagem(novaImagemLocal);

        try {
            // ✅ evita upload se conteúdo for o mesmo (md5Checksum)
            File atual = drive.files().get(fileId).setFields("md5Checksum").execute();
            return trocarImagem(fileId, novaImagemLocal, atual.getMd5Checksum());
        } catch (IOException e) {
            throw new RuntimeException("Erro ao substituir conteúdo do arquivo no Drive: " + fileId, e);
        }
    }

    @Override
    public boolean trocarImagem(String fileId, java.io.File novaImagemLocal, String md5Remoto) {
        Objects.requireNonNull(fileId, "fileId não pode ser nulo");
        validarArquivoImagem(novaImagemLocal);

        try {
            if (md5Remoto != null && !md5Remoto.isBlank()) {
                String md5Local = calcularMd5Hex(novaImagemLocal);
                if (md5Remoto.equalsIgnoreCase(md5Local)) {
                    return false; // nada a fazer
                }
            }

            FileContent media = new FileContent(detectarMimeType(novaImagemLocal), novaImagemLocal);

            // Atualiza o conteúdo mantendo id, nome e appProperties (associação fixa)
            drive.files()
                    .update(fileId, null, media)
                    .setFields("id")
                    .execute();

            return true;

        } catch (IOException e) {
            throw new RuntimeException("Erro ao substituir conteúdo do arquivo no Drive: " + fileId, e);
        }
    }

    @Override
    public void remover(String fileId) {
        Objects.requireNonNull(fileId, "fileId não pode ser nulo");

        try {
            drive.files().delete(fileId).execute();
        } catch (IOException e) {
            throw new RuntimeException("Erro ao remover arquivo do Drive: " + fileId, e);
        }
    }

    @Override
    public void vincularSku(String fileId, SKU sku) {
        Objects.requireNonNull(fileId, "fileId não pode ser nulo");
        Objects.requireNonNull(sku, "sku não pode ser nulo");

        // ⚠️ Importante:
        // este método ainda NÃO recebe Disponibilidade, então aqui só garantimos a identidade do SKU.
        // A atualização de tamanhos de fábrica é feita via atualizarTamanhosFabrica(...) durante a sync.
        File patch = new File();
        patch.setAppProperties(appPropertiesFromSku(sku));

        try {
            drive.files()
                    .update(fileId, patch)
                    .setFields("id,appProperties")
                    .execute();
        } catch (IOException e) {
            throw new RuntimeException("Erro ao vincular metadados no arquivo do Drive: " + fileId, e);
        }
    }

    @Override
    public boolean atualizarTamanhosFabrica(String fileId, Disponibilidade disponibilidade) {
        Objects.requireNonNull(fileId, "fileId não pode ser nulo");
        Objects.requireNonNull(disponibilidade, "disponibilidade não pode ser nula");

        try {
            // Lê appProperties atuais para evitar update desnecessário
            File atual = drive.files()
                    .get(fileId)
                    .setFields("appProperties")
                    .execute();

            Map<String, String> propsAtuais = atual.getAppProperties();
            if (propsAtuais == null) propsAtuais = new HashMap<>();

            String novoValor = serializarTamanhosFabrica(disponibilidade.getTamanhosDisponiveis());
            String atualValor = propsAtuais.get(DriveMetadataKeys.SKU_TAMANHOS_FABRICA);

            // ✅ no-op se já estiver igual (reduz chamadas e logs no Drive)
            if (Objects.equals(normalizeCsv(atualValor), normalizeCsv(novoValor))) {
                return false;
            }

            Map<String, String> propsPatch = new HashMap<>(propsAtuais);
            propsPatch.put(DriveMetadataKeys.SKU_TAMANHOS_FABRICA, novoValor);

            File patch = new File();
            patch.setAppProperties(propsPatch);

            drive.files()
                    .update(fileId, patch)
                    .setFields("id,appProperties")
                    .execute();

            return true;

        } catch (IOException e) {
            throw new RuntimeException("Erro ao atualizar metadata de tamanhos de fábrica no Drive: " + fileId, e);
        }
    }

    @Override
    public boolean atualizarTamanhosFabrica(String fileId, Disponibilidade disponibilidade, String tamanhosFabricaAtual) {
        Objects.requireNonNull(fileId, "fileId não pode ser nulo");
        Objects.requireNonNull(disponibilidade, "disponibilidade não pode ser nula");

        String novoValor = serializarTamanhosFabrica(disponibilidade.getTamanhosDisponiveis());
        if (Objects.equals(normalizeCsv(tamanhosFabricaAtual), normalizeCsv(novoValor))) {
            return false;
        }

        return atualizarTamanhosFabrica(fileId, disponibilidade);
    }

    private String normalizeCsv(String csv) {
        if (csv == null) return "";
        String trimmed = csv.trim();
        if (trimmed.isEmpty()) return "";

        // normaliza espaços, ordem e caixa para comparar com estabilidade
        List<String> tokens = Arrays.stream(trimmed.split(","))
                .map(String::trim)
                .filter(s -> !s.isBlank())
                .map(s -> s.toUpperCase(Locale.ROOT))
                .collect(Collectors.toList());

        Collections.sort(tokens);
        return String.join(",", tokens);
    }

    private Map<String, String> appPropertiesFromSku(SKU sku) {
        Map<String, String> props = new HashMap<>();
        props.put(DriveMetadataKeys.SKU_CLUBE, sku.getClube());
        props.put(DriveMetadataKeys.SKU_MODELO, sku.getModelo());
        props.put(DriveMetadataKeys.SKU_TIPO, sku.getTipo().name());
        props.put(DriveMetadataKeys.SKU_KEY,
                (sku.getClube() + "|" + sku.getModelo() + "|" + sku.getTipo().name())
                        .toUpperCase(Locale.ROOT)
        );
        return props;
    }

    /**
     * Versão completa: grava SKU + tamanhos de fábrica (para comparação técnica).
     * - INFANTIL: "18,20,24,28" (sem underscore)
     * - ADULTO: "P,M,G,GG,_2GG..." (mantém enum name)
     */
    private Map<String, String> appPropertiesFromSku(SKU sku, Disponibilidade disponibilidade) {
        Map<String, String> props = appPropertiesFromSku(sku);

        String tamanhosFabrica = serializarTamanhosFabrica(disponibilidade.getTamanhosDisponiveis());
        props.put(DriveMetadataKeys.SKU_TAMANHOS_FABRICA, tamanhosFabrica);

        return props;
    }

    private String serializarTamanhosFabrica(Set<Tamanho> tamanhos) {
        if (tamanhos == null || tamanhos.isEmpty()) return "";

        // Mantém uma ordem estável: ordem natural do enum
        List<Tamanho> lista = new ArrayList<>(tamanhos);
        lista.sort(Comparator.comparingInt(Enum::ordinal));

        List<String> tokens = new ArrayList<>(lista.size());
        for (Tamanho t : lista) {
            String name = t.name();
            // tamanhos numéricos vêm como _18, _20 etc -> salva como 18, 20...
            if (name.startsWith("_")) tokens.add(name.substring(1));
            else tokens.add(name);
        }
        return String.join(",", tokens);
    }

    private void validarArquivoImagem(java.io.File arquivo) {
        Objects.requireNonNull(arquivo, "arquivo não pode ser nulo");
        if (!arquivo.exists() || !arquivo.isFile()) {
            throw new IllegalArgumentException("Arquivo inválido: " + arquivo.getAbsolutePath());
        }
        String n = arquivo.getName().toLowerCase(Locale.ROOT);
        boolean extensaoSuportada = n.endsWith(".jpg") || n.endsWith(".jpeg") || n.endsWith(".png") || n.endsWith(".webp");
        boolean semExtensao = !n.contains(".");
        if (!extensaoSuportada && (!semExtensao || detectarMimeTypePorConteudo(arquivo) == null)) {
            throw new IllegalArgumentException("Imagem deve ser .jpg/.jpeg/.png/.webp: " + arquivo.getName());
        }
    }

    private String detectarMimeType(java.io.File arquivo) {
        try {
            String probed = Files.probeContentType(arquivo.toPath());
            if ("image/jpeg".equals(probed) || "image/png".equals(probed) || "image/webp".equals(probed)) {
                return probed;
            }
        } catch (IOException ignored) {}

        String n = arquivo.getName().toLowerCase(Locale.ROOT);
        if (n.endsWith(".png")) return "image/png";
        if (n.endsWith(".webp")) return "image/webp";
        String porConteudo = detectarMimeTypePorConteudo(arquivo);
        if (porConteudo != null) return porConteudo;
        return "image/jpeg";
    }

    private String detectarMimeTypePorConteudo(java.io.File arquivo) {
        try (InputStream in = Files.newInputStream(arquivo.toPath())) {
            byte[] cabecalho = in.readNBytes(12);
            if (cabecalho.length >= 3
                    && (cabecalho[0] & 0xff) == 0xff
                    && (cabecalho[1] & 0xff) == 0xd8
                    && (cabecalho[2] & 0xff) == 0xff) {
                return "image/jpeg";
            }
            if (cabecalho.length >= 8
                    && (cabecalho[0] & 0xff) == 0x89
                    && cabecalho[1] == 'P' && cabecalho[2] == 'N' && cabecalho[3] == 'G'
                    && (cabecalho[4] & 0xff) == 0x0d && (cabecalho[5] & 0xff) == 0x0a
                    && (cabecalho[6] & 0xff) == 0x1a && (cabecalho[7] & 0xff) == 0x0a) {
                return "image/png";
            }
            if (cabecalho.length >= 12
                    && cabecalho[0] == 'R' && cabecalho[1] == 'I' && cabecalho[2] == 'F' && cabecalho[3] == 'F'
                    && cabecalho[8] == 'W' && cabecalho[9] == 'E' && cabecalho[10] == 'B' && cabecalho[11] == 'P') {
                return "image/webp";
            }
        } catch (IOException ignored) {
            return null;
        }
        return null;
    }

    private String calcularMd5Hex(java.io.File arquivo) {
        try (InputStream in = Files.newInputStream(arquivo.toPath())) {
            MessageDigest md = MessageDigest.getInstance("MD5");
            byte[] buf = new byte[8192];
            int r;
            while ((r = in.read(buf)) > 0) {
                md.update(buf, 0, r);
            }
            byte[] digest = md.digest();
            StringBuilder sb = new StringBuilder(digest.length * 2);
            for (byte b : digest) sb.append(String.format("%02x", b));
            return sb.toString();
        } catch (Exception e) {
            throw new RuntimeException("Erro ao calcular MD5 do arquivo: " + arquivo.getAbsolutePath(), e);
        }
    }
}
