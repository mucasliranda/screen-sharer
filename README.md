# Screen Sharer

Compartilhamento de tela por link, ao vivo. Quem assiste só informa um nome — sem cadastro,
sem instalar nada. Construído sobre [LiveKit](https://livekit.io) (SFU WebRTC, Apache 2.0).

---

## Como rodar

### 1. Dependências

```bash
pnpm install
```

> **Use pnpm, não npm.** As duas ferramentas leem a chave `min-release-age` do `.npmrc` com
> unidades diferentes: o pnpm aceita sufixo e entende `2d` como 2 dias (2880 minutos), enquanto
> o npm espera um número em dias e quebra com `Invalid time value` diante do `2d`. Se o seu
> `~/.npmrc` usa esse formato, `npm install` falha em qualquer projeto — e "corrigir" trocando
> por `2` faria o pnpm passar a entender 2 *minutos*, esvaziando a proteção.

### 2. Servidor de mídia

**Opção A — self-host (recomendado para desenvolvimento):** exige Docker Desktop rodando.

```bash
docker compose up -d
```

**Opção B — LiveKit Cloud:** crie um projeto em [cloud.livekit.io](https://cloud.livekit.io) e
aponte o `.env.local` para ele:

```
NEXT_PUBLIC_LIVEKIT_URL=wss://seu-projeto.livekit.cloud
LIVEKIT_API_KEY=...
LIVEKIT_API_SECRET=...
```

### 3. Aplicação

```bash
pnpm dev
```

Abra <http://localhost:3000>, clique em **Criar transmissão** e envie o link `/r/<slug>`.

---

## Como funciona

```
Host (browser)                       Espectadores (browser)
getDisplayMedia() ──┐                     ┌── só assinam
                    ↓                     ↑
              ┌──────────────────────────────┐
              │      LiveKit SFU (WebRTC)    │
              └──────────────────────────────┘
                    ↑ valida o JWT
              ┌──────────────────────────────┐
              │   Next.js — rotas de API     │
              │   /api/rooms     cria sala   │
              │   /api/token     emite JWT   │
              │   /api/takeover  passa bastão│
              └──────────────────────────────┘
```

### Sem banco de dados

A posse da sala é **derivada, não armazenada**: `hostKey = HMAC-SHA256(slug, ROOM_SECRET)`.
Isso mantém o MVP sem persistência e funciona em serverless com várias instâncias.

O `hostKey` fica no `localStorage` de quem criou a sala e hoje serve apenas para rotular a
tela de entrada ("Sua transmissão"). **Ele não concede mais nenhum privilégio** — desde que
todos podem compartilhar, não há nada que só o criador possa fazer. A plumbing continua no
código porque é o gancho natural para recursos futuros (expulsar, travar a sala, encerrar).

### Nome não é identidade

O nome digitado é apenas rótulo de exibição. A `identity` no LiveKit é um UUID gerado pelo
servidor, então duas pessoas podem se chamar "Lucas" sem colidir nem se passar uma pela outra.
O nome é sanitizado (caracteres de controle removidos, 32 caracteres no máximo).

---

## Qualidade de vídeo

O SFU **não transcodifica** — o espectador recebe exatamente o que a sua máquina codificou.
Por isso as opções de publicação em `src/components/RoomClient.tsx` importam mais que qualquer
configuração do servidor:

**Toda transmissão sai em 1080p (1920×1080) a 3fps, teto de 1,5 Mbps.** É fixo — não há seletor.

| Opção | Valor | Por quê |
|---|---|---|
| `resolution` | `1920×1080 @ 3fps` | Requisito fixo do produto |
| `screenShareEncoding.maxBitrate` | `1,5 Mbps` | Ver derivação abaixo |
| `contentHint` | `'text'` | Sem isso o encoder borra texto para preservar FPS |
| `degradationPreference` | `'maintain-resolution'` | Sob congestionamento derruba FPS, não resolução |
| `videoCodec` + `scalabilityMode` | `vp9` + `L1T3` | **1** camada espacial: a resolução nunca cai. 3 camadas temporais: 3 / 1,5 / 0,75fps |
| `simulcast` | `false` | Simulcast implica camadas em resolução menor — incompatível com "sempre 1080p" |
| `backupCodec` | `true` | Fallback H.264 para quem não decodifica VP9 |

### De onde vem 1,5 Mbps

O preset `h720fps5` do LiveKit usa 800 kbps para 0,92 Mpx, ou seja ~0,87 Mbps por megapixel
em conteúdo de tela a 5fps. 1080p tem 2,07 Mpx → ~1,8 Mbps a 5fps; a 3fps sobra folga, e
fechamos em 1,5.

**O teto é o que de fato limita a banda.** Resolução e fps mudam o que o encoder *quer*
gastar; o `maxBitrate` é o que ele *pode*. Baixar só a resolução não reduz o tráfego de
conteúdo em movimento — apenas melhora a qualidade dentro do mesmo teto. Ajuste em `ENCODING`
no topo de `src/components/RoomClient.tsx` se o conteúdo for mais movimentado que texto.

### Por que L1T3 e não L3T3

Em `LxTy`, o **x é o número de camadas espaciais**. `L3T3` publica três resoluções e deixa o
SFU rebaixar quem estiver com rede ruim — o que violaria o requisito de 1080p. Com `L1T3`
existe uma única resolução; o espectador congestionado perde quadros (até 0,75fps), nunca
nitidez.

O preço disso: **não há degradação suave para redes fracas**. Quem não sustentar ~1,5 Mbps vai
travar em vez de receber uma imagem menor. Em compensação, o piso ficou bem mais baixo do que
os 3 Mbps anteriores, então menos gente cai nessa situação.

### 1080p é um teto, não uma garantia

O navegador não captura mais pixels do que a tela de origem tem — em um monitor 720p você
transmite 720p, independentemente do que foi pedido. A sala mede o que realmente saiu
(`getSettings()`) e mostra um aviso no topo quando fica abaixo de 1080p. Monitores maiores
que 1080p são reduzidos para 1080p na captura.

### Impacto em banda

1,5 Mbps ≈ **0,68 GB por espectador-hora** no pior caso — metade dos 1,35 GB da configuração
anterior (1440p a 5fps). No plano gratuito do LiveKit Cloud (50 GB/mês) isso dá cerca de
**74 espectador-horas**.

Esse número é o **teto**, não a média: ele pressupõe 1,5 Mbps sustentados por uma hora
inteira. Conteúdo de tela é dominado pelo que *muda* — com uma IDE ou planilha praticamente
parada, o encoder produz uma fração disso.

---

## Quem compartilha: modelo de bastão

**Qualquer pessoa na sala pode compartilhar tela**, e só uma por vez. Quando alguém começa,
a transmissão anterior é encerrada automaticamente — o último a clicar fica com a tela.

Todo token sai com `canPublish: true`. A exclusividade é decidida em `/api/takeover`:

1. O novo apresentador publica sua tela normalmente.
2. **Só então** chama `/api/takeover` — assim a sala nunca fica sem imagem no intervalo.
3. O servidor lista os participantes e chama `mutePublishedTrack()` nas telas dos demais.
4. Quem foi derrubado recebe `RoomEvent.TrackMuted`, despublica e vê um aviso com opção de
   retomar.

### Por que no servidor e não entre os clientes

A alternativa seria cada cliente derrubar a própria tela ao ver um `TrackPublished` remoto.
Isso quebra quando duas pessoas clicam ao mesmo tempo: **as duas se derrubam e a sala fica
sem imagem nenhuma**. Com a decisão no servidor, as chamadas são processadas em alguma ordem
definida e a última vence.

### Por que silenciar e não revogar `canPublish`

Revogar a permissão também encerraria a transmissão, mas impediria a pessoa de retomar o
bastão depois sem um token novo. `mutePublishedTrack()` encerra sem tirar o direito.

### Limite conhecido

A exclusividade depende do cliente cooperar: ele recebe o mute e despublica. Um cliente
modificado poderia republicar em seguida. Como o acesso à sala já é "quem tem o link entra",
isso não muda o modelo de ameaça — mas não trate como controle de acesso.

---

## Prévia da própria tela

Quem está transmitindo **não vê a própria tela por padrão**. Exibir a captura dentro da tela
capturada produz o espelho infinito (o famoso "túnel"). No lugar aparece um painel borrado
com o aviso de que a transmissão está no ar, e um botão **Ver minha tela / Ocultar minha
tela** na barra superior alterna quando quiser conferir.

Isso é puramente local: **os espectadores sempre veem a tela normalmente**, independentemente
dessa escolha.

Quando oculto, o `<video>` não é montado — não basta borrar. Um vídeo borrado continua sendo
recapturado e reborrado a cada quadro, o que mantém a recursão (só que embaçada) e faz o
encoder enxergar movimento constante numa transmissão calibrada para 3fps de conteúdo
estático. Sem elemento, não há realimentação.

---

## Limitações conhecidas

- **O repositório contém uma chave de desenvolvimento.** `livekit.yaml` e `.env.example`
  trazem `devkey / secret-de-desenvolvimento-com-32-chars-min` para o `docker compose up`
  funcionar sem configuração. **Troque antes de expor qualquer coisa na internet** — com essa
  chave pública, qualquer um emite tokens válidos para o seu servidor. O `ROOM_SECRET` real
  fica só no `.env.local`, que é ignorado pelo git.
- **`getDisplayMedia` exige HTTPS** (exceto `localhost`). Em produção, TLS é obrigatório.
- **iOS não compartilha tela** — nenhum navegador no iOS suporta a API. Assistir funciona.
- **Áudio do sistema** só é capturado de forma confiável no Chrome/Edge. Firefox e Safari são limitados.
- **Link secreto não é controle de acesso.** Quem tiver o link entra. PIN e expiração ainda não existem.
- **TURN.** O `docker-compose.yml` não sobe coturn; redes corporativas restritivas podem falhar.
  O LiveKit Cloud já inclui TURN.
- **Sem persistência.** Reiniciar o LiveKit derruba as salas ativas.

---

## Próximos passos

- [ ] Chat via data channel (`canPublishData` já está liberado no token)
- [ ] PIN opcional e link com expiração
- [ ] Host expulsar participante / travar a sala
- [ ] Gravação com LiveKit Egress → S3
- [ ] coturn no compose para redes restritivas
- [ ] Indicador de qualidade da conexão por espectador
