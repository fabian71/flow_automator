# Flow Automator

Extensão para Google Chrome que automatiza a geração de **imagens** e **vídeos** no [Google Flow](https://flow.google.com/).
Você cola uma lista de prompts, escolhe modelo e formato, e a extensão gera um por um e baixa cada resultado para uma pasta, com o nome do arquivo baseado no prompt.

> Versão atual: **6.0**, compatível com o Flow novo em `flow.google.com` (setembro/2026).

---

## Sumário

- [O que a extensão faz](#o-que-a-extensão-faz)
- [Requisitos](#requisitos)
- [Instalação](#instalação)
- [Deixar o download automático (importante)](#deixar-o-download-automático-importante)
- [Como usar](#como-usar)
- [Todas as opções do popup](#todas-as-opções-do-popup)
- [Modelos e custo em créditos](#modelos-e-custo-em-créditos)
- [Onde os arquivos são salvos](#onde-os-arquivos-são-salvos)
- [Vídeo a partir de imagem (frame inicial)](#vídeo-a-partir-de-imagem-frame-inicial)
- [Pausa programada](#pausa-programada)
- [Atualizar a extensão](#atualizar-a-extensão)
- [Solução de problemas](#solução-de-problemas)
- [Como funciona por dentro](#como-funciona-por-dentro)
- [Estrutura do projeto](#estrutura-do-projeto)

---

## O que a extensão faz

Para cada prompt da lista, a extensão:

1. Abre o painel de configurações do Flow e seleciona **modo** (imagem/vídeo), **modelo**, **proporção**, **duração**, **qualidade** e quantidade **x1**.
2. (Vídeo com imagens) Envia a imagem como **frame inicial**.
3. Escreve o prompt na caixa de texto e clica em **gerar**.
4. Acompanha o progresso (0% → 100%) e detecta o card novo.
5. Faz o **download** na resolução escolhida (1K/2K/4K para imagem; original, aprimorada ou GIF para vídeo).
6. Renomeia o arquivo (`001_nome_do_prompt.jpg`), salva o prompt em `.txt` (opcional), espera o intervalo configurado e segue para o próximo.

Ela também tenta de novo quando algo falha, faz pausas programadas e mostra um painel de status no canto da página.

---

## Requisitos

- **Google Chrome** (ou outro navegador baseado em Chromium: Edge, Brave, Opera).
- Uma conta Google com acesso ao **Google Flow** e créditos disponíveis.
- Estar logado em `https://flow.google.com/`.

---

## Instalação

A extensão não está na Chrome Web Store, então é instalada no **modo desenvolvedor**:

1. **Baixe o código.**
   - Com Git: `git clone https://github.com/fabian71/flow_automator.git`
   - Ou, no GitHub, clique em **Code → Download ZIP** e extraia para uma pasta (ex.: `C:\extensoes\flow_automator`).
2. Abra o Chrome e acesse **`chrome://extensions`**.
3. Ative o **Modo do desenvolvedor** (chave no canto superior direito).
4. Clique em **Carregar sem compactação** (*Load unpacked*).
5. Selecione a pasta que contém o arquivo `manifest.json`.
6. A extensão **Flow Automator** aparece na lista. Clique no ícone de quebra-cabeça 🧩 da barra do Chrome e **fixe** a extensão para acessar o popup com um clique.

> ⚠️ Não apague nem mova a pasta depois de instalar: o Chrome carrega a extensão direto dela.

### Permissões pedidas

| Permissão | Para quê |
|---|---|
| `flow.google.com`, `flow-content.google` | Controlar a página do Flow e baixar as mídias geradas |
| `downloads` | Baixar e renomear os arquivos |
| `storage` / `unlimitedStorage` | Guardar prompts, configurações e as imagens enviadas |
| `scripting`, `tabs`, `activeTab` | Injetar o script na aba do Flow |
| `debugger` | Fazer o clique "real" no botão de gerar (veja [por quê](#como-funciona-por-dentro)) |

---

## Deixar o download automático (importante)

Para a automação rodar sozinha, o Chrome **não pode perguntar nada** a cada download. Configure estes três pontos:

### 1. Desligar "Perguntar onde salvar"

1. Acesse **`chrome://settings/downloads`**.
2. **Desative** a opção **"Perguntar onde salvar cada arquivo antes de fazer download"**.
3. Em **Local**, confira a pasta padrão (normalmente `Downloads`). Os arquivos vão para uma **subpasta** dentro dela (veja [Onde os arquivos são salvos](#onde-os-arquivos-são-salvos)).

> Se essa opção ficar ligada, a janela "Salvar como" aparece a cada arquivo e a automação trava esperando você.

### 2. Permitir vários downloads no Flow

Na primeira vez que a extensão baixar mais de um arquivo, o Chrome mostra o aviso **"Este site tentou fazer o download de vários arquivos"**. Clique em **Permitir**.

Para já deixar liberado:

1. Acesse **`chrome://settings/content/automaticDownloads`**.
2. Em **"Autorizados a fazer download automático de vários arquivos"**, clique em **Adicionar** e coloque `https://flow.google.com`.

### 3. Marcar "Baixar automaticamente" no popup

No popup da extensão, deixe marcado **Baixar automaticamente**. Com ele desmarcado, a extensão só gera e não baixa nada.

### (Opcional) Esconder a bolha de downloads

A bolha de downloads do Chrome abre a cada arquivo. Para ela não atrapalhar, em `chrome://settings/downloads` desative **"Mostrar downloads quando concluídos"** (se essa opção existir na sua versão).

---

## Como usar

1. Abra **`https://flow.google.com/`** e faça login.
2. Abra um projeto (ou deixe na tela inicial: a extensão clica em **Novo projeto** sozinha).
3. Clique no ícone da extensão para abrir o popup.
4. Escolha o **Modo de geração** (Vídeo ou Imagem) e o **modelo**.
5. Cole os **prompts, um por linha**, de preferência **em inglês**.
6. Ajuste proporção, resolução e pasta (veja as opções abaixo).
7. Clique em **Iniciar Automação**.

Durante a execução:

- Um painel no **canto inferior direito** do Flow mostra o prompt atual, o progresso (`Gerando... 47%`) e o tempo.
- No popup, o botão vira **Parar**. Você pode fechar o popup que a automação continua.
- **Não troque de aba nem minimize** a janela do Flow durante a geração (veja [Solução de problemas](#solução-de-problemas)).
- No final aparece o resumo com quantos deram certo e quantos falharam.

---

## Todas as opções do popup

### Geração

| Opção | Descrição |
|---|---|
| **Modo de Geração** | `Vídeo` ou `Imagem`. |
| **Modelo (Apenas Imagem)** | Nano Banana Pro, Nano Banana 2 ou Nano Banana 2 Lite. |
| **Modelo (Apenas Vídeo)** | Modelo de vídeo usado. O padrão é Veo 3.1 - Lite. |
| **Duração do Vídeo (só Omni)** | 4, 6, 8 ou 10 segundos. Só aparece com o modelo Omni 1.1 Flash; os modelos Veo têm duração fixa (8s). |
| **Qualidade da Geração (só Omni)** | 360p (mais barato) ou 720p. Os modelos Veo geram em 720p. |
| **Upload Imagens (Opcional)** | Só no modo vídeo. Cada imagem vira o **frame inicial** de um vídeo. Veja [Vídeo a partir de imagem](#vídeo-a-partir-de-imagem-frame-inicial). |
| **Prompts (um por linha)** | Lista de prompts. Linhas vazias são ignoradas. O campo **Remover N** apaga os N primeiros prompts (útil para retomar de onde parou). |

### Proporção

| Opção | Descrição |
|---|---|
| **Proporção** | Imagem: 16:9, 4:3, 1:1, 3:4, 9:16. Vídeo: 16:9 ou 9:16. |
| **Randomize Proporção** | Sorteia uma proporção a cada prompt entre as marcadas (mínimo 1). |

### Download

| Opção | Descrição |
|---|---|
| **Baixar automaticamente** | Liga/desliga o download de cada resultado. |
| **Resolução da Imagem** | `1K` (tamanho original) ou `2K` (aprimorada: o Flow faz upscale e baixa sozinho, leva uns 15s a mais). 4K depende do seu plano; se não estiver disponível, a extensão baixa a maior liberada. |
| **Download do Vídeo** | `Tamanho original`, `Aprimorada (upscale, se disponível)` ou `GIF animado (270p)`. Se o upscale não estiver liberado no seu plano, baixa o original. |
| **Salvar prompt em arquivo .txt** | Salva ao lado de cada mídia um `.txt` com o prompt usado, com o mesmo nome. |
| **Nome da Subpasta** | Pasta dentro de `Downloads` onde tudo é salvo. O padrão é `flow_MM_DD` (ex.: `flow_09_30`). |
| **Delay após download (segundos)** | Espera entre um prompt e o próximo. |

### Pausa programada

| Opção | Descrição |
|---|---|
| **A cada N imagens/vídeos** | Depois de N gerações, a automação pausa. |
| **Intervalo de pausa aleatório** | Duração sorteada entre o mínimo e o máximo (em minutos). |

### Configurações Especiais

| Opção | Padrão | Descrição |
|---|---|---|
| **Timeout de geração (segundos)** | 180 | Tempo máximo esperando um resultado. Para vídeos Veo Quality, use 300 ou mais. |
| **Tentativas máximas por prompt** | 2 | Quantas vezes tentar o mesmo prompt se algo falhar. Erros de política de conteúdo ou falta de créditos **não** são repetidos. |

---

## Modelos e custo em créditos

Valores mostrados pelo Flow em setembro/2026, por geração (x1). Podem mudar; o Flow mostra o custo atual no painel de configurações.

### Imagem

| Modelo | Observação |
|---|---|
| Nano Banana Pro | Melhor qualidade |
| Nano Banana 2 | Padrão |
| Nano Banana 2 Lite | **0 créditos**, bom para testes |

### Vídeo

| Modelo | Créditos | Duração | Qualidade |
|---|---|---|---|
| Omni 1.1 Flash | 4 a 15 | 4 / 6 / 8 / 10s | 360p ou 720p |
| Veo 3.1 - Lite | 10 | 8s | 720p |
| Veo 3.1 - Fast | 20 | 8s | 720p |
| Veo 3.1 - Quality | 100 | 8s | 720p |

> Modelos que não existem mais no Flow (Imagen 4, Veo 3.1 Lite "Lower Priority") são convertidos automaticamente: Imagen 4 → Nano Banana 2, Lower Priority → Veo 3.1 - Lite.

---

## Onde os arquivos são salvos

```
Downloads/
└── flow_09_30/                        ← "Nome da Subpasta"
    ├── 001_A_red_apple_on_a_table.jpg
    ├── 001_A_red_apple_on_a_table.txt ← se "Salvar prompt em .txt" estiver marcado
    ├── 002_A_lighthouse_on_a_rocky_coast.jpg
    └── 002_A_lighthouse_on_a_rocky_coast.txt
```

- O número (`001`, `002`...) segue a ordem da lista.
- O nome usa os primeiros 50 caracteres do prompt.
- A extensão do arquivo é a real: `.jpg` para imagens, `.mp4` para vídeos, `.gif` para GIF.
- Se já existir um arquivo com o mesmo nome, o Chrome adiciona `(1)`, `(2)`...

Para salvar em outro disco ou pasta, mude o **Local** padrão em `chrome://settings/downloads`. A subpasta é criada dentro dele.

---

## Vídeo a partir de imagem (frame inicial)

1. Selecione o modo **Vídeo**.
2. Em **Upload Imagens**, clique e escolha uma ou várias imagens.
3. Cole os prompts de movimento (ex.: `slow camera push in, leaves moving in the wind`).

Como funciona:

- **Cada imagem gera um vídeo.** O número de vídeos é o número de **imagens**, não de prompts.
- Os prompts são usados em sequência e **repetidos** se houver menos prompts que imagens. Com um único prompt, ele vale para todas.
- Sem nenhum prompt, é usado um prompt padrão de animação.
- A proporção é detectada pela imagem: mais larga que alta = **16:9**, mais alta que larga = **9:16**.
- Na primeira vez, o Flow mostra o aviso **"Direitos de uso desta imagem"**. A extensão clica em **Concordo** automaticamente. Só envie imagens que você tem direito de usar.

As imagens enviadas ficam salvas no projeto do Flow (aba **Envios**).

---

## Pausa programada

Serve para não gerar tudo de uma vez (e evitar limites do Flow):

1. Marque **⏸️ Pausa programada**.
2. Defina **A cada N** e o intervalo **mínimo/máximo** em minutos.
3. Quando pausar, o painel no Flow mostra a contagem regressiva e um botão **Continuar**. No popup também aparece **Continuar**, para retomar antes do tempo.

---

## Atualizar a extensão

1. Baixe a versão nova (`git pull` ou baixe o ZIP de novo e substitua os arquivos na mesma pasta).
2. Em `chrome://extensions`, clique no botão **↻ Recarregar** da Flow Automator.
3. **Recarregue a aba do Flow** (F5). A aba antiga ainda está com o script da versão anterior.

As configurações e os prompts salvos continuam lá.

---

## Solução de problemas

**Aparece a faixa "Flow Automator começou a depurar este navegador"**
É normal. O Flow só aceita clique de verdade no botão de gerar, e a extensão usa a API de depuração do Chrome para isso. A faixa some sozinha. **Não clique em "Cancelar"** durante a automação: isso cancela o clique.

**Nada acontece ao clicar em Iniciar**
- Confira se a aba ativa é `https://flow.google.com/...`.
- Recarregue a extensão e depois a aba do Flow (F5).
- Veja se você está logado no Flow.

**Abre a janela "Salvar como" a cada arquivo**
Desligue "Perguntar onde salvar cada arquivo" em `chrome://settings/downloads` (veja [Deixar o download automático](#deixar-o-download-automático-importante)).

**Baixa só o primeiro arquivo**
O Chrome bloqueou downloads múltiplos. Libere `https://flow.google.com` em `chrome://settings/content/automaticDownloads`.

**Os arquivos saem com nome errado ou fora da subpasta**
Outra extensão que gerencia downloads (ex.: gerenciadores de download) pode estar interferindo. Desative-a durante o uso.

**"Timeout na geração"**
O Flow demorou mais que o limite. Aumente o **Timeout de geração** (vídeos Veo Quality podem levar vários minutos).

**"Modelo ... não disponível" ou "desabilitado no seu plano"**
O modelo não está liberado na sua conta, ou o Flow mudou o nome. O erro mostra os modelos que estão disponíveis.

**Erros de política ("violat...", "polic...")**
O Flow recusou o prompt ou a imagem. A extensão não repete esses casos, marca como falha e segue para o próximo.

**Travou no meio**
- Não troque de aba nem minimize a janela do Flow: o Chrome desacelera abas em segundo plano. Deixe a janela do Flow visível (pode ficar atrás de outras janelas, mas não minimizada).
- Clique em **Parar**, recarregue a aba e use **Remover N** para tirar os prompts já feitos antes de reiniciar.

**Ver os logs detalhados**
Na aba do Flow, pressione **F12 → Console** e filtre por `Flow Automator`. Os logs do background ficam em `chrome://extensions` → Flow Automator → **service worker**.

---

## Como funciona por dentro

- O Flow (`flow.google.com`) é um app **Angular Material**. A caixa de prompt usa o editor **ProseMirror**. Os menus e painéis abrem em `.cdk-overlay-container`.
- A extensão encontra os controles pelos **ícones** (`crop_16_9`, `videocam`, `download`, `arrow_forward`...) e não pelos textos. Assim funciona com o Flow em português ou em inglês.
- O **botão de gerar ignora cliques simulados** (o site confere `event.isTrusted`). Por isso o `background.js` usa `chrome.debugger` (Chrome DevTools Protocol) para fazer um clique real. As coordenadas do botão são medidas **depois** de conectar o debugger, porque a faixa amarela muda a posição da página.
- O **upload do frame inicial** intercepta o seletor de arquivos da página (sem abrir a janela do Windows) e entrega a imagem direto ao campo `<input type="file">`.
- Cada resultado é identificado pelo **ID da mídia** (`flow-content.google/image/<id>`). Assim a extensão sabe qual card é novo.
- O download usa o próprio menu do Flow (**botão direito → Fazer o download → resolução**). O `background.js` intercepta o arquivo em `chrome.downloads.onDeterminingFilename` e o renomeia para `subpasta/NNN_prompt.ext`.

---

## Estrutura do projeto

```
flow-prompt-automator3/
├── manifest.json        # Manifesto (MV3): permissões, scripts, versão
├── background.js        # Service worker: fila de prompts, pausa, downloads/renomeio,
│                        #   clique real via chrome.debugger, upload de arquivos
├── content/
│   ├── content.js       # Roda na página do Flow: configurações, prompt, geração,
│   │                    #   detecção do resultado, download e painel de status
│   └── content.css      # Estilo do painel de status
├── popup/
│   ├── popup.html       # Interface do popup
│   ├── popup.css
│   └── popup.js         # Configurações, lista de prompts, imagens, iniciar/parar
└── icons/               # Ícones da extensão
```

---

## Aviso

Projeto pessoal, sem vínculo com o Google. O Google Flow pode mudar a interface a qualquer momento e quebrar a automação. Use com moderação, respeite os [termos de uso](https://policies.google.com/terms) e a Política de Uso Proibido de IA Generativa do Google, e só envie imagens que você tem direito de usar.
