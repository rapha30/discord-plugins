# BetterDiscord Plugins

## Overview
Plugins BetterDiscord single-file monolith em vanilla JS. Todos compartilham os mesmos padrões de arquitetura.

## Project Structure
- `GlobalSearch.plugin.js` - Busca global de mensagens (~4900 linhas)
- `ServerActivity.plugin.js` - Metricas de atividade dos servidores (~1260 linhas)
- **BetterDiscord plugins dir:** `C:\Users\rapha\AppData\Roaming\BetterDiscord\plugins\`
- Apos qualquer alteracao, copiar o arquivo para a pasta do BD:
  ```
  cp "GlobalSearch.plugin.js" "$APPDATA/BetterDiscord/plugins/GlobalSearch.plugin.js"
  cp "ServerActivity.plugin.js" "$APPDATA/BetterDiscord/plugins/ServerActivity.plugin.js"
  ```

---

# GlobalSearch

## Architecture
Single class `GlobalSearch` exported via `module.exports`. Sections delimited by `// ==========` comments:

| Section | Description |
|---------|-------------|
| Constructor (top) | Settings, state properties, module refs |
| Logging | File + console logging |
| Lifecycle | `start()`, `stop()` |
| Settings | Load/save via BdApi.Data |
| Discord Modules | `cacheModules()` - GuildStore, ChannelStore, UserStore, NavigationUtils, ChannelActions, etc |
| API | `getToken()`, `discordFetch()` (GET), `discordPost()` (POST), `searchGuild()` |
| Search | `searchMultipleGuilds()`, `searchMultipleChannels()`, `resumeSearch()`, progress/pause/done UI updates |
| DM Search | `getDMChannels()`, `searchChannel()`, DM scope toggle |
| History | Load/save/add/delete/clear history, archive methods, storage size |
| Auto Refresh | Background refresh on window blur |
| Cache | `_resultCache` Map with TTL, `_getCached()`, `_setCache()` |
| CAPTCHA Solver | `_solveCaptcha()`, `_solveCaptchaBrowser()` (HTTP local + Chrome), `_solveCaptchaAPI()` (YesCaptcha/CapSolver/2Captcha) |
| Rate Limit | `_showRateLimitFeedback()`, `_applyRateLimitBackoff()` — backoff adaptativo +500ms/429 (max +5s, decay 30s) |
| Navigation | `goToMessage()`, `openDMWithUser()`, `forwardMessageToDM()` |
| Theme | `_applyTheme()` - dark/light/auto theme support |
| Keybind | Ctrl+Shift+F shortcut |
| UI: Toolbar | Button injection in Discord toolbar |
| UI: Modal | `openSearchModal()` - main UI with search, history, guild selection, results |
| UI: Results | `renderResults()` with view modes, find bar, channel filter |
| Styles | CSS injection via `injectStyles()` |

## Key Patterns
- **Storage:** `BdApi.Data.load/save(pluginName, key)` - keys: `"settings"`, `"history"`, `"archived"`
- **Discord API:** All calls via `discordFetch(url)` (GET) or `discordPost(url, body)` (POST) with user token auth
- **Navigation:** Multiple fallback methods (NavigationUtils > webpack > RouterStore > pushState)
- **UI:** All vanilla DOM manipulation, no frameworks. CSS injected via `BdApi.DOM.addStyle()`
- **Language:** All UI strings in Portuguese (pt-BR)
- **Settings merge gotcha:** `loadSettings()` faz `Object.assign(this.settings, saved)` — settings persistidas **sobrescrevem** o default. Alterar um default no codigo so afeta instalacoes novas/reset. Para usuarios existentes, a mudanca precisa ser feita via UI (que chama `saveSettings()`) ou apagando a chave com `BdApi.Data.delete("GlobalSearch", "settings")` (destrutivo — perde todas as settings)
- **excludeWords filter:** aplicado em `_filterResults()` via `content.toLowerCase().includes(word.toLowerCase())`. Split do input UI e **apenas por virgula**, entao entries com espaco (ex: `"por favor"`) sao preservadas como substring intacta

