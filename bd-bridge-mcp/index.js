#!/usr/bin/env node
/**
 * bd-bridge-mcp — MCP server que consome o ClaudeBridge BetterDiscord plugin.
 * Expoe tools read-only sobre o Discord client do usuario (guilds, canais, mensagens, DMs, users).
 * Le token compartilhado de %APPDATA%/BetterDiscord/data/claude-bridge-token.txt
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs";
import path from "node:path";

const PORT = Number(process.env.BD_BRIDGE_PORT || 17823);
const HOST = "127.0.0.1";
const TOKEN_FILE = process.env.BD_BRIDGE_TOKEN_FILE
    || path.join(process.env.APPDATA || "", "BetterDiscord", "data", "claude-bridge-token.txt");

function readToken() {
    try {
        return fs.readFileSync(TOKEN_FILE, "utf8").trim();
    } catch (e) {
        return null;
    }
}

async function bridgeFetch(pathWithQuery) {
    const token = readToken();
    if (!token) throw new Error(`Token file not found at ${TOKEN_FILE}. Is ClaudeBridge plugin enabled in BetterDiscord?`);
    const url = `http://${HOST}:${PORT}${pathWithQuery}`;
    const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
    });
    const text = await res.text();
    if (!res.ok) {
        throw new Error(`Bridge ${res.status}: ${text.slice(0, 300)}`);
    }
    try {
        return JSON.parse(text);
    } catch (e) {
        throw new Error(`Bridge returned non-JSON: ${text.slice(0, 200)}`);
    }
}

function qs(params) {
    const pairs = Object.entries(params || {}).filter(([, v]) => v !== undefined && v !== null && v !== "");
    if (!pairs.length) return "";
    return "?" + pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
}

function ok(obj) {
    return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

const TOOLS = [
    {
        name: "bridge_health",
        description: "Verifica se a ponte ClaudeBridge esta rodando no Discord. Use primeiro pra diagnostico.",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "get_me",
        description: "Retorna informacoes do usuario Discord atualmente logado.",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "list_guilds",
        description: "Lista todos os servidores Discord em que o usuario esta. Opcionalmente filtra por nome (substring).",
        inputSchema: {
            type: "object",
            properties: {
                name: { type: "string", description: "Filtro por nome (substring, case-insensitive)." },
            },
        },
    },
    {
        name: "get_guild",
        description: "Retorna detalhes de um servidor pelo ID.",
        inputSchema: {
            type: "object",
            required: ["guildId"],
            properties: { guildId: { type: "string" } },
        },
    },
    {
        name: "list_channels",
        description: "Lista canais de um servidor. Retorna TAMBEM canais ocultos que o HiddenChannels plugin revela. Suporta filtro por regex no nome e por tipo.",
        inputSchema: {
            type: "object",
            required: ["guildId"],
            properties: {
                guildId: { type: "string" },
                pattern: { type: "string", description: "Regex aplicada ao nome do canal (ex: '^edit-')." },
                type: { type: "number", description: "Tipo Discord: 0=text, 2=voice, 4=category, 5=announcement, 13=stage, 15=forum." },
            },
        },
    },
    {
        name: "count_channels",
        description: "Conta canais de um servidor, opcionalmente filtrados por regex/tipo. Pode agrupar por captura de regex (groupBy='regex' + groupRegex com grupo de captura). Exemplo: pra contar canais 'edit-X-Y' agrupados por editor X, use groupRegex='^edit-([^-]+)'.",
        inputSchema: {
            type: "object",
            required: ["guildId"],
            properties: {
                guildId: { type: "string" },
                pattern: { type: "string", description: "Regex de filtro no nome do canal (ex: '^edit-')." },
                type: { type: "number" },
                groupBy: { type: "string", enum: ["regex"], description: "Agrupar por captura de regex." },
                groupRegex: { type: "string", description: "Regex com grupo de captura pra agrupamento. Ex: '^edit-([^-]+)' agrupa pelo primeiro segmento." },
            },
        },
    },
    {
        name: "list_members",
        description: "Lista membros de um servidor (pode ser incompleto se o Discord ainda nao carregou todos). Opcional: filtrar por role ID.",
        inputSchema: {
            type: "object",
            required: ["guildId"],
            properties: {
                guildId: { type: "string" },
                role: { type: "string", description: "ID de um role pra filtrar." },
                limit: { type: "number", description: "Max resultados (default 500)." },
            },
        },
    },
    {
        name: "get_channel",
        description: "Retorna detalhes de um canal pelo ID.",
        inputSchema: {
            type: "object",
            required: ["channelId"],
            properties: { channelId: { type: "string" } },
        },
    },
    {
        name: "get_messages",
        description: "Busca mensagens recentes de um canal via Discord API (respeita permissoes — nao le canais ocultos que o usuario nao tem acesso real, so visiveis via HiddenChannels).",
        inputSchema: {
            type: "object",
            required: ["channelId"],
            properties: {
                channelId: { type: "string" },
                limit: { type: "number", description: "Max 100, default 50." },
                before: { type: "string", description: "Snowflake pra paginacao (mensagens antes deste ID)." },
                after: { type: "string" },
            },
        },
    },
    {
        name: "list_dms",
        description: "Lista todas as conversas diretas (DM 1:1 e grupos).",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "get_user",
        description: "Retorna info de um usuario pelo ID (a partir do cache local do Discord).",
        inputSchema: {
            type: "object",
            required: ["userId"],
            properties: { userId: { type: "string" } },
        },
    },
];

const server = new Server(
    { name: "bd-bridge-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    try {
        switch (name) {
            case "bridge_health":
                return ok(await bridgeFetch("/health"));
            case "get_me":
                return ok(await bridgeFetch("/me"));
            case "list_guilds":
                return ok(await bridgeFetch("/guilds" + qs({ name: args.name })));
            case "get_guild":
                return ok(await bridgeFetch(`/guilds/${encodeURIComponent(args.guildId)}`));
            case "list_channels":
                return ok(await bridgeFetch(`/guilds/${encodeURIComponent(args.guildId)}/channels` + qs({ pattern: args.pattern, type: args.type })));
            case "count_channels":
                return ok(await bridgeFetch(`/guilds/${encodeURIComponent(args.guildId)}/channels/count` + qs({
                    pattern: args.pattern, type: args.type, groupBy: args.groupBy, groupRegex: args.groupRegex,
                })));
            case "list_members":
                return ok(await bridgeFetch(`/guilds/${encodeURIComponent(args.guildId)}/members` + qs({ role: args.role, limit: args.limit })));
            case "get_channel":
                return ok(await bridgeFetch(`/channels/${encodeURIComponent(args.channelId)}`));
            case "get_messages":
                return ok(await bridgeFetch(`/channels/${encodeURIComponent(args.channelId)}/messages` + qs({
                    limit: args.limit, before: args.before, after: args.after,
                })));
            case "list_dms":
                return ok(await bridgeFetch("/dms"));
            case "get_user":
                return ok(await bridgeFetch(`/users/${encodeURIComponent(args.userId)}`));
            default:
                return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
        }
    } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
});

const transport = new StdioServerTransport();
await server.connect(transport);
