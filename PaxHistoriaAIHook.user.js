// ==UserScript==
// @name         Pax Historia: Custom AI Backend (Gemini/Thinking/OpenRouter)
// @namespace    http://tampermonkey.net/
// @version      12.0
// @description  Custom AI backend for Pax Historia with Settings GUI. Supports Google Gemini and OpenRouter.
// @author       You
// @match        https://paxhistoria.co/*
// @match        https://www.paxhistoria.co/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // === DEFAULT SETTINGS ===
    const DEFAULTS = {
        provider: "google", // 'google' or 'openrouter'
        apiKey: "",
        modelName: "gemini-3-flash-preview",
        openRouterModel: "google/gemini-2.0-flash-thinking-exp:free",
        thinkingBudget: 4096
    };

    // === SETTINGS MANAGEMENT ===
    function loadSettings() {
        return {
            provider: GM_getValue("provider", DEFAULTS.provider),
            apiKey: GM_getValue("apiKey", DEFAULTS.apiKey),
            modelName: GM_getValue("modelName", DEFAULTS.modelName),
            openRouterModel: GM_getValue("openRouterModel", DEFAULTS.openRouterModel),
            thinkingBudget: GM_getValue("thinkingBudget", DEFAULTS.thinkingBudget)
        };
    }

    function saveSettings(settings) {
        GM_setValue("provider", settings.provider);
        GM_setValue("apiKey", settings.apiKey);
        GM_setValue("modelName", settings.modelName);
        GM_setValue("openRouterModel", settings.openRouterModel);
        GM_setValue("thinkingBudget", settings.thinkingBudget);
    }

    // === GUI IMPLEMENTATION ===
    function createSettingsModal() {
        if (document.getElementById('ph-ai-settings-modal')) return;

        const settings = loadSettings();

        const modalHTML = `
            <div id="ph-ai-settings-modal" style="position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.7); z-index: 10000; display: flex; justify-content: center; align-items: center; font-family: sans-serif;">
                <div style="background: #222; color: #fff; padding: 20px; border-radius: 8px; width: 400px; box-shadow: 0 4px 10px rgba(0,0,0,0.5);">
                    <h2 style="margin-top: 0; border-bottom: 1px solid #444; padding-bottom: 10px;">AI Settings</h2>
                    
                    <label style="display: block; margin-top: 10px;">Provider:</label>
                    <select id="ph-provider" style="width: 100%; padding: 8px; margin-top: 5px; background: #333; color: #fff; border: 1px solid #555; border-radius: 4px;">
                        <option value="google" ${settings.provider === 'google' ? 'selected' : ''}>Google AI Studio</option>
                        <option value="openrouter" ${settings.provider === 'openrouter' ? 'selected' : ''}>OpenRouter</option>
                    </select>

                    <label style="display: block; margin-top: 10px;">API Key:</label>
                    <input type="text" id="ph-api-key" value="${settings.apiKey}" style="width: 100%; padding: 8px; margin-top: 5px; background: #333; color: #fff; border: 1px solid #555; border-radius: 4px;" placeholder="Enter API Key">

                    <div id="ph-google-fields" style="display: ${settings.provider === 'google' ? 'block' : 'none'};">
                        <label style="display: block; margin-top: 10px;">Model Name:</label>
                        <input type="text" id="ph-model-name" value="${settings.modelName}" style="width: 100%; padding: 8px; margin-top: 5px; background: #333; color: #fff; border: 1px solid #555; border-radius: 4px;">
                        
                        <label style="display: block; margin-top: 10px;">Thinking Budget (Tokens):</label>
                        <input type="number" id="ph-thinking-budget" value="${settings.thinkingBudget}" style="width: 100%; padding: 8px; margin-top: 5px; background: #333; color: #fff; border: 1px solid #555; border-radius: 4px;">
                    </div>

                    <div id="ph-openrouter-fields" style="display: ${settings.provider === 'openrouter' ? 'block' : 'none'};">
                        <label style="display: block; margin-top: 10px;">OpenRouter Model:</label>
                        <input type="text" id="ph-or-model-name" value="${settings.openRouterModel}" style="width: 100%; padding: 8px; margin-top: 5px; background: #333; color: #fff; border: 1px solid #555; border-radius: 4px;">
                    </div>

                    <div style="margin-top: 20px; text-align: right;">
                        <button id="ph-cancel-btn" style="padding: 8px 16px; background: #555; color: #fff; border: none; border-radius: 4px; cursor: pointer; margin-right: 10px;">Cancel</button>
                        <button id="ph-save-btn" style="padding: 8px 16px; background: #007bff; color: #fff; border: none; border-radius: 4px; cursor: pointer;">Save</button>
                    </div>
                </div>
            </div>
        `;

        const div = document.createElement('div');
        div.innerHTML = modalHTML;
        document.body.appendChild(div);

        // Event Listeners
        document.getElementById('ph-provider').addEventListener('change', (e) => {
            const isGoogle = e.target.value === 'google';
            document.getElementById('ph-google-fields').style.display = isGoogle ? 'block' : 'none';
            document.getElementById('ph-openrouter-fields').style.display = isGoogle ? 'none' : 'block';
        });

        document.getElementById('ph-cancel-btn').addEventListener('click', () => {
            document.getElementById('ph-ai-settings-modal').remove();
        });

        document.getElementById('ph-save-btn').addEventListener('click', () => {
            const newSettings = {
                provider: document.getElementById('ph-provider').value,
                apiKey: document.getElementById('ph-api-key').value,
                modelName: document.getElementById('ph-model-name').value,
                openRouterModel: document.getElementById('ph-or-model-name').value,
                thinkingBudget: parseInt(document.getElementById('ph-thinking-budget').value) || 4096
            };
            saveSettings(newSettings);
            alert('Settings saved! Reload the page for changes to take effect.');
            document.getElementById('ph-ai-settings-modal').remove();
            location.reload();
        });
    }

    GM_registerMenuCommand("Open AI Settings", createSettingsModal);


    // === INTERCEPTION LOGIC ===
    // When using GM_ functions, we must use unsafeWindow to access the page's fetch
    const originalFetch = unsafeWindow.fetch.bind(unsafeWindow);

    unsafeWindow.fetch = async function (url, options) {
        if (url && url.toString().includes('/api/simple-chat')) {
            const settings = loadSettings();

            if (!settings.apiKey) {
                console.warn("[PAX AI] No API Key configured. Please open settings via Tampermonkey menu.");
                // Optionally alert user once per session or just fail gracefully
                // alert("Pax Historia Hook: Please configure your API Key in the Tampermonkey menu!"); 
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

                    // Validate JSON
                    try {
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