## Settings
```js
{
    maxResultsPerGuild: 25,
    selectedGuilds: [], // orphan — declarado mas nao usado (todos os checkboxes nascem unchecked)
    blockedGuilds: [],  // IDs de servidores bloqueados (nunca pesquisados, aparecem riscados)
    searchDelay: 450,
    manualDelay: false,
    jitterPct: 25,
    parallelSearches: 4,
    viewMode: "traditional", // compact, traditional, detailed
    excludeWords: ["buy", "compro", "por favor"],
    fuzzyTerms: [],
    autoRefresh: false,
    autoRefreshInterval: 300000,
    autoForwardMessage: true,
    modalWidth: 700,
    modalHeight: 85,
    overlayBlur: 1,
    showImagePreviews: true,
    showHasFilters: true,
    theme: "dark", // dark, light, auto
    cacheMinutes: 10,
    captchaSolver: "browser", // none, browser, yescaptcha, capsolver, 2captcha
    captchaApiKey: "",
    captchaBrowserPath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    captchaExtensionPath: "C:\\ClaudeAIProjects\\...\\extension\\yescaptcha",
    captchaShowBrowser: true
}
```

## Search Result Object Shape
```js
{
    id, content, author, authorId, authorAvatar, timestamp,
    guildId, guildName, guildIcon,
    channelId, channelName,
    attachments: [], embeds: []
}
```

## Development Notes
- Validate syntax after changes: `node -e "try{require('./GlobalSearch.plugin.js')}catch(e){console.log(e.message)}"`
- BetterDiscord hot-reloads when the file in its plugins dir changes
- **Re-injeção BD após update do Discord:** ver seção "BD Injection" abaixo
- History entries store full result objects (can get large). Storage size shown in history header
- Max 50 history entries, 15 displayed. No limit on archived searches
- Pause/resume state lives in memory (`_pausedState`), not persisted to disk

## Features Implemented
- Busca global em todos os servidores ou servidores selecionados
- Blocklist persistente de servidores (botao 🚫 por item, riscado + disabled, respeitada por "Todos" e toggles de pasta)
- Busca em DMs (1:1 e grupos) com toggle Servidores/DMs
- 3 modos de visualizacao: compact, traditional, detailed
- Historico de buscas com delete individual e arquivamento (estrela)
- Indicador de tamanho do storage no header do historico
- Pause/Resume de buscas (em vez de apenas cancelar)
- Botao "Buscar" no view bar: find-in-results com highlight + toggle filtro
- Filtro por canal: incluir um canal especifico ou excluir canais (estado persiste entre re-renders)
- Filtro por tipo de conteudo: imagem, arquivo, link (has= API filters)
- Filtro por autor: from:usuario na query (client-side)
- Click esquerdo: ir para a mensagem no servidor
- Click direito: abrir DM com autor + preparar mensagem no chat (via ComponentDispatch INSERT_TEXT)
- Auto-refresh incremental em background (on blur)
- Botao "Atualizar": refresh incremental com feedback visual (pulse, green/nochange states, toast)
- Suporte a variantes fuzzy e palavras excluidas
- Filtro por periodo (24h, 7d, 30d, etc)
- Agrupamento por servidor (guild folders)
- Preview de imagens inline (thumbnail + lightbox fullscreen, toggle nas settings)
- Exportar resultados (JSON/CSV)
- Navegacao por teclado (setas + Enter nos resultados)
- Cache de resultados com TTL configuravel
- Tema claro/escuro/auto
- Rate limit feedback visual (banner + toast)
- Chunked rendering para grandes quantidades de resultados
- Modal width/height/blur configuraveis
- Delay manual (base + jitter %) ou automatico (450ms, 25% jitter up)
- Max 5 retries em 202/429 (evita loop infinito)
- Token caching (1 min TTL)
- Log path dinamico (BdApi.Plugins.folder)
- Settings unificado no modal (BD panel redireciona)
- CAPTCHA auto-solve: modo browser (Chrome + extensão YesCaptcha) ou API (YesCaptcha/CapSolver/2Captcha)
- Backoff adaptativo em rate limits (+500ms por 429, max +5s, decay automático 30s)
- Toggle de visibilidade do browser ao resolver CAPTCHA

---

# ServerActivity

## Architecture
Single class `ServerActivity` exported via `module.exports`. Same section pattern as GlobalSearch (`// ==========`):

