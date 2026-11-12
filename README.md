# Video to ASCII

Converta vídeos e GIFs em arte ASCII animada diretamente no navegador ou em uma janela local com Python.

O projeto não envia arquivos para servidores, não exige conta, não utiliza APIs externas e não emprega inteligência artificial. Todo o processamento acontece no dispositivo do usuário.

## Recursos

- Conversão de MP4, WebM, MOV e GIF compatíveis com o navegador ou OpenCV.
- Renderização em Canvas no site e Pillow na aplicação Python.
- Caracteres clássicos, detalhados, blocos, binário, Braille e conjunto personalizado.
- Cores originais, monocromático, verde-terminal, âmbar e paletas adicionais.
- Controle de densidade, brilho, contraste, gamma, inversão e dithering.
- Estabilização temporal para reduzir cintilação.
- Fundo preto ou branco preservado na exportação web.
- Reprodução, seek e loop no navegador.
- Cache temporário de frames ASCII para reduzir recálculos.
- Entrada de GIF com transparência, frames parciais, descarte e durações individuais.
- Exportação WebM e MP4 quando o navegador oferece um encoder MP4 real.
- Exportação WebM offline com WebCodecs, timestamps explícitos e duração independente da velocidade de conversão.
- Reprodução de áudio opcional no player web e no player Python.
- Preservação opcional do áudio na exportação WebM/MP4, ativada por padrão.
- Player Python minimalista, sem controles, com reprodução automática em loop.
- Exportação Python automática para `public/output/` por meio do FFmpeg.

## Aplicação web

### Requisitos

- Node.js 22 ou mais recente.
- Navegador moderno com Canvas 2D e WebCodecs.

### Instalação

```bash
git clone https://github.com/CaesarKairos/Mp4MediaTo-ASCII.git
cd Mp4MediaTo-ASCII
npm install
```

### Executar localmente

```bash
npm run dev
```

Abra o endereço exibido pelo Vite, arraste um vídeo ou GIF para a página e ajuste a conversão.

### Testes e build

```bash
npm test
npm run build
```

O build estático é criado em `dist/`.

### Exportação no navegador

1. Selecione WebM ou MP4.
2. Escolha a taxa de exportação entre 10, 15, 24, 30 ou 60 FPS.
3. Clique em **Download**.
4. Acompanhe a porcentagem de renderização.
5. Aguarde as etapas **Finalizing file** e **Download ready**.

Taxas maiores produzem mais quadros e movimento mais fluido, mas aumentam proporcionalmente o tempo de processamento. Para equilibrar fluidez e espera, use 30 FPS; para exportar mais rapidamente, use 15 FPS.

A exportação acontece localmente e percorre a duração do vídeo uma vez. O loop do player é suspenso temporariamente e restaurado ao final.

A exportação WebM usa `VideoEncoder` (VP8/VP9) e um muxer WebM local. Cada quadro recebe timestamp e duração derivados de seu índice e do FPS escolhido; o tempo gasto na conversão não altera a duração. O último quadro usa somente a duração restante. Navegadores sem WebCodecs recebem uma mensagem clara e não usam `captureStream()` como fallback.

MP4 web permanece desabilitado neste build porque não há muxer MP4 offline confiável incluído. O programa não usa `MediaRecorder`, não renomeia WebM para `.mp4` e não gera silenciosamente um arquivo com duração incorreta.

O botão **Audio on/off** controla somente o som da prévia. O controle **Include audio**, ativado por padrão quando a origem possui uma faixa, controla o download. Na exportação WebM, o áudio é demuxado localmente, decodificado e convertido para Opus com os timestamps originais; não é capturado em tempo real. Arquivos sem áudio mantêm o controle desabilitado.

`Frame blending` mistura pixels dos frames adjacentes antes da conversão ASCII. Isso suaviza transições, mas pode causar ghosting e não é interpolação perfeita de movimento. A estimativa de FPS da origem é refinada durante a reprodução pelo `requestVideoFrameCallback` quando disponível.

