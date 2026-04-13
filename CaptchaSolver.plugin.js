/**
 * @name CaptchaSolver
 * @author Rapha
 * @description Resolve CAPTCHAs do Discord automaticamente. Intercepta qualquer request que retorne CAPTCHA e resolve via browser (extensao YesCaptcha/CapSolver) ou API. Outros plugins podem usar via BdApi.Plugins.get("CaptchaSolver").instance.solve(data).
 * @version 1.0.0
 * @source https://github.com/rapha30/discord-plugins
 * @updateUrl https://raw.githubusercontent.com/rapha30/discord-plugins/master/CaptchaSolver.plugin.js
 */

module.exports = class CaptchaSolver {
    constructor(meta) {
        this.meta = meta;
        this.settings = {
            solver: "browser", // none, browser, yescaptcha, capsolver, 2captcha
            apiKey: "",
            browserPath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
            extensionPath: "C:\\ClaudeAIProjects\\RobloxAccountManagerPlus\\Roblox-Account-Manager\\build\\Release\\extension\\yescaptcha",
            showBrowser: true,
            timeoutSeconds: 120
        };
        this._originalFetch = null;
        this._captchaObserver = null;
        this._captchaModalDetected = false;
        this._captchaServer = null;
        this._solvingInProgress = false;
        this._solveQueue = [];
        this._stats = { solved: 0, failed: 0, lastSolveMs: 0 };
    }

    // ========== LIFECYCLE ==========

    start() {
        this.loadSettings();
        this._installFetchInterceptor();
        this._installDomObserver();
        this.log("CaptchaSolver ativado");
        BdApi.UI.showToast("CaptchaSolver ativado", { type: "success" });
    }

    stop() {
        this._removeFetchInterceptor();
        this._removeDomObserver();
        if (this._captchaServer) try { this._captchaServer.close(); } catch {}
        this._captchaServer = null;
        this._solveQueue = [];
        this._solvingInProgress = false;
        this.log("CaptchaSolver desativado");
    }

    // ========== LOGGING ==========

    log(msg) {
        const ts = new Date().toISOString();
        console.log(`%c[CaptchaSolver]%c ${msg}`, "color:#ff6b6b;font-weight:bold", "");
        try {
            const fs = require("fs");
            const path = require("path");
            const logPath = path.join(BdApi.Plugins.folder, "..", "CaptchaSolver.log");
            fs.appendFileSync(logPath, `[${ts}] ${msg}\n`);
        } catch {}
    }

    // ========== SETTINGS ==========

    loadSettings() {
        const saved = BdApi.Data.load(this.meta.name, "settings");
        if (saved) Object.assign(this.settings, saved);
    }

    saveSettings() {
        BdApi.Data.save(this.meta.name, "settings", this.settings);
    }

    getSettingsPanel() {
        const panel = document.createElement("div");
        panel.style.cssText = "padding:12px;color:#dcddde;font-family:var(--font-primary,sans-serif);";

        const makeRow = (label, input, help) => {
            const row = document.createElement("div");
            row.style.cssText = "margin-bottom:10px;";
            const lbl = document.createElement("div");
            lbl.style.cssText = "font-size:13px;font-weight:600;margin-bottom:4px;";
            lbl.textContent = label;
            row.appendChild(lbl);
            row.appendChild(input);
            if (help) {
                const h = document.createElement("div");
                h.style.cssText = "font-size:11px;color:#72767d;margin-top:2px;";
                h.textContent = help;
                row.appendChild(h);
            }
            return row;
        };

        const inputStyle = "background:#1e1f22;border:1px solid #3f4147;color:#dcddde;padding:6px 8px;border-radius:4px;font-size:13px;width:100%;box-sizing:border-box;";

        // Solver select
        const solverSelect = document.createElement("select");
        solverSelect.style.cssText = inputStyle + "width:180px;";
        [["none", "Nenhum"], ["browser", "Browser (extensao)"], ["yescaptcha", "YesCaptcha API"], ["capsolver", "CapSolver API"], ["2captcha", "2Captcha API"]].forEach(([val, label]) => {
            const opt = document.createElement("option");
            opt.value = val;
            opt.textContent = label;
            if (this.settings.solver === val) opt.selected = true;
            solverSelect.appendChild(opt);
        });

        // API key
        const apiKeyInput = document.createElement("input");
        apiKeyInput.type = "password";
        apiKeyInput.placeholder = "Cole sua API key aqui";
        apiKeyInput.value = this.settings.apiKey || "";
        apiKeyInput.style.cssText = inputStyle + "width:250px;";
        apiKeyInput.addEventListener("dblclick", () => {
            apiKeyInput.type = apiKeyInput.type === "password" ? "text" : "password";
        });

        // Browser path
        const browserInput = document.createElement("input");
        browserInput.type = "text";
        browserInput.value = this.settings.browserPath || "";
        browserInput.style.cssText = inputStyle + "font-size:11px;";

        // Extension path
        const extInput = document.createElement("input");
        extInput.type = "text";
        extInput.value = this.settings.extensionPath || "";
        extInput.style.cssText = inputStyle + "font-size:11px;";

        // Show browser toggle
        const showCheck = document.createElement("input");
        showCheck.type = "checkbox";
        showCheck.checked = this.settings.showBrowser !== false;
        showCheck.style.cssText = "margin-right:8px;cursor:pointer;";
        const showLabel = document.createElement("label");
        showLabel.style.cssText = "cursor:pointer;display:flex;align-items:center;font-size:13px;";
        showLabel.append(showCheck, document.createTextNode("Mostrar browser ao resolver"));

        // Timeout
        const timeoutInput = document.createElement("input");
        timeoutInput.type = "number";
        timeoutInput.min = "30";
        timeoutInput.max = "300";
        timeoutInput.value = this.settings.timeoutSeconds || 120;
        timeoutInput.style.cssText = inputStyle + "width:80px;";

        // Stats
        const statsDiv = document.createElement("div");
        statsDiv.style.cssText = "margin-top:12px;padding:8px;background:#2b2d31;border-radius:4px;font-size:12px;color:#b5bac1;";
        statsDiv.innerHTML = `Resolvidos: <b style="color:#57f287">${this._stats.solved}</b> | Falharam: <b style="color:#ed4245">${this._stats.failed}</b>${this._stats.lastSolveMs ? ` | Ultimo: ${(this._stats.lastSolveMs / 1000).toFixed(1)}s` : ""}`;

        // Visibility logic
        const updateVisibility = () => {
            const val = solverSelect.value;
            const isBrowser = val === "browser";
            const needsKey = !["none", "browser"].includes(val);
            apiKeyRow.style.display = needsKey ? "" : "none";
            browserRow.style.display = isBrowser ? "" : "none";
            extRow.style.display = isBrowser ? "" : "none";
            showLabel.parentElement.style.display = isBrowser ? "" : "none";
        };

        // Build rows
        const solverRow = makeRow("CAPTCHA solver:", solverSelect, "Resolve CAPTCHAs automaticamente em qualquer acao do Discord");
        const apiKeyRow = makeRow("API Key:", apiKeyInput, "Duplo-clique pra mostrar/esconder");
        const browserRow = makeRow("Chromium path:", browserInput, "Executavel do Chrome/Chromium");
        const extRow = makeRow("Extensao path:", extInput, "Pasta da extensao solver (YesCaptcha/CapSolver)");
        const showRow = document.createElement("div");
        showRow.style.cssText = "margin-bottom:10px;";
        showRow.appendChild(showLabel);
        const timeoutRow = makeRow("Timeout (segundos):", timeoutInput, "Tempo maximo pra resolver (30-300s)");

        // Events
        const save = () => {
            this.settings.solver = solverSelect.value;
            this.settings.apiKey = apiKeyInput.value.trim();
            this.settings.browserPath = browserInput.value.trim();
            this.settings.extensionPath = extInput.value.trim();
            this.settings.showBrowser = showCheck.checked;
            this.settings.timeoutSeconds = Math.max(30, Math.min(300, parseInt(timeoutInput.value) || 120));
            this.saveSettings();
            // Reinstall interceptor with new settings
            this._removeFetchInterceptor();
            this._removeDomObserver();
            this._installFetchInterceptor();
            this._installDomObserver();
        };

        [solverSelect, apiKeyInput, browserInput, extInput, showCheck, timeoutInput].forEach(el => {
            el.addEventListener("change", () => { save(); updateVisibility(); });
        });

        panel.append(solverRow, apiKeyRow, browserRow, extRow, showRow, timeoutRow, statsDiv);
        updateVisibility();

        return panel;
    }

    // ========== PUBLIC API (for other plugins) ==========

    /**
     * Resolve um CAPTCHA do Discord.
     * @param {Object} captchaData - { captcha_sitekey, captcha_rqdata, captcha_rqtoken, captcha_service }
     * @returns {Promise<string|null>} Token resolvido ou null
     */
    async solve(captchaData) {
        return this._solveCaptcha(captchaData);
    }

    /**
     * Retorna stats de resolucao.
     */
    getStats() {
        return { ...this._stats };
    }

    // ========== FETCH INTERCEPTOR ==========

    _installFetchInterceptor() {
        if (this.settings.solver === "none") return;
        if (this._originalFetch) return; // ja instalado

        this._originalFetch = window.fetch.bind(window);
        const plugin = this;

        window.fetch = async function(url, options = {}) {
            const res = await plugin._originalFetch(url, options);

            // Intercepta respostas 400 do Discord com CAPTCHA
            if (typeof url === "string" && url.includes("discord.com/api/") && res.status === 400) {
                try {
                    const clone = res.clone();
                    const body = await clone.json();

                    if (body?.captcha_key && body?.captcha_sitekey && plugin.settings.solver !== "none") {
                        plugin.log(`[Interceptor] CAPTCHA detectado em ${url.substring(url.indexOf("/api/"), url.indexOf("/api/") + 50)}...`);

                        const startTime = Date.now();
                        const token = await plugin._solveCaptcha({
                            captcha_sitekey: body.captcha_sitekey,
                            captcha_rqdata: body.captcha_rqdata,
                            captcha_rqtoken: body.captcha_rqtoken,
                            captcha_service: body.captcha_service,
                            captcha_session_id: body.captcha_session_id
                        });

                        if (token) {
                            plugin._stats.lastSolveMs = Date.now() - startTime;
                            plugin.log(`[Interceptor] Resolvido em ${plugin._stats.lastSolveMs}ms, re-tentando request...`);

                            const newHeaders = new Headers(options.headers || {});
                            newHeaders.set("X-Captcha-Key", token);
                            if (body.captcha_rqtoken) newHeaders.set("X-Captcha-Rqtoken", body.captcha_rqtoken);
                            if (body.captcha_session_id) newHeaders.set("X-Captcha-Session-Id", body.captcha_session_id);

                            return plugin._originalFetch(url, { ...options, headers: newHeaders });
                        }
                    }
                } catch (e) {
                    plugin.log(`[Interceptor] Erro: ${e.message}`);
                }
            }
            return res;
        };
        this.log("Fetch interceptor instalado");
    }

    _removeFetchInterceptor() {
        if (this._originalFetch) {
            window.fetch = this._originalFetch;
            this._originalFetch = null;
            this.log("Fetch interceptor removido");
        }
    }

    // ========== DOM OBSERVER (modal nativo fallback) ==========

    _installDomObserver() {
        if (this.settings.solver === "none") return;
        if (this._captchaObserver) return;

        // Quando o Discord mostra o iframe nativo do hCaptcha, o fetch interceptor
        // ja deveria ter resolvido (ele pega a resposta 400 antes do modal aparecer).
        // O modal nativo aparece quando o Discord renderiza o CAPTCHA no proprio UI
        // (ex: login, join server via invite no client). Nesses casos o iframe e cross-origin
        // e nao da pra injetar o token de volta diretamente.
        //
        // Estrategia: detectar o modal, avisar o usuario que o solver automatico esta ativo,
        // e se o fetch interceptor nao pegou, oferecer resolucao manual.
        // O postMessage de volta pro Discord nao funciona de forma confiavel porque
        // o Discord valida event.origin como hcaptcha.com.
        this._captchaObserver = new MutationObserver(() => {
            const iframe = document.querySelector('iframe[src*="hcaptcha.com"]');
            if (iframe && !this._captchaModalDetected) {
                this._captchaModalDetected = true;
                this.log("[DomObserver] Modal nativo de hCaptcha detectado");
                BdApi.UI.showToast("CAPTCHA nativo detectado — se nao resolver sozinho, resolva manualmente no modal", { type: "warning" });
                setTimeout(() => { this._captchaModalDetected = false; }, 30000);
            }
        });
        this._captchaObserver.observe(document.body, { childList: true, subtree: true });
        this.log("DOM observer instalado");
    }

    _removeDomObserver() {
        if (this._captchaObserver) {
            this._captchaObserver.disconnect();
            this._captchaObserver = null;
            this._captchaModalDetected = false;
            this.log("DOM observer removido");
        }
    }

    // ========== CAPTCHA SOLVER ==========

    async _solveCaptcha(captchaData) {
        const solver = this.settings.solver;

        if (solver === "none") {
            BdApi.UI.showToast("CAPTCHA detectado! Configure um solver no CaptchaSolver.", { type: "error" });
            return null;
        }

        if (solver === "browser") {
            return this._solveBrowser(captchaData);
        }

        return this._solveAPI(captchaData);
    }

    // ========== BROWSER SOLVER ==========

    async _solveBrowser(captchaData) {
        const http = require("http");
        const { execFile, exec } = require("child_process");

        return new Promise((resolve) => {
            const PORT = 47831 + Math.floor(Math.random() * 100);
            let solved = false;
            let server;

            const cleanup = () => {
                if (server) try { server.close(); } catch {}
                server = null;
                this._captchaServer = null;
            };

            const timeoutMs = (this.settings.timeoutSeconds || 120) * 1000;
            const timeout = setTimeout(() => {
                if (!solved) {
                    cleanup();
                    this.log(`Browser solver timeout (${timeoutMs / 1000}s)`);
                    BdApi.UI.showToast("Timeout — CAPTCHA nao resolvido a tempo", { type: "error" });
                    this._stats.failed++;
                    resolve(null);
                }
            }, timeoutMs);

            const sitekey = (captchaData.captcha_sitekey || "").replace(/"/g, '&quot;');
            const rqdata = (captchaData.captcha_rqdata || "").replace(/\\/g, "\\\\").replace(/"/g, '&quot;');

            const html = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<title>CaptchaSolver</title>
<script src="https://js.hcaptcha.com/1/api.js?onload=onHcaptchaLoad" async defer></script>
<style>
  body { background: #1a1a2e; color: #eee; font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  h2 { margin-bottom: 8px; font-size: 18px; }
  p { color: #aaa; margin-bottom: 20px; font-size: 13px; }
  #status { margin-top: 16px; font-size: 14px; color: #5865f2; }
  .success { color: #57f287 !important; font-weight: bold; }
</style>
</head><body>
<h2>CaptchaSolver</h2>
<p>Aguardando extensao resolver... ou resolva manualmente.</p>
<div class="h-captcha" id="captcha-container" data-sitekey="${sitekey}" data-callback="onSolved" ${rqdata ? `data-rqdata="${rqdata}"` : ""}></div>
<div id="status">Carregando hCaptcha...</div>
<script>
function onSolved(token) {
  document.getElementById("status").className = "success";
  document.getElementById("status").textContent = "Resolvido! Pode fechar esta aba.";
  fetch(location.origin + "/solved", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({token}) })
    .catch(() => {});
}
function onHcaptchaLoad() {
  document.getElementById("status").textContent = "Aguardando resolucao... (extensao ou manual)";
}
</script>
</body></html>`;

            server = http.createServer((req, res) => {
                if (req.method === "GET" && req.url === "/captcha") {
                    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Access-Control-Allow-Origin": "*" });
                    res.end(html);
                } else if (req.method === "POST" && req.url === "/solved") {
                    let body = "";
                    req.on("data", c => body += c);
                    req.on("end", () => {
                        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
                        res.end('{"ok":true}');
                        try {
                            const data = JSON.parse(body);
                            if (data.token && !solved) {
                                solved = true;
                                clearTimeout(timeout);
                                this.log(`CAPTCHA resolvido via browser! Token: ${data.token.substring(0, 30)}...`);
                                BdApi.UI.showToast("CAPTCHA resolvido!", { type: "success" });
                                this._stats.solved++;
                                cleanup();
                                resolve(data.token);
                            }
                        } catch {}
                    });
                } else if (req.method === "OPTIONS") {
                    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "Content-Type" });
                    res.end();
                } else {
                    res.writeHead(404);
                    res.end();
                }
            });

            this._captchaServer = server;
            server.listen(PORT, "127.0.0.1", () => {
                const url = `http://127.0.0.1:${PORT}/captcha`;
                this.log(`Browser solver em ${url}`);
                const showBrowser = this.settings.showBrowser !== false;
                BdApi.UI.showToast(showBrowser ? "Abrindo CAPTCHA no browser..." : "Resolvendo CAPTCHA em background...", { type: "info" });

                const browserPath = this.settings.browserPath;
                if (browserPath) {
                    const args = [
                        `--app=${url}`,
                        "--no-first-run",
                        "--no-default-browser-check",
                        "--disable-blink-features=AutomationControlled",
                        `--user-data-dir=${require("path").join(require("os").tmpdir(), "cs-captcha-profile")}`
                    ];
                    if (showBrowser) {
                        args.push("--window-size=400,580");
                    } else {
                        args.push("--window-size=400,580", "--window-position=-32000,-32000");
                    }
                    const extPath = this.settings.extensionPath;
                    if (extPath) {
                        args.push(`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`);
                    }
                    execFile(browserPath, args, (err) => {
                        if (err) this.log(`Erro ao abrir browser: ${err.message}`);
                    });
                } else {
                    exec(`start "" "${url}"`);
                }
            });

            server.on("error", (err) => {
                this.log(`Erro no server: ${err.message}`);
                BdApi.UI.showToast(`Erro abrindo CAPTCHA: ${err.message}`, { type: "error" });
                clearTimeout(timeout);
                this._stats.failed++;
                resolve(null);
            });
        });
    }

    // ========== API SOLVER ==========

    async _solveAPI(captchaData) {
        const solver = this.settings.solver;
        const apiKey = this.settings.apiKey;

        if (!apiKey) {
            BdApi.UI.showToast("API key do solver nao configurada!", { type: "error" });
            return null;
        }

        const apiUrls = {
            yescaptcha: "https://api.yescaptcha.com",
            capsolver: "https://api.capsolver.com",
            "2captcha": "https://api.2captcha.com"
        };
        const baseUrl = apiUrls[solver];
        if (!baseUrl) { this.log(`Solver desconhecido: ${solver}`); return null; }

        BdApi.UI.showToast("Resolvendo CAPTCHA via API... aguarde", { type: "info" });
        this.log(`Enviando CAPTCHA para ${solver}...`);

        try {
            const taskBody = {
                clientKey: apiKey,
                task: {
                    type: "HCaptchaTaskProxyLess",
                    websiteURL: "https://discord.com/channels/@me",
                    websiteKey: captchaData.captcha_sitekey,
                    isInvisible: true
                }
            };
            if (captchaData.captcha_rqdata) {
                taskBody.task.enterprisePayload = { rqdata: captchaData.captcha_rqdata };
            }

            // Usa o fetch original pra nao interceptar a si mesmo
            const doFetch = this._originalFetch || window.fetch.bind(window);

            const createResp = await doFetch(`${baseUrl}/createTask`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(taskBody)
            });
            const createData = await createResp.json();

            if (createData.errorId && createData.errorId !== 0) {
                this.log(`Erro ao criar task: ${createData.errorDescription || createData.errorCode}`);
                BdApi.UI.showToast(`Erro CAPTCHA: ${createData.errorDescription || "erro desconhecido"}`, { type: "error" });
                this._stats.failed++;
                return null;
            }

            const taskId = createData.taskId;
            this.log(`Task criada: ${taskId}`);

            const maxAttempts = Math.ceil((this.settings.timeoutSeconds || 120) / 3);
            for (let i = 0; i < maxAttempts; i++) {
                await new Promise(r => setTimeout(r, 3000));
                const resultResp = await doFetch(`${baseUrl}/getTaskResult`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ clientKey: apiKey, taskId })
                });
                const resultData = await resultResp.json();

                if (resultData.errorId && resultData.errorId !== 0) {
                    this.log(`Erro ao resolver: ${resultData.errorDescription || resultData.errorCode}`);
                    BdApi.UI.showToast(`Erro CAPTCHA: ${resultData.errorDescription || "falhou"}`, { type: "error" });
                    this._stats.failed++;
                    return null;
                }

                if (resultData.status === "ready") {
                    const token = resultData.solution?.gRecaptchaResponse;
                    if (token) {
                        this.log(`CAPTCHA resolvido via API! Token: ${token.substring(0, 30)}...`);
                        BdApi.UI.showToast("CAPTCHA resolvido!", { type: "success" });
                        this._stats.solved++;
                        return token;
                    }
                }
            }

            this.log("Timeout esperando solucao da API");
            BdApi.UI.showToast("Timeout resolvendo CAPTCHA", { type: "error" });
            this._stats.failed++;
            return null;
        } catch (err) {
            this.log(`Erro no solver: ${err.message}`);
            BdApi.UI.showToast(`Erro CAPTCHA: ${err.message}`, { type: "error" });
            this._stats.failed++;
            return null;
        }
    }
};