| Section | Description |
|---------|-------------|
| Constructor | Settings, state, module refs |
| Logging | File + console logging |
| Lifecycle | `start()`, `stop()` |
| Settings | Load/save/getSettingsPanel (threshold days, column visibility) |
| Discord Modules | `cacheModules()` - GuildStore, ChannelStore, GuildChannelStore, GuildMemberCountStore, ReadStateStore, GuildMemberStore, SortedGuildStore, UserStore, TokenModule, NavigationUtils |
| Guild Folders | `getGuildFolders()` via SortedGuildStore |
| Snowflake Utils | `snowflakeToTimestamp()`, `timestampToAge()`, `getActivityColor()` |
| Data Collection | `collectServerData()` - core logic, zero API calls |
| Server Actions | `getToken()`, `leaveServer()`, `goToServer()` |
| UI: Toolbar | Button injection (bar chart icon) |
| UI: Modal | `openModal()` - header, controls, table, footer |
| UI: Table | `_getColumns()`, `_buildTableHeader()`, `_getFilteredData()`, `renderTable()` |
| UI: Confirmacao | `showLeaveConfirmation()` |
| Helpers | `_formatNumber()` |
| Styles | CSS injection via `injectStyles()` |

## Key Design: Zero API Calls for Metrics
All data from in-memory webpack stores — no HTTP requests, no rate limits:
- **Last activity**: `ChannelStore.getChannel(id).lastMessageId` → snowflake → `BigInt(id) >> 22n + 1420070400000` → timestamp
- **Member counts**: `GuildMemberCountStore.getMemberCount(id)` / `.getOnlineCount(id)`
- **Unread/mentions**: `ReadStateStore.hasUnread(chId)` / `.getMentionCount(chId)`
- **Guild folders**: `SortedGuildStore.getGuildFolders()` → filter by `folderId` + `guildIds.length > 1`
- Only API call: `DELETE /users/@me/guilds/{id}` for leaving a server (with confirmation dialog)

## Settings
```js
{
    greenThresholdDays: 7,
    yellowThresholdDays: 30,
    columns: { lastActivity, onlineRatio, unreadChannels, mentionCount, channelCount, memberCount, serverAge, myRole },
    sortBy: "lastActivity",
    sortAsc: true,
    autoCollect: true
}
```

## Server Data Object Shape
```js
{
    id, name, icon, ownerId, isOwner,
    lastActivityMs, lastActiveChannel,
    memberCount, onlineCount, onlineRatio,
    unreadChannels, totalMentions,
    channelCount, serverCreatedMs, myRole
}
```

## Features Implemented
- Tabela com 9 colunas sortaveis (servidor, ult. atividade, online %, nao lidos, mencoes, canais, membros, criado em, meu cargo)
- Cores de saude: verde (< N dias), amarelo (N-M dias), vermelho (> M dias) — configuravel
- 7 filtros de atividade: todos, esconder ativos, so mortos >30d/90d, com nao lidos, com mencoes
- Filtro por pasta de servidores (guild folders) + opcao "sem pasta"
- Botao "Sair" por servidor com dialog de confirmacao (desabilitado se dono)
- Click no nome do servidor → navega ate ele
- Settings panel com thresholds e checkboxes de colunas
- CSS namespace `sa-` (sem conflito com GlobalSearch `gs-`)

## Development Notes
- Validate: `node -e "try{require('./ServerActivity.plugin.js')}catch(e){console.log(e.message)}"`
- Data collection is synchronous (~50ms for 100 servers) — all in-memory stores

---

---

## Distribution & Auto-Update

### GitHub Repo
- **Repo:** https://github.com/rapha30/discord-plugins (publico, nao listado — sem topicos, sem descricao)
- **Branch:** `master`
- **Estrutura:** `GlobalSearch.plugin.js`, `ServerActivity.plugin.js`, `README.md`

### Meta Headers para Auto-Update
Ambos os plugins tem no header JSDoc:
```js
 * @version 1.0.0
 * @source https://github.com/rapha30/discord-plugins
 * @updateUrl https://raw.githubusercontent.com/rapha30/discord-plugins/master/NOME.plugin.js
```
- `@updateUrl` aponta para `raw.githubusercontent.com` (URL publica sem auth)
- `@version` e comparada pelo BD — **incrementar a cada release** (ex: 1.0.0 → 1.0.1)
- Sem incremento de versao, o BD nao detecta update

