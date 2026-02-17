// ==UserScript==
// @name         Pax Historia: Custom AI Backend (Gemini/Thinking/OpenRouter/Copilot)
// @namespace    http://tampermonkey.net/
// @version      13.0
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
                        <label for="ph-copilot-base-url">Base URL (sin API key):</label>
                        <input type="text" id="ph-copilot-base-url" value="${settings.copilotBaseUrl}" placeholder="http://localhost:4141">
                        <label for="ph-copilot-model">Model:</label>
                        <select id="ph-copilot-model" size="8">
                            <option value="${settings.copilotModel}">${settings.copilotModel}</option>
                        </select>
                        <div style="margin-top: 10px; display: flex; flex-wrap: wrap; align-items: center; gap: 8px;">
                            <button id="ph-test-copilot-btn" style="background: #28a745; color: #fff;">Test conexion</button>
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

        document.getElementById('ph-test-copilot-btn').addEventListener('click', function () {
            const statusEl = document.getElementById('ph-test-status');
            const selectEl = document.getElementById('ph-copilot-model');
            const baseUrl = document.getElementById('ph-copilot-base-url').value.trim() || DEFAULTS.copilotBaseUrl;
            statusEl.textContent = 'Probando...';
            statusEl.style.color = '#ffc107';
            testCopilotConnection(baseUrl).then(function (result) {
                if (result.online) {
                    statusEl.textContent = 'Conectado (' + result.models.length + ' modelos)';
                    statusEl.style.color = '#28a745';
                    const currentVal = selectEl.value;
                    selectEl.innerHTML = '';
                    result.models.forEach(function (modelId, index) {
                        const opt = document.createElement('option');
                        opt.value = modelId;
                        opt.textContent = modelId;
                        if (modelId === currentVal || (index === 0 && !currentVal)) opt.selected = true;
                        selectEl.appendChild(opt);
                    });
                    if (!selectEl.value && result.models.length) selectEl.value = result.models[0];
                } else {
                    statusEl.textContent = 'Error: ' + (result.error || 'sin respuesta');
                    statusEl.style.color = '#dc3545';
                }
            }).catch(function (err) {
                statusEl.textContent = 'Error: ' + (err.message || 'red');
                statusEl.style.color = '#dc3545';
            });
        });

        document.getElementById('ph-cancel-btn').addEventListener('click', function () {
            document.getElementById('ph-ai-settings-modal').remove();
        });

        document.getElementById('ph-save-btn').addEventListener('click', function () {
            const newSettings = {
                provider: document.getElementById('ph-provider').value,
                apiKey: document.getElementById('ph-api-key').value,
                modelName: document.getElementById('ph-model-name').value,
                openRouterModel: document.getElementById('ph-or-model-name').value,
                copilotBaseUrl: document.getElementById('ph-copilot-base-url').value.trim() || DEFAULTS.copilotBaseUrl,
                copilotModel: document.getElementById('ph-copilot-model').value || DEFAULTS.copilotModel,
                thinkingBudget: parseInt(document.getElementById('ph-thinking-budget').value, 10) || 4096
            };
            saveSettings(newSettings);
            alert('Settings saved! Reload the page for changes to take effect.');
            document.getElementById('ph-ai-settings-modal').remove();
            location.reload();
        });

        if (settings.provider === 'copilot') {
            setTimeout(function () { document.getElementById('ph-test-copilot-btn').click(); }, 100);
        }
    }

    GM_registerMenuCommand("Open AI Settings", createSettingsModal);


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
                let schemaStr = "";

                if (options.body) {
                    const payload = JSON.parse(options.body);
                    userPrompt = payload.prompt || "";

                    // DETERMINE REQUEST TYPE
                    if (payload.promptStage === "chatWithUser") {
                        isAction = false;
                    } else if (payload.jsonSchema) {
                        isAction = true;
                        schemaStr = JSON.stringify(payload.jsonSchema);
                    }
                }

                console.log(`%c[PAX AI] TYPE: ${isAction ? "ACTION (RAW JSON)" : "CHAT (WRAPPER)"} | Provider: ${settings.provider}`, "background: blue; color: white; padding: 5px; font-weight: bold;");

                let finalPrompt = userPrompt;
                // For actions, add strict instruction
                if (isAction && schemaStr) {
                    finalPrompt += `\n\nTASK: Generate a valid JSON object matching this schema.\nSCHEMA: ${schemaStr}\n\nIMPORTANT: Return ONLY the JSON object. No markdown.`;
                }

                let responseText = "";

                if (settings.provider === 'google') {
                    // === GOOGLE AI STUDIO ===
                    const googleUrl = `https://generativelanguage.googleapis.com/v1beta/models/${settings.modelName}:generateContent?key=${settings.apiKey}`;

                    const genConfig = {
                        temperature: 0.7,
                        thinkingConfig: {
                            include_thoughts: true,
                            thinking_budget: settings.thinkingBudget
                        }
                    };

                    const googlePayload = {
                        contents: [{ parts: [{ text: finalPrompt }] }],
                        generationConfig: genConfig
                    };

                    // Use GM_xmlhttpRequest or originalFetch? 
                    // Since we are in the page context via unsafeWindow, we can use originalFetch (which is the page's fetch).
                    // However, for cross-origin requests (like to Google API), the page's CSP might block it if we use the page's fetch.
                    // But the original script used window.fetch and it worked, implying CSP allows it or it wasn't blocked.
                    // To be safe and avoid CORS/CSP issues, usually GM_xmlhttpRequest is better, but let's stick to originalFetch for now 
                    // as it mimics the previous behavior, just executed from the right context.
                    // Actually, if we use originalFetch, we are subject to the page's CSP. 
                    // If the previous script worked with `grant none`, it means the page's CSP allowed it OR the browser extension bypassed it.
                    // Let's try using originalFetch first.

                    const myResponse = await originalFetch(googleUrl, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(googlePayload)
                    });

                    if (!myResponse.ok) {
                        const errText = await myResponse.text();
                        console.error("[PAX AI] Google API Error:", errText);
                        throw new Error("Google API Error: " + errText);
                    }

                    const myJson = await myResponse.json();
                    const parts = myJson.candidates?.[0]?.content?.parts || [];

                    // Find the last text part (the actual response, skipping thoughts)
                    for (let i = parts.length - 1; i >= 0; i--) {
                        if (parts[i].text) {
                            responseText = parts[i].text;
                            break;
                        }
                    }

                } else if (settings.provider === 'openrouter') {
                    // === OPENROUTER ===
                    const orUrl = "https://openrouter.ai/api/v1/chat/completions";

                    const orPayload = {
                        model: settings.openRouterModel,
                        messages: [
                            { role: "user", content: finalPrompt }
                        ]
                    };

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
                        console.error("[PAX AI] OpenRouter API Error:", errText);
                        throw new Error("OpenRouter API Error: " + errText);
                    }

                    const myJson = await myResponse.json();
                    responseText = myJson.choices?.[0]?.message?.content || "";
                } else if (settings.provider === 'copilot') {
                    // === COPILOT API (OpenAI-compatible, no API key) ===
                    const baseUrl = (settings.copilotBaseUrl || DEFAULTS.copilotBaseUrl).replace(/\/$/, "");
                    const copilotPayload = {
                        model: settings.copilotModel || DEFAULTS.copilotModel,
                        messages: [{ role: "user", content: finalPrompt }]
                    };

                    const copilotResult = await fetchCopilotApi("/v1/chat/completions", {
                        baseUrl: baseUrl,
                        method: "POST",
                        body: copilotPayload
                    });

                    if (!copilotResult.ok) {
                        const errMsg = copilotResult.data?.error?.message || copilotResult.text || "HTTP " + copilotResult.status;
                        console.error("[PAX AI] Copilot API Error:", errMsg);
                        throw new Error("Copilot API Error: " + errMsg);
                    }

                    responseText = copilotResult.data?.choices?.[0]?.message?.content || "";
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
                    // FOR ACTIONS: Return raw JSON text
                    // Game expects: { "events": [...] }
                    responseBody = cleanText;
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