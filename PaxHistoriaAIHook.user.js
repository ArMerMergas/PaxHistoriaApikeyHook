// ==UserScript==
// @name         Pax Historia: Custom AI Backend (Multi-Provider)
// @namespace    http://tampermonkey.net/
// @version      15.0
// @description  Custom AI backend for Pax Historia. Supports Google, OpenRouter, OpenAI, Groq, Ollama, LM Studio, Together, Fireworks, Mistral, Anthropic, Copilot, Generic.
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
// @updateURL    https://raw.githubusercontent.com/ArMerMergas/PaxHistoriaApikeyHook/main/PaxHistoriaAIHook.user.js
// @downloadURL  https://raw.githubusercontent.com/ArMerMergas/PaxHistoriaApikeyHook/main/PaxHistoriaAIHook.user.js
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
        delete obj.title;  // Google doesn't support title in sub-schemas

        // Handle anyOf/oneOf: filter out empty-object null-placeholders
        // Google rejects type:"object" with empty properties
        ['anyOf', 'oneOf'].forEach(function (key) {
            if (!Array.isArray(obj[key])) return;
            obj[key] = obj[key].filter(function (entry) {
                if (entry && entry.type === 'object' &&
                    (!entry.properties || Object.keys(entry.properties).length === 0)) {
                    obj.nullable = true;
                    return false; // drop this null-placeholder
                }
                return true;
            });
            // Unwrap single-entry anyOf/oneOf
            if (obj[key].length === 1) {
                var inner = obj[key][0];
                delete obj[key];
                // Merge inner into obj, preserving nullable
                var wasNullable = obj.nullable;
                Object.assign(obj, inner);
                if (wasNullable) obj.nullable = true;
            } else if (obj[key].length === 0) {
                delete obj[key];
                if (!obj.type) obj.type = 'string';
            }
        });

        // Standalone object with no/empty properties → add placeholder
        if (obj.type === 'object' && (!obj.properties || Object.keys(obj.properties).length === 0)
            && !obj.anyOf && !obj.oneOf) {
            obj.properties = { "_placeholder": { type: "string", description: "unused" } };
        }

        // Recurse into ALL possible schema locations
        if (obj.properties) Object.values(obj.properties).forEach(fixTypeArrays);
        if (obj.items) fixTypeArrays(obj.items);
        if (obj.anyOf) obj.anyOf.forEach(fixTypeArrays);
        if (obj.oneOf) obj.oneOf.forEach(fixTypeArrays);
        if (obj.allOf) obj.allOf.forEach(fixTypeArrays);
        return obj;
    }


    // === PROVIDER URLS (documented endpoints) ===
    const PROVIDER_URLS = {
        openai: "https://api.openai.com/v1",
        groq: "https://api.groq.com/openai/v1",
        openrouter: "https://openrouter.ai/api/v1",
        ollama: "http://localhost:11434/v1",
        lmstudio: "http://localhost:1234/v1",
        together: "https://api.together.xyz/v1",
        fireworks: "https://api.fireworks.ai/inference/v1",
        mistral: "https://api.mistral.ai/v1",
        anthropic: "https://api.anthropic.com/v1"
    };

    // === DEFAULT SETTINGS ===
    const DEFAULTS = {
        provider: "google",
        apiKey: "",
        modelName: "gemini-3-flash-preview",
        openRouterModel: "google/gemini-2.0-flash-thinking-exp:free",
        openaiModel: "gpt-4o-mini",
        groqModel: "llama-3.1-70b-versatile",
        ollamaBaseUrl: "http://localhost:11434",
        ollamaModel: "llama3.2",
        lmStudioBaseUrl: "http://localhost:1234",
        lmStudioModel: "local-model",
        togetherModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
        fireworksModel: "accounts/fireworks/models/llama-v3p1-8b-instruct",
        mistralModel: "mistral-small-latest",
        anthropicModel: "claude-sonnet-4-20250514",
        copilotBaseUrl: "http://localhost:4141",
        copilotModel: "gpt-4.1",
        genericBaseUrl: "https://api.openai.com/v1",
        genericModel: "gpt-4o-mini",
        genericApiKey: "",
        thinkingBudget: 4096
    };

    // === SETTINGS MANAGEMENT ===
    function loadSettings() {
        return {
            provider: GM_getValue("provider", DEFAULTS.provider),
            apiKey: GM_getValue("apiKey", DEFAULTS.apiKey),
            modelName: GM_getValue("modelName", DEFAULTS.modelName),
            openRouterModel: GM_getValue("openRouterModel", DEFAULTS.openRouterModel),
            openaiModel: GM_getValue("openaiModel", DEFAULTS.openaiModel),
            groqModel: GM_getValue("groqModel", DEFAULTS.groqModel),
            ollamaBaseUrl: GM_getValue("ollamaBaseUrl", DEFAULTS.ollamaBaseUrl),
            ollamaModel: GM_getValue("ollamaModel", DEFAULTS.ollamaModel),
            lmStudioBaseUrl: GM_getValue("lmStudioBaseUrl", DEFAULTS.lmStudioBaseUrl),
            lmStudioModel: GM_getValue("lmStudioModel", DEFAULTS.lmStudioModel),
            togetherModel: GM_getValue("togetherModel", DEFAULTS.togetherModel),
            fireworksModel: GM_getValue("fireworksModel", DEFAULTS.fireworksModel),
            mistralModel: GM_getValue("mistralModel", DEFAULTS.mistralModel),
            anthropicModel: GM_getValue("anthropicModel", DEFAULTS.anthropicModel),
            copilotBaseUrl: GM_getValue("copilotBaseUrl", DEFAULTS.copilotBaseUrl),
            copilotModel: GM_getValue("copilotModel", DEFAULTS.copilotModel),
            genericBaseUrl: GM_getValue("genericBaseUrl", DEFAULTS.genericBaseUrl),
            genericModel: GM_getValue("genericModel", DEFAULTS.genericModel),
            genericApiKey: GM_getValue("genericApiKey", DEFAULTS.genericApiKey),
            thinkingBudget: GM_getValue("thinkingBudget", DEFAULTS.thinkingBudget)
        };
    }

    function saveSettings(settings) {
        GM_setValue("provider", settings.provider);
        GM_setValue("apiKey", settings.apiKey);
        GM_setValue("modelName", settings.modelName);
        GM_setValue("openRouterModel", settings.openRouterModel);
        GM_setValue("openaiModel", settings.openaiModel);
        GM_setValue("groqModel", settings.groqModel);
        GM_setValue("ollamaBaseUrl", settings.ollamaBaseUrl);
        GM_setValue("ollamaModel", settings.ollamaModel);
        GM_setValue("lmStudioBaseUrl", settings.lmStudioBaseUrl);
        GM_setValue("lmStudioModel", settings.lmStudioModel);
        GM_setValue("togetherModel", settings.togetherModel);
        GM_setValue("fireworksModel", settings.fireworksModel);
        GM_setValue("mistralModel", settings.mistralModel);
        GM_setValue("anthropicModel", settings.anthropicModel);
        GM_setValue("copilotBaseUrl", settings.copilotBaseUrl);
        GM_setValue("copilotModel", settings.copilotModel);
        GM_setValue("genericBaseUrl", settings.genericBaseUrl);
        GM_setValue("genericModel", settings.genericModel);
        GM_setValue("genericApiKey", settings.genericApiKey);
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

    // === CORS-FREE HTTP CLIENT (for external/local APIs) ===
    function fetchApi(url, options) {
        return new Promise(function (resolve, reject) {
            const method = options?.method || "GET";
            const body = options?.body ? JSON.stringify(options.body) : undefined;
            const headers = options?.headers || {};
            if (body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";

            GM_xmlhttpRequest({
                method: method,
                url: url,
                headers: headers,
                data: body,
                onload: function (response) {
                    try {
                        const parsed = response.responseText ? JSON.parse(response.responseText) : {};
                        resolve({
                            ok: response.status >= 200 && response.status < 300,
                            status: response.status,
                            data: parsed,
                            text: response.responseText
                        });
                    } catch (e) {
                        resolve({
                            ok: false,
                            status: response.status,
                            data: null,
                            text: response.responseText
                        });
                    }
                },
                onerror: function () {
                    reject(new Error("Network error: " + url));
                }
            });
        });
    }

    function getModelLabel(settings) {
        switch (settings.provider) {
            case "google": return settings.modelName;
            case "openrouter": return (settings.openRouterModel || "").split("/").pop() || "?";
            case "copilot": return settings.copilotModel;
            case "openai": return settings.openaiModel;
            case "groq": return settings.groqModel;
            case "ollama": return settings.ollamaModel;
            case "lmstudio": return settings.lmStudioModel;
            case "together": return (settings.togetherModel || "").split("/").pop() || "?";
            case "fireworks": return (settings.fireworksModel || "").split("/").pop() || "?";
            case "mistral": return settings.mistralModel;
            case "anthropic": return settings.anthropicModel;
            case "generic": return settings.genericModel || (settings.genericBaseUrl || "").replace(/\/$/, "").split("/").pop() || "?";
            default: return "?";
        }
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
        if (parent && parent !== document.body) {
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
            existing.style.position = "";
            existing.style.top = "";
            existing.style.left = "";
            existing.style.marginLeft = "";
            var logoElement = findPaxHistoriaLogo();
            if (logoElement && existing.parentNode === document.body) {
                var parent = logoElement.parentNode;
                if (parent) {
                    if (logoElement.nextElementSibling) {
                        parent.insertBefore(existing, logoElement.nextElementSibling);
                    } else {
                        parent.appendChild(existing);
                    }
                    ensureParentFlex(existing);
                }
            } else {
                ensureParentFlex(existing);
            }
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

    // === OPENAI-COMPATIBLE HELPERS ===
    function buildBaseUrl(url) {
        return (url || "").replace(/\/$/, "");
    }

    function getApiBase(baseUrl) {
        var base = buildBaseUrl(baseUrl);
        return base.endsWith("/v1") ? base : base + "/v1";
    }

    function callAnthropicApi(settings, finalPrompt, useStructuredOutput, gameSchema) {
        var url = PROVIDER_URLS.anthropic + "/messages";
        var body = {
            model: settings.anthropicModel || DEFAULTS.anthropicModel,
            max_tokens: 4096,
            messages: [{ role: "user", content: finalPrompt }]
        };
        if (useStructuredOutput && gameSchema && gameSchema.schema) {
            body.output_config = {
                format: { type: "json_schema", schema: gameSchema.schema }
            };
            console.log("%c[PAX AI] Using Anthropic output_config for: " + (gameSchema.name || "unknown"), "color: cyan");
        }
        var headers = {
            "Content-Type": "application/json",
            "x-api-key": settings.apiKey,
            "anthropic-version": "2023-06-01"
        };
        return fetchApi(url, { method: "POST", headers: headers, body: body }).then(function (result) {
            if (!result.ok) {
                var errMsg = result.data?.error?.message || result.text || "HTTP " + result.status;
                var err = new Error("Anthropic API Error: " + errMsg);
                err.status = result.status;
                throw err;
            }
            var content = result.data?.content || [];
            var text = "";
            for (var i = 0; i < content.length; i++) {
                if (content[i].type === "text" && content[i].text) {
                    text += content[i].text;
                }
            }
            return text;
        });
    }

    function testOpenAICompatibleConnection(baseUrl, apiKey) {
        var base = getApiBase(baseUrl);
        var modelsPath = "/models";
        var headers = {};
        if (apiKey) headers["Authorization"] = "Bearer " + apiKey;
        return fetchApi(base + modelsPath, { headers: headers }).then(function (result) {
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
                        <option value="openai" ${settings.provider === 'openai' ? 'selected' : ''}>OpenAI</option>
                        <option value="groq" ${settings.provider === 'groq' ? 'selected' : ''}>Groq</option>
                        <option value="ollama" ${settings.provider === 'ollama' ? 'selected' : ''}>Ollama (local)</option>
                        <option value="lmstudio" ${settings.provider === 'lmstudio' ? 'selected' : ''}>LM Studio (local)</option>
                        <option value="together" ${settings.provider === 'together' ? 'selected' : ''}>Together AI</option>
                        <option value="fireworks" ${settings.provider === 'fireworks' ? 'selected' : ''}>Fireworks AI</option>
                        <option value="mistral" ${settings.provider === 'mistral' ? 'selected' : ''}>Mistral AI</option>
                        <option value="anthropic" ${settings.provider === 'anthropic' ? 'selected' : ''}>Anthropic (Claude)</option>
                        <option value="copilot" ${settings.provider === 'copilot' ? 'selected' : ''}>Copilot API (local)</option>
                        <option value="generic" ${settings.provider === 'generic' ? 'selected' : ''}>Generic (URL)</option>
                    </select>

                    <div id="ph-api-key-container" style="display: ${['ollama', 'lmstudio', 'copilot', 'generic'].indexOf(settings.provider) !== -1 ? 'none' : 'block'};">
                        <label for="ph-api-key">API Key:</label>
                        <input type="text" id="ph-api-key" value="${settings.apiKey}" placeholder="sk-...">
                    </div>

                    <div id="ph-google-fields" style="display: ${settings.provider === 'google' ? 'block' : 'none'};">
                        <label for="ph-model-name">Model:</label>
                        <input type="text" id="ph-model-name" value="${settings.modelName}">
                        <label for="ph-thinking-budget">Thinking Budget (Tokens):</label>
                        <input type="number" id="ph-thinking-budget" value="${settings.thinkingBudget}">
                    </div>

                    <div id="ph-openrouter-fields" style="display: ${settings.provider === 'openrouter' ? 'block' : 'none'};">
                        <label for="ph-or-model-name">Model:</label>
                        <input type="text" id="ph-or-model-name" value="${settings.openRouterModel}" placeholder="provider/model">
                    </div>

                    <div id="ph-openai-fields" style="display: ${settings.provider === 'openai' ? 'block' : 'none'};">
                        <label for="ph-openai-model">Model:</label>
                        <input type="text" id="ph-openai-model" value="${settings.openaiModel}" placeholder="gpt-4o-mini">
                    </div>

                    <div id="ph-groq-fields" style="display: ${settings.provider === 'groq' ? 'block' : 'none'};">
                        <label for="ph-groq-model">Model:</label>
                        <input type="text" id="ph-groq-model" value="${settings.groqModel}" placeholder="llama-3.1-70b-versatile">
                    </div>

                    <div id="ph-ollama-fields" style="display: ${settings.provider === 'ollama' ? 'block' : 'none'};">
                        <label for="ph-ollama-base-url">Base URL:</label>
                        <input type="text" id="ph-ollama-base-url" value="${settings.ollamaBaseUrl}" placeholder="http://localhost:11434">
                        <label for="ph-ollama-model">Model:</label>
                        <input type="text" id="ph-ollama-model" value="${settings.ollamaModel}" placeholder="llama3.2">
                        <div style="margin-top: 8px;">
                            <button id="ph-test-ollama-btn" type="button" style="background: #28a745; color: #fff;">Test</button>
                            <span id="ph-ollama-status" style="font-size: 0.85rem; margin-left: 8px;"></span>
                        </div>
                    </div>

                    <div id="ph-lmstudio-fields" style="display: ${settings.provider === 'lmstudio' ? 'block' : 'none'};">
                        <label for="ph-lmstudio-base-url">Base URL:</label>
                        <input type="text" id="ph-lmstudio-base-url" value="${settings.lmStudioBaseUrl}" placeholder="http://localhost:1234">
                        <label for="ph-lmstudio-model">Model:</label>
                        <select id="ph-lmstudio-model" size="6">
                            <option value="${settings.lmStudioModel || DEFAULTS.lmStudioModel}">${settings.lmStudioModel || DEFAULTS.lmStudioModel}</option>
                        </select>
                        <div style="margin-top: 8px;">
                            <button id="ph-test-lmstudio-btn" type="button" style="background: #28a745; color: #fff;">Test</button>
                            <span id="ph-lmstudio-status" style="font-size: 0.85rem; margin-left: 8px;"></span>
                        </div>
                    </div>

                    <div id="ph-together-fields" style="display: ${settings.provider === 'together' ? 'block' : 'none'};">
                        <label for="ph-together-model">Model:</label>
                        <input type="text" id="ph-together-model" value="${settings.togetherModel}" placeholder="meta-llama/Llama-3.3-70B-Instruct-Turbo">
                    </div>

                    <div id="ph-fireworks-fields" style="display: ${settings.provider === 'fireworks' ? 'block' : 'none'};">
                        <label for="ph-fireworks-model">Model:</label>
                        <input type="text" id="ph-fireworks-model" value="${settings.fireworksModel}" placeholder="accounts/fireworks/models/llama-v3p1-8b-instruct">
                    </div>

                    <div id="ph-mistral-fields" style="display: ${settings.provider === 'mistral' ? 'block' : 'none'};">
                        <label for="ph-mistral-model">Model:</label>
                        <input type="text" id="ph-mistral-model" value="${settings.mistralModel}" placeholder="mistral-small-latest">
                    </div>

                    <div id="ph-anthropic-fields" style="display: ${settings.provider === 'anthropic' ? 'block' : 'none'};">
                        <label for="ph-anthropic-model">Model:</label>
                        <input type="text" id="ph-anthropic-model" value="${settings.anthropicModel}" placeholder="claude-sonnet-4-20250514">
                    </div>

                    <div id="ph-copilot-fields" style="display: ${settings.provider === 'copilot' ? 'block' : 'none'};">
                        <label for="ph-copilot-base-url">Base URL:</label>
                        <input type="text" id="ph-copilot-base-url" value="${settings.copilotBaseUrl}" placeholder="http://localhost:4141">
                        <label for="ph-copilot-model">Model:</label>
                        <select id="ph-copilot-model" size="6"></select>
                        <div style="margin-top: 8px;">
                            <button id="ph-test-copilot-btn" type="button" style="background: #28a745; color: #fff;">Test</button>
                            <span id="ph-copilot-status" style="font-size: 0.85rem; margin-left: 8px;"></span>
                        </div>
                    </div>

                    <div id="ph-generic-fields" style="display: ${settings.provider === 'generic' ? 'block' : 'none'};">
                        <label for="ph-generic-base-url">Base URL:</label>
                        <input type="text" id="ph-generic-base-url" value="${settings.genericBaseUrl}" placeholder="https://api.example.com/v1">
                        <label for="ph-generic-model">Model:</label>
                        <input type="text" id="ph-generic-model" value="${settings.genericModel}">
                        <label for="ph-generic-api-key">API Key (optional):</label>
                        <input type="text" id="ph-generic-api-key" value="${settings.genericApiKey}" placeholder="Optional">
                        <div style="margin-top: 8px;">
                            <button id="ph-test-generic-btn" type="button" style="background: #28a745; color: #fff;">Test</button>
                            <span id="ph-generic-status" style="font-size: 0.85rem; margin-left: 8px;"></span>
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
            const noApiKey = ['ollama', 'lmstudio', 'copilot', 'generic'];
            document.getElementById('ph-api-key-container').style.display = noApiKey.indexOf(provider) !== -1 ? 'none' : 'block';
            ['google', 'openrouter', 'openai', 'groq', 'ollama', 'lmstudio', 'together', 'fireworks', 'mistral', 'anthropic', 'copilot', 'generic'].forEach(function (p) {
                var el = document.getElementById('ph-' + p + '-fields');
                if (el) el.style.display = p === provider ? 'block' : 'none';
            });
        }

        document.getElementById('ph-provider').addEventListener('change', updateProviderVisibility);

        function runTestConnection(baseUrl, apiKey, statusElId) {
            var statusEl = document.getElementById(statusElId);
            if (!statusEl) return;
            statusEl.textContent = 'Testing...';
            statusEl.style.color = '#ffc107';
            testOpenAICompatibleConnection(baseUrl, apiKey || null).then(function (result) {
                if (result.online) {
                    statusEl.textContent = 'OK (' + result.models.length + ' models)';
                    statusEl.style.color = '#28a745';
                    return result;
                } else {
                    statusEl.textContent = 'Error: ' + (result.error || 'no response');
                    statusEl.style.color = '#dc3545';
                    return result;
                }
            }).catch(function (err) {
                statusEl.textContent = 'Error: ' + (err.message || 'network');
                statusEl.style.color = '#dc3545';
            });
        }

        function populateModelsIntoSelect(selectEl, models, savedModel) {
            if (!selectEl) return;
            if (!Array.isArray(models) || models.length === 0) models = savedModel ? [savedModel] : [];
            selectEl.innerHTML = '';
            models.forEach(function (modelId) {
                var opt = document.createElement('option');
                opt.value = modelId;
                opt.textContent = modelId;
                selectEl.appendChild(opt);
            });
            var keptVal = savedModel && models.indexOf(savedModel) !== -1 ? savedModel : models[0];
            selectEl.value = keptVal || "";
            var selectedOpt = selectEl.options[selectEl.selectedIndex];
            if (selectedOpt) selectedOpt.scrollIntoView({ block: 'nearest' });
        }

        function testAndPopulateCopilot() {
            var baseUrl = document.getElementById('ph-copilot-base-url').value.trim() || DEFAULTS.copilotBaseUrl;
            var statusEl = document.getElementById('ph-copilot-status');
            var selectEl = document.getElementById('ph-copilot-model');
            statusEl.textContent = 'Testing...';
            statusEl.style.color = '#ffc107';
            testOpenAICompatibleConnection(baseUrl, null).then(function (result) {
                if (result.online) {
                    statusEl.textContent = 'OK (' + result.models.length + ' models)';
                    statusEl.style.color = '#28a745';
                    populateModelsIntoSelect(selectEl, result.models, loadSettings().copilotModel);
                } else {
                    statusEl.textContent = 'Error: ' + (result.error || 'no response');
                    statusEl.style.color = '#dc3545';
                }
            }).catch(function (err) {
                statusEl.textContent = 'Error: ' + (err.message || 'network');
                statusEl.style.color = '#dc3545';
            });
        }

        function testAndPopulateLmStudio() {
            var baseUrl = document.getElementById('ph-lmstudio-base-url').value.trim() || DEFAULTS.lmStudioBaseUrl;
            var statusEl = document.getElementById('ph-lmstudio-status');
            var selectEl = document.getElementById('ph-lmstudio-model');
            statusEl.textContent = 'Testing...';
            statusEl.style.color = '#ffc107';
            testOpenAICompatibleConnection(baseUrl, null).then(function (result) {
                if (result.online) {
                    statusEl.textContent = 'OK (' + result.models.length + ' models)';
                    statusEl.style.color = '#28a745';
                    populateModelsIntoSelect(selectEl, result.models, loadSettings().lmStudioModel);
                } else {
                    statusEl.textContent = 'Error: ' + (result.error || 'no response');
                    statusEl.style.color = '#dc3545';
                }
            }).catch(function (err) {
                statusEl.textContent = 'Error: ' + (err.message || 'network');
                statusEl.style.color = '#dc3545';
            });
        }

        function testOllama() {
            var baseUrl = document.getElementById('ph-ollama-base-url').value.trim() || DEFAULTS.ollamaBaseUrl;
            runTestConnection(baseUrl, null, 'ph-ollama-status');
        }

        function testGeneric() {
            var baseUrl = document.getElementById('ph-generic-base-url').value.trim() || DEFAULTS.genericBaseUrl;
            var apiKey = document.getElementById('ph-generic-api-key').value.trim() || null;
            runTestConnection(baseUrl, apiKey, 'ph-generic-status');
        }

        document.getElementById('ph-test-copilot-btn').addEventListener('click', testAndPopulateCopilot);
        document.getElementById('ph-test-lmstudio-btn').addEventListener('click', testAndPopulateLmStudio);
        document.getElementById('ph-test-ollama-btn').addEventListener('click', testOllama);
        document.getElementById('ph-test-generic-btn').addEventListener('click', testGeneric);

        document.getElementById('ph-cancel-btn').addEventListener('click', function () {
            document.getElementById('ph-ai-settings-modal').remove();
        });

        document.getElementById('ph-save-btn').addEventListener('click', function () {
            function getVal(id, def) {
                var el = document.getElementById(id);
                return el ? (el.value || "").trim() : (def || "");
            }
            function getSelectVal(id, def) {
                var el = document.getElementById(id);
                if (!el) return def || "";
                return el.value || (el.selectedOptions && el.selectedOptions[0] ? el.selectedOptions[0].value : "") || def || "";
            }
            const newSettings = {
                provider: getVal('ph-provider', DEFAULTS.provider),
                apiKey: getVal('ph-api-key', DEFAULTS.apiKey),
                modelName: getVal('ph-model-name', DEFAULTS.modelName),
                openRouterModel: getVal('ph-or-model-name', DEFAULTS.openRouterModel),
                openaiModel: getVal('ph-openai-model', DEFAULTS.openaiModel),
                groqModel: getVal('ph-groq-model', DEFAULTS.groqModel),
                ollamaBaseUrl: getVal('ph-ollama-base-url', DEFAULTS.ollamaBaseUrl),
                ollamaModel: getVal('ph-ollama-model', DEFAULTS.ollamaModel),
                lmStudioBaseUrl: getVal('ph-lmstudio-base-url', DEFAULTS.lmStudioBaseUrl),
                lmStudioModel: getSelectVal('ph-lmstudio-model', DEFAULTS.lmStudioModel),
                togetherModel: getVal('ph-together-model', DEFAULTS.togetherModel),
                fireworksModel: getVal('ph-fireworks-model', DEFAULTS.fireworksModel),
                mistralModel: getVal('ph-mistral-model', DEFAULTS.mistralModel),
                anthropicModel: getVal('ph-anthropic-model', DEFAULTS.anthropicModel),
                copilotBaseUrl: getVal('ph-copilot-base-url', DEFAULTS.copilotBaseUrl),
                copilotModel: getSelectVal('ph-copilot-model', DEFAULTS.copilotModel),
                genericBaseUrl: getVal('ph-generic-base-url', DEFAULTS.genericBaseUrl),
                genericModel: getVal('ph-generic-model', DEFAULTS.genericModel),
                genericApiKey: getVal('ph-generic-api-key', DEFAULTS.genericApiKey),
                thinkingBudget: parseInt(document.getElementById('ph-thinking-budget').value, 10) || DEFAULTS.thinkingBudget
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
            setTimeout(function () { toast.style.opacity = '0'; }, 1500);
            setTimeout(function () { toast.remove(); }, 2000);
        });

        if (settings.provider === 'copilot') setTimeout(function () { testAndPopulateCopilot(); }, 100);
        else if (settings.provider === 'lmstudio') setTimeout(function () { testAndPopulateLmStudio(); }, 100);
    }

    GM_registerMenuCommand("Open AI Settings", createSettingsModal);

    ensureIndicator();

    // === INTERCEPTION LOGIC ===
    // When using GM_ functions, we must use unsafeWindow to access the page's fetch
    const originalFetch = unsafeWindow.fetch.bind(unsafeWindow);

    unsafeWindow.fetch = async function (url, options) {
        if (url && url.toString().includes('/api/simple-chat')) {
            const settings = loadSettings();

            const noApiKeyProviders = ['ollama', 'lmstudio', 'copilot', 'generic'];
            const needsApiKey = noApiKeyProviders.indexOf(settings.provider) === -1;
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
                // Native structured output for ALL action types (prompt-based schema injection
                // causes AI to dump schema text and ignore player's request)

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
                        if (isAction && gameSchema) {
                            genConfig.responseMimeType = "application/json";
                            genConfig.responseSchema = convertSchemaForGoogle(gameSchema);
                            console.log("%c[PAX AI] Using native responseSchema for: " + (gameSchema.name || "unknown"), "color: cyan");
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

                } else if (settings.provider === 'anthropic') {
                    responseText = await withRetry(async function () {
                        return callAnthropicApi(settings, finalPrompt, isAction && !!gameSchema, gameSchema);
                    });
                } else {
                    responseText = await withRetry(async function () {
                        var chatBaseUrl, modelId, authKey, extraHeaders = {};
                        switch (settings.provider) {
                            case 'openrouter':
                                chatBaseUrl = PROVIDER_URLS.openrouter;
                                modelId = settings.openRouterModel;
                                authKey = settings.apiKey;
                                extraHeaders["HTTP-Referer"] = window.location.href;
                                extraHeaders["X-Title"] = "Pax Historia Hook";
                                break;
                            case 'openai':
                                chatBaseUrl = PROVIDER_URLS.openai;
                                modelId = settings.openaiModel;
                                authKey = settings.apiKey;
                                break;
                            case 'groq':
                                chatBaseUrl = PROVIDER_URLS.groq;
                                modelId = settings.groqModel;
                                authKey = settings.apiKey;
                                break;
                            case 'ollama':
                                chatBaseUrl = getApiBase(settings.ollamaBaseUrl || DEFAULTS.ollamaBaseUrl);
                                modelId = settings.ollamaModel || DEFAULTS.ollamaModel;
                                authKey = null;
                                break;
                            case 'lmstudio':
                                chatBaseUrl = getApiBase(settings.lmStudioBaseUrl || DEFAULTS.lmStudioBaseUrl);
                                modelId = settings.lmStudioModel || DEFAULTS.lmStudioModel;
                                authKey = null;
                                break;
                            case 'together':
                                chatBaseUrl = PROVIDER_URLS.together;
                                modelId = settings.togetherModel;
                                authKey = settings.apiKey;
                                break;
                            case 'fireworks':
                                chatBaseUrl = PROVIDER_URLS.fireworks;
                                modelId = settings.fireworksModel;
                                authKey = settings.apiKey;
                                break;
                            case 'mistral':
                                chatBaseUrl = PROVIDER_URLS.mistral;
                                modelId = settings.mistralModel;
                                authKey = settings.apiKey;
                                break;
                            case 'copilot':
                                chatBaseUrl = getApiBase(settings.copilotBaseUrl || DEFAULTS.copilotBaseUrl);
                                modelId = settings.copilotModel || DEFAULTS.copilotModel;
                                authKey = null;
                                break;
                            case 'generic':
                                chatBaseUrl = getApiBase(settings.genericBaseUrl || DEFAULTS.genericBaseUrl);
                                modelId = settings.genericModel || DEFAULTS.genericModel;
                                authKey = (settings.genericApiKey || "").trim() || null;
                                break;
                            default:
                                throw new Error("Unknown provider: " + settings.provider);
                        }

                        var payload = {
                            model: modelId,
                            messages: [{ role: "user", content: finalPrompt }]
                        };
                        if (isAction && gameSchema) {
                            payload.response_format = { type: "json_schema", json_schema: gameSchema };
                            console.log("%c[PAX AI] Using response_format for: " + (gameSchema.name || "unknown"), "color: cyan");
                        }
                        var headers = { "Content-Type": "application/json" };
                        if (authKey) headers["Authorization"] = "Bearer " + authKey;
                        Object.keys(extraHeaders).forEach(function (k) { headers[k] = extraHeaders[k]; });

                        var result = await fetchApi(chatBaseUrl + "/chat/completions", {
                            method: "POST",
                            headers: headers,
                            body: payload
                        });
                        if (!result.ok) {
                            var errMsg = result.data?.error?.message || result.text || "HTTP " + result.status;
                            var err = new Error(settings.provider + " API Error: " + errMsg);
                            err.status = result.status;
                            throw err;
                        }
                        return result.data?.choices?.[0]?.message?.content || "";
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