GIF funciona como entrada. A geração de um novo arquivo `.gif` ainda não está conectada; selecione WebM ou MP4 para exportar uma entrada GIF.

### Cache e desempenho

O site prepara frames ASCII antes da primeira reprodução e exibe o progresso dentro do player. A taxa de preparação é ajustada à duração, densidade e memória disponível.

O cache:

- fica somente na RAM;
- usa até 192 MB;
- reutiliza arquivo, instante e configurações idênticas;
- remove primeiro os frames menos usados;
- expira após cinco minutos sem uso;
- permanece disponível por até cinco minutos para reconhecer o mesmo arquivo na mesma aba.

Frames RGB descomprimidos não são armazenados em massa. Isso evita que vídeos grandes consumam gigabytes de memória. Ao retornar para uma configuração já processada durante a mesma sessão, o resultado é recuperado do cache.

## Aplicação Python

### Requisitos

- Python 3.11 ou mais recente.
- NumPy, OpenCV, Pillow e Tkinter.
- FFmpeg para exportação.

### Instalar dependências

```bash
python -m pip install -r requirements.txt
```

### Instalar FFmpeg no Windows

```powershell
winget install Gyan.FFmpeg
```

Feche e abra o terminal novamente. Depois confirme:

```powershell
ffmpeg -version
```

### Preparar o arquivo de entrada

Coloque vídeos ou GIFs pessoais em:

```text
public/input/
```

A pasta é versionada por meio de `.gitkeep`, mas seu conteúdo é ignorado pelo Git. Se houver vários arquivos compatíveis, o programa escolhe um aleatoriamente. Se houver apenas um, ele será utilizado.

### Executar

```bash
python app.py
```

No VS Code, abra `app.py` e use o botão **Run and Debug** (ou pressione `F5`), selecionando **Video to ASCII**. A configuração do projeto executa o próprio `app.py` e mantém os painéis Terminal e Debug Console fechados.

Também é possível indicar um arquivo diretamente:

```powershell
python app.py "C:\Videos\exemplo.mp4"
```

Ou alterar a densidade temporariamente:

```bash
python app.py --columns 180
```

A janela local mostra somente o resultado ASCII e reproduz o arquivo continuamente em loop. Não há botões ou painéis. A exportação inicia automaticamente em segundo plano.

O player local usa exclusivamente `tk.Label` e `ImageTk.PhotoImage` para manter a reprodução visual fluida. O FFplay instalado junto ao FFmpeg reproduz somente a faixa sonora, sem abrir outra janela. O loop reinicia o áudio no timestamp correspondente; fechar a janela encerra explicitamente o processo auxiliar.

Na primeira execução, os quadros de prévia preparados são salvos em `public/cache/`. O cache persistente guarda somente os JPEGs necessários ao player, não uma segunda cópia Full HD de cada frame. Durante a reprodução, uma janela limitada de frames já decodificados é reutilizada para evitar abrir e redimensionar os mesmos JPEGs a cada atualização. A exportação continua em resolução máxima e relê a origem sequencialmente, mantendo apenas os frames adjacentes necessários ao blending na memória.

Ao executar novamente o mesmo arquivo com as mesmas configurações, o aplicativo carrega o cache visual e inicia a reprodução sem refazer a conversão. Alterar o vídeo, densidade, estilo, cores, filtros ou resolução cria automaticamente um cache diferente. Caches das versões antigas não são carregados e podem ser removidos manualmente para recuperar espaço.

O conteúdo de `public/cache/` é pessoal e não é versionado. Ele pode ser apagado manualmente a qualquer momento para liberar espaço; o aplicativo simplesmente fará a preparação novamente.

### Arquivos exportados

Os resultados são gravados em:

```text
public/output/
```

Assim como a pasta de entrada, `public/output/` é mantida no repositório com `.gitkeep`, mas os arquivos gerados são pessoais e não são versionados.

Exemplo:

```text
public/output/exemplo-ascii.mp4
```

Para apagar os arquivos locais de entrada, saída e cache, preservando as pastas e seus arquivos `.gitkeep`, execute:

```powershell
python scripts/clear_media.py
```

### Configuração do `app.py`

As opções ficam no início do arquivo e possuem comentários explicando seu efeito. As principais são:

```python
COLUMNS = 500                  # Densidade máxima de símbolos.
USE_DETAILED_ASCII = True      # Conjunto mais detalhado de caracteres.
USE_ORIGINAL_COLORS = True     # Preserva as cores médias da imagem.
USE_EDGE_DETECTION = True      # Reforça contornos.
USE_TEMPORAL_SMOOTHING = True  # Reduz cintilação.
CUSTOM_BACKGROUND = "#000000"  # Fundo da janela e da exportação.
OUTPUT_FORMAT = "mp4"          # Formato usado pelo FFmpeg.
OUTPUT_WIDTH = 1920            # Largura Full HD do arquivo exportado.
PLAYBACK_FPS = 60              # Frequência visual da janela.
PLAYBACK_AUDIO = True          # Reproduz a faixa sonora na janela.
PLAYBACK_AUDIO_VOLUME = 1.0    # Volume entre 0.0 e 1.0.
DECODED_PREVIEW_FRAMES = 12    # Janela limitada de frames decodificados.
EXPORT_FPS = 60                # Taxa do arquivo, sem mudar a duração.
EXPORT_AUDIO = True            # Inclui áudio na exportação quando disponível.
AUDIO_CODEC = "aac"            # Codec para MP4.
AUDIO_BITRATE = "192k"
USE_FRAME_BLENDING = True      # Amostragem temporal com mistura opcional.
PRESERVE_SOURCE_DURATION = True
```

Ative apenas um estilo de caracteres e um modo de cor por vez. Configurações conflitantes produzem uma mensagem antes do processamento.

## Cloudflare Pages

Use as seguintes opções:

```text
Framework preset: None
Build command: npm run build
Build output directory: dist
Root directory: vazio
Production branch: main
```

A versão do Node está definida em `.node-version`. Pushes para `main` geram deploy automático quando o repositório está conectado ao Cloudflare Pages.

## Como funciona

A imagem é dividida em uma grade de caracteres. A quantidade de linhas considera a proporção real de uma célula monoespaçada:

```text
linhas = colunas × alturaDaImagem / larguraDaImagem × larguraDaCélula / alturaDaCélula
```

A luminância utiliza Rec. 709:

```text
Y = 0,2126R + 0,7152G + 0,0722B
```

Depois, o motor aplica ajustes, bordas, dithering opcional, escolha de glifo, cor média e estabilização temporal. O resultado é renderizado como uma grade de símbolos coloridos.

## Testes

```bash
npm test
python -m pytest -q
```

Os testes cobrem luminância, proporção, quantização, Braille, dithering determinístico, cache, configurações conflitantes e conversão temporal.

## Limitações conhecidas

- O suporte a codecs depende do navegador, OpenCV e FFmpeg instalados.
- A exportação web requer WebCodecs VP8/VP9 e AudioEncoder Opus para incluir som; navegadores sem encoder de áudio ainda podem exportar somente o vídeo. MP4 offline não está incluído.
- O áudio web usa a faixa primária quando um arquivo contém várias faixas.
- A reprodução sonora Python requer FFplay; a exportação continua disponível somente com FFmpeg.
- Saída GIF animada ainda não está disponível no navegador.
- Vídeos muito longos utilizam uma taxa de cache menor para respeitar o limite de memória.
- OpenCV pode normalizar vídeos com timestamps variáveis para o FPS informado pelo contêiner; a versão Python usa CFR quando timestamps individuais não estão disponíveis.
- Correspondência estrutural completa por máscaras de glifos e distâncias OKLab ainda não está implementada em todos os modos.

## Dependências e licenças

O projeto utiliza Vite, TypeScript, Vitest, gifuct-js, gifenc, NumPy, OpenCV, Pillow e pytest. Cada dependência mantém sua licença original.

Courier New não é distribuída com o projeto. O programa utiliza a fonte instalada no sistema e recorre a DejaVu Sans Mono quando necessário.
