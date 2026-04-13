/**
 * @name GlobalSearch
 * @author Rapha
 * @description Busca mensagens em todos os servidores (ou servidores selecionados) de uma vez. Resultados ordenados do mais recente ao mais antigo.
 * @version 1.0.4
 * @source https://github.com/rapha30/discord-plugins
 * @updateUrl https://raw.githubusercontent.com/rapha30/discord-plugins/master/GlobalSearch.plugin.js
 */

module.exports = class GlobalSearch {
    constructor(meta) {
        this.meta = meta;
        this.settings = {
            maxResultsPerGuild: 25,
            selectedGuilds: [],
            blockedGuilds: [],
            searchDelay: 450,
            manualDelay: false,
            jitterPct: 25,
            parallelSearches: 4,
            viewMode: "traditional", // compact, traditional, detailed
            excludeWords: ["buy", "compro", "por favor"],
            fuzzyTerms: [],
            autoRefresh: false,
            autoRefreshInterval: 300000, // 5 min default
            autoForwardMessage: true,
            modalWidth: 700,
            modalHeight: 85,
            overlayBlur: 1,
            showImagePreviews: true,
            showHasFilters: true,
            theme: "dark",
            cacheMinutes: 10,
            // CAPTCHA: delegado ao plugin CaptchaSolver (separado)
        };
        this.styleId = "global-search-styles";
        this.buttonId = "global-search-btn";
        this.modules = {};
        this.observer = null;
        this._keyHandler = null;
        this._blurHandler = null;
        // Background search state
        this._lastResults = null;
        this._lastQuery = "";
        this._isSearching = false;
        this._searchProgress = null;
        // Search history
        this._searchHistory = [];
        // Archived searches
        this._archivedSearches = [];
        // Pause/resume state
        this._isPaused = false;
        this._pausedState = null;
        // Channel filter state (persists across re-renders)
        this._activeChannelFilter = null;
        this._excludedChannels = new Set();
        // Search scope toggles
        this._searchServers = true;
        this._searchDMs = false;
        this._dmChannels = [];
        // Has filters (attachments/embeds/links)
        this._hasFilters = { image: false, file: false, link: false };
        // Author filter
        this._authorFilter = null;
        // Result cache
        this._resultCache = new Map();
        // Keyboard navigation
        this._focusedResultIndex = -1;
        // Rate limit toast flag
        this._rateLimitToastShown = false;
    }

    // ========== LOGGING ==========

    _initLog() {
        try {
            this._fs = require("fs");
            const path = require("path");
            this._logPath = path.join(BdApi.Plugins.folder, "GlobalSearch.log");
            this._fs.writeFileSync(this._logPath, `[GlobalSearch] Log iniciado: ${new Date().toISOString()}\n`);
        } catch (e) {
            console.error("[GlobalSearch] Nao conseguiu iniciar log:", e);
            this._fs = null;
        }
    }

    log(msg) {
        const line = `[${new Date().toLocaleTimeString("pt-BR")}] ${msg}`;
        console.log(`[GlobalSearch] ${msg}`);
        if (this._fs) {
            try { this._fs.appendFileSync(this._logPath, line + "\n"); } catch {}
        }
    }

    // ========== LIFECYCLE ==========

    start() {
        this._initLog();
        try {
            this.loadSettings();
            this.log("Settings carregadas");
            this.cacheModules();
            this.log("Modules cacheados");
            this.injectStyles();
            this.log("Styles injetados");
            this.injectButton();
            this.log("Button injetado");
            this.setupObserver();
            this.setupKeybind();
            this.loadHistory();
            this.loadArchived();
            this.setupAutoRefresh();
            this._checkCaptchaSolver();
            this.log("Plugin ativado com sucesso!");
            BdApi.UI.showToast("GlobalSearch ativado! Use Ctrl+Shift+F para buscar.", { type: "success" });
        } catch (e) {
            this.log(`ERRO no start(): ${e.message}\n${e.stack}`);
        }
    }

    stop() {
        this._cancelSearch = true;
        this._isSearching = false;
        this._isPaused = false;
        this._pausedState = null;
        this._resultCache.clear();
        this._cachedToken = null;
        this.removeButton();
        this.removeSearchbarButton();
        this.removeStyles();
        this.removeKeybind();
        this.removeAutoRefresh();
        if (this._closeModal) this._closeModal();
        else {
            const overlay = document.querySelector(".gs-modal-overlay");
            if (overlay) overlay.remove();
        }
        if (this._modalKeyHandler) {
            document.removeEventListener("keydown", this._modalKeyHandler);
            this._modalKeyHandler = null;
        }
        if (this.observer) {
            this.observer.disconnect();
            this.observer = null;
        }
        BdApi.UI.showToast("GlobalSearch desativado!", { type: "info" });
    }

    // ========== SETTINGS ==========

    loadSettings() {
        const saved = BdApi.Data.load(this.meta.name, "settings");
        if (saved) this.settings = Object.assign(this.settings, saved);
    }

    saveSettings() {
        BdApi.Data.save(this.meta.name, "settings", this.settings);
    }

    getSettingsPanel() {
        const panel = document.createElement("div");
        panel.style.cssText = "padding:20px;color:var(--text-normal);text-align:center;";
        const msg = document.createElement("p");
        msg.style.cssText = "color:var(--text-muted);margin-bottom:16px;";
        msg.textContent = "As configuracoes completas estao disponiveis no modal de busca.";
        const btn = document.createElement("button");
        btn.textContent = "Abrir Busca Global (ou Ctrl+Shift+F)";
        btn.style.cssText = "padding:10px 20px;border-radius:8px;border:none;background:#0a84ff;color:#fff;font-size:14px;font-weight:600;cursor:pointer;";
        btn.addEventListener("click", () => this.openSearchModal());
        panel.append(msg, btn);
        return panel;
    }

    // ========== DISCORD MODULES ==========

    cacheModules() {
        this.modules.GuildStore = BdApi.Webpack.getStore("GuildStore");
        this.modules.ChannelStore = BdApi.Webpack.getStore("ChannelStore");
        this.modules.UserStore = BdApi.Webpack.getStore("UserStore");
        this.modules.SelectedGuildStore = BdApi.Webpack.getStore("SelectedGuildStore");

        // Token module
        this.modules.TokenModule = BdApi.Webpack.getModule(m => m?.getToken && m?.getEmail, { searchExports: false })
            || BdApi.Webpack.getByKeys("getToken", "getEmail");

        // Guild folders store
        this.modules.SortedGuildStore = BdApi.Webpack.getStore("SortedGuildStore");

        // Private channels (DMs) store
        this.modules.PrivateChannelSortedStore = BdApi.Webpack.getStore("PrivateChannelSortedStore");

        // Navigation module to jump to messages
        this.modules.NavigationUtils = BdApi.Webpack.getByKeys("transitionTo", "transitionToGuild");

        // Message jump module — selectChannel + focusMessage
        this.modules.ChannelActions = BdApi.Webpack.getByKeys("selectChannel", "selectPrivateChannel")
            || BdApi.Webpack.getByKeys("selectChannel");
        this.modules.MessageActions = BdApi.Webpack.getByKeys("jumpToMessage", "fetchMessages")
            || BdApi.Webpack.getByKeys("jumpToMessage");

        this.log(`Modules: GuildStore=${!!this.modules.GuildStore} ChannelStore=${!!this.modules.ChannelStore} TokenModule=${!!this.modules.TokenModule} SortedGuild=${!!this.modules.SortedGuildStore} PrivateChannels=${!!this.modules.PrivateChannelSortedStore} Nav=${!!this.modules.NavigationUtils} ChanActions=${!!this.modules.ChannelActions} MsgActions=${!!this.modules.MessageActions}`);
    }

    // ========== API ==========

    getToken() {
        // Return cached token if recent (avoid repeated lookups)
        if (this._cachedToken && Date.now() - this._cachedTokenTime < 60000) return this._cachedToken;
        const cacheAndReturn = (t) => { this._cachedToken = t; this._cachedTokenTime = Date.now(); return t; };
        // Method 1: via cached TokenModule
        if (this.modules.TokenModule?.getToken) {
            return cacheAndReturn(this.modules.TokenModule.getToken());
        }
        // Method 2: via AuthenticationStore
        const authStore = BdApi.Webpack.getStore("AuthenticationStore");
        if (authStore?.getToken) {
            return cacheAndReturn(authStore.getToken());
        }
        // Method 3: via webpack chunk search
        let token = null;
        try {
            webpackChunkdiscord_app.push([[""], {}, e => {
                for (let c in e.c) {
                    try {
                        const m = e.c[c]?.exports;
                        if (m?.default?.getToken) { token = m.default.getToken(); return; }
                        if (m?.getToken && typeof m.getToken === "function") { token = m.getToken(); return; }
                    } catch {}
                }
            }]);
        } catch {}
        if (token) return cacheAndReturn(token);
        return token;
    }

    async discordFetch(url, extraHeaders = {}) {
        const token = this.getToken();
        if (!token) {
            this.log("ERRO: Token nao encontrado!");
            return { ok: false, status: 401, json: async () => ({}) };
        }
        const resp = await fetch(url, {
            headers: {
                "Authorization": token,
                "Content-Type": "application/json",
                ...extraHeaders
            }
        });
        this.log(`Fetch ${url.substring(40, 100)}... -> ${resp.status}`);

        // CAPTCHA handled by CaptchaSolver plugin (fetch interceptor global)
        return resp;
    }

    async discordPost(url, body) {
        const token = this.getToken();
        if (!token) {
            this.log("ERRO: Token nao encontrado!");
            return { ok: false, status: 401, json: async () => ({}) };
        }
        const resp = await fetch(url, {
            method: "POST",
            headers: {
                "Authorization": token,
                "Content-Type": "application/json"
            },
            body: JSON.stringify(body)
        });
        this.log(`POST ${url.substring(40, 100)}... -> ${resp.status}`);
        return resp;
    }

    // ========== CAPTCHA (delegado ao CaptchaSolver plugin) ==========

    _checkCaptchaSolver() {
        const solver = BdApi.Plugins.get("CaptchaSolver");
        if (!solver || !BdApi.Plugins.isEnabled("CaptchaSolver")) {
            this.log("AVISO: Plugin CaptchaSolver nao encontrado ou desativado. CAPTCHAs nao serao resolvidos automaticamente.");
            BdApi.UI.showToast("Ative o plugin CaptchaSolver pra resolver CAPTCHAs automaticamente", { type: "warning" });
        } else {
            this.log("CaptchaSolver detectado e ativo");
        }
    }

    async searchGuild(guildId, query, offset = 0, minSnowflake = null, _retries = 0) {
        const limit = this.settings.maxResultsPerGuild;
        let url = `https://discord.com/api/v9/guilds/${guildId}/messages/search?content=${encodeURIComponent(query)}&limit=${limit}&offset=${offset}`;
        if (minSnowflake) url += `&min_id=${minSnowflake}`;
        for (const [key, active] of Object.entries(this._hasFilters)) {
            if (active) url += `&has=${key}`;
        }

        const cacheKey = this._getCacheKey("guild", guildId, query + JSON.stringify(this._hasFilters), minSnowflake);
        const cached = this._getCached(cacheKey);
        if (cached) return cached;

        try {
            const resp = await this.discordFetch(url);

            if (resp.status === 202 || resp.status === 429) {
                if (_retries >= 5) {
                    this.log(`Max retries atingido para guild ${guildId} (status ${resp.status})`);
                    return [];
                }
                if (resp.status === 429) {
                    const data = await resp.json();
                    const retryAfter = Math.max((data.retry_after || 2) * 1000, 2000);
                    this._showRateLimitFeedback(retryAfter);
                    this._applyRateLimitBackoff();
                    await this.sleep(retryAfter);
                } else {
                    await this.sleep(2000);
                }
                return this.searchGuild(guildId, query, offset, minSnowflake, _retries + 1);
            }

            if (!resp.ok) return [];

            const data = await resp.json();
            if (!data.messages) return [];

            const guild = this.modules.GuildStore.getGuild(guildId);
            const results = data.messages.map(msgGroup => {
                const msg = msgGroup[0];
                const channel = this.modules.ChannelStore.getChannel(msg.channel_id);
                return {
                    id: msg.id,
                    content: msg.content,
                    author: msg.author.global_name || msg.author.username,
                    authorId: msg.author.id,
                    authorAvatar: msg.author.avatar
                        ? `https://cdn.discordapp.com/avatars/${msg.author.id}/${msg.author.avatar}.png?size=40`
                        : null,
                    timestamp: msg.timestamp,
                    guildId: guildId,
                    guildName: guild ? guild.name : "Desconhecido",
                    guildIcon: guild && guild.icon ? `https://cdn.discordapp.com/icons/${guildId}/${guild.icon}.png?size=32` : null,
                    channelId: msg.channel_id,
                    channelName: channel ? channel.name : "desconhecido",
                    attachments: msg.attachments || [],
                    embeds: msg.embeds || []
                };
            });
            this._setCache(cacheKey, results);
            return results;
        } catch (err) {
            this.log(`ERRO servidor ${guildId}: ${err.message}`);
            return [];
        }
    }

    // ========== DM CHANNELS ==========

    async getDMChannels() {
        // Try webpack store first
        const store = this.modules.PrivateChannelSortedStore;
        if (store?.getPrivateChannelIds) {
            const ids = store.getPrivateChannelIds();
            const channels = ids
                .map(id => this.modules.ChannelStore.getChannel(id))
                .filter(ch => ch && (ch.type === 1 || ch.type === 3));
            this.log(`DM channels via store: ${channels.length}`);
            return channels;
        }
        // Fallback: API call
        try {
            const resp = await this.discordFetch("https://discord.com/api/v9/users/@me/channels");
            if (resp.ok) {
                const channels = await resp.json();
                this.log(`DM channels via API: ${channels.length}`);
                return channels.filter(ch => ch.type === 1 || ch.type === 3);
            }
        } catch (e) {
            this.log(`Erro ao buscar DMs: ${e.message}`);
        }
        return [];
    }

    getDMChannelDisplayName(channel) {
        if (channel.type === 3) {
            // Group DM
            if (channel.name) return channel.name;
            const recipients = channel.recipients || channel.rawRecipients || [];
            if (recipients.length > 0) {
                return recipients.map(r => r.global_name || r.globalName || r.username || "?").join(", ");
            }
            return `Grupo (${channel.id})`;
        }
        // 1:1 DM
        const recipients = channel.recipients || channel.rawRecipients || [];
        if (recipients.length > 0) {
            const r = recipients[0];
            return r.global_name || r.globalName || r.username || "Usuario";
        }
        return `DM (${channel.id})`;
    }

    getDMChannelAvatar(channel) {
        if (channel.type === 3 && channel.icon) {
            return `https://cdn.discordapp.com/channel-icons/${channel.id}/${channel.icon}.png?size=20`;
        }
        const recipients = channel.recipients || channel.rawRecipients || [];
        if (recipients.length > 0) {
            const r = recipients[0];
            const avatar = r.avatar;
            if (avatar) return `https://cdn.discordapp.com/avatars/${r.id}/${avatar}.png?size=20`;
        }
        return null;
    }

    async searchChannel(channelId, channelDisplayName, channelAvatar, query, offset = 0, minSnowflake = null, _retries = 0) {
        const limit = this.settings.maxResultsPerGuild;
        let url = `https://discord.com/api/v9/channels/${channelId}/messages/search?content=${encodeURIComponent(query)}&limit=${limit}&offset=${offset}`;
        if (minSnowflake) url += `&min_id=${minSnowflake}`;
        for (const [key, active] of Object.entries(this._hasFilters)) {
            if (active) url += `&has=${key}`;
        }

        const cacheKey = this._getCacheKey("ch", channelId, query + JSON.stringify(this._hasFilters), minSnowflake);
        const cached = this._getCached(cacheKey);
        if (cached) return cached;

        try {
            const resp = await this.discordFetch(url);

            if (resp.status === 202 || resp.status === 429) {
                if (_retries >= 5) {
                    this.log(`Max retries atingido para channel ${channelId} (status ${resp.status})`);
                    return [];
                }
                if (resp.status === 429) {
                    const data = await resp.json();
                    const retryAfter = Math.max((data.retry_after || 2) * 1000, 2000);
                    this._showRateLimitFeedback(retryAfter);
                    this._applyRateLimitBackoff();
                    await this.sleep(retryAfter);
                } else {
                    await this.sleep(2000);
                }
                return this.searchChannel(channelId, channelDisplayName, channelAvatar, query, offset, minSnowflake, _retries + 1);
            }

            if (!resp.ok) return [];

            const data = await resp.json();
            if (!data.messages) return [];

            const results = data.messages.map(msgGroup => {
                const msg = msgGroup[0];
                return {
                    id: msg.id,
                    content: msg.content,
                    author: msg.author.global_name || msg.author.username,
                    authorId: msg.author.id,
                    authorAvatar: msg.author.avatar
                        ? `https://cdn.discordapp.com/avatars/${msg.author.id}/${msg.author.avatar}.png?size=40`
                        : null,
                    timestamp: msg.timestamp,
                    guildId: null,
                    guildName: channelDisplayName,
                    guildIcon: channelAvatar,
                    channelId: channelId,
                    channelName: channelDisplayName,
                    attachments: msg.attachments || [],
                    embeds: msg.embeds || [],
                    isDM: true
                };
            });
            this._setCache(cacheKey, results);
            return results;
        } catch (err) {
            this.log(`ERRO DM ${channelId}: ${err.message}`);
            return [];
        }
    }

    async searchMultipleChannels(dmChannels, query, minSnowflake = null, excludeWords = [], customVariants = []) {
        // Runs after guild search (or standalone). Appends results to this._lastResults.
        const variantSet = new Set([query]);
        for (const v of customVariants) {
            if (v.toLowerCase() !== query.toLowerCase()) variantSet.add(v);
        }
        const queryVariants = [...variantSet];
        const seenIds = new Set(this._lastResults.map(r => r.id));

        this.log(`Buscando DMs: "${query}" (${queryVariants.length} variantes) em ${dmChannels.length} conversas`);

        const batchSize = Math.min(this.settings.parallelSearches || 3, 2); // DMs: max 2 parallel
        for (let i = 0; i < dmChannels.length; i += batchSize) {
            if (this._cancelSearch) break;
            if (this._isPaused) {
                // Save DM pause state
                this._pausedState = {
                    ...this._pausedState,
                    dmChannels, dmBatchIndex: i,
                    isDMPhase: true
                };
                this._isSearching = false;
                this.log(`Busca DMs pausada no batch ${i}/${dmChannels.length}`);
                this._updateModalPaused();
                return;
            }

            const batch = dmChannels.slice(i, i + batchSize);

            const batchResults = await Promise.all(
                batch.map(async ch => {
                    const displayName = this.getDMChannelDisplayName(ch);
                    const avatar = this.getDMChannelAvatar(ch);
                    const allResults = [];
                    for (const variant of queryVariants) {
                        if (this._cancelSearch || this._isPaused) break;
                        const results = await this.searchChannel(ch.id, displayName, avatar, variant, 0, minSnowflake);
                        allResults.push(...results);
                        if (queryVariants.length > 1) await this.sleep(100);
                    }
                    return allResults;
                })
            );

            const newMessages = [];
            for (const results of batchResults) {
                for (const msg of results) {
                    if (!seenIds.has(msg.id)) {
                        seenIds.add(msg.id);
                        newMessages.push(msg);
                    }
                }
            }

            const filtered = this._filterResults(newMessages, excludeWords);
            this._filteredCount += (newMessages.length - filtered.length);

            for (const msg of filtered) {
                const msgTime = new Date(msg.timestamp).getTime();
                let lo = 0, hi = this._lastResults.length;
                while (lo < hi) {
                    const mid = (lo + hi) >> 1;
                    if (new Date(this._lastResults[mid].timestamp).getTime() > msgTime) lo = mid + 1;
                    else hi = mid;
                }
                this._lastResults.splice(lo, 0, msg);
            }

            this._searchProgress.completed += batch.length;
            this._searchProgress.results = this._lastResults.length;

            this._updateModalProgress();
            if (this._searchProgress.completed % (batchSize * 3) === 0 || i + batchSize >= dmChannels.length) {
                this._updateModalResults();
            }

            if (i + batchSize < dmChannels.length) {
                await this.sleep(this.getBatchDelay());
            }
        }
    }

    async searchMultipleGuilds(guildIds, query, minSnowflake = null, excludeWords = [], customVariants = [], { skipInit = false } = {}) {
        if (!skipInit) {
            this._isSearching = true;
            this._cancelSearch = false;
            this._isPaused = false;
            this._pausedState = null;
            this._lastQuery = query;
            this._lastResults = [];
            this._excludeWords = excludeWords;
            this._filteredCount = 0;
            this._searchProgress = { completed: 0, total: guildIds.length, results: 0 };
        }
        // Build query variants: main query + custom user variants
        const variantSet = new Set([query]);
        for (const v of customVariants) {
            if (v.toLowerCase() !== query.toLowerCase()) variantSet.add(v);
        }
        const queryVariants = [...variantSet];
        this.log(`Iniciando busca: "${query}" (${queryVariants.length} variantes: ${queryVariants.join(" | ")}) em ${guildIds.length} servidores (paralelo: ${this.settings.parallelSearches}) minSnowflake=${minSnowflake} excluir=[${excludeWords.join(",")}]`);

        const seenIds = new Set(); // Deduplicate results across variants

        // Process guilds in parallel batches
        const batchSize = this.settings.parallelSearches || 3;
        for (let i = 0; i < guildIds.length; i += batchSize) {
            if (this._cancelSearch) break;
            if (this._isPaused) {
                this._pausedState = {
                    guildIds, query, minSnowflake, excludeWords, customVariants,
                    seenIds, batchIndex: i,
                    partialResults: this._lastResults,
                    filteredCount: this._filteredCount
                };
                this._isSearching = false;
                this.log(`Busca pausada no batch ${i}/${guildIds.length}`);
                this._updateModalPaused();
                return;
            }

            const batch = guildIds.slice(i, i + batchSize);

            // For each guild in the batch, search all query variants
            const batchResults = await Promise.all(
                batch.map(async guildId => {
                    const allResults = [];
                    for (const variant of queryVariants) {
                        if (this._cancelSearch || this._isPaused) break;
                        const results = await this.searchGuild(guildId, variant, 0, minSnowflake);
                        allResults.push(...results);
                        // Small delay between variant searches for same guild
                        if (queryVariants.length > 1) await this.sleep(100);
                    }
                    return allResults;
                })
            );

            // Deduplicate and apply filter incrementally
            const newMessages = [];
            for (const results of batchResults) {
                for (const msg of results) {
                    if (!seenIds.has(msg.id)) {
                        seenIds.add(msg.id);
                        newMessages.push(msg);
                    }
                }
            }

            // Filter new batch immediately
            const filtered = this._filterResults(newMessages, this._excludeWords);
            this._filteredCount += (newMessages.length - filtered.length);

            // Insert sorted (binary insertion) instead of re-sorting entire array
            for (const msg of filtered) {
                const msgTime = new Date(msg.timestamp).getTime();
                let lo = 0, hi = this._lastResults.length;
                while (lo < hi) {
                    const mid = (lo + hi) >> 1;
                    if (new Date(this._lastResults[mid].timestamp).getTime() > msgTime) lo = mid + 1;
                    else hi = mid;
                }
                this._lastResults.splice(lo, 0, msg);
            }

            this._searchProgress.completed += batch.length;
            this._searchProgress.results = this._lastResults.length;

            // Update modal UI with progress; debounce result rendering (every 3 batches)
            this._updateModalProgress();
            if (this._searchProgress.completed % (batchSize * 3) === 0 || i + batchSize >= guildIds.length) {
                this._updateModalResults();
            }

            // Delay between batches with jitter to avoid detection
            if (i + batchSize < guildIds.length) {
                await this.sleep(this.getBatchDelay());
            }
        }

        if (!skipInit) {
            this._isSearching = false;
            this.log(`Busca finalizada: ${this._lastResults.length} resultados (${this._filteredCount} filtrados)`);

            // Final update
            this._updateModalDone();

            if (!this._cancelSearch) {
                // Save to history
                this.addToHistory({
                    query: query,
                    variants: customVariants,
                    excludeWords: excludeWords,
                    guildIds: guildIds,
                    timestamp: Date.now(),
                    resultCount: this._lastResults.length,
                    results: this._lastResults,
                    channelFilter: this._activeChannelFilter,
                    excludedChannels: [...this._excludedChannels]
                });
            }
        } else {
            this.log(`Busca em servidores finalizada: ${this._lastResults.length} resultados parciais`);
        }
    }

    _updateModalProgress() {
        const progressEl = document.querySelector(".gs-progress");
        if (!progressEl || !this._searchProgress) return;
        const { completed, total, results } = this._searchProgress;
        const filtered = this._filteredCount || 0;
        progressEl.style.display = "block";
        progressEl.innerHTML = `
            <div class="gs-progress-bar-bg">
                <div class="gs-progress-bar" style="width:${(completed/total)*100}%"></div>
            </div>
            <div class="gs-progress-info">
                <span>Buscando: ${completed}/${total} ${this._searchDMs ? "itens" : "servidores"} | ${results} resultados${filtered > 0 ? ` (${filtered} filtrados)` : ""}</span>
                <div style="display:flex;gap:6px;">
                    <button class="gs-pause-btn" id="gs-pause-search">Pausar</button>
                    <button class="gs-cancel-btn" id="gs-cancel-search">Cancelar</button>
                </div>
            </div>
        `;
        // Attach pause handler
        const pauseBtn = progressEl.querySelector("#gs-pause-search");
        if (pauseBtn) {
            pauseBtn.addEventListener("click", () => {
                this._isPaused = true;
                this.log("Busca pausada pelo usuario");
                BdApi.UI.showToast("Busca pausada!", { type: "info" });
            });
        }
        // Attach cancel handler
        const cancelBtn = progressEl.querySelector("#gs-cancel-search");
        if (cancelBtn) {
            cancelBtn.addEventListener("click", () => {
                this._cancelSearch = true;
                this._isSearching = false;
                this._isPaused = false;
                this._pausedState = null;
                this.log("Busca cancelada pelo usuario");
                this._updateModalDone(true);
                BdApi.UI.showToast("Busca cancelada!", { type: "warning" });
            });
        }
    }

    _updateModalPaused() {
        const progressEl = document.querySelector(".gs-progress");
        const searchBtn = document.querySelector(".gs-search-btn");

        if (searchBtn) {
            searchBtn.disabled = false;
            searchBtn.textContent = "Buscar";
        }

        if (progressEl && this._searchProgress) {
            const { completed, total, results } = this._searchProgress;
            progressEl.style.display = "block";
            progressEl.innerHTML = `
                <div class="gs-progress-bar-bg">
                    <div class="gs-progress-bar gs-progress-bar-paused" style="width:${(completed/total)*100}%"></div>
                </div>
                <div class="gs-progress-info">
                    <span>Pausado: ${completed}/${total} servidores | ${results} resultados</span>
                    <div style="display:flex;gap:6px;">
                        <button class="gs-resume-btn" id="gs-resume-search">Continuar</button>
                        <button class="gs-cancel-btn" id="gs-cancel-paused">Cancelar</button>
                    </div>
                </div>
            `;
            const resumeBtn = progressEl.querySelector("#gs-resume-search");
            if (resumeBtn) {
                resumeBtn.addEventListener("click", () => {
                    this.resumeSearch();
                });
            }
            const cancelBtn = progressEl.querySelector("#gs-cancel-paused");
            if (cancelBtn) {
                cancelBtn.addEventListener("click", () => {
                    this._isPaused = false;
                    this._pausedState = null;
                    this._cancelSearch = true;
                    this.log("Busca pausada cancelada");
                    this._updateModalDone(true);
                    BdApi.UI.showToast("Busca cancelada!", { type: "warning" });
                });
            }
        }

        // Also render partial results
        this._updateModalResults();
    }

    async resumeSearch() {
        if (!this._pausedState) {
            BdApi.UI.showToast("Nenhuma busca pausada.", { type: "warning" });
            return;
        }
        const state = this._pausedState;
        this._pausedState = null;
        this._isPaused = false;
        this._isSearching = true;
        this._cancelSearch = false;
        this._lastResults = state.partialResults;
        this._filteredCount = state.filteredCount;
        this._lastQuery = state.query;
        this._excludeWords = state.excludeWords;

        const { guildIds, query, minSnowflake, excludeWords, customVariants, seenIds, batchIndex } = state;

        const variantSet = new Set([query]);
        for (const v of customVariants) {
            if (v.toLowerCase() !== query.toLowerCase()) variantSet.add(v);
        }
        const queryVariants = [...variantSet];

        this._searchProgress = {
            completed: batchIndex,
            total: guildIds.length,
            results: this._lastResults.length
        };

        const batchSize = this.settings.parallelSearches || 3;
        this.log(`Retomando busca: "${query}" a partir do batch ${batchIndex}/${guildIds.length}`);

        // Disable search button
        const searchBtn = document.querySelector(".gs-search-btn");
        if (searchBtn) {
            searchBtn.disabled = true;
            searchBtn.textContent = "Buscando...";
        }

        for (let i = batchIndex; i < guildIds.length; i += batchSize) {
            if (this._cancelSearch) break;
            if (this._isPaused) {
                this._pausedState = {
                    guildIds, query, minSnowflake, excludeWords, customVariants,
                    seenIds, batchIndex: i,
                    partialResults: this._lastResults,
                    filteredCount: this._filteredCount
                };
                this._isSearching = false;
                this.log(`Busca pausada novamente no batch ${i}/${guildIds.length}`);
                this._updateModalPaused();
                return;
            }

            const batch = guildIds.slice(i, i + batchSize);
            const batchResults = await Promise.all(
                batch.map(async guildId => {
                    const allResults = [];
                    for (const variant of queryVariants) {
                        if (this._cancelSearch || this._isPaused) break;
                        const results = await this.searchGuild(guildId, variant, 0, minSnowflake);
                        allResults.push(...results);
                        if (queryVariants.length > 1) await this.sleep(100);
                    }
                    return allResults;
                })
            );

            const newMessages = [];
            for (const results of batchResults) {
                for (const msg of results) {
                    if (!seenIds.has(msg.id)) {
                        seenIds.add(msg.id);
                        newMessages.push(msg);
                    }
                }
            }

            const filtered = this._filterResults(newMessages, this._excludeWords);
            this._filteredCount += (newMessages.length - filtered.length);

            for (const msg of filtered) {
                const msgTime = new Date(msg.timestamp).getTime();
                let lo = 0, hi = this._lastResults.length;
                while (lo < hi) {
                    const mid = (lo + hi) >> 1;
                    if (new Date(this._lastResults[mid].timestamp).getTime() > msgTime) lo = mid + 1;
                    else hi = mid;
                }
                this._lastResults.splice(lo, 0, msg);
            }

            this._searchProgress.completed += batch.length;
            this._searchProgress.results = this._lastResults.length;

            this._updateModalProgress();
            if (this._searchProgress.completed % (batchSize * 3) === 0 || i + batchSize >= guildIds.length) {
                this._updateModalResults();
            }

            if (i + batchSize < guildIds.length) {
                await this.sleep(this.getBatchDelay());
            }
        }

        this._isSearching = false;
        this.log(`Busca retomada finalizada: ${this._lastResults.length} resultados (${this._filteredCount} filtrados)`);
        this._updateModalDone();

        if (!this._cancelSearch) {
            this.addToHistory({
                query, variants: customVariants, excludeWords,
                guildIds, timestamp: Date.now(),
                resultCount: this._lastResults.length,
                results: this._lastResults,
                channelFilter: this._activeChannelFilter,
                excludedChannels: [...this._excludedChannels]
            });
        }
    }

    _updateModalResults() {
        const resultsEl = document.querySelector(".gs-results");
        if (!resultsEl || !this._lastResults) return;
        const overlay = document.querySelector(".gs-modal-overlay");
        if (!overlay) return;
        this.renderResults(resultsEl, this._lastResults, overlay);
    }

    _updateModalDone(cancelled = false) {
        const progressEl = document.querySelector(".gs-progress");
        const searchBtn = document.querySelector(".gs-search-btn");
        this._rateLimitToastShown = false;

        if (searchBtn) {
            searchBtn.disabled = false;
            searchBtn.textContent = "Buscar";
        }

        if (progressEl && this._lastResults) {
            const filtered = this._filteredCount || 0;
            const count = this._lastResults.length;
            if (cancelled) {
                progressEl.innerHTML = `<span class="gs-done-cancelled">Busca cancelada! ${count} resultado(s)${filtered > 0 ? ` (${filtered} filtrados)` : ""}.</span>`;
            } else {
                progressEl.innerHTML = `<span class="gs-done-success">\u2713 Busca concluida! ${count} resultado(s)${filtered > 0 ? ` (${filtered} filtrados)` : ""}.</span>`;
                BdApi.UI.showToast(`Busca concluida: ${count} resultado(s).`, { type: count > 0 ? "success" : "info" });
            }
            progressEl.style.opacity = "1";
            progressEl.style.transition = "";
            setTimeout(() => {
                progressEl.style.transition = "opacity 0.8s ease";
                progressEl.style.opacity = "0";
            }, cancelled ? 5000 : 4000);
        }

        this._updateModalResults();
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    getBatchDelay() {
        const base = this.settings.manualDelay ? this.settings.searchDelay : 450;
        const pct = this.settings.manualDelay ? this.settings.jitterPct : 25;
        const spread = base * pct / 100;
        const jitter = Math.floor(Math.random() * spread);
        // Adaptive backoff: if we've been rate limited recently, add extra delay
        const backoff = this._rateLimitBackoff || 0;
        return base + jitter + backoff;
    }

    _applyRateLimitBackoff() {
        // Increase delay temporarily after rate limit
        this._rateLimitBackoff = Math.min((this._rateLimitBackoff || 0) + 500, 5000);
        this.log(`Backoff adaptativo: +${this._rateLimitBackoff}ms`);
        // Decay backoff after 30s without rate limits
        clearTimeout(this._backoffDecayTimer);
        this._backoffDecayTimer = setTimeout(() => { this._rateLimitBackoff = 0; }, 30000);
    }

    _showRateLimitFeedback(retryAfterMs) {
        const seconds = Math.ceil(retryAfterMs / 1000);
        const progressEl = document.querySelector(".gs-progress");
        if (progressEl) {
            // Only one banner at a time
            let banner = progressEl.querySelector(".gs-rate-limit-banner");
            if (!banner) {
                banner = document.createElement("div");
                banner.className = "gs-rate-limit-banner";
                progressEl.appendChild(banner);
            }
            this._rateLimitCount = (this._rateLimitCount || 0) + 1;
            banner.textContent = `Rate limited — aguardando ${seconds}s...${this._rateLimitCount > 1 ? ` (${this._rateLimitCount}x)` : ""}`;
            clearTimeout(this._rateLimitBannerTimeout);
            this._rateLimitBannerTimeout = setTimeout(() => { banner.remove(); this._rateLimitCount = 0; }, retryAfterMs + 500);
        }
        if (!this._rateLimitToastShown) {
            this._rateLimitToastShown = true;
            BdApi.UI.showToast(`Rate limited pelo Discord. Aguardando ${seconds}s...`, { type: "warning" });
        }
    }

    // ========== RESULT CACHE ==========

    _getCacheKey(type, id, query, minSnowflake) {
        return `${type}:${id}:${query}:${minSnowflake || ""}`;
    }

    _getCached(key) {
        const cached = this._resultCache.get(key);
        if (cached && Date.now() - cached.cachedAt < (this.settings.cacheMinutes || 10) * 60000) {
            this.log(`Cache hit: ${key.substring(0, 60)}`);
            return cached.results;
        }
        return null;
    }

    _setCache(key, results) {
        this._resultCache.set(key, { results, cachedAt: Date.now() });
    }

    // ========== SEARCH HISTORY ==========

    loadHistory() {
        this._searchHistory = BdApi.Data.load(this.meta.name, "history") || [];
        this.log(`Historico carregado: ${this._searchHistory.length} entradas`);
    }

    saveHistory() {
        // Keep max 50 entries
        if (this._searchHistory.length > 50) {
            this._searchHistory = this._searchHistory.slice(0, 50);
        }
        BdApi.Data.save(this.meta.name, "history", this._searchHistory);
    }

    addToHistory(entry) {
        // entry: { query, variants, excludeWords, guildIds, period, timestamp, resultCount, results }
        // Remove duplicate with same query if exists
        this._searchHistory = this._searchHistory.filter(h => h.query !== entry.query);
        // Add to front
        this._searchHistory.unshift(entry);
        this.saveHistory();
        this.log(`Historico: adicionado "${entry.query}" (${entry.resultCount} resultados)`);
    }

    clearHistory() {
        this._searchHistory = [];
        BdApi.Data.save(this.meta.name, "history", []);
        this.log("Historico limpo");
    }

    getHistoryEntry(query) {
        return this._searchHistory.find(h => h.query === query);
    }

    deleteHistoryEntry(query) {
        this._searchHistory = this._searchHistory.filter(h => h.query !== query);
        this.saveHistory();
        this.log(`Historico: removido "${query}"`);
    }

    // ========== ARCHIVED SEARCHES ==========

    loadArchived() {
        this._archivedSearches = BdApi.Data.load(this.meta.name, "archived") || [];
        this.log(`Arquivados carregados: ${this._archivedSearches.length} entradas`);
    }

    saveArchived() {
        BdApi.Data.save(this.meta.name, "archived", this._archivedSearches);
    }

    archiveSearch(entry) {
        if (this._archivedSearches.some(a => a.query === entry.query)) {
            BdApi.UI.showToast(`"${entry.query}" ja esta arquivado.`, { type: "warning" });
            return;
        }
        const archived = { ...entry, archivedAt: Date.now() };
        this._archivedSearches.unshift(archived);
        this.saveArchived();
        this.log(`Arquivado: "${entry.query}"`);
    }

    unarchiveSearch(query) {
        this._archivedSearches = this._archivedSearches.filter(a => a.query !== query);
        this.saveArchived();
        this.log(`Desarquivado: "${query}"`);
    }

    // ========== STORAGE SIZE ==========

    getStorageSize() {
        const histJson = JSON.stringify(this._searchHistory || []);
        const archJson = JSON.stringify(this._archivedSearches || []);
        const histBytes = new Blob([histJson]).size;
        const archBytes = new Blob([archJson]).size;
        const totalBytes = histBytes + archBytes;
        const formatSize = (bytes) => {
            if (bytes < 1024) return `${bytes} B`;
            if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
            return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
        };
        return {
            history: formatSize(histBytes),
            archived: formatSize(archBytes),
            total: formatSize(totalBytes),
            historyBytes: histBytes,
            archivedBytes: archBytes,
            totalBytes: totalBytes
        };
    }

    // ========== AUTO REFRESH ==========

    setupAutoRefresh() {
        this._blurHandler = () => {
            if (!this.settings.autoRefresh) return;
            if (this._isSearching) return;
            // Find the most recent history entry to refresh
            const lastEntry = this._searchHistory[0];
            if (!lastEntry) return;
            this.log(`Auto-refresh: janela perdeu foco, atualizando "${lastEntry.query}"...`);
            this._runAutoRefresh(lastEntry);
        };
        window.addEventListener("blur", this._blurHandler);
    }

    removeAutoRefresh() {
        if (this._blurHandler) {
            window.removeEventListener("blur", this._blurHandler);
            this._blurHandler = null;
        }
    }

    async _runAutoRefresh(historyEntry, onProgress) {
        if (this._isSearching) return;
        // Build min_id from the history entry timestamp (search only messages newer than last search)
        const DISCORD_EPOCH = 1420070400000;
        const lastSearchTime = historyEntry.timestamp;
        const minSnowflake = String(BigInt(lastSearchTime - DISCORD_EPOCH) << 22n);

        // Build variants
        const customVariants = historyEntry.variants || [];

        this.log(`Auto-refresh: buscando desde ${new Date(lastSearchTime).toLocaleTimeString("pt-BR")}`);

        // Run the search but keep old results and merge
        this._isSearching = true;
        this._cancelSearch = false;
        const oldResults = historyEntry.results || [];
        const seenIds = new Set(oldResults.map(r => r.id));

        const variantSet = new Set([historyEntry.query]);
        for (const v of customVariants) {
            if (v.toLowerCase() !== historyEntry.query.toLowerCase()) variantSet.add(v);
        }
        const queryVariants = [...variantSet];

        const guildIds = historyEntry.guildIds || [];
        const excludeWords = historyEntry.excludeWords || [];
        let newCount = 0;

        const batchSize = this.settings.parallelSearches || 3;
        for (let i = 0; i < guildIds.length; i += batchSize) {
            if (this._cancelSearch) break;
            const batch = guildIds.slice(i, i + batchSize);
            const done = Math.min(i + batchSize, guildIds.length);
            if (onProgress) onProgress(done, guildIds.length, newCount);
            const batchResults = await Promise.all(
                batch.map(async guildId => {
                    const allResults = [];
                    for (const variant of queryVariants) {
                        if (this._cancelSearch) break;
                        const results = await this.searchGuild(guildId, variant, 0, minSnowflake);
                        allResults.push(...results);
                        if (queryVariants.length > 1) await this.sleep(100);
                    }
                    return allResults;
                })
            );
            for (const results of batchResults) {
                for (const msg of results) {
                    if (!seenIds.has(msg.id)) {
                        seenIds.add(msg.id);
                        const filtered = this._filterResults([msg], excludeWords);
                        if (filtered.length > 0) {
                            oldResults.push(msg);
                            newCount++;
                        }
                    }
                }
            }
            if (i + batchSize < guildIds.length) {
                await this.sleep(this.getBatchDelay());
            }
        }

        this._isSearching = false;

        if (newCount > 0) {
            // Sort and update history
            oldResults.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
            historyEntry.results = oldResults;
            historyEntry.resultCount = oldResults.length;
            historyEntry.timestamp = Date.now();
            this.saveHistory();
            // Update in-memory state
            this._lastResults = oldResults;
            this._lastQuery = historyEntry.query;
            this.log(`Auto-refresh: +${newCount} novos resultados para "${historyEntry.query}"`);
            BdApi.UI.showToast(`Auto-refresh: +${newCount} novo(s) resultado(s) para "${historyEntry.query}"`, { type: "info" });
        } else {
            historyEntry.timestamp = Date.now();
            this.saveHistory();
            this.log(`Auto-refresh: nenhum resultado novo para "${historyEntry.query}"`);
        }
    }

    // ========== GUILD FOLDERS ==========

    getGuildFolders() {
        // Try to get folder structure from SortedGuildStore
        const folders = [];
        try {
            const store = this.modules.SortedGuildStore;
            if (store?.getGuildFolders) {
                const rawFolders = store.getGuildFolders();
                for (const folder of rawFolders) {
                    if (folder.folderId && folder.guildIds && folder.guildIds.length > 1) {
                        folders.push({
                            id: folder.folderId,
                            name: folder.folderName || `Pasta (${folder.guildIds.length} servidores)`,
                            color: folder.folderColor,
                            guildIds: [...folder.guildIds]
                        });
                    }
                }
            }
        } catch (e) {
            this.log(`Erro ao pegar pastas: ${e.message}`);
        }
        this.log(`Encontradas ${folders.length} pastas de servidores`);
        return folders;
    }

    // ========== QUERY VARIANTS ==========

    // Generate search query variants to catch different spellings
    _generateQueryVariants(query) {
        const variants = new Set([query]);
        const words = query.split(/\s+/);

        for (let wi = 0; wi < words.length; wi++) {
            const word = words[wi].toLowerCase();
            if (word.length < 4) continue; // Skip short words

            // Variant 1: remove double letters (cannelloni -> caneloni)
            const singleLetters = word.replace(/(.)\1+/g, "$1");
            if (singleLetters !== word) {
                const v = [...words];
                v[wi] = singleLetters;
                variants.add(v.join(" "));
            }

            // Variant 2: double each single consonant that could be doubled
            // (caneloni -> canneloni, canelloni, canelonni)
            // Only do the most likely one — double the first consonant cluster
            const doubled = word.replace(/([bcdfgklmnprst])(?!\1)/i, "$1$1");
            if (doubled !== word) {
                const v = [...words];
                v[wi] = doubled;
                variants.add(v.join(" "));
            }
        }

        // Limit to 3 variants max to avoid too many API calls
        return [...variants].slice(0, 3);
    }

    // ========== FUZZY MATCHING ==========

    // Levenshtein distance — how many edits to transform a into b
    _levenshtein(a, b) {
        const m = a.length, n = b.length;
        if (m === 0) return n;
        if (n === 0) return m;
        const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
        for (let i = 0; i <= m; i++) dp[i][0] = i;
        for (let j = 0; j <= n; j++) dp[0][j] = j;
        for (let i = 1; i <= m; i++) {
            for (let j = 1; j <= n; j++) {
                dp[i][j] = a[i - 1] === b[j - 1]
                    ? dp[i - 1][j - 1]
                    : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
            }
        }
        return dp[m][n];
    }

    // Check if query words fuzzy-match the message content
    // Each query word must match at least one word in the message (exact or fuzzy)
    _fuzzyMatch(content, query) {
        const contentLower = content.toLowerCase();
        const queryLower = query.toLowerCase();

        // Exact substring match — always passes
        if (contentLower.includes(queryLower)) return true;

        // Split into words and check each query word
        const queryWords = queryLower.split(/\s+/).filter(w => w.length > 0);
        const contentWords = contentLower.split(/\s+/).filter(w => w.length > 0);

        return queryWords.every(qw => {
            // Exact word match
            if (contentWords.some(cw => cw.includes(qw))) return true;

            // Fuzzy match — allow ~30% edit distance (typo tolerance)
            const maxDist = Math.max(1, Math.floor(qw.length * 0.35));
            return contentWords.some(cw => {
                // Only compare words of similar length to avoid false positives
                if (Math.abs(cw.length - qw.length) > maxDist) return false;
                return this._levenshtein(qw, cw) <= maxDist;
            });
        });
    }

    // Filter results: apply exclude words
    _filterResults(results, excludeWords) {
        return results.filter(msg => {
            const content = msg.content.toLowerCase();

            // Exclude messages containing excluded words
            if (excludeWords && excludeWords.length > 0) {
                for (const word of excludeWords) {
                    if (word && content.includes(word.toLowerCase())) {
                        return false;
                    }
                }
            }

            // Author filter (from:username)
            if (this._authorFilter && !msg.author.toLowerCase().includes(this._authorFilter)) {
                return false;
            }

            return true;
        });
    }

    // ========== NAVIGATION ==========

    goToMessage(guildId, channelId, messageId) {
        const path = guildId ? `/channels/${guildId}/${channelId}/${messageId}` : `/channels/@me/${channelId}/${messageId}`;
        this.log(`Navegando para: ${path}`);

        // Method 1: transitionTo with message ID in path (no reload)
        if (this.modules.NavigationUtils?.transitionTo) {
            try {
                this.modules.NavigationUtils.transitionTo(path);
                this.log("Navegou via NavigationUtils.transitionTo");
                return;
            } catch (e) {
                this.log(`Erro NavigationUtils: ${e.message}`);
            }
        }

        // Method 2: Find transitionTo via webpack at runtime
        try {
            const navModule = BdApi.Webpack.getByKeys("transitionTo");
            if (navModule?.transitionTo) {
                navModule.transitionTo(path);
                this.log("Navegou via webpack transitionTo");
                return;
            }
        } catch (e) {
            this.log(`Erro webpack nav: ${e.message}`);
        }

        // Method 3: RouterStore history push
        try {
            const RouterStore = BdApi.Webpack.getStore("RouterStore");
            if (RouterStore) {
                const history = RouterStore.getHistory?.() || RouterStore.__getLocalVars?.()?.history;
                if (history?.push) {
                    history.push(path);
                    this.log("Navegou via RouterStore history");
                    return;
                }
            }
        } catch (e) {
            this.log(`Erro RouterStore: ${e.message}`);
        }

        // Method 4: Use history.pushState + dispatch popstate (SPA navigation, no reload)
        try {
            window.history.pushState(null, "", path);
            window.dispatchEvent(new PopStateEvent("popstate"));
            this.log("Navegou via history.pushState + popstate");
            return;
        } catch (e) {
            this.log(`Erro pushState: ${e.message}`);
        }

        // Method 5: Last resort — open in same tab but warn
        this.log("AVISO: Nenhum metodo de navegacao SPA funcionou, nao redirecionando");
        BdApi.UI.showToast("Nao foi possivel navegar ate a mensagem. Tente atualizar o Discord.", { type: "error" });
    }

    // ========== DM & FORWARD ==========

    async openDMWithUser(authorId) {
        try {
            const resp = await this.discordPost("https://discord.com/api/v9/users/@me/channels", {
                recipient_id: authorId
            });
            if (!resp.ok) {
                this.log(`ERRO ao abrir DM: status ${resp.status}`);
                BdApi.UI.showToast("Erro ao abrir DM com este usuario.", { type: "error" });
                return null;
            }
            const dmChannel = await resp.json();
            this.log(`DM channel aberto: ${dmChannel.id} com usuario ${authorId}`);

            // Method 1: selectPrivateChannel
            if (this.modules.ChannelActions?.selectPrivateChannel) {
                try {
                    this.modules.ChannelActions.selectPrivateChannel(dmChannel.id);
                    this.log("Navegou para DM via selectPrivateChannel");
                    return dmChannel;
                } catch (e) {
                    this.log(`Erro selectPrivateChannel: ${e.message}`);
                }
            }

            // Method 2: NavigationUtils.transitionTo
            if (this.modules.NavigationUtils?.transitionTo) {
                try {
                    this.modules.NavigationUtils.transitionTo(`/channels/@me/${dmChannel.id}`);
                    this.log("Navegou para DM via transitionTo");
                    return dmChannel;
                } catch (e) {
                    this.log(`Erro transitionTo DM: ${e.message}`);
                }
            }

            // Method 3: history.pushState fallback
            try {
                window.history.pushState(null, "", `/channels/@me/${dmChannel.id}`);
                window.dispatchEvent(new PopStateEvent("popstate"));
                this.log("Navegou para DM via pushState");
                return dmChannel;
            } catch (e) {
                this.log(`Erro pushState DM: ${e.message}`);
            }

            BdApi.UI.showToast("Nao foi possivel abrir a DM.", { type: "error" });
            return dmChannel;
        } catch (err) {
            this.log(`ERRO openDMWithUser: ${err.message}`);
            BdApi.UI.showToast("Erro ao abrir DM.", { type: "error" });
            return null;
        }
    }

    async forwardMessageToDM(dmChannelId, msg) {
        try {
            const date = new Date(msg.timestamp);
            const dateStr = date.toLocaleDateString("pt-BR") + " " + date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

            const messageLink = `https://discord.com/channels/${msg.guildId}/${msg.channelId}/${msg.id}`;

            const lines = [
                `> **${msg.author}** em **${msg.guildName}** > #${msg.channelName}`,
                `> ${dateStr}`,
                `> `,
                ...msg.content.split("\n").map(line => `> ${line}`),
                ``,
                `[Ir para a mensagem original](${messageLink})`
            ];

            let content = lines.join("\n");

            // Truncate if over Discord's 2000 char limit
            if (content.length > 2000) {
                const header = lines.slice(0, 4).join("\n");
                const footer = `\n\n[Ir para a mensagem original](${messageLink})`;
                const maxContent = 2000 - header.length - footer.length - 20;
                const truncated = msg.content.substring(0, maxContent) + "...";
                content = header + "\n" + truncated.split("\n").map(line => `> ${line}`).join("\n") + footer;
            }

            const resp = await this.discordPost(`https://discord.com/api/v9/channels/${dmChannelId}/messages`, {
                content: content
            });

            if (resp.ok) {
                this.log(`Mensagem encaminhada para DM ${dmChannelId}`);
                BdApi.UI.showToast("Mensagem encaminhada!", { type: "success" });
            } else {
                const errData = await resp.json().catch(() => ({}));
                this.log(`ERRO ao encaminhar: ${resp.status} - ${JSON.stringify(errData)}`);
                if (resp.status === 403) {
                    BdApi.UI.showToast("Nao foi possivel enviar. O usuario pode ter DMs desabilitadas.", { type: "error" });
                } else if (resp.status === 429) {
                    const retryAfter = errData.retry_after || 5;
                    BdApi.UI.showToast(`Rate limited. Tente em ${Math.ceil(retryAfter)}s.`, { type: "warning" });
                } else {
                    BdApi.UI.showToast("Erro ao encaminhar a mensagem.", { type: "error" });
                }
            }
        } catch (err) {
            this.log(`ERRO forwardMessageToDM: ${err.message}`);
            BdApi.UI.showToast("Erro ao encaminhar a mensagem.", { type: "error" });
        }
    }

    insertTextInChatBox(msg) {
        const date = new Date(msg.timestamp);
        const dateStr = date.toLocaleDateString("pt-BR") + " " + date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
        const messageLink = `https://discord.com/channels/${msg.guildId || "@me"}/${msg.channelId}/${msg.id}`;

        const lines = [
            `> **${msg.author}** em **${msg.guildName}** > #${msg.channelName}`,
            `> ${dateStr}`,
            `> `,
            ...msg.content.split("\n").map(line => `> ${line}`),
            ``,
            messageLink
        ];
        let text = lines.join("\n");
        if (text.length > 2000) {
            const header = lines.slice(0, 3).join("\n");
            const footer = `\n\n${messageLink}`;
            const maxContent = 2000 - header.length - footer.length - 20;
            text = header + "\n> " + msg.content.substring(0, maxContent) + "..." + footer;
        }

        try {
            // Copy to clipboard and paste via Slate editor — avoids corrupting editor state
            const textarea = document.querySelector('[role="textbox"][contenteditable="true"]');
            if (textarea) {
                textarea.focus();
                // Use clipboard API + paste event for clean Slate integration
                if (navigator.clipboard?.writeText) {
                    navigator.clipboard.writeText(text).then(() => {
                        document.execCommand("paste");
                        this.log("Texto colado via clipboard + paste");
                        BdApi.UI.showToast("Mensagem preparada! Edite e aperte Enter.", { type: "success" });
                    }).catch(() => {
                        // Fallback: execCommand insertText
                        document.execCommand("insertText", false, text);
                        this.log("Texto inserido via execCommand fallback");
                        BdApi.UI.showToast("Mensagem preparada! Edite e aperte Enter.", { type: "success" });
                    });
                    return;
                }
                // Fallback without clipboard API
                document.execCommand("insertText", false, text);
                this.log("Texto inserido via execCommand");
                BdApi.UI.showToast("Mensagem preparada! Edite e aperte Enter.", { type: "success" });
                return;
            }

            // Last resort: copy to clipboard only
            if (navigator.clipboard?.writeText) {
                navigator.clipboard.writeText(text);
                this.log("Texto copiado para clipboard (nao encontrou editor)");
                BdApi.UI.showToast("Texto copiado! Cole com Ctrl+V no chat.", { type: "info" });
                return;
            }

            this.log("AVISO: Nao encontrou caixa de texto nem clipboard");
            BdApi.UI.showToast("Nao foi possivel inserir o texto.", { type: "warning" });
        } catch (err) {
            this.log(`ERRO insertTextInChatBox: ${err.message}`);
            BdApi.UI.showToast("Erro ao inserir texto.", { type: "error" });
        }
    }

    // ========== KEYBIND ==========

    setupKeybind() {
        this._keyHandler = (e) => {
            // Ctrl+Shift+F to open global search — use e.code to ignore layout/capslock
            if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && (e.code === "KeyF" || e.key === "F" || e.key === "f")) {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                if (!document.querySelector(".gs-modal-overlay")) {
                    this.openSearchModal();
                }
                return false;
            }
        };
        // Listen on window in capture phase — earliest possible interception, before Discord's own handlers
        window.addEventListener("keydown", this._keyHandler, true);
        document.addEventListener("keydown", this._keyHandler, true);
    }

    removeKeybind() {
        if (this._keyHandler) {
            window.removeEventListener("keydown", this._keyHandler, true);
            document.removeEventListener("keydown", this._keyHandler, true);
            this._keyHandler = null;
        }
    }

    // ========== UI: TOOLBAR BUTTON ==========

    setupObserver() {
        this.observer = new MutationObserver(() => {
            if (!document.getElementById(this.buttonId)) {
                this.injectButton();
            }
            if (!document.getElementById(this.buttonId + "-searchbar")) {
                this.injectSearchbarButton();
            }
        });
        this.observer.observe(document.body, { childList: true, subtree: true });
    }

    injectButton() {
        if (document.getElementById(this.buttonId)) return;
        const toolbar = document.querySelector('[class*="toolbar_"]') || document.querySelector('[class*="toolbar-"]') || document.querySelector('[class*="Toolbar"]');
        if (!toolbar) return;

        const btn = document.createElement("div");
        btn.id = this.buttonId;
        btn.className = "global-search-toolbar-btn";
        btn.title = "Busca Global (Ctrl+Shift+F)";
        btn.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
            <path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0016 9.5 6.5 6.5 0 109.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
            <path d="M12 10h-2v2H9v-2H7V9h2V7h1v2h2v1z"/>
        </svg>`;
        btn.addEventListener("click", () => this.openSearchModal());

        toolbar.insertBefore(btn, toolbar.firstChild);
    }

    injectSearchbarButton() {
        const btnId = this.buttonId + "-searchbar";
        if (document.getElementById(btnId)) return;
        // Native Discord searchbar lives inside [class*="searchBar_"] within the toolbar
        const searchBar = document.querySelector('[class*="searchBar_"]');
        if (!searchBar || !searchBar.parentElement) return;

        const btn = document.createElement("div");
        btn.id = btnId;
        btn.className = "global-search-searchbar-btn";
        btn.title = "Busca Global (Ctrl+Shift+F)";
        btn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0016 9.5 6.5 6.5 0 109.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
            <path d="M12 10h-2v2H9v-2H7V9h2V7h1v2h2v1z"/>
        </svg>`;
        btn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.openSearchModal();
        });

        searchBar.parentElement.insertBefore(btn, searchBar.nextSibling);
    }

    removeSearchbarButton() {
        const btn = document.getElementById(this.buttonId + "-searchbar");
        if (btn) btn.remove();
    }

    removeButton() {
        const btn = document.getElementById(this.buttonId);
        if (btn) btn.remove();
    }

    // ========== UI: SEARCH MODAL ==========

    openSearchModal() {
        const guilds = this.modules.GuildStore.getGuilds();
        const guildList = Object.values(guilds).sort((a, b) => a.name.localeCompare(b.name));

        // Create modal overlay
        const overlay = document.createElement("div");
        overlay.className = "gs-modal-overlay";
        const blurVal = this.settings.overlayBlur ?? 1;
        overlay.style.backdropFilter = `blur(${blurVal}px)`;
        overlay.style.webkitBackdropFilter = `blur(${blurVal}px)`;
        overlay.addEventListener("click", (e) => {
            if (e.target === overlay && this._closeModal) this._closeModal();
        });

        const modal = document.createElement("div");
        modal.className = "gs-modal";
        modal.style.width = `${this.settings.modalWidth || 700}px`;
        modal.style.maxHeight = `${this.settings.modalHeight || 85}vh`;

        // Header
        const header = document.createElement("div");
        header.className = "gs-modal-header";
        header.innerHTML = `
            <h2>Busca Global</h2>
            <div class="gs-header-actions">
                <div class="gs-settings-btn" id="gs-settings-btn" title="Configuracoes">&#9881;</div>
                <div class="gs-close" id="gs-close-btn">&times;</div>
            </div>
        `;

        // Settings panel (hidden by default)
        const settingsPanel = document.createElement("div");
        settingsPanel.className = "gs-settings-panel";
        settingsPanel.style.display = "none";

        const buildSettingsPanel = () => {
            settingsPanel.innerHTML = "";

            const makeRow = (label, inputEl, helpText) => {
                const row = document.createElement("div");
                row.className = "gs-settings-row";
                const lbl = document.createElement("label");
                lbl.className = "gs-settings-label";
                lbl.textContent = label;
                row.append(lbl, inputEl);
                if (helpText) {
                    const help = document.createElement("span");
                    help.className = "gs-settings-help";
                    help.textContent = helpText;
                    row.appendChild(help);
                }
                return row;
            };

            // Parallel searches
            const parallelInput = document.createElement("input");
            parallelInput.type = "number";
            parallelInput.min = "1";
            parallelInput.max = "6";
            parallelInput.value = this.settings.parallelSearches;
            parallelInput.className = "gs-settings-input";
            parallelInput.addEventListener("change", () => {
                this.settings.parallelSearches = Math.max(1, Math.min(6, parseInt(parallelInput.value) || 2));
                parallelInput.value = this.settings.parallelSearches;
                this.saveSettings();
            });

            // Manual delay checkbox
            const manualDelayWrap = document.createElement("div");
            manualDelayWrap.className = "gs-settings-row";
            const manualCheckbox = document.createElement("input");
            manualCheckbox.type = "checkbox";
            manualCheckbox.checked = this.settings.manualDelay;
            manualCheckbox.style.cssText = "margin-right:8px;cursor:pointer;";
            const manualLabel = document.createElement("label");
            manualLabel.style.cssText = "cursor:pointer;display:flex;align-items:center;";
            manualLabel.append(manualCheckbox);
            manualLabel.append(document.createTextNode("Configurar delay manualmente"));
            const manualHelp = document.createElement("span");
            manualHelp.className = "gs-settings-help";
            manualHelp.textContent = "Padrao: 450ms, 25% jitter";
            manualDelayWrap.append(manualLabel, manualHelp);

            // Search delay (manual)
            const delayInput = document.createElement("input");
            delayInput.type = "number";
            delayInput.min = "450";
            delayInput.max = "3000";
            delayInput.step = "50";
            delayInput.value = this.settings.searchDelay;
            delayInput.className = "gs-settings-input";
            delayInput.disabled = !this.settings.manualDelay;
            delayInput.addEventListener("change", () => {
                this.settings.searchDelay = Math.max(450, Math.min(3000, parseInt(delayInput.value) || 450));
                delayInput.value = this.settings.searchDelay;
                this.saveSettings();
            });

            // Jitter % (manual)
            const jitterInput = document.createElement("input");
            jitterInput.type = "number";
            jitterInput.min = "0";
            jitterInput.max = "100";
            jitterInput.step = "5";
            jitterInput.value = this.settings.jitterPct;
            jitterInput.className = "gs-settings-input";
            jitterInput.disabled = !this.settings.manualDelay;
            jitterInput.addEventListener("change", () => {
                this.settings.jitterPct = Math.max(0, Math.min(100, parseInt(jitterInput.value) || 25));
                jitterInput.value = this.settings.jitterPct;
                this.saveSettings();
            });

            const delayRow = makeRow("Delay base (ms):", delayInput, "Minimo 450ms");
            const jitterRow = makeRow("Jitter (%):", jitterInput, "Variacao pra cima sobre o delay base");

            manualCheckbox.addEventListener("change", () => {
                this.settings.manualDelay = manualCheckbox.checked;
                delayInput.disabled = !manualCheckbox.checked;
                jitterInput.disabled = !manualCheckbox.checked;
                delayRow.style.opacity = manualCheckbox.checked ? "1" : "0.4";
                jitterRow.style.opacity = manualCheckbox.checked ? "1" : "0.4";
                this.saveSettings();
            });
            delayRow.style.opacity = this.settings.manualDelay ? "1" : "0.4";
            jitterRow.style.opacity = this.settings.manualDelay ? "1" : "0.4";

            // Max results per guild
            const maxResultsInput = document.createElement("input");
            maxResultsInput.type = "number";
            maxResultsInput.min = "1";
            maxResultsInput.max = "100";
            maxResultsInput.value = this.settings.maxResultsPerGuild;
            maxResultsInput.className = "gs-settings-input";
            maxResultsInput.addEventListener("change", () => {
                this.settings.maxResultsPerGuild = Math.max(1, Math.min(100, parseInt(maxResultsInput.value) || 25));
                maxResultsInput.value = this.settings.maxResultsPerGuild;
                this.saveSettings();
            });

            const title = document.createElement("div");
            title.className = "gs-settings-title";
            title.textContent = "Configuracoes";

            // Modal width
            const widthInput = document.createElement("input");
            widthInput.type = "number";
            widthInput.min = "400";
            widthInput.max = "1400";
            widthInput.step = "50";
            widthInput.value = this.settings.modalWidth || 700;
            widthInput.className = "gs-settings-input";
            widthInput.addEventListener("change", () => {
                this.settings.modalWidth = Math.max(400, Math.min(1400, parseInt(widthInput.value) || 700));
                widthInput.value = this.settings.modalWidth;
                modal.style.width = `${this.settings.modalWidth}px`;
                this.saveSettings();
            });

            // Modal height
            const heightInput = document.createElement("input");
            heightInput.type = "number";
            heightInput.min = "40";
            heightInput.max = "98";
            heightInput.step = "5";
            heightInput.value = this.settings.modalHeight || 85;
            heightInput.className = "gs-settings-input";
            heightInput.addEventListener("change", () => {
                this.settings.modalHeight = Math.max(40, Math.min(98, parseInt(heightInput.value) || 85));
                heightInput.value = this.settings.modalHeight;
                modal.style.maxHeight = `${this.settings.modalHeight}vh`;
                this.saveSettings();
            });

            // Overlay blur
            const blurInput = document.createElement("input");
            blurInput.type = "number";
            blurInput.min = "0";
            blurInput.max = "40";
            blurInput.step = "1";
            blurInput.value = this.settings.overlayBlur ?? 1;
            blurInput.className = "gs-settings-input";
            blurInput.addEventListener("change", () => {
                this.settings.overlayBlur = Math.max(0, Math.min(40, parseInt(blurInput.value) || 0));
                blurInput.value = this.settings.overlayBlur;
                overlay.style.backdropFilter = `blur(${this.settings.overlayBlur}px)`;
                overlay.style.webkitBackdropFilter = `blur(${this.settings.overlayBlur}px)`;
                this.saveSettings();
            });

            // Reset button
            const resetBtn = document.createElement("button");
            resetBtn.textContent = "Restaurar padrao";
            resetBtn.className = "gs-settings-reset-btn";
            resetBtn.addEventListener("click", () => {
                const defaults = { parallelSearches: 4, searchDelay: 450, manualDelay: false, jitterPct: 25, maxResultsPerGuild: 25, modalWidth: 700, modalHeight: 85, overlayBlur: 1, showImagePreviews: true, showHasFilters: true, theme: "dark", cacheMinutes: 10 };
                Object.assign(this.settings, defaults);
                this.saveSettings();
                modal.style.width = `${defaults.modalWidth}px`;
                modal.style.maxHeight = `${defaults.modalHeight}vh`;
                overlay.style.backdropFilter = `blur(${defaults.overlayBlur}px)`;
                overlay.style.webkitBackdropFilter = `blur(${defaults.overlayBlur}px)`;
                this._applyTheme();
                buildSettingsPanel();
            });

            // Image previews toggle
            const previewCheck = document.createElement("input");
            previewCheck.type = "checkbox";
            previewCheck.checked = this.settings.showImagePreviews;
            previewCheck.style.cssText = "margin-right:8px;cursor:pointer;";
            const previewLabel = document.createElement("label");
            previewLabel.style.cssText = "cursor:pointer;display:flex;align-items:center;";
            previewLabel.append(previewCheck, document.createTextNode("Preview de imagens nos resultados"));
            const previewRow = document.createElement("div");
            previewRow.className = "gs-settings-row";
            previewRow.appendChild(previewLabel);
            previewCheck.addEventListener("change", () => {
                this.settings.showImagePreviews = previewCheck.checked;
                this.saveSettings();
            });

            // Has filters toggle
            const hasFilterCheck = document.createElement("input");
            hasFilterCheck.type = "checkbox";
            hasFilterCheck.checked = this.settings.showHasFilters;
            hasFilterCheck.style.cssText = "margin-right:8px;cursor:pointer;";
            const hasFilterLabel = document.createElement("label");
            hasFilterLabel.style.cssText = "cursor:pointer;display:flex;align-items:center;";
            hasFilterLabel.append(hasFilterCheck, document.createTextNode("Mostrar filtros de anexo/imagem/link"));
            const hasFilterRow = document.createElement("div");
            hasFilterRow.className = "gs-settings-row";
            hasFilterRow.appendChild(hasFilterLabel);
            hasFilterCheck.addEventListener("change", () => {
                this.settings.showHasFilters = hasFilterCheck.checked;
                this.saveSettings();
                const hasArea = document.querySelector(".gs-has-area");
                if (hasArea) hasArea.style.display = this.settings.showHasFilters ? "flex" : "none";
            });

            // Theme selector
            const themeSelect = document.createElement("select");
            themeSelect.className = "gs-settings-input";
            themeSelect.style.width = "120px";
            for (const [val, label] of [["dark", "Escuro"], ["light", "Claro"], ["auto", "Auto (Discord)"]]) {
                const opt = document.createElement("option");
                opt.value = val;
                opt.textContent = label;
                if (this.settings.theme === val) opt.selected = true;
                themeSelect.appendChild(opt);
            }
            themeSelect.addEventListener("change", () => {
                this.settings.theme = themeSelect.value;
                this.saveSettings();
                this._applyTheme();
            });

            // Cache minutes
            const cacheInput = document.createElement("input");
            cacheInput.type = "number";
            cacheInput.min = "0";
            cacheInput.max = "60";
            cacheInput.step = "1";
            cacheInput.value = this.settings.cacheMinutes || 10;
            cacheInput.className = "gs-settings-input";
            cacheInput.addEventListener("change", () => {
                this.settings.cacheMinutes = Math.max(0, Math.min(60, parseInt(cacheInput.value) || 0));
                cacheInput.value = this.settings.cacheMinutes;
                if (this.settings.cacheMinutes === 0) this._resultCache.clear();
                this.saveSettings();
            });

            settingsPanel.append(
                title,
                makeRow("Buscas paralelas:", parallelInput, "Mais = rapido, mas mais captcha (1-6)"),
                makeRow("Max resultados por servidor:", maxResultsInput, "Limite por servidor/DM (1-100)"),
                manualDelayWrap,
                delayRow,
                jitterRow,
                makeRow("Largura do modal (px):", widthInput, "400-1400px"),
                makeRow("Altura do modal (vh):", heightInput, "40-98% da tela"),
                makeRow("Blur do fundo (px):", blurInput, "0 = sem blur, 20 = forte"),
                makeRow("Tema:", themeSelect, "Escuro por padrao"),
                makeRow("Cache de resultados (min):", cacheInput, "0 = desabilitado"),
                previewRow,
                hasFilterRow,
                resetBtn
            );
        };

        header.querySelector("#gs-settings-btn").addEventListener("click", () => {
            if (settingsPanel.style.display === "none") {
                buildSettingsPanel();
                settingsPanel.style.display = "block";
            } else {
                settingsPanel.style.display = "none";
            }
        });

        // Search input area
        const searchArea = document.createElement("div");
        searchArea.className = "gs-search-area";

        const searchInput = document.createElement("input");
        searchInput.type = "text";
        searchInput.className = "gs-search-input";
        searchInput.placeholder = "Digite sua busca... (ex: dragon canneloni, from:usuario)";
        searchInput.autofocus = true;

        const searchBtn = document.createElement("button");
        searchBtn.className = "gs-search-btn";
        searchBtn.textContent = "Buscar";

        // Refresh button (incremental update)
        const refreshBtn = document.createElement("button");
        refreshBtn.className = "gs-refresh-btn";
        refreshBtn.textContent = "Atualizar";
        refreshBtn.title = "Busca apenas mensagens novas desde a ultima pesquisa deste termo";

        searchArea.append(searchInput, searchBtn, refreshBtn);

        // Has filters (image/file/link)
        const hasArea = document.createElement("div");
        hasArea.className = "gs-has-area";
        hasArea.style.display = this.settings.showHasFilters ? "flex" : "none";
        const hasFilters = [
            { key: "image", label: "Imagem", icon: "\uD83D\uDDBC\uFE0F" },
            { key: "file", label: "Arquivo", icon: "\uD83D\uDCCE" },
            { key: "link", label: "Link", icon: "\uD83D\uDD17" }
        ];
        for (const hf of hasFilters) {
            const btn = document.createElement("button");
            btn.className = "gs-has-btn" + (this._hasFilters[hf.key] ? " gs-has-btn-active" : "");
            btn.textContent = `${hf.icon} ${hf.label}`;
            btn.title = `Filtrar mensagens com ${hf.label.toLowerCase()}`;
            btn.addEventListener("click", () => {
                this._hasFilters[hf.key] = !this._hasFilters[hf.key];
                btn.classList.toggle("gs-has-btn-active", this._hasFilters[hf.key]);
            });
            hasArea.appendChild(btn);
        }

        // Search history dropdown
        const historyWrapper = document.createElement("div");
        historyWrapper.className = "gs-history-wrapper";

        const historyDropdown = document.createElement("div");
        historyDropdown.className = "gs-history-dropdown";
        historyDropdown.style.display = "none";

        // Helper to restore a history/archived entry into the modal
        const restoreEntry = (entry) => {
            searchInput.value = entry.query;
            if (entry.variants && entry.variants.length > 0) {
                fuzzyInput.value = entry.variants.join(", ");
            }
            if (entry.excludeWords && entry.excludeWords.length > 0) {
                excludeInput.value = entry.excludeWords.join(", ");
            }
            historyDropdown.style.display = "none";
            // Restore channel filter state from history entry
            this._activeChannelFilter = entry.channelFilter || null;
            this._excludedChannels = new Set(entry.excludedChannels || []);
            if (entry.results && entry.results.length > 0) {
                this._lastResults = entry.results;
                this._lastQuery = entry.query;
                progressArea.style.display = "block";
                const date = new Date(entry.timestamp);
                const dateStr = date.toLocaleDateString("pt-BR") + " " + date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
                progressArea.innerHTML = `<span>Historico: "${this.escapeHtml(entry.query)}" — ${entry.resultCount} resultado(s) de ${dateStr}</span>`;
                this.renderResults(resultsArea, entry.results, overlay);
            }
            if (entry.guildIds) {
                guildCheckboxes.forEach(cb => { cb.checked = false; });
                for (const id of entry.guildIds) {
                    if (guildIdToCheckbox[id]) guildIdToCheckbox[id].checked = true;
                }
                updateCount();
            }
        };

        const buildHistoryDropdown = () => {
            historyDropdown.innerHTML = "";
            const hasHistory = this._searchHistory.length > 0;
            const hasArchived = this._archivedSearches.length > 0;

            if (!hasHistory && !hasArchived) {
                historyDropdown.innerHTML = `<div class="gs-history-empty">Nenhuma pesquisa anterior</div>`;
                return;
            }

            // Archived section (shown first if there are archives)
            if (hasArchived) {
                const archHeader = document.createElement("div");
                archHeader.className = "gs-history-header gs-archive-header";
                archHeader.innerHTML = `<span>\u2605 Arquivados (${this._archivedSearches.length})</span>`;
                historyDropdown.appendChild(archHeader);

                for (const entry of this._archivedSearches) {
                    const item = document.createElement("div");
                    item.className = "gs-history-item gs-archived-item";
                    const date = new Date(entry.archivedAt || entry.timestamp);
                    const dateStr = date.toLocaleDateString("pt-BR") + " " + date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
                    item.innerHTML = `
                        <span class="gs-history-query">\u2605 ${this.escapeHtml(entry.query)}</span>
                        <span class="gs-history-meta">${entry.resultCount} result. | ${dateStr}</span>
                    `;
                    item.addEventListener("click", () => restoreEntry(entry));

                    // Action buttons container
                    const actions = document.createElement("div");
                    actions.className = "gs-history-actions";

                    // Unarchive button
                    const unarchBtn = document.createElement("button");
                    unarchBtn.className = "gs-history-archive gs-history-archive-active";
                    unarchBtn.innerHTML = "\u2605";
                    unarchBtn.title = "Remover dos arquivos";
                    unarchBtn.addEventListener("click", (e) => {
                        e.stopPropagation();
                        this.unarchiveSearch(entry.query);
                        buildHistoryDropdown();
                        BdApi.UI.showToast(`"${entry.query}" removido dos arquivos.`, { type: "info" });
                    });
                    actions.appendChild(unarchBtn);
                    item.appendChild(actions);
                    historyDropdown.appendChild(item);
                }
            }

            if (!hasHistory) return;

            // History header with clear button and storage size
            const storageInfo = this.getStorageSize();
            const histHeader = document.createElement("div");
            histHeader.className = "gs-history-header";
            histHeader.innerHTML = `<span>Historico de buscas <span class="gs-storage-size" title="Historico: ${storageInfo.history} | Arquivados: ${storageInfo.archived}">(${storageInfo.total})</span></span>`;
            const clearBtn = document.createElement("button");
            clearBtn.className = "gs-history-clear";
            clearBtn.textContent = "Limpar";
            clearBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                this.clearHistory();
                buildHistoryDropdown();
                BdApi.UI.showToast("Historico limpo!", { type: "info" });
            });
            histHeader.appendChild(clearBtn);
            historyDropdown.appendChild(histHeader);

            for (const entry of this._searchHistory.slice(0, 15)) {
                const item = document.createElement("div");
                item.className = "gs-history-item";
                const date = new Date(entry.timestamp);
                const dateStr = date.toLocaleDateString("pt-BR") + " " + date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
                item.innerHTML = `
                    <span class="gs-history-query">${this.escapeHtml(entry.query)}</span>
                    <span class="gs-history-meta">${entry.resultCount} result. | ${dateStr}</span>
                `;
                item.addEventListener("click", () => restoreEntry(entry));

                // Action buttons container
                const actions = document.createElement("div");
                actions.className = "gs-history-actions";

                // Archive button (star toggle)
                const archiveBtn = document.createElement("button");
                const isArchived = this._archivedSearches.some(a => a.query === entry.query);
                archiveBtn.className = "gs-history-archive" + (isArchived ? " gs-history-archive-active" : "");
                archiveBtn.innerHTML = isArchived ? "\u2605" : "\u2606";
                archiveBtn.title = isArchived ? "Ja arquivado" : "Arquivar busca";
                archiveBtn.addEventListener("click", (e) => {
                    e.stopPropagation();
                    if (isArchived) {
                        this.unarchiveSearch(entry.query);
                        BdApi.UI.showToast(`"${entry.query}" removido dos arquivos.`, { type: "info" });
                    } else {
                        this.archiveSearch(entry);
                        BdApi.UI.showToast(`"${entry.query}" arquivado!`, { type: "success" });
                    }
                    buildHistoryDropdown();
                });
                actions.appendChild(archiveBtn);

                // Delete button
                const deleteBtn = document.createElement("button");
                deleteBtn.className = "gs-history-delete";
                deleteBtn.innerHTML = "&times;";
                deleteBtn.title = "Remover do historico";
                deleteBtn.addEventListener("click", (e) => {
                    e.stopPropagation();
                    this.deleteHistoryEntry(entry.query);
                    buildHistoryDropdown();
                    BdApi.UI.showToast(`"${entry.query}" removido do historico.`, { type: "info" });
                });
                actions.appendChild(deleteBtn);

                item.appendChild(actions);
                historyDropdown.appendChild(item);
            }
        };

        // Show/hide history on focus/blur
        searchInput.addEventListener("focus", () => {
            buildHistoryDropdown();
            if (this._searchHistory.length > 0 || this._archivedSearches.length > 0) {
                historyDropdown.style.display = "block";
            }
        });
        searchInput.addEventListener("input", () => {
            const val = searchInput.value.toLowerCase();
            if (!val) {
                buildHistoryDropdown();
                historyDropdown.style.display = (this._searchHistory.length > 0 || this._archivedSearches.length > 0) ? "block" : "none";
                return;
            }
            // Filter history items
            buildHistoryDropdown();
            const items = historyDropdown.querySelectorAll(".gs-history-item");
            let visible = 0;
            items.forEach(item => {
                const q = item.querySelector(".gs-history-query")?.textContent?.toLowerCase() || "";
                const match = q.includes(val);
                item.style.display = match ? "" : "none";
                if (match) visible++;
            });
            historyDropdown.style.display = visible > 0 ? "block" : "none";
        });
        // Hide dropdown when clicking elsewhere
        overlay.addEventListener("click", (e) => {
            if (!historyWrapper.contains(e.target) && e.target !== searchInput) {
                historyDropdown.style.display = "none";
            }
        });

        historyWrapper.append(historyDropdown);

        // Period selector
        const periodArea = document.createElement("div");
        periodArea.className = "gs-period-area";

        const periodLabel = document.createElement("span");
        periodLabel.className = "gs-period-label";
        periodLabel.textContent = "Periodo:";

        const periodSelect = document.createElement("select");
        periodSelect.className = "gs-period-select";
        const periods = [
            { value: "10m", label: "Ultimos 10 minutos" },
            { value: "30m", label: "Ultimos 30 minutos" },
            { value: "1h", label: "Ultima 1 hora" },
            { value: "3h", label: "Ultimas 3 horas" },
            { value: "6h", label: "Ultimas 6 horas" },
            { value: "12h", label: "Ultimas 12 horas" },
            { value: "24h", label: "Ultimas 24 horas" },
            { value: "48h", label: "Ultimas 48 horas" },
            { value: "7d", label: "Ultimos 7 dias" },
            { value: "30d", label: "Ultimos 30 dias" },
            { value: "90d", label: "Ultimos 90 dias" },
            { value: "365d", label: "Ultimo ano" },
            { value: "all", label: "Todos (sem limite)" }
        ];
        for (const p of periods) {
            const opt = document.createElement("option");
            opt.value = p.value;
            opt.textContent = p.label;
            if (p.value === "12h") opt.selected = true;
            periodSelect.appendChild(opt);
        }

        // Auto-refresh toggle
        const autoRefreshLabel = document.createElement("label");
        autoRefreshLabel.className = "gs-auto-refresh-toggle";
        const autoRefreshCb = document.createElement("input");
        autoRefreshCb.type = "checkbox";
        autoRefreshCb.checked = this.settings.autoRefresh;
        autoRefreshCb.addEventListener("change", () => {
            this.settings.autoRefresh = autoRefreshCb.checked;
            this.saveSettings();
        });
        const autoRefreshText = document.createElement("span");
        autoRefreshText.textContent = "Auto-refresh";
        autoRefreshText.title = "Atualiza automaticamente quando o Discord perde foco (alt-tab)";
        autoRefreshLabel.append(autoRefreshCb, autoRefreshText);

        periodArea.append(periodLabel, periodSelect, autoRefreshLabel);

        // Fuzzy / custom variants area
        const fuzzyArea = document.createElement("div");
        fuzzyArea.className = "gs-fuzzy-area";

        const fuzzyLabel = document.createElement("span");
        fuzzyLabel.className = "gs-period-label";
        fuzzyLabel.textContent = "Tambem buscar:";

        const fuzzyInput = document.createElement("input");
        fuzzyInput.type = "text";
        fuzzyInput.className = "gs-fuzzy-input";
        fuzzyInput.placeholder = "variantes separadas por virgula (ex: cannelloni, caneloni, canelloni)";
        fuzzyInput.value = (this.settings.fuzzyTerms || []).join(", ");

        const fuzzyHelp = document.createElement("span");
        fuzzyHelp.className = "gs-exclude-help";
        fuzzyHelp.textContent = "Cada variante sera buscada como termo separado nos servidores";

        fuzzyArea.append(fuzzyLabel, fuzzyInput, fuzzyHelp);

        // Exclude words filter
        const excludeArea = document.createElement("div");
        excludeArea.className = "gs-exclude-area";

        const excludeLabel = document.createElement("span");
        excludeLabel.className = "gs-period-label";
        excludeLabel.textContent = "Excluir palavras:";

        const excludeInput = document.createElement("input");
        excludeInput.type = "text";
        excludeInput.className = "gs-exclude-input";
        excludeInput.placeholder = "ex: buy, sell, trade (separadas por virgula)";
        excludeInput.value = (this.settings.excludeWords || []).join(", ");

        const excludeHelp = document.createElement("span");
        excludeHelp.className = "gs-exclude-help";
        excludeHelp.textContent = "Mensagens com essas palavras serao removidas dos resultados";

        excludeArea.append(excludeLabel, excludeInput, excludeHelp);

        // Search scope toggles (Servidores / DMs)
        const scopeArea = document.createElement("div");
        scopeArea.className = "gs-scope-area";

        const scopeLabel = document.createElement("span");
        scopeLabel.className = "gs-period-label";
        scopeLabel.textContent = "Buscar em:";

        const serverToggle = document.createElement("button");
        serverToggle.className = "gs-scope-btn gs-scope-btn-active";
        serverToggle.textContent = "Servidores";

        const dmToggle = document.createElement("button");
        dmToggle.className = "gs-scope-btn";
        dmToggle.textContent = "DMs";

        scopeArea.append(scopeLabel, serverToggle, dmToggle);

        // Guild selector
        const guildSection = document.createElement("div");
        guildSection.className = "gs-guild-section";

        // --- Folder quick-select buttons ---
        const folders = this.getGuildFolders();
        const folderArea = document.createElement("div");
        folderArea.className = "gs-folder-area";

        const guildCheckboxes = [];
        const guildLabels = [];
        const guildIdToCheckbox = {};

        // Helper to update checkboxes by guild IDs (respects blocklist)
        const setGuildsChecked = (guildIds, checked) => {
            for (const id of guildIds) {
                const cb = guildIdToCheckbox[id];
                if (cb && !cb.disabled) cb.checked = checked;
            }
        };

        // "Todos" button
        const allBtn = document.createElement("button");
        allBtn.className = "gs-folder-btn";
        allBtn.textContent = `Todos (${guildList.length})`;
        allBtn.addEventListener("click", () => {
            guildCheckboxes.forEach(cb => { if (!cb.disabled) cb.checked = true; });
            updateCount();
        });
        folderArea.appendChild(allBtn);

        // "Nenhum" button
        const noneBtn = document.createElement("button");
        noneBtn.className = "gs-folder-btn";
        noneBtn.textContent = "Nenhum";
        noneBtn.addEventListener("click", () => {
            guildCheckboxes.forEach(cb => { cb.checked = false; });
            updateCount();
        });
        folderArea.appendChild(noneBtn);

        // Folder buttons (toggle mode — click to add, click again to remove)
        for (const folder of folders) {
            const btn = document.createElement("button");
            btn.className = "gs-folder-btn";
            const colorHex = folder.color ? `#${folder.color.toString(16).padStart(6, "0")}` : null;
            if (colorHex) {
                btn.style.borderLeft = `3px solid ${colorHex}`;
            }
            btn.textContent = `${folder.name} (${folder.guildIds.length})`;
            btn.title = `Toggle: selecionar/desmarcar esta pasta`;
            let folderActive = false;
            btn.addEventListener("click", () => {
                folderActive = !folderActive;
                // Toggle: if activating, check this folder's guilds; if deactivating, uncheck them
                setGuildsChecked(folder.guildIds, folderActive);
                btn.classList.toggle("gs-folder-btn-active", folderActive);
                updateCount();
            });
            folderArea.appendChild(btn);
        }

        // --- Header row ---
        const guildHeader = document.createElement("div");
        guildHeader.className = "gs-guild-header";

        const guildCountSpan = document.createElement("span");
        guildCountSpan.className = "gs-guild-count";
        guildCountSpan.textContent = `0/${guildList.length} selecionados`;

        const toggleBtn = document.createElement("button");
        toggleBtn.className = "gs-toggle-guilds";
        toggleBtn.textContent = "Mostrar servidores";
        let guildsVisible = false;

        guildHeader.append(guildCountSpan, toggleBtn);

        // --- Filter input ---
        const guildFilterInput = document.createElement("input");
        guildFilterInput.type = "text";
        guildFilterInput.className = "gs-guild-filter";
        guildFilterInput.placeholder = "Filtrar servidores...";
        guildFilterInput.style.display = "none";

        // --- Guild list ---
        const guildListDiv = document.createElement("div");
        guildListDiv.className = "gs-guild-list";
        guildListDiv.style.display = "none";

        const blockedSet = new Set(this.settings.blockedGuilds || []);
        const applyBlockedVisual = (label, cb, isBlocked) => {
            label.classList.toggle("gs-guild-blocked", isBlocked);
            cb.disabled = isBlocked;
            if (isBlocked) cb.checked = false;
        };

        for (const guild of guildList) {
            const label = document.createElement("label");
            label.className = "gs-checkbox-label gs-guild-item";
            label.dataset.name = guild.name.toLowerCase();
            label.dataset.guildId = guild.id;
            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.checked = false;
            cb.dataset.guildId = guild.id;
            cb.addEventListener("change", updateCount);
            guildCheckboxes.push(cb);
            guildLabels.push(label);
            guildIdToCheckbox[guild.id] = cb;

            const icon = document.createElement("img");
            icon.className = "gs-guild-icon";
            icon.src = guild.icon
                ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=20`
                : "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjAiIGhlaWdodD0iMjAiIHZpZXdCb3g9IjAgMCAyMCAyMCIgZmlsbD0iIzcyNzY3ZCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iMjAiIGhlaWdodD0iMjAiIHJ4PSI0IiBmaWxsPSIjMzYzOTNmIi8+PHRleHQgeD0iMTAiIHk9IjE0IiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBmb250LXNpemU9IjEwIiBmaWxsPSIjZGNkZGRlIj4/PC90ZXh0Pjwvc3ZnPg==";
            icon.onerror = () => { icon.style.display = "none"; };

            // Activity dot based on last message snowflake
            const activityDot = document.createElement("span");
            activityDot.className = "gs-activity-dot";
            try {
                const GuildChannelStore = BdApi.Webpack.getStore("GuildChannelStore");
                const channels = GuildChannelStore?.getChannels?.(guild.id);
                let latestMs = 0;
                const allChannels = channels?.SELECTABLE?.map(c => c.channel) || [];
                for (const ch of allChannels) {
                    if (ch.lastMessageId) {
                        const ms = Number(BigInt(ch.lastMessageId) >> 22n) + 1420070400000;
                        if (ms > latestMs) latestMs = ms;
                    }
                }
                const daysAgo = latestMs > 0 ? (Date.now() - latestMs) / 86400000 : 999;
                activityDot.style.background = daysAgo <= 7 ? "#57f287" : daysAgo <= 30 ? "#fee75c" : "#ed4245";
                activityDot.title = latestMs > 0 ? `Ultima atividade: ${Math.floor(daysAgo)}d atras` : "Sem atividade recente";
            } catch { activityDot.style.background = "#72767d"; }

            const blockBtn = document.createElement("button");
            blockBtn.type = "button";
            blockBtn.className = "gs-block-btn";
            blockBtn.textContent = "🚫";
            blockBtn.title = "Bloquear/desbloquear servidor (nao sera pesquisado)";
            blockBtn.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();
                const nowBlocked = !blockedSet.has(guild.id);
                if (nowBlocked) blockedSet.add(guild.id);
                else blockedSet.delete(guild.id);
                applyBlockedVisual(label, cb, nowBlocked);
                this.settings.blockedGuilds = Array.from(blockedSet);
                this.saveSettings();
                updateCount();
            });

            label.append(cb, icon, activityDot, document.createTextNode(` ${guild.name}`), blockBtn);
            guildListDiv.appendChild(label);
            applyBlockedVisual(label, cb, blockedSet.has(guild.id));
        }

        function updateCount() {
            const count = guildCheckboxes.filter(cb => cb.checked).length;
            guildCountSpan.textContent = `${count}/${guildList.length} selecionados`;
        }

        // Filter guilds as user types
        guildFilterInput.addEventListener("input", () => {
            const filter = guildFilterInput.value.toLowerCase();
            for (const label of guildLabels) {
                const match = !filter || label.dataset.name.includes(filter);
                label.style.display = match ? "" : "none";
            }
        });

        toggleBtn.addEventListener("click", () => {
            guildsVisible = !guildsVisible;
            guildFilterInput.style.display = guildsVisible ? "block" : "none";
            guildListDiv.style.display = guildsVisible ? "grid" : "none";
            toggleBtn.textContent = guildsVisible ? "Ocultar servidores" : "Mostrar servidores";
            if (guildsVisible) guildFilterInput.focus();
        });

        guildSection.append(folderArea, guildHeader, guildFilterInput, guildListDiv);

        // DM selector section
        const dmSection = document.createElement("div");
        dmSection.className = "gs-guild-section";
        dmSection.style.display = "none";

        const dmCheckboxes = [];
        const dmLabels = [];
        const dmIdToCheckbox = {};
        const dmIdToChannel = {};

        const dmAllBtn = document.createElement("button");
        dmAllBtn.className = "gs-folder-btn";
        dmAllBtn.addEventListener("click", () => {
            dmCheckboxes.forEach(cb => { cb.checked = true; });
            updateDMCount();
        });

        const dmNoneBtn = document.createElement("button");
        dmNoneBtn.className = "gs-folder-btn";
        dmNoneBtn.textContent = "Nenhum";
        dmNoneBtn.addEventListener("click", () => {
            dmCheckboxes.forEach(cb => { cb.checked = false; });
            updateDMCount();
        });

        const dmFolderArea = document.createElement("div");
        dmFolderArea.className = "gs-folder-area";
        dmFolderArea.append(dmAllBtn, dmNoneBtn);

        const dmHeader = document.createElement("div");
        dmHeader.className = "gs-guild-header";
        const dmCountSpan = document.createElement("span");
        dmCountSpan.className = "gs-guild-count";
        dmCountSpan.textContent = "0/0 selecionados";

        const dmToggleBtn = document.createElement("button");
        dmToggleBtn.className = "gs-toggle-guilds";
        dmToggleBtn.textContent = "Mostrar conversas";
        let dmsVisible = false;
        dmHeader.append(dmCountSpan, dmToggleBtn);

        const dmFilterInput = document.createElement("input");
        dmFilterInput.type = "text";
        dmFilterInput.className = "gs-guild-filter";
        dmFilterInput.placeholder = "Filtrar conversas...";
        dmFilterInput.style.display = "none";

        const dmListDiv = document.createElement("div");
        dmListDiv.className = "gs-guild-list";
        dmListDiv.style.display = "none";

        const dmLoadingDiv = document.createElement("div");
        dmLoadingDiv.style.cssText = "text-align:center;color:var(--text-muted);padding:12px;font-size:13px;";
        dmLoadingDiv.textContent = "Carregando conversas...";

        function updateDMCount() {
            const count = dmCheckboxes.filter(cb => cb.checked).length;
            const total = dmCheckboxes.length;
            dmCountSpan.textContent = `${count}/${total} selecionados`;
        }

        dmFilterInput.addEventListener("input", () => {
            const filter = dmFilterInput.value.toLowerCase();
            for (const label of dmLabels) {
                const match = !filter || label.dataset.name.includes(filter);
                label.style.display = match ? "" : "none";
            }
        });

        dmToggleBtn.addEventListener("click", () => {
            dmsVisible = !dmsVisible;
            dmFilterInput.style.display = dmsVisible ? "block" : "none";
            dmListDiv.style.display = dmsVisible ? "grid" : "none";
            dmToggleBtn.textContent = dmsVisible ? "Ocultar conversas" : "Mostrar conversas";
            if (dmsVisible) dmFilterInput.focus();
        });

        dmSection.append(dmFolderArea, dmHeader, dmFilterInput, dmLoadingDiv, dmListDiv);

        const loadDMList = async () => {
            this._dmChannels = await this.getDMChannels();
            dmLoadingDiv.remove();
            dmListDiv.innerHTML = "";
            dmCheckboxes.length = 0;
            dmLabels.length = 0;

            const sorted = this._dmChannels.sort((a, b) => {
                return this.getDMChannelDisplayName(a).localeCompare(this.getDMChannelDisplayName(b));
            });

            dmAllBtn.textContent = `Todos (${sorted.length})`;

            for (const ch of sorted) {
                const displayName = this.getDMChannelDisplayName(ch);
                const avatarUrl = this.getDMChannelAvatar(ch);
                const label = document.createElement("label");
                label.className = "gs-checkbox-label gs-guild-item";
                label.dataset.name = displayName.toLowerCase();
                const cb = document.createElement("input");
                cb.type = "checkbox";
                cb.checked = false;
                cb.dataset.channelId = ch.id;
                cb.addEventListener("change", updateDMCount);
                dmCheckboxes.push(cb);
                dmLabels.push(label);
                dmIdToCheckbox[ch.id] = cb;
                dmIdToChannel[ch.id] = ch;

                const icon = document.createElement("img");
                icon.className = "gs-guild-icon";
                icon.src = avatarUrl || "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjAiIGhlaWdodD0iMjAiIHZpZXdCb3g9IjAgMCAyMCAyMCIgZmlsbD0iIzcyNzY3ZCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iMjAiIGhlaWdodD0iMjAiIHJ4PSI0IiBmaWxsPSIjMzYzOTNmIi8+PHRleHQgeD0iMTAiIHk9IjE0IiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBmb250LXNpemU9IjEwIiBmaWxsPSIjZGNkZGRlIj4/PC90ZXh0Pjwvc3ZnPg==";
                icon.onerror = () => { icon.style.display = "none"; };

                const typeTag = ch.type === 3 ? " (Grupo)" : "";
                label.append(cb, icon, document.createTextNode(` ${displayName}${typeTag}`));
                dmListDiv.appendChild(label);
            }
            updateDMCount();
        };

        // Scope toggle logic
        serverToggle.addEventListener("click", () => {
            this._searchServers = !this._searchServers;
            // Don't allow both off
            if (!this._searchServers && !this._searchDMs) {
                this._searchServers = true;
                return;
            }
            serverToggle.classList.toggle("gs-scope-btn-active", this._searchServers);
            guildSection.style.display = this._searchServers ? "" : "none";
        });

        dmToggle.addEventListener("click", async () => {
            this._searchDMs = !this._searchDMs;
            if (!this._searchServers && !this._searchDMs) {
                this._searchDMs = true;
                return;
            }
            dmToggle.classList.toggle("gs-scope-btn-active", this._searchDMs);
            dmSection.style.display = this._searchDMs ? "" : "none";
            // Load DM list on first activation
            if (this._searchDMs && dmCheckboxes.length === 0) {
                await loadDMList();
            }
        });

        // Progress area
        const progressArea = document.createElement("div");
        progressArea.className = "gs-progress";
        progressArea.style.display = "none";

        // Results area
        const resultsArea = document.createElement("div");
        resultsArea.className = "gs-results";

        // Assemble modal — everything inside a single scrollable container
        const modalScroll = document.createElement("div");
        modalScroll.className = "gs-modal-scroll";
        modalScroll.append(header, settingsPanel, searchArea, hasArea, historyWrapper, periodArea, fuzzyArea, excludeArea, scopeArea, guildSection, dmSection, progressArea, resultsArea);
        modal.appendChild(modalScroll);
        overlay.appendChild(modal);
        document.body.appendChild(overlay);
        this._applyTheme();

        // Keyboard handler: ESC, arrows, Enter on focused result
        const modalKeyHandler = (e) => {
            if (e.key === "Escape") {
                closeModal();
                return;
            }
            if (document.activeElement && (document.activeElement.tagName === "INPUT" || document.activeElement.tagName === "SELECT" || document.activeElement.tagName === "TEXTAREA")) return;
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const items = [...resultsArea.querySelectorAll(".gs-result-item")];
                if (items.length === 0) return;
                const prev = this._focusedResultIndex;
                if (prev >= 0 && items[prev]) items[prev].classList.remove("gs-result-focused");
                if (e.key === "ArrowDown") {
                    this._focusedResultIndex = prev < 0 ? 0 : Math.min(prev + 1, items.length - 1);
                } else {
                    this._focusedResultIndex = prev < 0 ? items.length - 1 : Math.max(prev - 1, 0);
                }
                items[this._focusedResultIndex].classList.add("gs-result-focused");
                items[this._focusedResultIndex].scrollIntoView({ block: "nearest", behavior: "smooth" });
            } else if (e.key === "Enter" && this._focusedResultIndex >= 0) {
                e.preventDefault();
                const items = resultsArea.querySelectorAll(".gs-result-item");
                if (items[this._focusedResultIndex]) items[this._focusedResultIndex].click();
            }
        };
        this._modalKeyHandler = modalKeyHandler;
        document.addEventListener("keydown", modalKeyHandler);

        // Close modal helper — removes overlay + cleans up key handler
        const closeModal = () => {
            overlay.remove();
            document.removeEventListener("keydown", modalKeyHandler);
            this._modalKeyHandler = null;
            this._closeModal = null;
        };
        this._closeModal = closeModal;
        header.querySelector("#gs-close-btn").addEventListener("click", closeModal);

        // Restore previous results if they exist
        if (this._lastQuery) {
            searchInput.value = this._lastQuery;
        }
        if (this._isSearching) {
            searchBtn.disabled = true;
            searchBtn.textContent = "Buscando...";
            this._updateModalProgress();
            // Show partial results found so far
            if (this._lastResults && this._lastResults.length > 0) {
                this.renderResults(resultsArea, this._lastResults, overlay);
            }
        } else if (this._lastResults && this._lastResults.length > 0) {
            progressArea.style.display = "block";
            progressArea.innerHTML = `<span>Ultima busca: "${this.escapeHtml(this._lastQuery)}" — ${this._lastResults.length} resultado(s).</span>`;
            this.renderResults(resultsArea, this._lastResults, overlay);
        }

        // Search action
        const doSearch = () => {
            const rawQuery = searchInput.value.trim();
            if (!rawQuery) return;

            // Parse from: prefix
            let authorFilter = null;
            const query = rawQuery.replace(/\bfrom:(\S+)/gi, (_, name) => {
                authorFilter = name.toLowerCase();
                return "";
            }).trim();
            if (!query) {
                BdApi.UI.showToast("Digite um termo alem de from: para buscar.", { type: "warning" });
                return;
            }
            this._authorFilter = authorFilter;

            if (this._isSearching) {
                BdApi.UI.showToast("Busca ja em andamento! Aguarde.", { type: "warning" });
                return;
            }

            const selectedGuildIds = this._searchServers
                ? guildCheckboxes.filter(cb => cb.checked).map(cb => cb.dataset.guildId)
                : [];

            const selectedDMChannels = this._searchDMs
                ? dmCheckboxes.filter(cb => cb.checked).map(cb => dmIdToChannel[cb.dataset.channelId]).filter(Boolean)
                : [];

            if (selectedGuildIds.length === 0 && selectedDMChannels.length === 0) {
                BdApi.UI.showToast("Selecione pelo menos um servidor ou conversa!", { type: "warning" });
                return;
            }

            searchBtn.disabled = true;
            searchBtn.textContent = "Buscando...";
            progressArea.style.display = "block";
            resultsArea.innerHTML = "";

            // Parse period to min_id (Discord Snowflake)
            const period = periodSelect.value;
            let minSnowflake = null;
            if (period !== "all") {
                const now = Date.now();
                let ms;
                if (period.endsWith("m")) ms = parseInt(period) * 60000;
                else if (period.endsWith("h")) ms = parseInt(period) * 3600000;
                else ms = parseInt(period) * 86400000;
                const cutoff = now - ms;
                // Discord Snowflake = (timestamp - DISCORD_EPOCH) << 22
                const DISCORD_EPOCH = 1420070400000;
                minSnowflake = String(BigInt(cutoff - DISCORD_EPOCH) << 22n);
            }

            // Parse exclude words
            const excludeWords = excludeInput.value
                .split(",")
                .map(w => w.trim().toLowerCase())
                .filter(w => w.length > 0);
            // Parse fuzzy / custom variant terms
            const fuzzyTerms = fuzzyInput.value
                .split(",")
                .map(w => w.trim())
                .filter(w => w.length > 0);
            // Save settings
            this.settings.excludeWords = excludeWords;
            this.settings.fuzzyTerms = fuzzyTerms;
            this.saveSettings();

            // Reset channel filters for new search
            this._activeChannelFilter = null;
            this._excludedChannels = new Set();
            this._isSearching = true;
            this._cancelSearch = false;
            // Start search in background (not awaited — runs independently)
            const runSearch = async () => {
                // Calculate total items for progress
                const totalItems = selectedGuildIds.length + selectedDMChannels.length;
                this._searchProgress = { completed: 0, total: totalItems, results: 0 };
                this._isPaused = false;
                this._pausedState = null;
                this._lastQuery = query;
                this._lastResults = [];
                this._excludeWords = excludeWords;
                this._filteredCount = 0;
                this._rateLimitToastShown = false;
                this._focusedResultIndex = -1;

                if (selectedGuildIds.length > 0) {
                    await this.searchMultipleGuilds(selectedGuildIds, query, minSnowflake, excludeWords, fuzzyTerms, { skipInit: true });
                }
                if (selectedDMChannels.length > 0 && !this._cancelSearch && !this._isPaused) {
                    // Update progress total to include DMs
                    this._searchProgress.total = totalItems;
                    this._searchProgress.completed = selectedGuildIds.length;
                    await this.searchMultipleChannels(selectedDMChannels, query, minSnowflake, excludeWords, fuzzyTerms);
                }

                if (!this._cancelSearch && !this._isPaused) {
                    this._isSearching = false;
                    this._updateModalDone();
                    this.addToHistory({
                        query, variants: fuzzyTerms, excludeWords,
                        guildIds: selectedGuildIds,
                        dmChannelIds: selectedDMChannels.map(ch => ch.id),
                        searchMode: { servers: this._searchServers, dms: this._searchDMs },
                        timestamp: Date.now(),
                        resultCount: this._lastResults.length,
                        results: this._lastResults,
                        channelFilter: this._activeChannelFilter,
                        excludedChannels: [...this._excludedChannels]
                    });
                }
            };
            runSearch();
        };

        searchBtn.addEventListener("click", doSearch);
        searchInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                historyDropdown.style.display = "none";
                doSearch();
            }
        });

        // Refresh button — incremental search from last history timestamp
        refreshBtn.addEventListener("click", () => {
            const query = searchInput.value.trim();
            if (!query) return;
            const histEntry = this.getHistoryEntry(query);
            if (!histEntry) {
                BdApi.UI.showToast("Nenhuma busca anterior para esse termo. Use 'Buscar' primeiro.", { type: "warning" });
                return;
            }
            if (this._isSearching) {
                BdApi.UI.showToast("Busca ja em andamento!", { type: "warning" });
                return;
            }

            refreshBtn.disabled = true;
            refreshBtn.classList.add("gs-refresh-btn-loading");
            refreshBtn.textContent = "Atualizando...";
            progressArea.style.display = "block";
            progressArea.style.opacity = "1";
            progressArea.style.transition = "";
            const totalGuilds = (histEntry.guildIds || []).length;
            progressArea.innerHTML = `<span>Atualizando 0/${totalGuilds} servidores... (+0 novos)</span><div class="gs-progress-bar-bg"><div class="gs-progress-bar" style="width:0%"></div></div>`;

            const onProgress = (done, total, newCount) => {
                const pct = total > 0 ? Math.round((done / total) * 100) : 0;
                progressArea.innerHTML = `<span>Atualizando ${done}/${total} servidores... (+${newCount} novos)</span><div class="gs-progress-bar-bg"><div class="gs-progress-bar" style="width:${pct}%"></div></div>`;
            };

            this._runAutoRefresh(histEntry, onProgress).then(() => {
                refreshBtn.disabled = false;
                refreshBtn.classList.remove("gs-refresh-btn-loading");
                const oldCount = histEntry.resultCount || 0;
                const newTotal = this._lastResults ? this._lastResults.length : 0;
                const diff = newTotal - oldCount;
                if (this._lastResults) {
                    this.renderResults(resultsArea, this._lastResults, overlay);
                }
                if (diff > 0) {
                    refreshBtn.textContent = `\u2713 +${diff} novos`;
                    refreshBtn.classList.add("gs-refresh-btn-done");
                    progressArea.innerHTML = `<span class="gs-done-success">\u2713 Atualizado! +${diff} novo(s), ${newTotal} total.</span>`;
                    BdApi.UI.showToast(`Atualizado: +${diff} novo(s) resultado(s).`, { type: "success" });
                } else {
                    refreshBtn.textContent = "\u2713 Em dia";
                    refreshBtn.classList.add("gs-refresh-btn-nochange");
                    progressArea.innerHTML = `<span class="gs-done-nochange">Nenhuma novidade. ${newTotal} resultado(s) total.</span>`;
                    BdApi.UI.showToast("Nenhuma novidade encontrada.", { type: "info" });
                }
                setTimeout(() => {
                    refreshBtn.textContent = "Atualizar";
                    refreshBtn.classList.remove("gs-refresh-btn-done", "gs-refresh-btn-nochange");
                }, 4000);
                setTimeout(() => {
                    progressArea.style.transition = "opacity 0.8s ease";
                    progressArea.style.opacity = "0";
                }, 5000);
            });
        });

        // Restore paused search state if exists
        if (this._isPaused && this._pausedState) {
            searchInput.value = this._pausedState.query;
            if (this._pausedState.customVariants && this._pausedState.customVariants.length > 0) {
                fuzzyInput.value = this._pausedState.customVariants.join(", ");
            }
            if (this._pausedState.excludeWords && this._pausedState.excludeWords.length > 0) {
                excludeInput.value = this._pausedState.excludeWords.join(", ");
            }
            this._lastResults = this._pausedState.partialResults;
            this._lastQuery = this._pausedState.query;
            if (this._pausedState.guildIds) {
                guildCheckboxes.forEach(cb => { cb.checked = false; });
                for (const id of this._pausedState.guildIds) {
                    if (guildIdToCheckbox[id]) guildIdToCheckbox[id].checked = true;
                }
                updateCount();
            }
            progressArea.style.display = "block";
            this._updateModalPaused();
            if (this._lastResults && this._lastResults.length > 0) {
                this.renderResults(resultsArea, this._lastResults, overlay);
            }
        }

        // Focus input
        setTimeout(() => searchInput.focus(), 100);
    }

    renderResults(container, results, overlay) {
        container.innerHTML = "";

        if (results.length === 0) {
            container.innerHTML = `<div class="gs-no-results">Nenhuma mensagem encontrada.</div>`;
            return;
        }

        // View mode selector
        const viewBar = document.createElement("div");
        viewBar.className = "gs-view-bar";

        const viewLabel = document.createElement("span");
        viewLabel.className = "gs-view-label";
        viewLabel.textContent = "Visualizacao:";

        const modes = [
            { key: "compact", label: "Compacta" },
            { key: "traditional", label: "Tradicional" },
            { key: "detailed", label: "Detalhada" }
        ];

        const viewBtns = [];
        for (const mode of modes) {
            const btn = document.createElement("button");
            btn.className = "gs-view-btn" + (this.settings.viewMode === mode.key ? " gs-view-btn-active" : "");
            btn.textContent = mode.label;
            btn.dataset.mode = mode.key;
            btn.addEventListener("click", () => {
                this.settings.viewMode = mode.key;
                this.saveSettings();
                viewBtns.forEach(b => b.classList.toggle("gs-view-btn-active", b.dataset.mode === mode.key));
                this._renderResultItems(resultsList, results);
            });
            viewBtns.push(btn);
            viewBar.appendChild(btn);
        }

        // Separator before find button
        const separator = document.createElement("span");
        separator.className = "gs-view-separator";
        separator.textContent = "|";
        viewBar.appendChild(separator);

        // Find in results button
        const findBtn = document.createElement("button");
        findBtn.className = "gs-view-btn gs-find-toggle-btn";
        findBtn.textContent = "\uD83D\uDD0D Buscar";
        findBtn.title = "Buscar nos resultados";
        viewBar.appendChild(findBtn);

        // Channel filter dropdown
        const channelMap = new Map();
        for (const msg of results) {
            const key = `${msg.guildId}:${msg.channelId}`;
            if (!channelMap.has(key)) {
                channelMap.set(key, { guildName: msg.guildName, channelName: msg.channelName, channelId: msg.channelId, guildId: msg.guildId, count: 0 });
            }
            channelMap.get(key).count++;
        }

        const channelFilterBtn = document.createElement("button");
        channelFilterBtn.className = "gs-view-btn gs-channel-filter-btn";
        channelFilterBtn.title = "Filtrar por canal";
        viewBar.appendChild(channelFilterBtn);

        // Restore button label from persisted state
        if (this._activeChannelFilter) {
            const chInfo = channelMap.get(this._activeChannelFilter);
            channelFilterBtn.textContent = chInfo ? `#${chInfo.channelName}` : "#\uFE0F\u20E3 Canal";
            channelFilterBtn.classList.add("gs-view-btn-active");
        } else if (this._excludedChannels.size > 0) {
            channelFilterBtn.textContent = `#\uFE0F\u20E3 -${this._excludedChannels.size}`;
            channelFilterBtn.classList.add("gs-view-btn-active");
        } else {
            channelFilterBtn.textContent = "#\uFE0F\u20E3 Canal";
        }

        const countLabel = document.createElement("span");
        countLabel.className = "gs-result-count";
        countLabel.textContent = `${results.length} resultado(s)`;

        // Export button
        const exportBtn = document.createElement("button");
        exportBtn.className = "gs-view-btn";
        exportBtn.textContent = "\u2B07 Exportar";
        exportBtn.title = "Exportar resultados";
        exportBtn.addEventListener("click", () => {
            const exportDrop = document.createElement("div");
            exportDrop.className = "gs-export-dropdown";
            const jsonOpt = document.createElement("div");
            jsonOpt.className = "gs-export-option";
            jsonOpt.textContent = "JSON";
            jsonOpt.dataset.fmt = "json";
            const csvOpt = document.createElement("div");
            csvOpt.className = "gs-export-option";
            csvOpt.textContent = "CSV";
            csvOpt.dataset.fmt = "csv";
            exportDrop.append(jsonOpt, csvOpt);
            exportBtn.style.position = "relative";
            exportBtn.appendChild(exportDrop);
            exportDrop.addEventListener("click", (ev) => {
                const fmt = ev.target.dataset.fmt;
                if (!fmt) return;
                ev.stopPropagation();
                let blob, filename;
                const qname = this._lastQuery || "export";
                if (fmt === "json") {
                    blob = new Blob([JSON.stringify(results, null, 2)], { type: "application/json" });
                    filename = "busca-" + qname + "-" + Date.now() + ".json";
                } else {
                    const esc = (s) => '"' + (s || "").replace(/"/g, '""') + '"';
                    const header = "id,autor,data,servidor,canal,conteudo,anexos\n";
                    const rows = results.map(r =>
                        r.id + "," + esc(r.author) + "," + esc(r.timestamp) + "," + esc(r.guildName) + "," + esc(r.channelName) + "," + esc(r.content) + "," + (r.attachments ? r.attachments.length : 0)
                    ).join("\n");
                    blob = new Blob([header + rows], { type: "text/csv" });
                    filename = "busca-" + qname + "-" + Date.now() + ".csv";
                }
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url; a.download = filename; a.click();
                URL.revokeObjectURL(url);
                exportDrop.remove();
                BdApi.UI.showToast("Exportado como " + fmt.toUpperCase() + "!", { type: "success" });
            });
            setTimeout(() => {
                const dismiss = (e) => { if (!exportDrop.contains(e.target)) { exportDrop.remove(); document.removeEventListener("click", dismiss); } };
                document.addEventListener("click", dismiss);
            }, 10);
        });
        viewBar.appendChild(exportBtn);

        viewBar.prepend(viewLabel);
        viewBar.appendChild(countLabel);
        container.appendChild(viewBar);

        // Apply current channel filters and re-render
        const applyChannelFilter = () => {
            let filtered;
            if (this._activeChannelFilter) {
                filtered = results.filter(m => `${m.guildId}:${m.channelId}` === this._activeChannelFilter);
            } else if (this._excludedChannels.size > 0) {
                filtered = results.filter(m => !this._excludedChannels.has(`${m.guildId}:${m.channelId}`));
            } else {
                filtered = results;
            }
            countLabel.textContent = filtered.length === results.length
                ? `${results.length} resultado(s)`
                : `${filtered.length} de ${results.length} resultado(s)`;
            const isActive = this._activeChannelFilter !== null || this._excludedChannels.size > 0;
            channelFilterBtn.classList.toggle("gs-view-btn-active", isActive);
            if (!isActive) channelFilterBtn.textContent = "#\uFE0F\u20E3 Canal";
            this._renderResultItems(resultsList, filtered);
        };

        // Channel filter dropdown panel
        const channelDropdown = document.createElement("div");
        channelDropdown.className = "gs-channel-dropdown";
        channelDropdown.style.display = "none";

        const buildChannelDropdown = () => {
            channelDropdown.innerHTML = "";

            // "All channels" option (reset)
            const allItem = document.createElement("div");
            allItem.className = "gs-channel-item" + (this._activeChannelFilter === null && this._excludedChannels.size === 0 ? " gs-channel-item-active" : "");
            allItem.textContent = `Todos os canais (${results.length})`;
            allItem.addEventListener("click", () => {
                this._activeChannelFilter = null;
                this._excludedChannels.clear();
                channelDropdown.style.display = "none";
                applyChannelFilter();
            });
            channelDropdown.appendChild(allItem);

            // Hint
            const hint = document.createElement("div");
            hint.className = "gs-channel-hint";
            hint.textContent = "Clique = so esse canal | X = esconder canal";
            channelDropdown.appendChild(hint);

            // Sort channels by server > channel name
            const sorted = [...channelMap.values()].sort((a, b) => {
                const g = a.guildName.localeCompare(b.guildName);
                return g !== 0 ? g : a.channelName.localeCompare(b.channelName);
            });

            for (const ch of sorted) {
                const key = `${ch.guildId}:${ch.channelId}`;
                const isExcluded = this._excludedChannels.has(key);
                const isSelected = this._activeChannelFilter === key;
                const item = document.createElement("div");
                item.className = "gs-channel-item" + (isSelected ? " gs-channel-item-active" : "") + (isExcluded ? " gs-channel-item-excluded" : "");
                item.innerHTML = `
                    <span class="gs-channel-item-guild">${this.escapeHtml(ch.guildName)}</span>
                    <span class="gs-channel-item-name">#${this.escapeHtml(ch.channelName)}</span>
                    <span class="gs-channel-item-count">(${ch.count})</span>
                `;

                // Left click: show only this channel
                item.addEventListener("click", (e) => {
                    if (e.target.closest(".gs-channel-exclude")) return; // let exclude button handle it
                    this._activeChannelFilter = isSelected ? null : key;
                    this._excludedChannels.clear();
                    if (this._activeChannelFilter) {
                        channelFilterBtn.textContent = `#${ch.channelName}`;
                    }
                    channelDropdown.style.display = "none";
                    applyChannelFilter();
                });

                // Exclude button (X)
                const excludeBtn = document.createElement("button");
                excludeBtn.className = "gs-channel-exclude";
                excludeBtn.innerHTML = isExcluded ? "&#10003;" : "&times;";
                excludeBtn.title = isExcluded ? "Mostrar este canal" : "Esconder este canal";
                excludeBtn.addEventListener("click", (e) => {
                    e.stopPropagation();
                    this._activeChannelFilter = null;
                    if (isExcluded) {
                        this._excludedChannels.delete(key);
                    } else {
                        this._excludedChannels.add(key);
                    }
                    if (this._excludedChannels.size > 0) {
                        channelFilterBtn.textContent = `#\uFE0F\u20E3 -${this._excludedChannels.size}`;
                    }
                    buildChannelDropdown(); // rebuild to update state
                    applyChannelFilter();
                });
                item.appendChild(excludeBtn);

                channelDropdown.appendChild(item);
            }
        };

        channelFilterBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            if (channelDropdown.style.display === "none") {
                buildChannelDropdown();
                channelDropdown.style.display = "block";
            } else {
                channelDropdown.style.display = "none";
            }
        });

        // Close dropdown when clicking outside
        overlay.addEventListener("click", (e) => {
            if (!channelFilterBtn.contains(e.target) && !channelDropdown.contains(e.target)) {
                channelDropdown.style.display = "none";
            }
        });

        viewBar.appendChild(channelDropdown);

        // Find bar (hidden by default, toggled by button)
        let findBar = null;
        let findState = { matches: [], currentIndex: -1, filterMode: false };

        const resultsList = document.createElement("div");
        resultsList.className = "gs-results-list";

        const openFindBar = () => {
            if (findBar) { findBar.querySelector(".gs-find-input").focus(); return; }

            findBtn.classList.add("gs-view-btn-active");

            findBar = document.createElement("div");
            findBar.className = "gs-find-bar";
            findBar.innerHTML = `
                <input type="text" class="gs-find-input" placeholder="Buscar nos resultados..."/>
                <span class="gs-find-count">0 de 0</span>
                <button class="gs-find-prev" title="Anterior (Shift+Enter)">\u25B2</button>
                <button class="gs-find-next" title="Proximo (Enter)">\u25BC</button>
                <button class="gs-find-filter" title="Filtrar resultados">\u2263</button>
                <button class="gs-find-close" title="Fechar (Esc)">&times;</button>
            `;

            // Insert between viewBar and resultsList
            container.insertBefore(findBar, resultsList);

            const findInput = findBar.querySelector(".gs-find-input");
            const findCount = findBar.querySelector(".gs-find-count");
            const prevBtn = findBar.querySelector(".gs-find-prev");
            const nextBtn = findBar.querySelector(".gs-find-next");
            const filterBtn = findBar.querySelector(".gs-find-filter");
            const closeBtn = findBar.querySelector(".gs-find-close");

            let debounceTimer = null;

            const clearHighlights = () => {
                resultsList.querySelectorAll("mark.gs-highlight").forEach(mark => {
                    const parent = mark.parentNode;
                    parent.replaceChild(document.createTextNode(mark.textContent), mark);
                    parent.normalize();
                });
                resultsList.querySelectorAll(".gs-result-item").forEach(item => {
                    item.classList.remove("gs-filtered-out");
                });
                findState.matches = [];
                findState.currentIndex = -1;
            };

            const doFind = () => {
                clearHighlights();
                const query = findInput.value.trim().toLowerCase();
                if (!query) {
                    findCount.textContent = "0 de 0";
                    return;
                }

                const items = resultsList.querySelectorAll(".gs-result-item");
                const allMarks = [];

                items.forEach(item => {
                    let hasMatch = false;
                    const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT, null);
                    const textNodes = [];
                    while (walker.nextNode()) textNodes.push(walker.currentNode);

                    for (const textNode of textNodes) {
                        const text = textNode.textContent;
                        const lowerText = text.toLowerCase();
                        let idx = lowerText.indexOf(query);
                        if (idx === -1) continue;
                        hasMatch = true;

                        const fragment = document.createDocumentFragment();
                        let lastIdx = 0;
                        while (idx !== -1) {
                            if (idx > lastIdx) {
                                fragment.appendChild(document.createTextNode(text.substring(lastIdx, idx)));
                            }
                            const mark = document.createElement("mark");
                            mark.className = "gs-highlight";
                            mark.textContent = text.substring(idx, idx + query.length);
                            fragment.appendChild(mark);
                            allMarks.push(mark);
                            lastIdx = idx + query.length;
                            idx = lowerText.indexOf(query, lastIdx);
                        }
                        if (lastIdx < text.length) {
                            fragment.appendChild(document.createTextNode(text.substring(lastIdx)));
                        }
                        textNode.parentNode.replaceChild(fragment, textNode);
                    }

                    if (findState.filterMode && !hasMatch) {
                        item.classList.add("gs-filtered-out");
                    }
                });

                findState.matches = allMarks;
                if (allMarks.length > 0) {
                    findState.currentIndex = 0;
                    allMarks[0].classList.add("gs-highlight-active");
                    allMarks[0].scrollIntoView({ block: "center", behavior: "smooth" });
                }
                findCount.textContent = allMarks.length > 0
                    ? `1 de ${allMarks.length}`
                    : "0 de 0";
            };

            const goToMatch = (direction) => {
                if (findState.matches.length === 0) return;
                findState.matches[findState.currentIndex]?.classList.remove("gs-highlight-active");
                findState.currentIndex = (findState.currentIndex + direction + findState.matches.length) % findState.matches.length;
                const current = findState.matches[findState.currentIndex];
                current.classList.add("gs-highlight-active");
                current.scrollIntoView({ block: "center", behavior: "smooth" });
                findCount.textContent = `${findState.currentIndex + 1} de ${findState.matches.length}`;
            };

            const closeFindBar = () => {
                clearHighlights();
                findBar.remove();
                findBar = null;
                findBtn.classList.remove("gs-view-btn-active");
            };

            findInput.addEventListener("input", () => {
                clearTimeout(debounceTimer);
                debounceTimer = setTimeout(doFind, 150);
            });

            findInput.addEventListener("keydown", (e) => {
                if (e.key === "Enter" && e.shiftKey) {
                    e.preventDefault();
                    goToMatch(-1);
                } else if (e.key === "Enter") {
                    e.preventDefault();
                    goToMatch(1);
                } else if (e.key === "Escape") {
                    e.preventDefault();
                    closeFindBar();
                }
            });

            prevBtn.addEventListener("click", () => goToMatch(-1));
            nextBtn.addEventListener("click", () => goToMatch(1));

            filterBtn.addEventListener("click", () => {
                findState.filterMode = !findState.filterMode;
                filterBtn.classList.toggle("gs-find-filter-active", findState.filterMode);
                doFind();
            });

            closeBtn.addEventListener("click", closeFindBar);

            findInput.focus();
        };

        findBtn.addEventListener("click", () => {
            if (findBar) {
                // Close if already open
                const closeBtn = findBar.querySelector(".gs-find-close");
                if (closeBtn) closeBtn.click();
            } else {
                openFindBar();
            }
        });

        container.appendChild(resultsList);

        // Apply persisted channel filters on initial render
        applyChannelFilter();
    }

    _renderResultItems(container, results) {
        container.innerHTML = "";
        this._focusedResultIndex = -1;
        const mode = this.settings.viewMode || "traditional";

        const renderItem = (msg) => {
            const item = document.createElement("div");
            item.className = `gs-result-item gs-mode-${mode}`;

            const date = new Date(msg.timestamp);
            const dateStr = date.toLocaleDateString("pt-BR") + " " + date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
            const hasAttachments = msg.attachments && msg.attachments.length > 0;

            if (mode === "compact") {
                // Compact: single line — date | server > #channel | author: message
                const content = msg.content.length > 120 ? msg.content.substring(0, 120) + "..." : msg.content;
                item.innerHTML = `
                    <span class="gs-compact-date">${dateStr}</span>
                    <span class="gs-compact-location">${this.escapeHtml(msg.guildName)} &gt; #${this.escapeHtml(msg.channelName)}</span>
                    <span class="gs-compact-author">${this.escapeHtml(msg.author)}:</span>
                    <span class="gs-compact-content">${this.escapeHtml(content)}</span>
                    ${hasAttachments ? `<span class="gs-attachment-badge">${msg.attachments.length}</span>` : ""}
                `;
            } else if (mode === "detailed") {
                // Detailed: avatar, full content, embeds info
                const content = msg.content.length > 800 ? msg.content.substring(0, 800) + "..." : msg.content;
                const avatarHtml = msg.authorAvatar
                    ? `<img class="gs-detail-avatar" src="${this.escapeHtml(msg.authorAvatar)}" onerror="this.style.display='none'"/>`
                    : `<div class="gs-detail-avatar gs-detail-avatar-fallback">${msg.author.charAt(0).toUpperCase()}</div>`;
                item.innerHTML = `
                    <div class="gs-detail-top">
                        <div class="gs-result-guild">
                            ${msg.guildIcon ? `<img class="gs-guild-icon" src="${this.escapeHtml(msg.guildIcon)}" onerror="this.style.display='none'"/>` : ""}
                            <strong>${this.escapeHtml(msg.guildName)}</strong>
                            <span class="gs-channel-name">#${this.escapeHtml(msg.channelName)}</span>
                        </div>
                        <span class="gs-result-date">${dateStr}</span>
                    </div>
                    <div class="gs-detail-body">
                        ${avatarHtml}
                        <div class="gs-detail-msg">
                            <span class="gs-result-author">${this.escapeHtml(msg.author)}</span>
                            <div class="gs-result-content">${this.escapeHtml(content)}</div>
                            ${hasAttachments ? `<div class="gs-detail-attachments">${msg.attachments.map(a => `<span class="gs-attachment-badge">${this.escapeHtml(a.filename || "anexo")}</span>`).join(" ")}</div>` : ""}
                            ${msg.embeds && msg.embeds.length > 0 ? `<div class="gs-detail-attachments"><span class="gs-attachment-badge">${msg.embeds.length} embed(s)</span></div>` : ""}
                        </div>
                    </div>
                `;
            } else {
                // Traditional (default)
                const content = msg.content.length > 300 ? msg.content.substring(0, 300) + "..." : msg.content;
                item.innerHTML = `
                    <div class="gs-result-header">
                        <div class="gs-result-guild">
                            ${msg.guildIcon ? `<img class="gs-guild-icon" src="${this.escapeHtml(msg.guildIcon)}" onerror="this.style.display='none'"/>` : ""}
                            <strong>${this.escapeHtml(msg.guildName)}</strong>
                            <span class="gs-channel-name">#${this.escapeHtml(msg.channelName)}</span>
                        </div>
                        <span class="gs-result-date">${dateStr}</span>
                    </div>
                    <div class="gs-result-body">
                        <span class="gs-result-author">${this.escapeHtml(msg.author)}:</span>
                        <span class="gs-result-content">${this.escapeHtml(content)}</span>
                        ${hasAttachments ? `<span class="gs-attachment-badge">${msg.attachments.length} anexo(s)</span>` : ""}
                    </div>
                `;
            }

            // Image previews (for detailed and traditional modes)
            if (this.settings.showImagePreviews && mode !== "compact" && hasAttachments) {
                const imageAtts = msg.attachments.filter(a =>
                    (a.content_type && a.content_type.startsWith("image/")) ||
                    /\.(png|jpg|jpeg|gif|webp)$/i.test(a.filename || "")
                );
                if (imageAtts.length > 0) {
                    const thumbsDiv = document.createElement("div");
                    thumbsDiv.className = "gs-attachment-thumbs";
                    for (const att of imageAtts) {
                        const img = document.createElement("img");
                        img.className = "gs-attachment-thumb";
                        img.src = att.url;
                        img.alt = att.filename || "imagem";
                        img.loading = "lazy";
                        img.addEventListener("click", (e) => {
                            e.stopPropagation();
                            const lb = document.createElement("div");
                            lb.className = "gs-lightbox";
                            const fullImg = document.createElement("img");
                            fullImg.src = att.url;
                            lb.appendChild(fullImg);
                            lb.addEventListener("click", () => lb.remove());
                            document.body.appendChild(lb);
                        });
                        img.addEventListener("error", () => img.style.display = "none");
                        thumbsDiv.appendChild(img);
                    }
                    item.appendChild(thumbsDiv);
                }
            }

            item.title = "Clique para ir a mensagem | Clique direito para abrir DM";

            item.addEventListener("click", () => {
                this.goToMessage(msg.guildId, msg.channelId, msg.id);
                if (this._closeModal) this._closeModal();
            });

            item.addEventListener("contextmenu", async (e) => {
                e.preventDefault();
                if (!msg.authorId) {
                    BdApi.UI.showToast("ID do autor nao disponivel.", { type: "error" });
                    return;
                }
                BdApi.UI.showToast("Abrindo DM com " + msg.author + "...", { type: "info" });
                const dmChannel = await this.openDMWithUser(msg.authorId);
                if (dmChannel) {
                    if (this._closeModal) this._closeModal();
                    await this.sleep(800);
                    this.insertTextInChatBox(msg);
                }
            });

            return item;
        };

        // Chunked rendering for large result sets
        const CHUNK = 50;
        const renderChunk = (start) => {
            const end = Math.min(start + CHUNK, results.length);
            for (let i = start; i < end; i++) {
                container.appendChild(renderItem(results[i]));
            }
            if (end < results.length) {
                requestAnimationFrame(() => renderChunk(end));
            } else {
                // All chunks rendered — notify find bar if active
                const findInput = document.querySelector(".gs-find-input");
                if (findInput && findInput.value.trim()) {
                    findInput.dispatchEvent(new Event("input"));
                }
            }
        };
        renderChunk(0);
    }

    escapeHtml(text) {
        const div = document.createElement("div");
        div.textContent = text;
        return div.innerHTML;
    }

    _applyTheme() {
        const overlay = document.querySelector(".gs-modal-overlay");
        if (!overlay) return;
        const theme = this.settings.theme || "dark";
        if (theme === "auto") {
            const isLight = document.documentElement.classList.contains("theme-light");
            overlay.classList.toggle("gs-theme-light", isLight);
        } else {
            overlay.classList.toggle("gs-theme-light", theme === "light");
        }
    }

    // ========== STYLES ==========

    injectStyles() {
        BdApi.DOM.addStyle(this.styleId, `
            /* ===== Apple-inspired Design System ===== */
            /* Font stack: SF Pro → system UI fallback */
            .gs-modal-overlay, .gs-modal, .gs-modal * {
                font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Helvetica Neue", system-ui, sans-serif;
                -webkit-font-smoothing: antialiased;
                -moz-osx-font-smoothing: grayscale;
                letter-spacing: -0.01em;
            }

            /* Toolbar button */
            .global-search-toolbar-btn {
                cursor: pointer;
                color: var(--interactive-normal, #b5bac1);
                padding: 4px 8px;
                display: flex;
                align-items: center;
                border-radius: 8px;
                transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
            }
            .global-search-toolbar-btn:hover {
                color: #fff;
                background: rgba(255,255,255,0.08);
            }

            /* Searchbar side button */
            .global-search-searchbar-btn {
                cursor: pointer;
                color: var(--interactive-normal, #b5bac1);
                padding: 4px 6px;
                margin-left: 6px;
                display: flex;
                align-items: center;
                justify-content: center;
                border-radius: 6px;
                height: 24px;
                transition: all 0.15s ease;
                flex-shrink: 0;
            }
            .global-search-searchbar-btn:hover {
                color: #fff;
                background: rgba(10, 132, 255, 0.15);
            }

            /* Modal overlay */
            .gs-modal-overlay {
                position: fixed;
                top: 0; left: 0; right: 0; bottom: 0;
                background: rgba(0,0,0,0.55);
                backdrop-filter: blur(1px);
                -webkit-backdrop-filter: blur(1px);
                z-index: 9999;
                display: flex;
                align-items: center;
                justify-content: center;
                animation: gs-fade-in 0.25s cubic-bezier(0.4, 0, 0.2, 1);
            }
            @keyframes gs-fade-in {
                from { opacity: 0; }
                to { opacity: 1; }
            }

            /* Modal */
            .gs-modal {
                background: rgba(30, 31, 34, 0.92);
                backdrop-filter: blur(40px) saturate(180%);
                -webkit-backdrop-filter: blur(40px) saturate(180%);
                border: 1px solid rgba(255,255,255,0.08);
                border-radius: 16px;
                width: 700px;
                max-width: 92vw;
                max-height: 85vh;
                display: flex;
                flex-direction: column;
                box-shadow: 0 24px 80px rgba(0,0,0,0.45), 0 0 0 1px rgba(255,255,255,0.05) inset;
                animation: gs-slide-in 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                overflow: hidden;
            }
            .gs-modal-scroll {
                overflow-y: auto;
                overflow-x: hidden;
                flex: 1;
                min-height: 0;
                scrollbar-width: thin;
                scrollbar-color: rgba(255,255,255,0.15) transparent;
            }
            .gs-modal-scroll::-webkit-scrollbar { width: 6px; }
            .gs-modal-scroll::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 3px; }
            .gs-modal-scroll::-webkit-scrollbar-track { background: transparent; }
            @keyframes gs-slide-in {
                from { transform: scale(0.97) translateY(-8px); opacity: 0; }
                to { transform: scale(1) translateY(0); opacity: 1; }
            }

            /* Header */
            .gs-modal-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 18px 24px;
                border-bottom: 1px solid rgba(255,255,255,0.06);
            }
            .gs-modal-header h2 {
                margin: 0;
                color: #f5f5f7;
                font-size: 19px;
                font-weight: 600;
                letter-spacing: -0.02em;
            }
            .gs-header-actions {
                display: flex;
                align-items: center;
                gap: 2px;
            }
            .gs-settings-btn, .gs-close {
                cursor: pointer;
                color: rgba(255,255,255,0.45);
                padding: 6px 8px;
                border-radius: 8px;
                line-height: 1;
                transition: all 0.2s ease;
            }
            .gs-settings-btn { font-size: 18px; }
            .gs-close { font-size: 22px; }
            .gs-settings-btn:hover, .gs-close:hover {
                color: rgba(255,255,255,0.85);
                background: rgba(255,255,255,0.08);
            }

            /* Settings panel */
            .gs-settings-panel {
                padding: 16px 24px;
                background: rgba(255,255,255,0.03);
                border-bottom: 1px solid rgba(255,255,255,0.06);
            }
            .gs-settings-title {
                font-size: 11px;
                font-weight: 600;
                color: rgba(255,255,255,0.4);
                text-transform: uppercase;
                letter-spacing: 0.06em;
                margin-bottom: 12px;
            }
            .gs-settings-row {
                display: flex;
                align-items: center;
                gap: 12px;
                margin-bottom: 10px;
                flex-wrap: wrap;
            }
            .gs-settings-label {
                color: rgba(255,255,255,0.8);
                font-size: 13px;
                font-weight: 450;
                min-width: 190px;
            }
            .gs-settings-input {
                width: 80px;
                padding: 6px 10px;
                border-radius: 8px;
                border: 1px solid rgba(255,255,255,0.1);
                background: rgba(255,255,255,0.06);
                color: #f5f5f7;
                font-size: 13px;
                font-weight: 450;
                outline: none;
                transition: all 0.2s ease;
            }
            .gs-settings-input:focus {
                border-color: #0a84ff;
                box-shadow: 0 0 0 3px rgba(10, 132, 255, 0.2);
            }
            select.gs-settings-input {
                appearance: none;
                -webkit-appearance: none;
                padding-right: 28px;
                background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23999' d='M6 8L1 3h10z'/%3E%3C/svg%3E");
                background-repeat: no-repeat;
                background-position: right 8px center;
                cursor: pointer;
            }
            select.gs-settings-input option {
                background: #1e1f22 !important;
                color: #ffffff !important;
                padding: 4px 8px;
                font-size: 13px;
            }
            select.gs-settings-input option:checked {
                background: #5865f2 !important;
                color: #ffffff !important;
            }
            .gs-settings-help {
                color: rgba(255,255,255,0.35);
                font-size: 11px;
                font-weight: 400;
            }

            .gs-settings-reset-btn {
                margin-top: 10px;
                padding: 6px 14px;
                border: 1px solid rgba(255,255,255,0.12);
                border-radius: 6px;
                background: rgba(255,255,255,0.06);
                color: var(--text-normal);
                font-size: 12px;
                cursor: pointer;
                transition: background 0.15s;
            }
            .gs-settings-reset-btn:hover {
                background: rgba(255,255,255,0.12);
            }

            /* Search area */
            .gs-search-area {
                display: flex;
                gap: 10px;
                padding: 18px 24px 10px;
            }
            .gs-search-input {
                flex: 1;
                padding: 10px 16px;
                border-radius: 10px;
                border: 1px solid rgba(255,255,255,0.1);
                background: rgba(255,255,255,0.06);
                color: #f5f5f7;
                font-size: 15px;
                font-weight: 400;
                outline: none;
                transition: all 0.2s ease;
            }
            .gs-search-input:focus {
                border-color: #0a84ff;
                box-shadow: 0 0 0 3px rgba(10, 132, 255, 0.2);
                background: rgba(255,255,255,0.08);
            }
            .gs-search-input::placeholder {
                color: rgba(255,255,255,0.3);
                font-weight: 400;
            }
            .gs-search-btn {
                padding: 10px 22px;
                border-radius: 10px;
                border: none;
                background: #0a84ff;
                color: #fff;
                font-size: 14px;
                font-weight: 600;
                cursor: pointer;
                transition: all 0.2s ease;
                white-space: nowrap;
            }
            .gs-search-btn:hover:not(:disabled) {
                background: #0070e0;
                transform: translateY(-0.5px);
            }
            .gs-search-btn:active:not(:disabled) {
                transform: translateY(0.5px);
            }
            .gs-search-btn:disabled {
                opacity: 0.5;
                cursor: not-allowed;
            }
            .gs-refresh-btn {
                padding: 10px 16px;
                border-radius: 10px;
                border: 1px solid rgba(10, 132, 255, 0.4);
                background: rgba(10, 132, 255, 0.1);
                color: #4db2ff;
                font-size: 13px;
                font-weight: 600;
                cursor: pointer;
                transition: all 0.2s ease;
                white-space: nowrap;
            }
            .gs-refresh-btn:hover:not(:disabled) {
                background: #0a84ff;
                color: #fff;
                border-color: #0a84ff;
            }
            .gs-refresh-btn:disabled {
                opacity: 0.5;
                cursor: not-allowed;
            }

            /* History dropdown */
            .gs-history-wrapper {
                position: relative;
                padding: 0 24px;
            }
            .gs-history-dropdown {
                position: absolute;
                top: 0;
                left: 24px;
                right: 24px;
                background: rgba(28, 28, 30, 0.95);
                backdrop-filter: blur(30px);
                -webkit-backdrop-filter: blur(30px);
                border: 1px solid rgba(255,255,255,0.1);
                border-radius: 12px;
                box-shadow: 0 12px 40px rgba(0,0,0,0.5);
                z-index: 10;
                max-height: 300px;
                overflow-y: auto;
            }
            .gs-history-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 10px 14px 6px;
                color: rgba(255,255,255,0.4);
                font-size: 11px;
                font-weight: 600;
                text-transform: uppercase;
                letter-spacing: 0.04em;
                border-bottom: 1px solid rgba(255,255,255,0.06);
            }
            .gs-history-clear {
                background: none;
                border: none;
                color: #ff453a;
                font-size: 11px;
                font-weight: 600;
                cursor: pointer;
                padding: 3px 8px;
                border-radius: 6px;
                transition: all 0.15s ease;
            }
            .gs-history-clear:hover {
                background: rgba(255, 69, 58, 0.15);
            }
            .gs-history-item {
                padding: 10px 14px;
                cursor: pointer;
                display: flex;
                justify-content: space-between;
                align-items: center;
                gap: 10px;
                transition: background 0.15s ease;
                border-radius: 8px;
                margin: 2px 4px;
            }
            .gs-history-item:hover {
                background: rgba(255,255,255,0.06);
            }
            .gs-history-query {
                color: rgba(255,255,255,0.85);
                font-size: 13px;
                font-weight: 500;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            .gs-history-meta {
                color: rgba(255,255,255,0.35);
                font-size: 11px;
                flex-shrink: 0;
                white-space: nowrap;
                font-weight: 400;
            }
            .gs-history-empty {
                padding: 20px;
                text-align: center;
                color: rgba(255,255,255,0.3);
                font-size: 13px;
            }

            /* Auto-refresh toggle */
            .gs-auto-refresh-toggle {
                display: flex;
                align-items: center;
                gap: 6px;
                color: rgba(255,255,255,0.45);
                font-size: 12px;
                font-weight: 450;
                cursor: pointer;
                margin-left: 8px;
                padding: 4px 10px;
                border-radius: 8px;
                border: 1px solid rgba(255,255,255,0.08);
                background: rgba(255,255,255,0.04);
                transition: all 0.2s ease;
            }
            .gs-auto-refresh-toggle:hover {
                border-color: rgba(10, 132, 255, 0.4);
                background: rgba(10, 132, 255, 0.08);
            }
            .gs-auto-refresh-toggle input:checked + span {
                color: rgba(255,255,255,0.85);
            }

            /* Scope toggle area */
            .gs-scope-area {
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 4px 24px 10px;
            }
            .gs-scope-btn {
                padding: 6px 16px;
                border-radius: 20px;
                border: 1px solid rgba(255,255,255,0.1);
                background: rgba(255,255,255,0.04);
                color: rgba(255,255,255,0.5);
                font-size: 13px;
                font-weight: 500;
                cursor: pointer;
                transition: all 0.2s ease;
            }
            .gs-scope-btn:hover {
                border-color: rgba(10, 132, 255, 0.4);
                color: rgba(255,255,255,0.8);
                background: rgba(10, 132, 255, 0.08);
            }
            .gs-scope-btn-active {
                background: #0a84ff;
                color: #fff;
                border-color: #0a84ff;
            }
            .gs-scope-btn-active:hover {
                background: #0070e0;
                border-color: #0070e0;
                color: #fff;
            }

            /* Guild section */
            .gs-guild-section {
                padding: 8px 24px;
            }
            .gs-guild-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
            }
            .gs-checkbox-label {
                display: flex;
                align-items: center;
                gap: 7px;
                color: rgba(255,255,255,0.8);
                font-size: 13px;
                font-weight: 450;
                cursor: pointer;
            }
            .gs-toggle-guilds {
                background: none;
                border: none;
                color: #0a84ff;
                font-size: 13px;
                font-weight: 500;
                cursor: pointer;
                padding: 4px 10px;
                border-radius: 6px;
                transition: all 0.15s ease;
            }
            .gs-toggle-guilds:hover {
                background: rgba(10, 132, 255, 0.1);
            }
            .gs-folder-area {
                display: flex;
                flex-wrap: wrap;
                gap: 6px;
                padding: 8px 24px 6px;
            }
            .gs-folder-btn {
                padding: 5px 12px;
                border-radius: 20px;
                border: 1px solid rgba(255,255,255,0.08);
                background: rgba(255,255,255,0.04);
                color: rgba(255,255,255,0.7);
                font-size: 12px;
                font-weight: 500;
                cursor: pointer;
                transition: all 0.2s ease;
                white-space: nowrap;
            }
            .gs-folder-btn:hover {
                background: rgba(255,255,255,0.08);
                border-color: rgba(255,255,255,0.15);
            }
            .gs-folder-btn-active {
                background: #0a84ff;
                color: #fff;
                border-color: #0a84ff;
            }
            .gs-guild-filter {
                width: 100%;
                padding: 9px 14px;
                margin-top: 8px;
                border-radius: 10px;
                border: 1px solid rgba(255,255,255,0.1);
                background: rgba(255,255,255,0.06);
                color: #f5f5f7;
                font-size: 13px;
                font-weight: 400;
                outline: none;
                box-sizing: border-box;
                transition: all 0.2s ease;
            }
            .gs-guild-filter:focus {
                border-color: #0a84ff;
                box-shadow: 0 0 0 3px rgba(10, 132, 255, 0.2);
            }
            .gs-guild-filter::placeholder {
                color: rgba(255,255,255,0.3);
            }
            .gs-guild-count {
                color: rgba(255,255,255,0.4);
                font-size: 12px;
                font-weight: 450;
                margin-left: 4px;
            }
            .gs-guild-list {
                max-height: 160px;
                overflow-y: auto;
                margin-top: 8px;
                padding: 8px;
                background: rgba(255,255,255,0.03);
                border: 1px solid rgba(255,255,255,0.06);
                border-radius: 12px;
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 2px;
            }
            .gs-guild-item {
                padding: 5px 8px;
                border-radius: 8px;
                font-size: 13px;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                transition: background 0.15s ease;
            }
            .gs-guild-item:hover {
                background: rgba(255,255,255,0.06);
            }
            .gs-guild-item {
                display: flex;
                align-items: center;
                gap: 4px;
            }
            .gs-guild-item .gs-block-btn {
                margin-left: auto;
                background: transparent;
                border: none;
                cursor: pointer;
                font-size: 12px;
                opacity: 0.35;
                padding: 2px 6px;
                border-radius: 4px;
                transition: opacity 0.15s ease, background 0.15s ease;
            }
            .gs-guild-item .gs-block-btn:hover {
                opacity: 1;
                background: rgba(237, 66, 69, 0.15);
            }
            .gs-guild-blocked {
                opacity: 0.45;
                text-decoration: line-through;
            }
            .gs-guild-blocked .gs-block-btn {
                opacity: 0.9;
                background: rgba(237, 66, 69, 0.2);
            }
            .gs-activity-dot {
                width: 8px;
                height: 8px;
                border-radius: 50%;
                display: inline-block;
                margin-right: 2px;
                margin-left: 4px;
                vertical-align: middle;
                flex-shrink: 0;
            }
            .gs-guild-icon {
                width: 20px;
                height: 20px;
                border-radius: 6px;
                vertical-align: middle;
                flex-shrink: 0;
            }

            /* Progress */
            .gs-progress {
                padding: 10px 24px;
                color: rgba(255,255,255,0.5);
                font-size: 13px;
                font-weight: 450;
                display: flex;
                flex-direction: column;
                gap: 8px;
            }
            .gs-progress-bar-bg {
                width: 100%;
                height: 4px;
                background: rgba(255,255,255,0.08);
                border-radius: 2px;
                overflow: hidden;
            }
            .gs-progress-bar {
                height: 100%;
                background: #0a84ff;
                border-radius: 2px;
                transition: width 0.4s cubic-bezier(0.4, 0, 0.2, 1);
            }
            .gs-progress-info {
                display: flex;
                justify-content: space-between;
                align-items: center;
            }
            .gs-cancel-btn {
                padding: 4px 14px;
                border-radius: 8px;
                border: none;
                background: rgba(255, 69, 58, 0.12);
                color: #ff453a;
                font-size: 12px;
                font-weight: 600;
                cursor: pointer;
                transition: all 0.15s ease;
                flex-shrink: 0;
            }
            .gs-cancel-btn:hover {
                background: rgba(255, 69, 58, 0.25);
            }

            /* Results */
            .gs-results {
                padding: 8px 24px 20px;
            }
            .gs-no-results {
                text-align: center;
                color: rgba(255,255,255,0.3);
                padding: 48px 0;
                font-size: 15px;
                font-weight: 450;
            }
            .gs-result-item {
                padding: 12px 14px;
                border-radius: 12px;
                cursor: pointer;
                transition: all 0.15s ease;
                border-bottom: 1px solid rgba(255,255,255,0.04);
            }
            .gs-result-item:last-child {
                border-bottom: none;
            }
            .gs-result-item:hover {
                background: rgba(255,255,255,0.05);
            }
            .gs-result-item:active {
                background: rgba(255,255,255,0.08);
                transform: scale(0.995);
            }
            .gs-result-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 5px;
            }
            .gs-result-guild {
                display: flex;
                align-items: center;
                gap: 7px;
                font-size: 13px;
                color: rgba(255,255,255,0.8);
            }
            .gs-result-guild strong {
                font-weight: 600;
            }
            .gs-channel-name {
                color: rgba(255,255,255,0.35);
                font-size: 12px;
                font-weight: 450;
            }
            .gs-result-date {
                color: rgba(255,255,255,0.3);
                font-size: 12px;
                font-weight: 400;
                flex-shrink: 0;
            }
            .gs-result-body {
                font-size: 14px;
                color: rgba(255,255,255,0.75);
                line-height: 1.5;
                font-weight: 400;
            }
            .gs-result-author {
                font-weight: 600;
                color: rgba(255,255,255,0.85);
                margin-right: 5px;
            }
            .gs-result-content {
                color: rgba(255,255,255,0.7);
                word-break: break-word;
            }
            .gs-attachment-badge {
                display: inline-block;
                background: rgba(255,255,255,0.06);
                color: rgba(255,255,255,0.45);
                font-size: 11px;
                font-weight: 500;
                padding: 2px 8px;
                border-radius: 6px;
                margin-left: 6px;
            }

            /* View mode bar */
            .gs-view-bar {
                display: flex;
                align-items: center;
                gap: 6px;
                padding: 8px 0 12px;
                border-bottom: 1px solid rgba(255,255,255,0.06);
                margin-bottom: 8px;
                flex-wrap: wrap;
                position: relative;
            }
            .gs-view-label {
                color: rgba(255,255,255,0.35);
                font-size: 12px;
                font-weight: 500;
                margin-right: 2px;
            }
            .gs-view-btn {
                padding: 4px 12px;
                border-radius: 8px;
                border: 1px solid rgba(255,255,255,0.08);
                background: rgba(255,255,255,0.04);
                color: rgba(255,255,255,0.65);
                font-size: 12px;
                font-weight: 500;
                cursor: pointer;
                transition: all 0.15s ease;
            }
            .gs-view-btn:hover {
                background: rgba(255,255,255,0.08);
                border-color: rgba(255,255,255,0.15);
            }
            .gs-view-btn-active {
                background: #0a84ff;
                color: #fff;
                border-color: #0a84ff;
            }
            .gs-result-count {
                margin-left: auto;
                color: rgba(255,255,255,0.35);
                font-size: 12px;
                font-weight: 450;
            }

            /* Compact mode */
            .gs-mode-compact {
                display: flex;
                align-items: center;
                gap: 10px;
                padding: 5px 10px !important;
                font-size: 13px;
                white-space: nowrap;
                overflow: hidden;
            }
            .gs-compact-date {
                color: rgba(255,255,255,0.3);
                font-size: 11px;
                font-weight: 400;
                flex-shrink: 0;
                min-width: 105px;
            }
            .gs-compact-location {
                color: rgba(255,255,255,0.35);
                font-size: 12px;
                font-weight: 450;
                flex-shrink: 0;
                max-width: 200px;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            .gs-compact-author {
                font-weight: 600;
                color: rgba(255,255,255,0.85);
                flex-shrink: 0;
            }
            .gs-compact-content {
                color: rgba(255,255,255,0.65);
                overflow: hidden;
                text-overflow: ellipsis;
                font-weight: 400;
            }

            /* Detailed mode */
            .gs-mode-detailed {
                padding: 14px !important;
            }
            .gs-detail-top {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 10px;
            }
            .gs-detail-body {
                display: flex;
                gap: 12px;
                align-items: flex-start;
            }
            .gs-detail-avatar {
                width: 38px;
                height: 38px;
                border-radius: 50%;
                flex-shrink: 0;
            }
            .gs-detail-avatar-fallback {
                background: linear-gradient(135deg, #0a84ff, #5e5ce6);
                color: #fff;
                display: flex;
                align-items: center;
                justify-content: center;
                font-weight: 700;
                font-size: 16px;
            }
            .gs-detail-msg {
                flex: 1;
                min-width: 0;
            }
            .gs-detail-msg .gs-result-author {
                display: block;
                margin-bottom: 3px;
            }
            .gs-detail-msg .gs-result-content {
                white-space: pre-wrap;
                line-height: 1.5;
            }
            .gs-detail-attachments {
                margin-top: 8px;
                display: flex;
                flex-wrap: wrap;
                gap: 5px;
            }

            /* Period selector */
            .gs-period-area {
                display: flex;
                align-items: center;
                gap: 10px;
                padding: 4px 24px 10px;
            }
            .gs-period-label {
                color: rgba(255,255,255,0.4);
                font-size: 12px;
                font-weight: 500;
            }
            .gs-period-select {
                padding: 5px 10px;
                border-radius: 8px;
                border: 1px solid rgba(255,255,255,0.1);
                background: rgba(255,255,255,0.06);
                color: #f5f5f7;
                font-size: 13px;
                font-weight: 450;
                outline: none;
                cursor: pointer;
                transition: all 0.2s ease;
            }
            .gs-period-select:focus {
                border-color: #0a84ff;
                box-shadow: 0 0 0 3px rgba(10, 132, 255, 0.2);
            }

            /* Fuzzy / custom variants */
            .gs-fuzzy-area {
                display: flex;
                align-items: center;
                gap: 10px;
                padding: 0 24px 10px;
                flex-wrap: wrap;
            }
            .gs-fuzzy-input {
                flex: 1;
                min-width: 200px;
                padding: 6px 12px;
                border-radius: 8px;
                border: 1px solid rgba(255,255,255,0.1);
                background: rgba(255,255,255,0.06);
                color: #f5f5f7;
                font-size: 13px;
                font-weight: 400;
                outline: none;
                transition: all 0.2s ease;
            }
            .gs-fuzzy-input:focus {
                border-color: #0a84ff;
                box-shadow: 0 0 0 3px rgba(10, 132, 255, 0.2);
            }
            .gs-fuzzy-input::placeholder {
                color: rgba(255,255,255,0.3);
            }

            /* Exclude words */
            .gs-exclude-area {
                display: flex;
                align-items: center;
                gap: 10px;
                padding: 0 24px 10px;
                flex-wrap: wrap;
            }
            .gs-exclude-input {
                flex: 1;
                min-width: 200px;
                padding: 6px 12px;
                border-radius: 8px;
                border: 1px solid rgba(255,255,255,0.1);
                background: rgba(255,255,255,0.06);
                color: #f5f5f7;
                font-size: 13px;
                font-weight: 400;
                outline: none;
                transition: all 0.2s ease;
            }
            .gs-exclude-input:focus {
                border-color: #0a84ff;
                box-shadow: 0 0 0 3px rgba(10, 132, 255, 0.2);
            }
            .gs-exclude-input::placeholder {
                color: rgba(255,255,255,0.3);
            }
            .gs-exclude-help {
                color: rgba(255,255,255,0.3);
                font-size: 11px;
                font-weight: 400;
                width: 100%;
            }

            /* ===== History action buttons ===== */
            .gs-history-actions {
                display: flex;
                align-items: center;
                gap: 2px;
                flex-shrink: 0;
                margin-left: auto;
            }
            .gs-history-item {
                display: flex;
                align-items: center;
                gap: 8px;
            }
            .gs-history-delete {
                background: none;
                border: none;
                color: rgba(255,255,255,0.35);
                font-size: 16px;
                cursor: pointer;
                padding: 3px 7px;
                border-radius: 6px;
                flex-shrink: 0;
                line-height: 1;
                opacity: 0;
                transition: all 0.15s ease;
            }
            .gs-history-item:hover .gs-history-delete {
                opacity: 1;
            }
            .gs-history-delete:hover {
                color: #ff453a;
                background: rgba(255, 69, 58, 0.12);
            }
            .gs-history-archive {
                background: none;
                border: none;
                color: rgba(255,255,255,0.35);
                font-size: 14px;
                cursor: pointer;
                padding: 3px 5px;
                border-radius: 6px;
                flex-shrink: 0;
                opacity: 0;
                transition: all 0.15s ease;
            }
            .gs-history-item:hover .gs-history-archive {
                opacity: 1;
            }
            .gs-history-archive-active {
                color: #0a84ff;
                opacity: 1 !important;
            }
            .gs-history-archive:hover {
                color: #0a84ff;
                background: rgba(10, 132, 255, 0.1);
            }

            /* ===== Archived section ===== */
            .gs-archive-header {
                background: rgba(10, 132, 255, 0.04);
            }
            .gs-archived-item {
                border-left: 2px solid #0a84ff;
            }
            .gs-storage-size {
                color: rgba(255,255,255,0.3);
                font-size: 11px;
                font-weight: normal;
            }

            /* ===== Pause/Resume buttons ===== */
            .gs-pause-btn {
                padding: 4px 14px;
                border-radius: 8px;
                border: none;
                background: rgba(10, 132, 255, 0.12);
                color: #4db2ff;
                font-size: 12px;
                font-weight: 600;
                cursor: pointer;
                transition: all 0.15s ease;
                flex-shrink: 0;
            }
            .gs-pause-btn:hover {
                background: rgba(10, 132, 255, 0.25);
            }
            .gs-resume-btn {
                padding: 4px 14px;
                border-radius: 8px;
                border: none;
                background: #0a84ff;
                color: #fff;
                font-size: 12px;
                font-weight: 600;
                cursor: pointer;
                transition: all 0.15s ease;
                flex-shrink: 0;
            }
            .gs-resume-btn:hover {
                background: #0070e0;
            }
            .gs-progress-bar-paused {
                background: rgba(255,255,255,0.2) !important;
            }

            /* ===== Channel filter dropdown ===== */
            .gs-channel-dropdown {
                position: absolute;
                top: 100%;
                right: 0;
                z-index: 1000;
                background: rgba(28, 28, 30, 0.95);
                backdrop-filter: blur(30px);
                -webkit-backdrop-filter: blur(30px);
                border: 1px solid rgba(255,255,255,0.1);
                border-radius: 12px;
                padding: 6px 0;
                max-height: 300px;
                overflow-y: auto;
                min-width: 260px;
                box-shadow: 0 12px 40px rgba(0,0,0,0.5);
            }
            .gs-channel-item {
                padding: 8px 14px;
                cursor: pointer;
                font-size: 13px;
                font-weight: 450;
                color: rgba(255,255,255,0.8);
                display: flex;
                align-items: center;
                gap: 5px;
                transition: all 0.12s ease;
                border-radius: 8px;
                margin: 1px 4px;
            }
            .gs-channel-item:hover {
                background: rgba(255,255,255,0.06);
            }
            .gs-channel-item-active {
                background: rgba(10, 132, 255, 0.15);
                color: #4db2ff;
            }
            .gs-channel-item-guild {
                color: rgba(255,255,255,0.35);
                font-size: 11px;
                font-weight: 450;
                flex-shrink: 0;
            }
            .gs-channel-item-name {
                font-weight: 550;
            }
            .gs-channel-item-count {
                color: rgba(255,255,255,0.3);
                font-size: 11px;
                margin-left: auto;
                flex-shrink: 0;
            }
            .gs-channel-filter-btn {
                font-size: 12px !important;
                max-width: 150px;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            .gs-channel-hint {
                padding: 5px 14px;
                font-size: 10px;
                color: rgba(255,255,255,0.3);
                border-bottom: 1px solid rgba(255,255,255,0.06);
                margin-bottom: 2px;
                font-weight: 400;
            }
            .gs-channel-exclude {
                background: none;
                border: none;
                color: rgba(255,255,255,0.35);
                font-size: 14px;
                cursor: pointer;
                padding: 3px 7px;
                border-radius: 6px;
                margin-left: auto;
                flex-shrink: 0;
                opacity: 0;
                transition: all 0.15s ease;
                line-height: 1;
            }
            .gs-channel-item:hover .gs-channel-exclude {
                opacity: 1;
            }
            .gs-channel-exclude:hover {
                color: #ff453a;
                background: rgba(255, 69, 58, 0.12);
            }
            .gs-channel-item-excluded {
                opacity: 0.4;
                text-decoration: line-through;
            }
            .gs-channel-item-excluded .gs-channel-exclude {
                opacity: 1;
                color: #30d158;
            }

            /* ===== View bar find button ===== */
            .gs-view-separator {
                color: rgba(255,255,255,0.15);
                font-size: 14px;
                margin: 0 2px;
                user-select: none;
            }
            .gs-find-toggle-btn {
                font-size: 12px !important;
            }

            /* ===== Find bar ===== */
            .gs-find-bar {
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 8px 12px;
                background: rgba(255,255,255,0.04);
                border: 1px solid rgba(255,255,255,0.08);
                border-radius: 10px;
                margin-bottom: 10px;
                flex-shrink: 0;
            }
            .gs-find-input {
                flex: 1;
                background: rgba(255,255,255,0.06);
                border: 1px solid rgba(255,255,255,0.1);
                border-radius: 8px;
                padding: 5px 10px;
                color: #f5f5f7;
                font-size: 13px;
                font-weight: 400;
                outline: none;
                min-width: 120px;
                transition: all 0.2s ease;
            }
            .gs-find-input:focus {
                border-color: #0a84ff;
                box-shadow: 0 0 0 3px rgba(10, 132, 255, 0.2);
            }
            .gs-find-count {
                color: rgba(255,255,255,0.35);
                font-size: 12px;
                font-weight: 450;
                white-space: nowrap;
                min-width: 50px;
                text-align: center;
            }
            .gs-find-prev, .gs-find-next, .gs-find-filter, .gs-find-close {
                background: none;
                border: none;
                color: rgba(255,255,255,0.4);
                font-size: 14px;
                cursor: pointer;
                padding: 3px 7px;
                border-radius: 6px;
                transition: all 0.15s ease;
                line-height: 1;
            }
            .gs-find-prev:hover, .gs-find-next:hover, .gs-find-close:hover {
                color: rgba(255,255,255,0.85);
                background: rgba(255,255,255,0.08);
            }
            .gs-find-filter:hover {
                color: #0a84ff;
                background: rgba(10, 132, 255, 0.1);
            }
            .gs-find-filter-active {
                color: #0a84ff !important;
                background: rgba(10, 132, 255, 0.15);
            }

            /* Highlights */
            mark.gs-highlight {
                background: rgba(255, 214, 10, 0.3);
                color: inherit;
                border-radius: 3px;
                padding: 1px 2px;
            }
            mark.gs-highlight-active {
                background: rgba(255, 159, 10, 0.55);
                color: inherit;
            }
            .gs-filtered-out {
                display: none !important;
            }

            /* ===== Scrollbar styling ===== */
            .gs-modal ::-webkit-scrollbar {
                width: 6px;
            }
            .gs-modal ::-webkit-scrollbar-track {
                background: transparent;
            }
            .gs-modal ::-webkit-scrollbar-thumb {
                background: rgba(255,255,255,0.12);
                border-radius: 3px;
            }
            .gs-modal ::-webkit-scrollbar-thumb:hover {
                background: rgba(255,255,255,0.2);
            }

            /* Has filters */
            .gs-has-area {
                display: flex;
                gap: 6px;
                padding: 0 24px 8px;
            }
            .gs-has-btn {
                padding: 4px 10px;
                border-radius: 12px;
                border: 1px solid rgba(255,255,255,0.1);
                background: rgba(255,255,255,0.04);
                color: rgba(255,255,255,0.5);
                font-size: 11px;
                cursor: pointer;
                transition: all 0.15s;
            }
            .gs-has-btn:hover { background: rgba(255,255,255,0.08); }
            .gs-has-btn-active {
                background: rgba(10,132,255,0.15);
                border-color: rgba(10,132,255,0.4);
                color: #0a84ff;
            }

            /* Rate limit banner */
            .gs-rate-limit-banner {
                background: rgba(255,159,10,0.12);
                border: 1px solid rgba(255,159,10,0.25);
                border-radius: 8px;
                padding: 4px 12px;
                color: #ff9f0a;
                font-size: 12px;
                font-weight: 500;
                margin-top: 4px;
            }

            /* Refresh button states */
            @keyframes gs-refresh-pulse {
                0%, 100% { opacity: 1; }
                50% { opacity: 0.5; }
            }
            .gs-refresh-btn-loading {
                animation: gs-refresh-pulse 1s infinite;
                pointer-events: none;
            }
            .gs-refresh-btn-done {
                background: rgba(48,209,88,0.15) !important;
                border-color: rgba(48,209,88,0.4) !important;
                color: #30d158 !important;
            }
            .gs-refresh-btn-nochange {
                background: rgba(255,255,255,0.06) !important;
                color: rgba(255,255,255,0.5) !important;
            }

            /* Done states */
            .gs-done-success { color: #30d158; font-weight: 500; }
            .gs-done-cancelled { color: #ff9f0a; font-weight: 500; }
            .gs-done-nochange { color: rgba(255,255,255,0.45); }

            /* Image preview */
            .gs-attachment-thumbs {
                display: flex;
                flex-wrap: wrap;
                gap: 6px;
                margin-top: 6px;
            }
            .gs-attachment-thumb {
                max-width: 180px;
                max-height: 100px;
                border-radius: 8px;
                cursor: pointer;
                object-fit: cover;
                border: 1px solid rgba(255,255,255,0.08);
                transition: transform 0.15s, opacity 0.15s;
            }
            .gs-attachment-thumb:hover {
                transform: scale(1.03);
                opacity: 0.9;
            }

            /* Lightbox */
            .gs-lightbox {
                position: fixed;
                inset: 0;
                background: rgba(0,0,0,0.88);
                z-index: 10001;
                display: flex;
                align-items: center;
                justify-content: center;
                cursor: pointer;
                animation: gs-fade-in 0.2s ease;
            }
            .gs-lightbox img {
                max-width: 90vw;
                max-height: 90vh;
                border-radius: 8px;
                box-shadow: 0 16px 64px rgba(0,0,0,0.6);
            }

            /* Export dropdown */
            .gs-export-dropdown {
                position: absolute;
                bottom: 100%;
                left: 0;
                background: rgba(30,31,34,0.95);
                backdrop-filter: blur(20px);
                border: 1px solid rgba(255,255,255,0.1);
                border-radius: 8px;
                overflow: hidden;
                z-index: 100;
                box-shadow: 0 8px 24px rgba(0,0,0,0.4);
                min-width: 80px;
            }
            .gs-export-option {
                padding: 8px 14px;
                font-size: 12px;
                cursor: pointer;
                color: var(--text-normal, #dcddde);
                transition: background 0.1s;
            }
            .gs-export-option:hover {
                background: rgba(255,255,255,0.08);
            }

            /* Keyboard navigation focus */
            .gs-result-focused {
                background: rgba(10,132,255,0.1) !important;
                outline: 1px solid rgba(10,132,255,0.35);
                outline-offset: -1px;
            }

            /* Light theme overrides */
            .gs-theme-light .gs-modal {
                background: rgba(255,255,255,0.95);
                border-color: rgba(0,0,0,0.1);
                box-shadow: 0 24px 80px rgba(0,0,0,0.15);
            }
            .gs-theme-light .gs-modal-header { border-bottom-color: rgba(0,0,0,0.08); }
            .gs-theme-light .gs-modal-header h2 { color: #1d1d1f; }
            .gs-theme-light .gs-search-input,
            .gs-theme-light .gs-fuzzy-input,
            .gs-theme-light .gs-exclude-input,
            .gs-theme-light .gs-guild-filter {
                background: rgba(0,0,0,0.05);
                border-color: rgba(0,0,0,0.12);
                color: #1d1d1f;
            }
            .gs-theme-light .gs-search-input::placeholder { color: rgba(0,0,0,0.35); }
            .gs-theme-light .gs-result-item { border-bottom-color: rgba(0,0,0,0.06); }
            .gs-theme-light .gs-result-item:hover { background: rgba(0,0,0,0.03); }
            .gs-theme-light .gs-result-guild strong,
            .gs-theme-light .gs-result-author { color: #1d1d1f; }
            .gs-theme-light .gs-result-content { color: rgba(0,0,0,0.7); }
            .gs-theme-light .gs-result-date,
            .gs-theme-light .gs-channel-name { color: rgba(0,0,0,0.4); }
            .gs-theme-light .gs-compact-date,
            .gs-theme-light .gs-compact-location { color: rgba(0,0,0,0.4); }
            .gs-theme-light .gs-compact-author { color: #1d1d1f; }
            .gs-theme-light .gs-compact-content { color: rgba(0,0,0,0.65); }
            .gs-theme-light .gs-history-dropdown,
            .gs-theme-light .gs-channel-dropdown,
            .gs-theme-light .gs-export-dropdown {
                background: rgba(255,255,255,0.97);
                border-color: rgba(0,0,0,0.1);
            }
            .gs-theme-light .gs-history-query { color: rgba(0,0,0,0.85); }
            .gs-theme-light .gs-history-meta { color: rgba(0,0,0,0.4); }
            .gs-theme-light .gs-view-btn {
                color: rgba(0,0,0,0.55);
                background: rgba(0,0,0,0.04);
                border-color: rgba(0,0,0,0.1);
            }
            .gs-theme-light .gs-view-btn:hover { background: rgba(0,0,0,0.08); }
            .gs-theme-light .gs-view-btn-active {
                background: rgba(10,132,255,0.1);
                color: #0a84ff;
            }
            .gs-theme-light .gs-progress { color: rgba(0,0,0,0.55); }
            .gs-theme-light .gs-settings-panel {
                background: rgba(0,0,0,0.03);
                border-color: rgba(0,0,0,0.08);
            }
            .gs-theme-light .gs-settings-label { color: rgba(0,0,0,0.7); }
            .gs-theme-light .gs-settings-input {
                background: rgba(0,0,0,0.05);
                border-color: rgba(0,0,0,0.12);
                color: #1d1d1f;
            }
            .gs-theme-light .gs-settings-help { color: rgba(0,0,0,0.35); }
            .gs-theme-light .gs-settings-title { color: #1d1d1f; }
            .gs-theme-light .gs-no-results { color: rgba(0,0,0,0.45); }
            .gs-theme-light .gs-scope-btn {
                border-color: rgba(0,0,0,0.1);
                color: rgba(0,0,0,0.5);
                background: rgba(0,0,0,0.03);
            }
            .gs-theme-light .gs-scope-btn-active {
                background: rgba(10,132,255,0.1);
                border-color: rgba(10,132,255,0.3);
                color: #0a84ff;
            }
            .gs-theme-light .gs-has-btn {
                border-color: rgba(0,0,0,0.1);
                color: rgba(0,0,0,0.45);
                background: rgba(0,0,0,0.03);
            }
            .gs-theme-light .gs-has-btn-active {
                background: rgba(10,132,255,0.1);
                border-color: rgba(10,132,255,0.3);
                color: #0a84ff;
            }
            .gs-theme-light .gs-attachment-thumb { border-color: rgba(0,0,0,0.1); }
            .gs-theme-light .gs-rate-limit-banner {
                background: rgba(255,159,10,0.08);
                color: #c77c00;
            }
            .gs-theme-light .gs-search-btn,
            .gs-theme-light .gs-refresh-btn {
                border-color: rgba(0,0,0,0.12);
                color: rgba(0,0,0,0.7);
            }
            .gs-theme-light .gs-result-focused {
                background: rgba(10,132,255,0.08) !important;
                outline-color: rgba(10,132,255,0.25);
            }
            .gs-theme-light .gs-modal-overlay { background: rgba(0,0,0,0.3); }
            .gs-theme-light .gs-modal ::-webkit-scrollbar-thumb {
                background: rgba(0,0,0,0.12);
            }
            .gs-theme-light .gs-modal ::-webkit-scrollbar-thumb:hover {
                background: rgba(0,0,0,0.2);
            }
        `);
    }

    removeStyles() {
        BdApi.DOM.removeStyle(this.styleId);
    }
};
