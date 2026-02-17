// ==UserScript==
// @name         Pax Historia: Custom AI Backend (Gemini/Thinking/OpenRouter/Copilot)
// @namespace    http://tampermonkey.net/
// @version      14.1
// @description  Custom AI backend for Pax Historia with Settings GUI. Supports Google Gemini, OpenRouter and Copilot API.
// @author       You
// @match        https://paxhistoria.co/*
// @match        https://www.paxhistoria.co/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      localhost
// @connect      127.0.0.1
// @connect      *
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // === SCHEMA CONVERSION ===
    // Game sends OpenAI-style schema: { name: "...", strict: true, schema: { ... } }
    // Google API expects raw schema with "nullable: true" instead of type arrays like ["object", "null"]
    function convertSchemaForGoogle(gameSchema) {
        let schema = gameSchema && gameSchema.schema ? gameSchema.schema : gameSchema;
        return fixTypeArrays(JSON.parse(JSON.stringify(schema)));
    }

    function fixTypeArrays(obj) {
        if (!obj || typeof obj !== 'object') return obj;
        if (Array.isArray(obj)) { obj.forEach(fixTypeArrays); return obj; }

        // Convert type: ["object", "null"] → type: "object", nullable: true
        if (Array.isArray(obj.type)) {
            const nonNull = obj.type.filter(t => t !== 'null');
            if (obj.type.includes('null')) obj.nullable = true;
            obj.type = nonNull[0] || 'string';
        }
        // Remove fields unsupported by Google's responseSchema
        delete obj.additionalProperties;
        delete obj.minItems;

        // Recurse into ALL possible schema locations
        if (obj.properties) Object.values(obj.properties).forEach(fixTypeArrays);
        if (obj.items) fixTypeArrays(obj.items);
        if (obj.anyOf) obj.anyOf.forEach(fixTypeArrays);
        if (obj.oneOf) obj.oneOf.forEach(fixTypeArrays);
        if (obj.allOf) obj.allOf.forEach(fixTypeArrays);
        return obj;
    }


    // === DEFAULT SETTINGS ===
    const DEFAULTS = {
        provider: "google", // 'google', 'openrouter', or 'copilot'
        apiKey: "",
        modelName: "gemini-3-flash-preview",
        openRouterModel: "google/gemini-2.0-flash-thinking-exp:free",
        copilotBaseUrl: "http://localhost:4141",
        copilotModel: "gpt-4.1",
        thinkingBudget: 4096
    };

    // === SETTINGS MANAGEMENT ===
    function loadSettings() {
        return {
            provider: GM_getValue("provider", DEFAULTS.provider),
            apiKey: GM_getValue("apiKey", DEFAULTS.apiKey),
            modelName: GM_getValue("modelName", DEFAULTS.modelName),
            openRouterModel: GM_getValue("openRouterModel", DEFAULTS.openRouterModel),
            copilotBaseUrl: GM_getValue("copilotBaseUrl", DEFAULTS.copilotBaseUrl),
            copilotModel: GM_getValue("copilotModel", DEFAULTS.copilotModel),
            thinkingBudget: GM_getValue("thinkingBudget", DEFAULTS.thinkingBudget)
        };
    }

    function saveSettings(settings) {
        GM_setValue("provider", settings.provider);
        GM_setValue("apiKey", settings.apiKey);
        GM_setValue("modelName", settings.modelName);
        GM_setValue("openRouterModel", settings.openRouterModel);
        GM_setValue("copilotBaseUrl", settings.copilotBaseUrl);
        GM_setValue("copilotModel", settings.copilotModel);
        GM_setValue("thinkingBudget", settings.thinkingBudget);
    }

    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 1000;

    function isRetryableError(errorOrStatus) {
        if (typeof errorOrStatus === "number") {
            return errorOrStatus === 429 || (errorOrStatus >= 500 && errorOrStatus < 600);
        }
        if (errorOrStatus instanceof Error) {
            var msg = (errorOrStatus.message || "").toLowerCase();
            return msg.includes("network") || msg.includes("timeout") || msg.includes("fetch");
        }
        return false;
    }

    function delay(ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    async function withRetry(asyncFn) {
        var lastError;
        for (var attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                return await asyncFn();
            } catch (e) {
                lastError = e;
                var status = e.status || (e.response && e.response.status);
                if (attempt < MAX_RETRIES && (isRetryableError(e) || isRetryableError(status))) {
                    var backoff = RETRY_DELAY_MS * Math.pow(2, attempt - 1);
                    console.warn("[PAX AI] Retry " + attempt + "/" + MAX_RETRIES + " in " + backoff + "ms:", e.message || e);
                    await delay(backoff);
                } else {
                    throw e;
                }
            }
        }
        throw lastError;
    }

    function getModelLabel(settings) {
        if (settings.provider === "google") return settings.modelName;
        if (settings.provider === "openrouter") return settings.openRouterModel.split("/").pop();
        if (settings.provider === "copilot") return settings.copilotModel;
        return "?";
    }

    function isInFooter(el) {
        if (!el || !el.closest) return false;
        return !!el.closest("footer, [class*='footer'], [class*='Footer']");
    }

    function findPaxHistoriaLogo() {
        var header = document.querySelector("header");
        if (header && !isInFooter(header)) {
            var logoLink = header.querySelector('a[href="/games"], a[href^="/games"]');
            if (logoLink && (logoLink.textContent || "").indexOf("Pax Historia") !== -1) return logoLink;
        }
        var mainNav = document.querySelector("nav");
        if (mainNav && !isInFooter(mainNav)) {
            var link = mainNav.querySelector('a[href="/games"], a[href^="/games"]');
            if (link && (link.textContent || "").indexOf("Pax Historia") !== -1) return link;
        }
        var containers = document.querySelectorAll("header, nav");
        for (var c = 0; c < containers.length; c++) {
            var cont = containers[c];
            if (isInFooter(cont)) continue;
            var children = cont.children;
            for (var i = 0; i < children.length; i++) {
                var el = children[i];
                if ((el.textContent || "").indexOf("Pax Historia") !== -1) return el;
            }
        }
        return null;
    }

    function ensureParentFlex(element) {
        var parent = element && element.parentNode;
        if (parent) {
            parent.style.setProperty("display", "flex", "important");
            parent.style.setProperty("align-items", "center", "important");
            parent.style.setProperty("gap", "0.5rem", "important");
        }
    }

    function insertIndicatorAfterLogo(box, logoElement) {
        var parent = logoElement.parentNode;
        if (parent) {
            if (logoElement.nextElementSibling) {
                parent.insertBefore(box, logoElement.nextElementSibling);
            } else {
                parent.appendChild(box);
            }
            ensureParentFlex(box);
        } else {
            document.body.appendChild(box);
        }
    }

    function createOrUpdateIndicator() {
        if (!document.body) return;
        var settings = loadSettings();
        var existing = document.getElementById("ph-ai-indicator");
        var label = settings.provider.toUpperCase() + " | " + getModelLabel(settings);
        if (existing) {
            existing.querySelector(".ph-ai-indicator-text").textContent = label;
            existing.style.background = "rgb(40, 20, 60)";
            existing.style.color = "#fafafa";
            ensureParentFlex(existing);
            return;
        }
        var box = document.createElement("button");
        box.type = "button";
        box.id = "ph-ai-indicator";
        box.className = "ph-ai-indicator-btn";
        box.innerHTML = '<span class="ph-ai-indicator-text">' + label + '</span>';
        box.title = "Pax AI Hook - Click to open settings";
        var indicatorBg = "rgb(40, 20, 60)";
        var indicatorHover = "rgb(56, 32, 84)";
        Object.assign(box.style, {
            display: "inline-flex",
            alignItems: "center",
            gap: "0.5rem",
            padding: "4px 12px",
            border: "none",
            borderRadius: "9999px",
            fontSize: "0.875rem",
            fontFamily: "inherit",
            fontWeight: "500",
            cursor: "pointer",
            transition: "color 200ms, background-color 200ms",
            flexShrink: "0",
            background: indicatorBg,
            color: "#fafafa"
        });
        box.addEventListener("click", function (e) {
            e.preventDefault();
            e.stopPropagation();
            createSettingsModal();
        });
        box.addEventListener("mouseenter", function () {
            box.style.backgroundColor = indicatorHover;
            box.style.color = "#fafafa";
        });
        box.addEventListener("mouseleave", function () {
            box.style.backgroundColor = indicatorBg;
            box.style.color = "#fafafa";
        });

        var logoElement = findPaxHistoriaLogo();
        if (logoElement) {
            insertIndicatorAfterLogo(box, logoElement);
        } else {
            box.style.position = "fixed";
            box.style.top = "12px";
            box.style.left = "12px";
            box.style.zIndex = "9999";
            box.style.marginLeft = "0";
            document.body.appendChild(box);
        }
    }

    function ensureIndicator() {
        function tryCreate() {
            if (!document.body) return false;
            if (document.getElementById("ph-ai-indicator")) return true;
            var logoElement = findPaxHistoriaLogo();
            createOrUpdateIndicator();
            return true;
        }

        function run() {
            if (tryCreate()) return;
            var attempts = 0;
            var maxAttempts = 100;
            var interval = setInterval(function () {
                attempts++;
                if (tryCreate() || attempts >= maxAttempts) {
                    clearInterval(interval);
                }
            }, 250);
        }

        function runWithObserver() {
            if (tryCreate()) return;
            var attempts = 0;
            var maxAttempts = 100;
            var interval = setInterval(function () {
                attempts++;
                if (tryCreate() || attempts >= maxAttempts) {
                    clearInterval(interval);
                }
            }, 250);
            if (document.body && !document.getElementById("ph-ai-indicator")) {
                var observer = new MutationObserver(function () {
                    if (document.getElementById("ph-ai-indicator")) return;
                    if (tryCreate()) observer.disconnect();
                });
                observer.observe(document.body, { childList: true, subtree: true });
                setTimeout(function () { observer.disconnect(); }, 15000);
            }
        }

        if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", runWithObserver);
        } else {
            runWithObserver();
        }
        window.addEventListener("load", function () {
            createOrUpdateIndicator();
        });
        [1000, 2500, 5000].forEach(function (delayMs) {
            setTimeout(function () {
                createOrUpdateIndicator();
            }, delayMs);
        });
        var observerRemoval = new MutationObserver(function () {
            if (!document.getElementById("ph-ai-indicator") && document.body) {
                createOrUpdateIndicator();
            }
        });
        function startRemovalObserver() {
            if (!document.body) return;
            observerRemoval.observe(document.body, { childList: true, subtree: true });
            setTimeout(function () { observerRemoval.disconnect(); }, 20000);
        }
        if (document.body) startRemovalObserver();
        else document.addEventListener("DOMContentLoaded", startRemovalObserver);
    }

    // === COPILOT API HELPERS ===
    function fetchCopilotApi(endpoint, options) {
        return new Promise(function (resolve, reject) {
            const baseUrl = (options?.baseUrl || loadSettings().copilotBaseUrl || DEFAULTS.copilotBaseUrl).replace(/\/$/, "");
            const url = baseUrl + endpoint;
            const method = options?.method || "GET";
            const body = options?.body ? JSON.stringify(options.body) : undefined;

            GM_xmlhttpRequest({
                method: method,
                url: url,
                headers: { "Content-Type": "application/json" },
                data: body,
                onload: function (response) {
                    try {
                        const parsed = response.responseText ? JSON.parse(response.responseText) : {};
                        resolve({ ok: response.status >= 200 && response.status < 300, status: response.status, data: parsed, text: response.responseText });
                    } catch (e) {
                        resolve({ ok: false, status: response.status, data: null, text: response.responseText });
                    }
                },
                onerror: function () {
                    reject(new Error("Network error connecting to Copilot API"));
                }
            });
        });
    }

    function testCopilotConnection(baseUrl) {
        return fetchCopilotApi("/v1/models", { baseUrl: baseUrl }).then(function (result) {
            if (!result.ok) {
                return {
                    online: false,
                    models: [],
                    error: result.text || "HTTP " + result.status
                };
            }
            var rawData = result.data && result.data.data;
            if (!Array.isArray(rawData) && Array.isArray(result.data)) {
                rawData = result.data;
            }
            var models = [];
            if (Array.isArray(rawData)) {
                var seen = {};
                for (var i = 0; i < rawData.length; i++) {
                    var modelId = rawData[i] && (rawData[i].id || rawData[i]);
                    if (modelId && typeof modelId === "string" && !seen[modelId]) {
                        seen[modelId] = true;
                        models.push(modelId);
                    }
                }
            }
            return {
                online: true,
                models: models,
                error: null
            };
        });
    }

    // === GUI IMPLEMENTATION ===
    function createSettingsModal() {
        if (document.getElementById('ph-ai-settings-modal')) return;

        const settings = loadSettings();

        const modalHTML = `
            <style id="ph-ai-modal-styles">
                #ph-ai-settings-modal { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.7); z-index: 10000; display: flex; justify-content: center; align-items: center; padding: 12px; box-sizing: border-box; overflow-y: auto; font-family: system-ui, -apple-system, sans-serif; }
                #ph-ai-modal-box { background: #222; color: #fff; padding: 16px; border-radius: 8px; width: 100%; max-width: 420px; max-height: calc(100vh - 24px); overflow-y: auto; box-shadow: 0 4px 20px rgba(0,0,0,0.5); box-sizing: border-box; }
                #ph-ai-modal-box h2 { margin: 0 0 12px; font-size: 1.1rem; border-bottom: 1px solid #444; padding-bottom: 8px; }
                #ph-ai-modal-box label { display: block; margin-top: 10px; font-size: 0.9rem; }
                #ph-ai-modal-box input, #ph-ai-modal-box select { width: 100%; padding: 8px; margin-top: 4px; background: #333; color: #fff; border: 1px solid #555; border-radius: 4px; box-sizing: border-box; font-size: 0.9rem; }
                #ph-ai-modal-box select[multiple] { min-height: 120px; max-height: 40vh; }
                #ph-ai-modal-box button { padding: 8px 14px; font-size: 0.9rem; border: none; border-radius: 4px; cursor: pointer; }
                #ph-ai-modal-buttons { margin-top: 16px; display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }
                @media (max-width: 380px) { #ph-ai-modal-box { padding: 12px; } #ph-ai-modal-buttons { flex-direction: column; } #ph-ai-modal-buttons button { width: 100%; } }
            </style>
            <div id="ph-ai-settings-modal">
                <div id="ph-ai-modal-box">
                    <h2>AI Settings</h2>
                    
                    <label for="ph-provider">Provider:</label>
                    <select id="ph-provider">
                        <option value="google" ${settings.provider === 'google' ? 'selected' : ''}>Google AI Studio</option>
                        <option value="openrouter" ${settings.provider === 'openrouter' ? 'selected' : ''}>OpenRouter</option>
                        <option value="copilot" ${settings.provider === 'copilot' ? 'selected' : ''}>Copilot API (local)</option>
                    </select>

                    <div id="ph-api-key-container" style="display: ${settings.provider === 'copilot' ? 'none' : 'block'};">
                        <label for="ph-api-key">API Key:</label>
                        <input type="text" id="ph-api-key" value="${settings.apiKey}" placeholder="Enter API Key">
                    </div>

                    <div id="ph-google-fields" style="display: ${settings.provider === 'google' ? 'block' : 'none'};">
                        <label for="ph-model-name">Model Name:</label>
                        <input type="text" id="ph-model-name" value="${settings.modelName}">
                        <label for="ph-thinking-budget">Thinking Budget (Tokens):</label>
                        <input type="number" id="ph-thinking-budget" value="${settings.thinkingBudget}">
                    </div>

                    <div id="ph-openrouter-fields" style="display: ${settings.provider === 'openrouter' ? 'block' : 'none'};">
                        <label for="ph-or-model-name">OpenRouter Model:</label>
                        <input type="text" id="ph-or-model-name" value="${settings.openRouterModel}">
                    </div>

                    <div id="ph-copilot-fields" style="display: ${settings.provider === 'copilot' ? 'block' : 'none'};">
                        <label for="ph-copilot-base-url">Base URL (no API key):</label>
                        <input type="text" id="ph-copilot-base-url" value="${settings.copilotBaseUrl}" placeholder="http://localhost:4141">
                        <label for="ph-copilot-model">Model:</label>
                        <select id="ph-copilot-model" size="8">
                            <option value="${settings.copilotModel}">${settings.copilotModel}</option>
                        </select>
                        <div style="margin-top: 10px; display: flex; flex-wrap: wrap; align-items: center; gap: 8px;">
                            <button id="ph-test-copilot-btn" style="background: #28a745; color: #fff;">Test connection</button>
                            <span id="ph-test-status" style="font-size: 0.85rem;"></span>
                        </div>
                    </div>

                    <div id="ph-ai-modal-buttons">
                        <button id="ph-cancel-btn" style="background: #555; color: #fff;">Cancel</button>
                        <button id="ph-save-btn" style="background: #007bff; color: #fff;">Save</button>
                    </div>
                </div>
            </div>
        `;

        const div = document.createElement('div');
        div.innerHTML = modalHTML;
        document.body.appendChild(div);

        // Event Listeners
        function updateProviderVisibility() {
            const provider = document.getElementById('ph-provider').value;
            const isGoogle = provider === 'google';
            const isOpenRouter = provider === 'openrouter';
            const isCopilot = provider === 'copilot';
            document.getElementById('ph-google-fields').style.display = isGoogle ? 'block' : 'none';
            document.getElementById('ph-openrouter-fields').style.display = isOpenRouter ? 'block' : 'none';
            document.getElementById('ph-copilot-fields').style.display = isCopilot ? 'block' : 'none';
            document.getElementById('ph-api-key-container').style.display = isCopilot ? 'none' : 'block';
        }

        document.getElementById('ph-provider').addEventListener('change', updateProviderVisibility);

        function populateCopilotModels() {
            const statusEl = document.getElementById('ph-test-status');
            const selectEl = document.getElementById('ph-copilot-model');
            const baseUrl = document.getElementById('ph-copilot-base-url').value.trim() || DEFAULTS.copilotBaseUrl;
            const savedModel = loadSettings().copilotModel;
            statusEl.textContent = 'Testing...';
            statusEl.style.color = '#ffc107';
            testCopilotConnection(baseUrl).then(function (result) {
                if (result.online) {
                    statusEl.textContent = 'Connected (' + result.models.length + ' models)';
                    statusEl.style.color = '#28a745';
                    selectEl.innerHTML = '';
                    result.models.forEach(function (modelId) {
                        const opt = document.createElement('option');
                        opt.value = modelId;
                        opt.textContent = modelId;
                        selectEl.appendChild(opt);
                    });
                    var keptVal = savedModel && result.models.indexOf(savedModel) !== -1 ? savedModel : result.models[0];
                    selectEl.value = keptVal || "";
                    var selectedOpt = selectEl.options[selectEl.selectedIndex];
                    if (selectedOpt) selectedOpt.scrollIntoView({ block: 'nearest' });
                } else {
                    statusEl.textContent = 'Error: ' + (result.error || 'no response');
                    statusEl.style.color = '#dc3545';
                }
            }).catch(function (err) {
                statusEl.textContent = 'Error: ' + (err.message || 'network');
                statusEl.style.color = '#dc3545';
            });
        }

        document.getElementById('ph-test-copilot-btn').addEventListener('click', populateCopilotModels);

        if (settings.provider === 'copilot') {
            populateCopilotModels();
        }

        document.getElementById('ph-cancel-btn').addEventListener('click', function () {
            document.getElementById('ph-ai-settings-modal').remove();
        });

        document.getElementById('ph-save-btn').addEventListener('click', function () {
            var copilotSelect = document.getElementById('ph-copilot-model');
            var copilotModelVal = "";
            if (copilotSelect) {
                copilotModelVal = copilotSelect.value || (copilotSelect.selectedOptions && copilotSelect.selectedOptions[0] ? copilotSelect.selectedOptions[0].value : "");
            }
            const newSettings = {
                provider: document.getElementById('ph-provider').value,
                apiKey: document.getElementById('ph-api-key').value,
                modelName: document.getElementById('ph-model-name').value,
                openRouterModel: document.getElementById('ph-or-model-name').value,
                copilotBaseUrl: document.getElementById('ph-copilot-base-url').value.trim() || DEFAULTS.copilotBaseUrl,
                copilotModel: copilotModelVal || DEFAULTS.copilotModel,
                thinkingBudget: parseInt(document.getElementById('ph-thinking-budget').value, 10) || 4096
            };
            saveSettings(newSettings);
            document.getElementById('ph-ai-settings-modal').remove();
            createOrUpdateIndicator();

            const toast = document.createElement('div');
            toast.textContent = 'Settings saved. Changes apply immediately (no reload needed).';
            Object.assign(toast.style, {
                position: 'fixed', bottom: '30px', left: '50%', transform: 'translateX(-50%)',
                background: '#2ecc40', color: '#fff', padding: '12px 24px', borderRadius: '8px',
                fontSize: '14px', fontFamily: 'sans-serif', fontWeight: 'bold',
                zIndex: '10001', opacity: '1', transition: 'opacity 0.5s ease',
                boxShadow: '0 4px 12px rgba(0,0,0,0.3)'
            });
            document.body.appendChild(toast);
            setTimeout(() => { toast.style.opacity = '0'; }, 1500);
            setTimeout(() => { toast.remove(); }, 2000);
        });

        if (settings.provider === 'copilot') {
            setTimeout(function () { document.getElementById('ph-test-copilot-btn').click(); }, 100);
        }
    }

    GM_registerMenuCommand("Open AI Settings", createSettingsModal);

    ensureIndicator();

    // === INTERCEPTION LOGIC ===
    // When using GM_ functions, we must use unsafeWindow to access the page's fetch
    const originalFetch = unsafeWindow.fetch.bind(unsafeWindow);

    unsafeWindow.fetch = async function (url, options) {
        if (url && url.toString().includes('/api/simple-chat')) {
            const settings = loadSettings();

            const isCopilot = settings.provider === 'copilot';
            const needsApiKey = !isCopilot;
            if (needsApiKey && !settings.apiKey) {
                console.warn("[PAX AI] No API Key configured. Please open settings via Tampermonkey menu.");
                return originalFetch(url, options);
            }

            try {
                let userPrompt = "";
                let isAction = false;
                let gameSchema = null; // raw schema object from the game

                if (options.body) {
                    const payload = JSON.parse(options.body);
                    userPrompt = payload.prompt || "";

                    // DETERMINE REQUEST TYPE
                    if (payload.promptStage === "chatWithUser") {
                        isAction = false;
                    } else if (payload.jsonSchema) {
                        isAction = true;
                        gameSchema = payload.jsonSchema;
                    }
                }

                console.log(`%c[PAX AI] TYPE: ${isAction ? "ACTION (RAW JSON)" : "CHAT (WRAPPER)"} | Provider: ${settings.provider}`, "background: blue; color: white; padding: 5px; font-weight: bold;");

                let finalPrompt = userPrompt;
                // Advisor uses native responseSchema (clean JSON output).
                // Everything else uses old prompt-based schema injection (complex schemas break Google's API).
                const isAdvisor = isAction && gameSchema && gameSchema.name === 'advisorResponse';

                if (isAction && gameSchema && !isAdvisor) {
                    finalPrompt += `\n\nTASK: Generate a valid JSON object matching this schema.\nSCHEMA: ${JSON.stringify(gameSchema)}\n\nIMPORTANT: Return ONLY the JSON object. No markdown.`;
                }

                let responseText = "";

                if (settings.provider === 'google') {
                    responseText = await withRetry(async function () {
                        const googleUrl = `https://generativelanguage.googleapis.com/v1beta/models/${settings.modelName}:generateContent?key=${settings.apiKey}`;
                        const genConfig = {
                            temperature: 0.7,
                            thinkingConfig: {
                                include_thoughts: true,
                                thinking_budget: settings.thinkingBudget
                            }
                        };
                        if (isAdvisor) {
                            genConfig.responseMimeType = "application/json";
                            genConfig.responseSchema = convertSchemaForGoogle(gameSchema);
                            console.log("%c[PAX AI] Advisor: using native responseSchema", "color: cyan");
                        }
                        const googlePayload = {
                            contents: [{ parts: [{ text: finalPrompt }] }],
                            generationConfig: genConfig
                        };
                        const myResponse = await originalFetch(googleUrl, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify(googlePayload)
                        });
                        if (!myResponse.ok) {
                            const errText = await myResponse.text();
                            const err = new Error("Google API Error: " + errText);
                            err.status = myResponse.status;
                            throw err;
                        }
                        const myJson = await myResponse.json();
                        const parts = myJson.candidates?.[0]?.content?.parts || [];
                        for (let i = parts.length - 1; i >= 0; i--) {
                            if (parts[i].text) return parts[i].text;
                        }
                        return "";
                    });

                } else if (settings.provider === 'openrouter') {
                    responseText = await withRetry(async function () {
                        const orUrl = "https://openrouter.ai/api/v1/chat/completions";
                        const orPayload = {
                            model: settings.openRouterModel,
                            messages: [{ role: "user", content: finalPrompt }]
                        };
                        if (isAdvisor) {
                            orPayload.response_format = {
                                type: "json_schema",
                                json_schema: gameSchema
                            };
                            console.log("%c[PAX AI] Advisor: using response_format", "color: cyan");
                        }
                        const myResponse = await originalFetch(orUrl, {
                            method: "POST",
                            headers: {
                                "Content-Type": "application/json",
                                "Authorization": `Bearer ${settings.apiKey}`,
                                "HTTP-Referer": window.location.href,
                                "X-Title": "Pax Historia Hook"
                            },
                            body: JSON.stringify(orPayload)
                        });
                        if (!myResponse.ok) {
                            const errText = await myResponse.text();
                            const err = new Error("OpenRouter API Error: " + errText);
                            err.status = myResponse.status;
                            throw err;
                        }
                        const myJson = await myResponse.json();
                        return myJson.choices?.[0]?.message?.content || "";
                    });
                } else if (settings.provider === 'copilot') {
                    responseText = await withRetry(async function () {
                        const baseUrl = (settings.copilotBaseUrl || DEFAULTS.copilotBaseUrl).replace(/\/$/, "");
                        const copilotPayload = {
                            model: settings.copilotModel || DEFAULTS.copilotModel,
                            messages: [{ role: "user", content: finalPrompt }]
                        };
                        try {
                            var copilotResult = await fetchCopilotApi("/v1/chat/completions", {
                                baseUrl: baseUrl,
                                method: "POST",
                                body: copilotPayload
                            });
                        } catch (e) {
                            e.status = 0;
                            throw e;
                        }
                        if (!copilotResult.ok) {
                            const errMsg = copilotResult.data?.error?.message || copilotResult.text || "HTTP " + copilotResult.status;
                            const err = new Error("Copilot API Error: " + errMsg);
                            err.status = copilotResult.status;
                            throw err;
                        }
                        return copilotResult.data?.choices?.[0]?.message?.content || "";
                    });
                }

                // === CLEANUP & SURGERY ===
                // 1. Remove Markdown
                let cleanText = responseText.replace(/```json/gi, "").replace(/```/g, "").trim();

                // 2. If Action, extract JSON
                if (isAction) {
                    const firstBrace = cleanText.indexOf('{');
                    const lastBrace = cleanText.lastIndexOf('}');

                    if (firstBrace !== -1 && lastBrace !== -1) {
                        cleanText = cleanText.substring(firstBrace, lastBrace + 1);
                    } else {
                        console.error("[PAX AI] JSON not found in response for action!");
                    }

                    // Unwrap schema wrapper: AI may return {name,strict,schema:{message,mapMode}}
                    // Game expects {message,mapMode} directly
                    try {
                        var parsed = JSON.parse(cleanText);
                        if (parsed && parsed.schema && typeof parsed.schema === "object") {
                            cleanText = JSON.stringify(parsed.schema);
                        }
                        JSON.parse(cleanText);
                        console.log("%c[PAX AI] JSON VALID.", "color: lime");
                    } catch (e) {
                        console.error("[PAX AI] INVALID JSON:", cleanText);
                    }
                }

                // === FORMAT RESPONSE FOR GAME ===
                let responseBody;

                if (isAction) {
                    // FOR ACTIONS: The AI follows the jsonSchema and may wrap the
                    // response in a root key (e.g. { "advisorResponse": { "message": "...", "mapMode": {...} } }).
                    // The game expects the inner fields at the top level, so we unwrap
                    // single-key object wrappers automatically.
                    try {
                        const parsed = JSON.parse(cleanText);
                        const keys = Object.keys(parsed);
                        if (keys.length === 1 && typeof parsed[keys[0]] === 'object' && !Array.isArray(parsed[keys[0]])) {
                            console.log(`%c[PAX AI] Unwrapped root key "${keys[0]}"`, "color: cyan");
                            responseBody = JSON.stringify(parsed[keys[0]]);
                        } else {
                            responseBody = cleanText;
                        }
                    } catch {
                        responseBody = cleanText;
                    }
                } else {
                    // FOR CHAT: Wrap in message object
                    // Game expects: { "message": "Hello" }
                    responseBody = JSON.stringify({ message: cleanText });
                }

                // We must return a Response object that the page can understand.
                // Since we are in the sandbox, 'Response' might be the sandbox's Response.
                // Usually this is fine, but sometimes we need to construct it in the page context.
                // For now, standard Response usually works across the boundary in modern TM.
                return new Response(responseBody, {
                    status: 200,
                    headers: { "Content-Type": "application/json" }
                });

            } catch (e) {
                console.error("[PAX AI] Critical Failure:", e);
                // Fallback to original fetch if our hook fails? 
                // Usually better to let the user know, but for game stability maybe fallback.
                // However, if we don't have a key, we already returned. If we have a key and it failed, 
                // the original game backend might not be what the user wants. 
                // But let's return originalFetch to be safe so the game doesn't just hang.
                return originalFetch(url, options);
            }
        }
        return originalFetch(url, options);
    };
})();