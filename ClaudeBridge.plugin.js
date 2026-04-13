/**
 * @name ClaudeBridge
 * @author Rapha
 * @description Expoe os dados do Discord client (guilds, canais, mensagens, DMs, users) via HTTP local autenticado para consumo por agentes Claude / MCP. Somente leitura. Acesso aos webpack stores — retorna tambem canais ocultos visiveis via HiddenChannels.
 * @version 1.0.0
 * @source https://github.com/rapha30/discord-plugins
 * @updateUrl https://raw.githubusercontent.com/rapha30/discord-plugins/master/ClaudeBridge.plugin.js
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

module.exports = class ClaudeBridge {
    constructor(meta) {
        this.meta = meta;
        this.pluginName = "ClaudeBridge";
        this.port = 17823;
        this.server = null;
        this.token = null;
        this.tokenFilePath = path.join(
            process.env.APPDATA || "",
            "BetterDiscord",
            "data",
            "claude-bridge-token.txt"
        );
        this.modules = {};
        this.logFilePath = path.join(
            (BdApi.Plugins && BdApi.Plugins.folder) || "",
            "ClaudeBridge.log"
        );
    }

    // ========== LOGGING ==========
    log(msg) {
        const line = `[${new Date().toISOString()}] ${msg}\n`;
        try { fs.appendFileSync(this.logFilePath, line); } catch (e) {}
        console.log(`[ClaudeBridge] ${msg}`);
    }

    // ========== LIFECYCLE ==========
    start() {
        try {
            this.log("Iniciando ClaudeBridge...");
            this.cacheModules();
            this.ensureToken();
            this.startServer();
            BdApi.UI.showToast(`ClaudeBridge ON — porta ${this.port}`, { type: "success" });
            this.log(`Pronto. Token salvo em ${this.tokenFilePath}`);
        } catch (e) {
            this.log(`ERRO start(): ${e.message}\n${e.stack}`);
            BdApi.UI.showToast(`ClaudeBridge falhou: ${e.message}`, { type: "error" });
        }
    }

    stop() {
        try {
            if (this.server) {
                this.server.close();
                this.server = null;
            }
            this.log("ClaudeBridge parado");
        } catch (e) {
            this.log(`ERRO stop(): ${e.message}`);
        }
    }

    getSettingsPanel() {
        const panel = document.createElement("div");
        panel.style.cssText = "padding:16px;color:var(--text-normal);";
        const status = this.server ? `🟢 ON — porta ${this.port}` : "🔴 OFF";
        panel.innerHTML = `
            <h3 style="margin:0 0 12px;">ClaudeBridge</h3>
            <p>Status: <strong>${status}</strong></p>
            <p>Token file: <code style="font-size:11px;">${this.tokenFilePath}</code></p>
            <p style="color:var(--text-muted);margin-top:12px;">
                Servidor HTTP local que expoe os dados do Discord client para agentes Claude.<br>
                Endpoints GET em <code>http://localhost:${this.port}</code> com header <code>Authorization: Bearer &lt;token&gt;</code>.
            </p>
            <p style="color:var(--text-muted);font-size:12px;margin-top:12px;">
                Endpoints: /health, /guilds, /guilds/:id, /guilds/:id/channels, /guilds/:id/members,
                /channels/:id, /channels/:id/messages, /dms, /users/:id, /me
            </p>
        `;
        return panel;
    }

    // ========== DISCORD MODULES ==========
    cacheModules() {
        const findByProps = (...props) => BdApi.Webpack.getModule(
            m => props.every(p => m && m[p] !== undefined)
        );
        this.modules.GuildStore = findByProps("getGuild", "getGuilds");
        this.modules.ChannelStore = findByProps("getChannel", "getMutableGuildChannelsForGuild")
            || findByProps("getChannel", "getDMFromUserId")
            || findByProps("getChannel");
        this.modules.GuildChannelStore = findByProps("getChannels", "getDefaultChannel")
            || findByProps("getChannels");
        this.modules.GuildMemberStore = findByProps("getMember", "getMembers");
        this.modules.GuildMemberCountStore = findByProps("getMemberCount", "getOnlineCount")
            || findByProps("getMemberCount");
        this.modules.UserStore = findByProps("getUser", "getCurrentUser");
        this.modules.ReadStateStore = findByProps("hasUnread", "getMentionCount");
        this.modules.PrivateChannelSortStore = findByProps("getPrivateChannelIds")
            || findByProps("getSortedPrivateChannels");
        this.modules.SortedGuildStore = findByProps("getGuildFolders");
        this.modules.RelationshipStore = findByProps("isFriend", "getRelationships");
        this.modules.PermissionStore = findByProps("can", "canManageUser") || findByProps("can");

        const missing = Object.entries(this.modules).filter(([, v]) => !v).map(([k]) => k);
        if (missing.length) this.log(`Aviso: modulos nao encontrados: ${missing.join(", ")}`);
    }

    // ========== TOKEN ==========
    ensureToken() {
        try {
            if (fs.existsSync(this.tokenFilePath)) {
                this.token = fs.readFileSync(this.tokenFilePath, "utf8").trim();
                if (this.token && this.token.length >= 32) {
                    this.log("Token existente carregado");
                    return;
                }
            }
        } catch (e) {}
        this.token = crypto.randomBytes(32).toString("hex");
        try {
            fs.mkdirSync(path.dirname(this.tokenFilePath), { recursive: true });
            fs.writeFileSync(this.tokenFilePath, this.token);
            this.log("Novo token gerado");
        } catch (e) {
            this.log(`ERRO salvando token: ${e.message}`);
        }
    }

    // ========== HTTP SERVER ==========
    startServer() {
        this.server = http.createServer((req, res) => this.handleRequest(req, res));
        this.server.on("error", (err) => {
            this.log(`HTTP server error: ${err.message}`);
            if (err.code === "EADDRINUSE") {
                BdApi.UI.showToast(`Porta ${this.port} ja em uso`, { type: "error" });
            }
        });
        this.server.listen(this.port, "127.0.0.1", () => {
            this.log(`HTTP server ouvindo em 127.0.0.1:${this.port}`);
        });
    }

    handleRequest(req, res) {
        const send = (code, body, headers = {}) => {
            res.writeHead(code, {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "http://localhost",
                ...headers,
            });
            res.end(typeof body === "string" ? body : JSON.stringify(body));
        };

        try {
            // Auth
            const auth = req.headers.authorization || "";
            const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
            const url = new URL(req.url, `http://127.0.0.1:${this.port}`);

            // /health is public
            if (url.pathname === "/health") {
                return send(200, { ok: true, plugin: this.pluginName, version: this.meta?.version || "1.0.0" });
            }

            if (!bearer || bearer !== this.token) {
                return send(401, { error: "unauthorized" });
            }

            // Route dispatch
            const p = url.pathname;
            const q = Object.fromEntries(url.searchParams);

            if (p === "/me") return send(200, this.getMe());
            if (p === "/guilds") return send(200, this.getGuilds(q));
            if (p === "/dms") return send(200, this.getDMs());

            let m;
            if ((m = p.match(/^\/guilds\/([^\/]+)$/))) return send(200, this.getGuild(m[1]));
            if ((m = p.match(/^\/guilds\/([^\/]+)\/channels$/))) return send(200, this.getGuildChannels(m[1], q));
            if ((m = p.match(/^\/guilds\/([^\/]+)\/channels\/count$/))) return send(200, this.countGuildChannels(m[1], q));
            if ((m = p.match(/^\/guilds\/([^\/]+)\/members$/))) return send(200, this.getGuildMembers(m[1], q));
            if ((m = p.match(/^\/channels\/([^\/]+)$/))) return send(200, this.getChannel(m[1]));
            if ((m = p.match(/^\/channels\/([^\/]+)\/messages$/))) {
                return this.fetchChannelMessages(m[1], q).then(
                    data => send(200, data),
                    err => send(500, { error: err.message })
                );
            }
            if ((m = p.match(/^\/users\/([^\/]+)$/))) return send(200, this.getUser(m[1]));

            return send(404, { error: "not found", path: p });
        } catch (e) {
            this.log(`ERRO handleRequest: ${e.message}\n${e.stack}`);
            return send(500, { error: e.message });
        }
    }

    // ========== DATA HELPERS ==========
    getMe() {
        const u = this.modules.UserStore?.getCurrentUser();
        if (!u) return { error: "current user not found" };
        return {
            id: u.id, username: u.username, globalName: u.globalName,
            discriminator: u.discriminator, avatar: u.avatar,
        };
    }

    getGuilds(q = {}) {
        const all = this.modules.GuildStore?.getGuilds() || {};
        let list = Object.values(all).map(g => ({
            id: g.id, name: g.name, icon: g.icon, ownerId: g.ownerId,
            memberCount: this.modules.GuildMemberCountStore?.getMemberCount?.(g.id) ?? null,
            onlineCount: this.modules.GuildMemberCountStore?.getOnlineCount?.(g.id) ?? null,
        }));
        if (q.name) {
            const needle = q.name.toLowerCase();
            list = list.filter(g => g.name.toLowerCase().includes(needle));
        }
        return { count: list.length, guilds: list };
    }

    getGuild(id) {
        const g = this.modules.GuildStore?.getGuild(id);
        if (!g) return { error: "guild not found" };
        return {
            id: g.id, name: g.name, icon: g.icon, ownerId: g.ownerId,
            description: g.description, memberCount: this.modules.GuildMemberCountStore?.getMemberCount?.(g.id) ?? null,
            onlineCount: this.modules.GuildMemberCountStore?.getOnlineCount?.(g.id) ?? null,
        };
    }

    getGuildChannelsRaw(guildId) {
        // Try GuildChannelStore.getChannels (returns grouped by type)
        const gcs = this.modules.GuildChannelStore;
        if (gcs?.getChannels) {
            const grouped = gcs.getChannels(guildId);
            if (grouped) {
                const out = [];
                for (const key of Object.keys(grouped)) {
                    const v = grouped[key];
                    if (Array.isArray(v)) {
                        for (const entry of v) {
                            const c = entry?.channel || entry;
                            if (c && c.id) out.push(c);
                        }
                    }
                }
                if (out.length) return out;
            }
        }
        // Fallback: ChannelStore.getMutableGuildChannelsForGuild
        const cs = this.modules.ChannelStore;
        if (cs?.getMutableGuildChannelsForGuild) {
            const map = cs.getMutableGuildChannelsForGuild(guildId) || {};
            return Object.values(map);
        }
        return [];
    }

    getGuildChannels(guildId, q = {}) {
        const raw = this.getGuildChannelsRaw(guildId);
        let list = raw.map(c => ({
            id: c.id, name: c.name, type: c.type, parentId: c.parent_id || c.parentId,
            position: c.position, topic: c.topic, nsfw: c.nsfw,
            lastMessageId: c.lastMessageId || c.last_message_id,
            permissionOverwrites: Array.isArray(c.permissionOverwrites)
                ? c.permissionOverwrites
                : c.permissionOverwrites
                    ? Object.values(c.permissionOverwrites)
                    : [],
        }));
        if (q.pattern) {
            let regex;
            try { regex = new RegExp(q.pattern, "i"); }
            catch (e) { return { error: `invalid regex: ${e.message}` }; }
            list = list.filter(c => regex.test(c.name || ""));
        }
        if (q.type !== undefined) {
            const t = Number(q.type);
            list = list.filter(c => c.type === t);
        }
        return { guildId, count: list.length, channels: list };
    }

    countGuildChannels(guildId, q = {}) {
        const raw = this.getGuildChannelsRaw(guildId);
        let list = raw.map(c => ({ id: c.id, name: c.name || "", type: c.type }));
        if (q.pattern) {
            let regex;
            try { regex = new RegExp(q.pattern, "i"); }
            catch (e) { return { error: `invalid regex: ${e.message}` }; }
            list = list.filter(c => regex.test(c.name));
        }
        if (q.type !== undefined) {
            const t = Number(q.type);
            list = list.filter(c => c.type === t);
        }

        const result = { guildId, total: list.length };

        if (q.groupBy === "regex" && q.groupRegex) {
            let gr;
            try { gr = new RegExp(q.groupRegex, "i"); }
            catch (e) { return { error: `invalid groupRegex: ${e.message}` }; }
            const groups = {};
            for (const c of list) {
                const match = c.name.match(gr);
                const key = match ? (match[1] || match[0]) : "(no match)";
                groups[key] = (groups[key] || 0) + 1;
            }
            result.groups = groups;
        }
        return result;
    }

    getGuildMembers(guildId, q = {}) {
        const store = this.modules.GuildMemberStore;
        if (!store) return { error: "GuildMemberStore unavailable" };
        const members = store.getMembers?.(guildId) || [];
        let list = members.map(m => ({
            userId: m.userId, nick: m.nick, roles: m.roles,
            premiumSince: m.premiumSince, joinedAt: m.joinedAt,
        }));
        if (q.role) list = list.filter(m => m.roles?.includes(q.role));
        return { guildId, count: list.length, members: list.slice(0, Number(q.limit) || 500) };
    }

    getChannel(id) {
        const c = this.modules.ChannelStore?.getChannel(id);
        if (!c) return { error: "channel not found" };
        return {
            id: c.id, name: c.name, type: c.type, guildId: c.guild_id,
            parentId: c.parent_id, topic: c.topic, nsfw: c.nsfw,
            lastMessageId: c.lastMessageId || c.last_message_id,
        };
    }

    getDMs() {
        const cs = this.modules.ChannelStore;
        if (!cs) return { error: "ChannelStore unavailable" };
        // Attempt via PrivateChannelSortStore
        const ids = this.modules.PrivateChannelSortStore?.getPrivateChannelIds?.() || [];
        let channels = ids.map(id => cs.getChannel(id)).filter(Boolean);
        if (!channels.length) {
            // Fallback: scan all channels
            const mutable = cs.getMutablePrivateChannels?.() || {};
            channels = Object.values(mutable);
        }
        const list = channels.map(c => ({
            id: c.id,
            type: c.type, // 1=DM, 3=group DM
            name: c.name || null,
            recipientIds: c.recipients || c.rawRecipients?.map(r => r.id) || [],
            lastMessageId: c.lastMessageId || c.last_message_id,
        }));
        return { count: list.length, dms: list };
    }

    getUser(id) {
        const u = this.modules.UserStore?.getUser(id);
        if (!u) return { error: "user not found" };
        return {
            id: u.id, username: u.username, globalName: u.globalName,
            discriminator: u.discriminator, avatar: u.avatar, bot: u.bot,
        };
    }

    // ========== DISCORD API FETCH (for messages) ==========
    async fetchChannelMessages(channelId, q = {}) {
        const token = this.getDiscordToken();
        if (!token) throw new Error("user token unavailable");
        const limit = Math.min(Number(q.limit) || 50, 100);
        const params = new URLSearchParams({ limit: String(limit) });
        if (q.before) params.set("before", q.before);
        if (q.after) params.set("after", q.after);
        const url = `https://discord.com/api/v9/channels/${channelId}/messages?${params}`;
        const https = require("https");
        return new Promise((resolve, reject) => {
            const req = https.request(url, {
                method: "GET",
                headers: { Authorization: token, "User-Agent": "Mozilla/5.0 ClaudeBridge" },
            }, (r) => {
                let data = "";
                r.on("data", (chunk) => (data += chunk));
                r.on("end", () => {
                    if (r.statusCode !== 200) {
                        return reject(new Error(`Discord API ${r.statusCode}: ${data.slice(0, 200)}`));
                    }
                    try {
                        const msgs = JSON.parse(data);
                        resolve({
                            channelId,
                            count: msgs.length,
                            messages: msgs.map(m => ({
                                id: m.id,
                                content: m.content,
                                authorId: m.author?.id,
                                authorName: m.author?.username,
                                timestamp: m.timestamp,
                                editedTimestamp: m.edited_timestamp,
                                attachmentCount: m.attachments?.length || 0,
                                embedCount: m.embeds?.length || 0,
                            })),
                        });
                    } catch (e) { reject(e); }
                });
            });
            req.on("error", reject);
            req.end();
        });
    }

    getDiscordToken() {
        try {
            const wpReq = BdApi.Webpack.getModule(m => m?.getToken, { searchExports: false });
            if (wpReq?.getToken) return wpReq.getToken();
        } catch (e) {}
        try {
            // Fallback via localStorage hack
            const iframe = document.createElement("iframe");
            document.body.appendChild(iframe);
            const ls = iframe.contentWindow.localStorage;
            document.body.removeChild(iframe);
            const t = ls.getItem("token");
            if (t) return t.replace(/"/g, "");
        } catch (e) {}
        return null;
    }
};