### Workflow de Release
1. Editar plugin localmente
2. Incrementar `@version` no header
3. `git add` + `git commit` + `git push` no repo discord-plugins
4. Amigos recebem auto-update na proxima verificacao do BD

### Nota sobre Source Code
Plugins BD sao arquivos `.js` executados diretamente — nao existe compilacao. Destinatarios sempre tem acesso ao source code localmente independente do metodo de distribuicao. Repo publico necessario para `@updateUrl` funcionar sem token.

---

## Changelog
- **2026-02-23** — Filtro de canal persiste ao fechar/reabrir modal; progresso visivel no "Atualizar"; bugfixes (forward sem titulo, dropdown visivel)
- **2026-02-23** — Filtro de canal salvo no historico (restaura ao clicar em entry); reset de filtros ao iniciar nova busca
- **2026-02-26** — Novo plugin ServerActivity: metricas de atividade dos servidores, tabela sortavel, filtros, leave server, filtro por pasta
- **2026-02-26** — Distribuicao via GitHub: repo discord-plugins, @updateUrl + @source nos headers, README com instrucoes
- **2026-03-13** — Busca em DMs (toggle Servidores/DMs), filtros has= (imagem/arquivo/link), from:usuario, preview de imagens com lightbox, exportar JSON/CSV, navegacao por teclado, cache de resultados, tema claro/escuro/auto, rate limit feedback, chunked rendering, modal size/blur configuraveis, delay manual, max retries, token cache, log path dinamico, settings unificado, bugfixes (event listener leaks, double toast, XSS em URLs, infinite retry loop, _isSearching race)
- **2026-03-15** — CAPTCHA auto-solve (browser + YesCaptcha extensao ou API), backoff adaptativo em rate limits, banner unico de rate limit com contador, CSS fix selects (options legiveis), cleanup no stop() (cache/token/captcha server), user-data-dir separado pro Chrome captcha
- **2026-04-12** — v1.0.2: default `excludeWords` agora inclui `"por favor"`; blocklist persistente de servidores (`blockedGuilds`) com botao 🚫 por item, visual riscado + disabled, respeitada por "Todos" e toggles de pasta

## BD Injection
Quando o Discord atualiza, ele substitui o `index.js` do core e remove a injeção do BD.

**Caminho do core** (varia com a versão):
```
C:\Users\rapha\AppData\Local\Discord\app-{VERSION}\modules\discord_desktop_core-1\discord_desktop_core\index.js
```

**Verificar versão atual:**
```bash
ls "C:/Users/rapha/AppData/Local/Discord/" | grep app-
```

**index.js original (sem BD):**
```js
module.exports = require('./core.asar');
```

**index.js com BD injetado:**
```js
require("C:\\Users\\rapha\\AppData\\Roaming\\BetterDiscord\\data\\betterdiscord.asar");
module.exports = require('./core.asar');
```

**Procedimento completo:**
1. Verificar versão do Discord em `AppData/Local/Discord/`
2. Ler o `index.js` — se só tem `require('./core.asar')`, BD não está injetado
3. Adicionar a linha `require(...)` do asar **antes** do `module.exports`
4. Copiar plugins atualizados para `AppData/Roaming/BetterDiscord/plugins/`
5. Reiniciar Discord: `taskkill //IM Discord.exe //F` + reabrir via `Update.exe --processStart Discord.exe`

**Nota:** O instalador em `C:\Users\rapha\Downloads\BetterDiscord-Windows.exe` também resolve, mas a injeção manual é mais rápida.

---

## Comando "-att"
Consolidar conhecimento da conversa na documentação:
1. **Ler primeiro**: CLAUDE.md, MEMORY.md e topic files relevantes antes de escrever
2. **Classificar** cada info nova:
   - `CLAUDE.md` → arquitetura, estrutura, fluxos, convenções, workflows
   - `MEMORY.md` → gotchas, preferências, padrões NÃO cobertos no CLAUDE.md (max ~200 linhas)
   - `memory/*.md` → detalhes extensos por tema. Linkar do MEMORY.md se topic novo
3. **Aplicar**: inserir nas seções existentes (preferir Edit). Criar topic file só se necessário
4. **Deduplicar**: remover entradas obsoletas ou que subiram de nível entre arquivos
5. **Não salvar**: estado temporário da sessão, tarefas em andamento, conclusões não verificadas
