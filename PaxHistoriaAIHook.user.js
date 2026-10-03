// ==UserScript==
// @name         Pax Historia: Custom AI Backend (Multi-Provider)
// @namespace    http://tampermonkey.net/
// @version      15.5
// @description  Custom AI backend for Pax Historia. Supports Google, Vertex AI, OpenRouter, OpenAI, Groq, Ollama, LM Studio, Together, Fireworks, Mistral, Anthropic, Copilot, Generic, DeepSeek.
// @author       You
// @match        https://paxhistoria.co/*
// @match        https://www.paxhistoria.co/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
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

        // Handle anyOf/oneOf: filter out empty-object null-placeholders
        // Google rejects type:"object" with empty properties
        ['anyOf', 'oneOf'].forEach(function (key) {
            if (!Array.isArray(obj[key])) return;
            obj[key] = obj[key].filter(function (entry) {
                if (entry && entry.type === 'object' &&
                    (!entry.properties || Object.keys(entry.properties).length === 0)) {
                    obj.nullable = true;
                    return false;
                }
                return true;
            });
            if (obj[key].length === 1) {
                var inner = obj[key][0];
                delete obj[key];
                var wasNullable = obj.nullable;
                Object.assign(obj, inner);
                if (wasNullable) obj.nullable = true;
            } else if (obj[key].length === 0) {
                delete obj[key];
                if (!obj.type) obj.type = 'string';
            }
        });

        // удаляем ПОСЛЕ anyOf-развёртки, иначе Object.assign тащит их обратно
        delete obj.additionalProperties;
        delete obj.minItems;
        delete obj.maxItems;
        delete obj.title;
        delete obj.propertyOrdering;

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
        anthropic: "https://api.anthropic.com/v1",
        deepseek: "https://api.deepseek.com"
    };

    // === DEFAULT SETTINGS ===
    const DEFAULTS = {
        provider: "google",
        apiKey: "",
        modelName: "gemini-3-flash-preview",
        vertexServiceAccountJson: "",
        vertexProjectId: "",
        vertexLocation: "global",
        vertexModel: "gemini-3.5-flash",
        vertexThinkingBudget: -1,
        vertexThinkingLevel: "default",
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
        deepseekModel: "deepseek-v4-pro",
        copilotBaseUrl: "http://localhost:4141",
        copilotModel: "gpt-4.1",
        genericBaseUrl: "https://api.openai.com/v1",
        genericModel: "gpt-4o-mini",
        genericApiKey: "",
        thinkingBudget: -1,
        thinkingLevel: "default",
        streamChats: true
    };

    // === SETTINGS MANAGEMENT ===
    const API_KEY_PROVIDERS = ['google', 'openrouter', 'openai', 'groq', 'together', 'fireworks', 'mistral', 'anthropic', 'deepseek'];

    function loadProviderApiKeys() {
        const stored = GM_getValue("providerApiKeys", null);
        const keys = {};
        API_KEY_PROVIDERS.forEach(function (provider) {
            if (typeof stored?.[provider] === 'string') keys[provider] = stored[provider];
        });
        if (!stored) {
            const provider = GM_getValue("provider", DEFAULTS.provider);
            if (API_KEY_PROVIDERS.includes(provider)) keys[provider] = GM_getValue("apiKey", DEFAULTS.apiKey);
            GM_setValue("providerApiKeys", keys);
        }
        return keys;
    }

    function loadSettings() {
        const provider = GM_getValue("provider", DEFAULTS.provider);
        const providerApiKeys = loadProviderApiKeys();
        return {
            provider: provider,
            apiKey: providerApiKeys[provider] || "",
            providerApiKeys: providerApiKeys,
            modelName: GM_getValue("modelName", DEFAULTS.modelName),
            vertexServiceAccountJson: GM_getValue("vertexServiceAccountJson", DEFAULTS.vertexServiceAccountJson),
            vertexProjectId: GM_getValue("vertexProjectId", DEFAULTS.vertexProjectId),
            vertexLocation: GM_getValue("vertexLocation", DEFAULTS.vertexLocation),
            vertexModel: GM_getValue("vertexModel", DEFAULTS.vertexModel),
            vertexThinkingBudget: GM_getValue("vertexThinkingBudget", DEFAULTS.vertexThinkingBudget),
            vertexThinkingLevel: GM_getValue("vertexThinkingLevel", DEFAULTS.vertexThinkingLevel),
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
            deepseekModel: GM_getValue("deepseekModel", DEFAULTS.deepseekModel),
            copilotBaseUrl: GM_getValue("copilotBaseUrl", DEFAULTS.copilotBaseUrl),
            copilotModel: GM_getValue("copilotModel", DEFAULTS.copilotModel),
            genericBaseUrl: GM_getValue("genericBaseUrl", DEFAULTS.genericBaseUrl),
            genericModel: GM_getValue("genericModel", DEFAULTS.genericModel),
            genericApiKey: GM_getValue("genericApiKey", DEFAULTS.genericApiKey),
            thinkingBudget: GM_getValue("thinkingBudget", DEFAULTS.thinkingBudget),
            thinkingLevel: GM_getValue("thinkingLevel", DEFAULTS.thinkingLevel),
            streamChats: GM_getValue("streamChats", DEFAULTS.streamChats)
        };
    }

    function saveSettings(settings) {
        const providerApiKeys = loadProviderApiKeys();
        API_KEY_PROVIDERS.forEach(function (provider) {
            if (typeof settings.providerApiKeys?.[provider] === 'string') providerApiKeys[provider] = settings.providerApiKeys[provider];
        });
        if (API_KEY_PROVIDERS.includes(settings.provider)) providerApiKeys[settings.provider] = (settings.apiKey || "").trim();
        GM_setValue("providerApiKeys", providerApiKeys);
        GM_setValue("provider", settings.provider);
        GM_setValue("modelName", settings.modelName);
        if (settings.vertexServiceAccountJson !== GM_getValue("vertexServiceAccountJson", "")) vertexTokenCache = null;
        GM_setValue("vertexServiceAccountJson", settings.vertexServiceAccountJson);
        GM_setValue("vertexProjectId", settings.vertexProjectId);
        GM_setValue("vertexLocation", settings.vertexLocation);
        GM_setValue("vertexModel", settings.vertexModel);
        GM_setValue("vertexThinkingBudget", settings.vertexThinkingBudget);
        GM_setValue("vertexThinkingLevel", settings.vertexThinkingLevel);
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
        GM_setValue("deepseekModel", settings.deepseekModel);
        GM_setValue("copilotBaseUrl", settings.copilotBaseUrl);
        GM_setValue("copilotModel", settings.copilotModel);
        GM_setValue("genericBaseUrl", settings.genericBaseUrl);
        GM_setValue("genericModel", settings.genericModel);
        GM_setValue("genericApiKey", settings.genericApiKey);
        GM_setValue("thinkingBudget", settings.thinkingBudget);
        GM_setValue("thinkingLevel", settings.thinkingLevel);
        GM_setValue("streamChats", settings.streamChats);
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
            const body = typeof options?.body === "string" ? options.body : (options?.body ? JSON.stringify(options.body) : undefined);
            const headers = options?.headers || {};
            if (body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";

            console.log(`%c[PAX AI Network] Initiating ${method} request to ${url}...`, "color: orange");

            GM_xmlhttpRequest({
                method: method,
                url: url,
                headers: headers,
                data: body,
                timeout: options?.timeout || 0,
                onload: function (response) {
                    console.log(`%c[PAX AI Network] Response received from ${url} | Status: ${response.status}`, "color: " + (response.status >= 200 && response.status < 300 ? "lime" : "red"));
                    if (response.status >= 400 && !options?.sensitive) {
                        console.error(`[PAX AI Network] HTTP Error ${response.status}:`, response.responseText);
                    }
                    try {
                        const parsed = response.responseText ? JSON.parse(response.responseText) : {};
                        resolve({
                            ok: response.status >= 200 && response.status < 300,
                            status: response.status,
                            data: parsed,
                            text: response.responseText
                        });
                    } catch (e) {
                        console.warn(`[PAX AI Network] Failed to parse JSON response from ${url}`);
                        resolve({
                            ok: false,
                            status: response.status,
                            data: null,
                            text: response.responseText
                        });
                    }
                },
                onerror: function (err) {
                    console.error(`[PAX AI Network] Network error (onerror) for ${url}:`, options?.sensitive ? "Request failed" : err);
                    reject(new Error("Network error: " + url));
                },
                onabort: function () {
                    console.error(`[PAX AI Network] Request aborted for ${url}`);
                    reject(new Error("Request aborted: " + url));
                },
                ontimeout: function () {
                    console.error(`[PAX AI Network] Request timed out for ${url}`);
                    reject(new Error("Request timeout: " + url));
                }
            });
        });
    }

    const VERTEX_TOKEN_URL = "https://oauth2.googleapis.com/token";
    let vertexTokenCache = null;

    function parseVertexServiceAccount(json) {
        let account;
        try { account = JSON.parse(json); } catch {
            throw new Error("Vertex AI: import a valid service account JSON key.");
        }
        if (!account || account.type !== "service_account" ||
            typeof account.client_email !== "string" || !account.client_email.includes("@") ||
            typeof account.private_key !== "string" ||
            !/^-----BEGIN PRIVATE KEY-----\s+[A-Za-z0-9+/=\s]+\s+-----END PRIVATE KEY-----\s*$/.test(account.private_key)) {
            throw new Error("Vertex AI: JSON must contain type service_account, client_email and a PEM private_key.");
        }
        return account;
    }

    function getVertexConfig(settings) {
        const account = parseVertexServiceAccount(settings.vertexServiceAccountJson);
        const project = (settings.vertexProjectId || account.project_id || "").trim();
        const location = (settings.vertexLocation || DEFAULTS.vertexLocation).trim().toLowerCase();
        const model = (settings.vertexModel || DEFAULTS.vertexModel).trim();
        if (!/^[a-zA-Z0-9_-]+$/.test(project)) throw new Error("Vertex AI: enter a valid Google Cloud Project ID.");
        if (!/^(global|[a-z]+(?:-[a-z0-9]+)+)$/.test(location)) throw new Error("Vertex AI: location must be global or a region such as us-central1.");
        if (!/^gemini-[a-zA-Z0-9._-]+$/.test(model)) throw new Error("Vertex AI: enter a Gemini model ID, such as gemini-2.5-flash.");
        getVertexGenerationConfig(settings);
        const host = location === "global" ? "aiplatform.googleapis.com" : location + "-aiplatform.googleapis.com";
        return {
            account: account,
            url: `https://${host}/v1/projects/${encodeURIComponent(project)}/locations/${location}/publishers/google/models/${encodeURIComponent(model)}:generateContent`
        };
    }

    function base64Url(bytes) {
        return btoa(Array.from(new Uint8Array(bytes), byte => String.fromCharCode(byte)).join(""))
            .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    }

    function usesGeminiThinkingLevel(model) {
        const version = /^gemini-(\d+)(?:[.-]|$)/.exec((model || '').trim());
        return !!version && Number(version[1]) >= 3;
    }

    function getGeminiGenerationConfig(model, budget, level) {
        const config = { temperature: 0.7 };
        if (usesGeminiThinkingLevel(model)) {
            if (level && level !== 'default') {
                if (!['LOW', 'MEDIUM', 'HIGH'].includes(level)) throw new Error("Gemini: thinking level must be Default, LOW, MEDIUM or HIGH.");
                config.thinkingConfig = { thinkingLevel: level };
            }
        } else if (/^gemini-2\.5-/.test((model || '').trim())) {
            if (!Number.isInteger(budget) || budget < -1) throw new Error("Gemini: thinking budget must be -1 (automatic), 0, or a positive integer.");
            config.thinkingConfig = { thinkingBudget: budget };
        }
        return config;
    }

    function getVertexGenerationConfig(settings) {
        return getGeminiGenerationConfig(settings.vertexModel || DEFAULTS.vertexModel, settings.vertexThinkingBudget, settings.vertexThinkingLevel);
    }

    function getGoogleGenerationConfig(settings) {
        return getGeminiGenerationConfig(settings.modelName || DEFAULTS.modelName, settings.thinkingBudget, settings.thinkingLevel);
    }

    function vertexApiError(result, label) {
        const detail = result.data?.error?.message || result.data?.error_description ||
            (typeof result.data?.error === "string" ? result.data.error : "HTTP " + result.status);
        const error = new Error(label + ": " + detail);
        error.status = result.status;
        return error;
    }

    async function getVertexAccessToken(settings) {
        const source = settings.vertexServiceAccountJson;
        if (!vertexTokenCache || vertexTokenCache.source !== source) {
            vertexTokenCache = { source: source, token: "", expiresAt: 0, pending: null };
        }
        const cache = vertexTokenCache;
        if (cache.token && Date.now() < cache.expiresAt - 60000) return cache.token;
        if (cache.pending) return cache.pending;
        cache.pending = (async function () {
            const account = parseVertexServiceAccount(source);
            if (!crypto.subtle) throw new Error("Vertex AI: Web Crypto is unavailable in this browser.");
            const pem = account.private_key.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
            let key;
            try {
                key = await crypto.subtle.importKey("pkcs8", Uint8Array.from(atob(pem), ch => ch.charCodeAt(0)),
                    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
            } catch {
                throw new Error("Vertex AI: the service account RSA private key is invalid.");
            }
            const encoder = new TextEncoder();
            const now = Math.floor(Date.now() / 1000);
            const header = { alg: "RS256", typ: "JWT" };
            if (account.private_key_id) header.kid = account.private_key_id;
            const claims = {
                iss: account.client_email,
                scope: "https://www.googleapis.com/auth/cloud-platform",
                aud: VERTEX_TOKEN_URL,
                iat: now,
                exp: now + 3600
            };
            const unsigned = base64Url(encoder.encode(JSON.stringify(header))) + "." + base64Url(encoder.encode(JSON.stringify(claims)));
            const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(unsigned));
            const assertion = unsigned + "." + base64Url(signature);
            const tokenData = new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: assertion }).toString();
            const result = await withRetry(async function () {
                const response = await fetchApi(VERTEX_TOKEN_URL, {
                    method: "POST",
                    headers: { "Content-Type": "application/x-www-form-urlencoded" },
                    body: tokenData,
                    sensitive: true,
                    timeout: 60000
                });
                if (!response.ok) throw vertexApiError(response, "Vertex AI authorization failed");
                return response;
            });
            const lifetime = Number(result.data?.expires_in);
            if (typeof result.data?.access_token !== "string" || !result.data.access_token || !Number.isFinite(lifetime) || lifetime <= 0) {
                throw new Error("Vertex AI: Google returned an invalid OAuth token response.");
            }
            cache.token = result.data.access_token;
            cache.expiresAt = Date.now() + lifetime * 1000;
            return cache.token;
        })();
        try { return await cache.pending; } finally { cache.pending = null; }
    }

    async function requestVertexApi(settings, payload) {
        const config = getVertexConfig(settings);
        let token = await getVertexAccessToken(settings);
        return withRetry(async function () {
            async function send() {
                return fetchApi(config.url, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
                    body: payload,
                    timeout: 180000
                });
            }
            let result = await send();
            if (result.status === 401) {
                if (vertexTokenCache?.source === settings.vertexServiceAccountJson && vertexTokenCache.token === token) {
                    vertexTokenCache.expiresAt = 0;
                }
                token = await getVertexAccessToken(settings);
                result = await send();
            }
            if (!result.ok && isRetryableError(result.status)) throw vertexApiError(result, "Vertex AI API Error");
            return result;
        });
    }

    function streamAbortError() {
        const error = new Error("Chat generation cancelled");
        error.name = "AbortError";
        return error;
    }

    function fetchGeminiStream(url, payload, headers, onText, signal) {
        return new Promise(function (resolve, reject) {
            let request, reader, started = false, settled = false;
            function finish(error, text) {
                if (settled) return;
                settled = true;
                signal?.removeEventListener('abort', abort);
                if (error) {
                    reject(error);
                    request?.abort();
                    if (reader) reader.cancel().catch(function () {});
                } else resolve(text);
            }
            function abort() {
                finish(streamAbortError());
                request?.abort();
                if (reader) reader.cancel().catch(function () {});
            }
            if (signal?.aborted) { abort(); return; }
            signal?.addEventListener('abort', abort, { once: true });
            try {
                request = GM_xmlhttpRequest({
                    method: 'POST', url: url, headers: headers, data: JSON.stringify(payload),
                    responseType: 'stream', timeout: 180000,
                    onloadstart: async function (response) {
                        if (settled || started || !response.response?.getReader) return;
                        started = true;
                        reader = response.response.getReader();
                        let buffer = '', text = '', errorBody = '', completed = false;
                        const decoder = new TextDecoder();
                        const ok = response.status >= 200 && response.status < 300;
                        function consume(event) {
                            const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
                            if (!data || data === '[DONE]') return;
                            const chunk = JSON.parse(data);
                            if (chunk.error) throw new Error(chunk.error.message || 'Gemini stream failed');
                            if (chunk.promptFeedback?.blockReason) throw new Error('Gemini blocked the response: ' + chunk.promptFeedback.blockReason);
                            const candidate = chunk.candidates?.[0];
                            const delta = (candidate?.content?.parts || []).filter(part => !part.thought && typeof part.text === 'string').map(part => part.text).join('');
                            if (delta) { text += delta; onText(delta, text); }
                            if (candidate?.finishReason) {
                                if (candidate.finishReason !== 'STOP') throw new Error('Gemini stopped generation: ' + candidate.finishReason);
                                completed = true;
                            }
                        }
                        function drain() {
                            let boundary;
                            while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
                                consume(buffer.slice(0, boundary.index));
                                buffer = buffer.slice(boundary.index + boundary[0].length);
                            }
                        }
                        try {
                            while (!settled) {
                                const { done, value } = await reader.read();
                                if (done) break;
                                const decoded = typeof value === 'string' ? value : decoder.decode(value, { stream: true });
                                if (ok) { buffer += decoded; drain(); } else errorBody += decoded;
                            }
                            if (settled) return;
                            if (!ok) {
                                let detail;
                                try { detail = JSON.parse(errorBody + decoder.decode()).error?.message; } catch (_) {}
                                const error = new Error(detail || 'Gemini stream HTTP ' + response.status);
                                error.status = response.status;
                                throw error;
                            }
                            buffer += decoder.decode();
                            drain();
                            if (buffer.trim()) consume(buffer);
                            if (!completed) throw new Error('Gemini stream ended before generation completed');
                            if (!text) throw new Error('Gemini returned no text');
                            finish(null, text);
                        } catch (error) {
                            finish(error);
                            request?.abort();
                            reader.cancel().catch(function () {});
                        } finally { reader.releaseLock(); }
                    },
                    onload: function () {
                        if (!started) finish(new Error('Streaming is unavailable. Update Tampermonkey or disable Stream chats in AI Settings.'));
                    },
                    onerror: function () { finish(new Error('Gemini stream network error')); },
                    ontimeout: function () { finish(new Error('Gemini stream timed out')); },
                    onabort: function () { finish(streamAbortError()); }
                });
            } catch (error) { finish(error); }
        });
    }

    function partialChatMessage(text) {
        const match = /"message"\s*:\s*"/.exec(text);
        if (!match) return '';
        let value = '';
        for (let i = match.index + match[0].length; i < text.length; i++) {
            const char = text[i];
            if (char === '"') break;
            if (char !== '\\') { value += char; continue; }
            const escape = text[++i];
            if (!escape) break;
            if (escape === 'u') {
                const hex = text.slice(i + 1, i + 5);
                if (!/^[0-9a-f]{4}$/i.test(hex)) break;
                value += String.fromCharCode(parseInt(hex, 16));
                i += 4;
            } else {
                const escapes = { '"': '"', '\\': '\\', '/': '/', n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' };
                if (!(escape in escapes)) break;
                value += escapes[escape];
            }
        }
        return value;
    }

    function createChatPreview() {
        const box = document.createElement('section');
        box.style.cssText = 'position:fixed;right:16px;bottom:16px;width:min(440px,calc(100vw - 32px));max-height:45vh;overflow:auto;background:#222;color:#fff;border:1px solid #555;border-radius:8px;padding:12px;box-sizing:border-box;z-index:9999;font:14px/1.5 system-ui;box-shadow:0 4px 20px #0008;';
        box.setAttribute('aria-label', 'Live chat reply');
        const title = document.createElement('div');
        title.textContent = 'Ответ генерируется…';
        const close = document.createElement('button');
        close.textContent = '×';
        close.setAttribute('aria-label', 'Hide live reply');
        close.style.cssText = 'float:right;background:transparent;border:0;color:inherit;font-size:20px;cursor:pointer;';
        close.addEventListener('click', function () { box.remove(); });
        const content = document.createElement('div');
        content.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;margin-top:8px;';
        box.appendChild(close); box.appendChild(title); box.appendChild(content);
        document.body.appendChild(box);
        return {
            update: function (text) { content.textContent = text; box.scrollTop = box.scrollHeight; },
            complete: function () { box.remove(); },
            fail: function (error) { title.textContent = error.name === 'AbortError' ? 'Генерация отменена' : 'Ошибка: ' + error.message; }
        };
    }

    function createGeminiChatResponse(settings, prompt, schema, signal, onComplete, onFailure) {
        const isVertex = settings.provider === 'vertex';
        const generationConfig = isVertex ? getVertexGenerationConfig(settings) : getGoogleGenerationConfig(settings);
        if (schema) {
            generationConfig.responseMimeType = 'application/json';
            generationConfig.responseSchema = convertSchemaForGoogle(schema);
        }
        const payload = { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: generationConfig };
        const abortController = new AbortController();
        const forwardAbort = function () { abortController.abort(); };
        if (signal?.aborted) forwardAbort();
        else signal?.addEventListener('abort', forwardAbort, { once: true });
        const preview = createChatPreview();
        const encoder = new TextEncoder();
        let cancelled = false;
        const body = new unsafeWindow.ReadableStream({
            start: function (controller) {
                (async function () {
                    try {
                        if (cancelled || abortController.signal.aborted) throw streamAbortError();
                        let url, headers = { 'Content-Type': 'application/json' };
                        if (isVertex) {
                            url = getVertexConfig(settings).url.replace(':generateContent', ':streamGenerateContent?alt=sse');
                            headers.Authorization = 'Bearer ' + await getVertexAccessToken(settings);
                        } else {
                            url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(settings.modelName) + ':streamGenerateContent?alt=sse';
                            headers['x-goog-api-key'] = settings.apiKey;
                        }
                        let emitted = false;
                        function delta(part, text) {
                            if (cancelled || abortController.signal.aborted) throw streamAbortError();
                            if (!emitted && !schema) controller.enqueue(encoder.encode('{"message":"'));
                            emitted = true;
                            controller.enqueue(encoder.encode(schema ? part : JSON.stringify(part).slice(1, -1)));
                            preview.update(schema ? partialChatMessage(text) : text);
                        }
                        let text;
                        try { text = await fetchGeminiStream(url, payload, headers, delta, abortController.signal); }
                        catch (error) {
                            if (!isVertex || error.status !== 401 || emitted || abortController.signal.aborted) throw error;
                            if (vertexTokenCache?.source === settings.vertexServiceAccountJson && headers.Authorization === 'Bearer ' + vertexTokenCache.token) vertexTokenCache.expiresAt = 0;
                            headers.Authorization = 'Bearer ' + await getVertexAccessToken(settings);
                            text = await fetchGeminiStream(url, payload, headers, delta, abortController.signal);
                        }
                        if (cancelled || abortController.signal.aborted) throw streamAbortError();
                        let responseBody;
                        if (schema) {
                            const parsed = JSON.parse(text);
                            if (typeof parsed.message !== 'string') throw new Error('Gemini returned an invalid chat message');
                            responseBody = text;
                        } else {
                            controller.enqueue(encoder.encode('"}'));
                            responseBody = JSON.stringify({ message: text });
                        }
                        controller.close();
                        preview.complete();
                        onComplete({ body: responseBody, status: 200, headers: { 'Content-Type': 'application/json' } });
                    } catch (error) {
                        if (!cancelled) controller.error(error);
                        preview.fail(error);
                        onFailure(error);
                    } finally { signal?.removeEventListener('abort', forwardAbort); }
                })();
            },
            cancel: function () { cancelled = true; abortController.abort(); }
        });
        return new unsafeWindow.Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    function getModelLabel(settings) {
        switch (settings.provider) {
            case "google": return settings.modelName;
            case "vertex": return settings.vertexModel;
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
            case "deepseek": return settings.deepseekModel;
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
            max_tokens: -1,
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
                #ph-ai-modal-box input, #ph-ai-modal-box select, #ph-ai-modal-box textarea { width: 100%; padding: 8px; margin-top: 4px; background: #333; color: #fff; border: 1px solid #555; border-radius: 4px; box-sizing: border-box; font-size: 0.9rem; }
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
                        <option value="vertex" ${settings.provider === 'vertex' ? 'selected' : ''}>Vertex AI (Gemini / service account)</option>
                        <option value="openrouter" ${settings.provider === 'openrouter' ? 'selected' : ''}>OpenRouter</option>
                        <option value="openai" ${settings.provider === 'openai' ? 'selected' : ''}>OpenAI</option>
                        <option value="groq" ${settings.provider === 'groq' ? 'selected' : ''}>Groq</option>
                        <option value="ollama" ${settings.provider === 'ollama' ? 'selected' : ''}>Ollama (local)</option>
                        <option value="lmstudio" ${settings.provider === 'lmstudio' ? 'selected' : ''}>LM Studio (local)</option>
                        <option value="together" ${settings.provider === 'together' ? 'selected' : ''}>Together AI</option>
                        <option value="fireworks" ${settings.provider === 'fireworks' ? 'selected' : ''}>Fireworks AI</option>
                        <option value="mistral" ${settings.provider === 'mistral' ? 'selected' : ''}>Mistral AI</option>
                        <option value="anthropic" ${settings.provider === 'anthropic' ? 'selected' : ''}>Anthropic (Claude)</option>
                        <option value="deepseek" ${settings.provider === 'deepseek' ? 'selected' : ''}>DeepSeek</option>
                        <option value="copilot" ${settings.provider === 'copilot' ? 'selected' : ''}>Copilot API (local)</option>
                        <option value="generic" ${settings.provider === 'generic' ? 'selected' : ''}>Generic (URL)</option>
                    </select>

                    <div id="ph-stream-fields" style="display: ${['google', 'vertex'].includes(settings.provider) ? 'block' : 'none'};">
                        <label><input id="ph-stream-chats" type="checkbox" style="width: auto;"> Stream chats with live preview</label>
                        <p style="font-size: 0.8rem; color: #aaa;">Gemini / Vertex country chats only. Actions stay buffered.</p>
                    </div>

                    <div id="ph-api-key-container" style="display: ${['vertex', 'ollama', 'lmstudio', 'copilot', 'generic'].indexOf(settings.provider) !== -1 ? 'none' : 'block'};">
                        <label for="ph-api-key">API Key:</label>
                        <input type="text" id="ph-api-key" placeholder="sk-...">
                    </div>

                    <div id="ph-google-fields" style="display: ${settings.provider === 'google' ? 'block' : 'none'};">
                        <label for="ph-model-name">Model:</label>
                        <input type="text" id="ph-model-name" value="${settings.modelName}">
                        <div id="ph-google-thinking-level-fields">
                            <label for="ph-thinking-level">Thinking Level:</label>
                            <select id="ph-thinking-level">
                                <option value="default">Default (MEDIUM for Gemini 3.8 Flash)</option>
                                <option value="LOW">LOW — faster</option>
                                <option value="MEDIUM">MEDIUM — balanced</option>
                                <option value="HIGH">HIGH — deeper reasoning</option>
                            </select>
                        </div>
                        <div id="ph-google-thinking-budget-fields">
                            <label for="ph-thinking-budget">Thinking Budget (Tokens, -1 = automatic):</label>
                            <input type="number" id="ph-thinking-budget" value="${settings.thinkingBudget}" min="-1" step="1">
                        </div>
                        <span id="ph-google-thinking-status" role="status" style="font-size: 0.85rem; color: #dc3545;"></span>
                    </div>

                    <div id="ph-vertex-fields" style="display: ${settings.provider === 'vertex' ? 'block' : 'none'};">
                        <label for="ph-vertex-service-account-file">Service account JSON key:</label>
                        <input type="file" id="ph-vertex-service-account-file" accept=".json,application/json">
                        <label for="ph-vertex-service-account-json">Or paste a JSON key:</label>
                        <textarea id="ph-vertex-service-account-json" rows="4" autocomplete="off" spellcheck="false" placeholder="Paste a new key; leave empty to keep the saved account"></textarea>
                        <div style="margin-top: 8px;">
                            <button id="ph-vertex-clear-btn" type="button" style="background: #555; color: #fff;">Clear account</button>
                            <span id="ph-vertex-account-status" style="font-size: 0.85rem;"></span>
                        </div>
                        <p style="font-size: 0.8rem; color: #aaa;">The key is saved in Tampermonkey storage. OAuth tokens refresh automatically.</p>
                        <label for="ph-vertex-project">Google Cloud Project ID (optional):</label>
                        <input type="text" id="ph-vertex-project" placeholder="Uses project_id from the JSON key">
                        <label for="ph-vertex-location">Location:</label>
                        <input type="text" id="ph-vertex-location" placeholder="global or us-central1">
                        <label for="ph-vertex-model">Gemini model:</label>
                        <input type="text" id="ph-vertex-model" placeholder="gemini-3.8-flash">
                        <div id="ph-vertex-thinking-level-fields">
                            <label for="ph-vertex-thinking-level">Thinking Level:</label>
                            <select id="ph-vertex-thinking-level">
                                <option value="default">Default (MEDIUM for Gemini 3.8 Flash)</option>
                                <option value="LOW">LOW — faster</option>
                                <option value="MEDIUM">MEDIUM — balanced</option>
                                <option value="HIGH">HIGH — deeper reasoning</option>
                            </select>
                        </div>
                        <div id="ph-vertex-thinking-budget-fields">
                            <label for="ph-vertex-thinking-budget">Thinking Budget (Tokens, -1 = automatic):</label>
                            <input type="number" id="ph-vertex-thinking-budget" min="-1" step="1">
                        </div>
                        <div style="margin-top: 8px;">
                            <button id="ph-test-vertex-btn" type="button" style="background: #28a745; color: #fff;">Test connection</button>
                            <span id="ph-vertex-status" role="status" style="font-size: 0.85rem; margin-left: 8px;"></span>
                        </div>
                        <p style="font-size: 0.8rem; color: #aaa;">Test sends a short request to the selected model and may incur usage charges.</p>
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

                    <div id="ph-deepseek-fields" style="display: ${settings.provider === 'deepseek' ? 'block' : 'none'};">
                        <label for="ph-deepseek-model">Model:</label>
                        <input type="text" id="ph-deepseek-model" value="${settings.deepseekModel}" placeholder="deepseek-v4-pro">
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

        const providerApiKeys = { ...settings.providerApiKeys };
        const apiKeyInput = document.getElementById('ph-api-key');
        let apiKeyProvider = settings.provider;
        apiKeyInput.value = settings.apiKey;
        document.getElementById('ph-thinking-level').value = settings.thinkingLevel;
        document.getElementById('ph-stream-chats').checked = settings.streamChats;

        let vertexCredentialDraft = settings.vertexServiceAccountJson;
        let vertexAccountCleared = false;
        const vertexJsonInput = document.getElementById('ph-vertex-service-account-json');
        const vertexStatus = document.getElementById('ph-vertex-status');
        const vertexAccountStatus = document.getElementById('ph-vertex-account-status');
        document.getElementById('ph-vertex-project').value = settings.vertexProjectId;
        document.getElementById('ph-vertex-location').value = settings.vertexLocation;
        document.getElementById('ph-vertex-model').value = settings.vertexModel;
        document.getElementById('ph-vertex-thinking-budget').value = settings.vertexThinkingBudget;
        document.getElementById('ph-vertex-thinking-level').value = settings.vertexThinkingLevel;
        vertexAccountStatus.textContent = vertexCredentialDraft ? 'Saved account available' : 'No account';

        function updateThinkingFields() {
            [['google', 'ph-model-name', DEFAULTS.modelName], ['vertex', 'ph-vertex-model', DEFAULTS.vertexModel]].forEach(function ([provider, modelId, fallback]) {
                const model = document.getElementById(modelId).value.trim() || fallback;
                document.getElementById('ph-' + provider + '-thinking-level-fields').style.display = usesGeminiThinkingLevel(model) ? 'block' : 'none';
                document.getElementById('ph-' + provider + '-thinking-budget-fields').style.display = /^gemini-2\.5-/.test(model) ? 'block' : 'none';
            });
            document.getElementById('ph-google-thinking-status').textContent = '';
        }
        ['ph-model-name', 'ph-vertex-model'].forEach(function (id) {
            document.getElementById(id).addEventListener('input', updateThinkingFields);
            document.getElementById(id).addEventListener('change', updateThinkingFields);
        });
        updateThinkingFields();

        function readVertexSettings() {
            return {
                vertexServiceAccountJson: vertexJsonInput.value.trim() || vertexCredentialDraft,
                vertexProjectId: document.getElementById('ph-vertex-project').value.trim(),
                vertexLocation: document.getElementById('ph-vertex-location').value.trim() || DEFAULTS.vertexLocation,
                vertexModel: document.getElementById('ph-vertex-model').value.trim() || DEFAULTS.vertexModel,
                vertexThinkingBudget: Number(document.getElementById('ph-vertex-thinking-budget').value.trim() || DEFAULTS.vertexThinkingBudget),
                vertexThinkingLevel: document.getElementById('ph-vertex-thinking-level').value || DEFAULTS.vertexThinkingLevel
            };
        }

        function showVertexError(error) {
            vertexStatus.textContent = error.message;
            vertexStatus.style.color = '#dc3545';
        }

        document.getElementById('ph-vertex-service-account-file').addEventListener('change', async function (event) {
            const file = event.target.files[0];
            if (!file) return;
            try {
                const json = await file.text();
                const account = parseVertexServiceAccount(json);
                vertexCredentialDraft = json.trim();
                vertexAccountCleared = false;
                vertexJsonInput.value = '';
                vertexAccountStatus.textContent = 'Imported: ' + account.client_email + ' (save to apply)';
                vertexStatus.textContent = '';
            } catch (error) { showVertexError(error); }
            event.target.value = '';
        });
        document.getElementById('ph-vertex-clear-btn').addEventListener('click', function () {
            vertexCredentialDraft = '';
            vertexAccountCleared = true;
            vertexJsonInput.value = '';
            vertexAccountStatus.textContent = 'Account cleared (save to apply)';
            vertexStatus.textContent = '';
        });
        document.getElementById('ph-test-vertex-btn').addEventListener('click', async function (event) {
            const button = event.currentTarget;
            button.disabled = true;
            vertexStatus.textContent = 'Testing...';
            vertexStatus.style.color = '#ffc107';
            try {
                const vertexSettings = readVertexSettings();
                const result = await requestVertexApi(vertexSettings, {
                    contents: [{ role: 'user', parts: [{ text: 'Reply with OK.' }] }],
                    generationConfig: getVertexGenerationConfig(vertexSettings)
                });
                if (!result.ok) throw vertexApiError(result, 'Vertex AI connection failed');
                if (!result.data?.candidates?.[0]?.content?.parts?.some(part => part.text && !part.thought)) {
                    throw new Error('Vertex AI: the model returned no text. Check model availability.');
                }
                vertexStatus.textContent = 'OK (model responded)';
                vertexStatus.style.color = '#28a745';
            } catch (error) { showVertexError(error); }
            finally { button.disabled = false; }
        });

        // Event Listeners
        function updateProviderVisibility() {
            document.getElementById('ph-stream-fields').style.display = ['google', 'vertex'].includes(document.getElementById('ph-provider').value) ? 'block' : 'none';
            const provider = document.getElementById('ph-provider').value;
            if (API_KEY_PROVIDERS.includes(apiKeyProvider)) providerApiKeys[apiKeyProvider] = apiKeyInput.value.trim();
            apiKeyProvider = provider;
            apiKeyInput.value = providerApiKeys[provider] || '';
            const noApiKey = ['vertex', 'ollama', 'lmstudio', 'copilot', 'generic'];
            document.getElementById('ph-api-key-container').style.display = noApiKey.indexOf(provider) !== -1 ? 'none' : 'block';
            ['google', 'vertex', 'openrouter', 'openai', 'groq', 'ollama', 'lmstudio', 'together', 'fireworks', 'mistral', 'anthropic', 'deepseek', 'copilot', 'generic'].forEach(function (p) {
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
            if (apiKeyProvider !== document.getElementById('ph-provider').value) updateProviderVisibility();
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
                providerApiKeys: providerApiKeys,
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
                deepseekModel: getVal('ph-deepseek-model', DEFAULTS.deepseekModel),
                copilotBaseUrl: getVal('ph-copilot-base-url', DEFAULTS.copilotBaseUrl),
                copilotModel: getSelectVal('ph-copilot-model', DEFAULTS.copilotModel),
                genericBaseUrl: getVal('ph-generic-base-url', DEFAULTS.genericBaseUrl),
                genericModel: getVal('ph-generic-model', DEFAULTS.genericModel),
                genericApiKey: getVal('ph-generic-api-key', DEFAULTS.genericApiKey),
                thinkingBudget: Number(document.getElementById('ph-thinking-budget').value.trim() || DEFAULTS.thinkingBudget),
                thinkingLevel: getSelectVal('ph-thinking-level', DEFAULTS.thinkingLevel),
                streamChats: document.getElementById('ph-stream-chats').checked
            };
            if (newSettings.provider === 'google') {
                try { getGoogleGenerationConfig(newSettings); } catch (error) {
                    document.getElementById('ph-google-thinking-status').textContent = error.message;
                    return;
                }
            }
            const vertexSettings = readVertexSettings();
            try {
                if (vertexSettings.vertexServiceAccountJson) parseVertexServiceAccount(vertexSettings.vertexServiceAccountJson);
                if (newSettings.provider === 'vertex' && (!vertexAccountCleared || vertexSettings.vertexServiceAccountJson)) getVertexConfig(vertexSettings);
            } catch (error) {
                showVertexError(error);
                document.getElementById('ph-provider').value = 'vertex';
                updateProviderVisibility();
                return;
            }
            Object.assign(newSettings, vertexSettings);
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

    var _inflightRequests = {};

    unsafeWindow.fetch = async function (url, options) {
        if (url && url.toString().includes('/api/simple-chat')) {
            var reqKey = null;
            try {
                var bodyStr = options && options.body ? options.body : "";
                reqKey = bodyStr;
            } catch (e) { }

            if (reqKey && _inflightRequests[reqKey]) {
                console.log("%c[PAX AI] Duplicate request detected, waiting for existing response...", "color: #ff9800");
                try {
                    var existingResult = await _inflightRequests[reqKey];
                    return new unsafeWindow.Response(existingResult.body, {
                        status: existingResult.status,
                        headers: existingResult.headers
                    });
                } catch (e) {
                    console.warn("[PAX AI] Existing request failed, proceeding with new one");
                }
            }

            var resolveInflight, rejectInflight;
            const settings = loadSettings();

            const noApiKeyProviders = ['vertex', 'ollama', 'lmstudio', 'copilot', 'generic'];
            const needsApiKey = noApiKeyProviders.indexOf(settings.provider) === -1;
            if (needsApiKey && !settings.apiKey) {
                console.warn("[PAX AI] No API Key configured. Please open settings via Tampermonkey menu.");
                return originalFetch(url, options);
            }
            if (reqKey) {
                _inflightRequests[reqKey] = new Promise(function (res, rej) {
                    resolveInflight = res;
                    rejectInflight = rej;
                });
                _inflightRequests[reqKey].catch(function () {});
            }

            let streamingRequest = false;
            try {
                let userPrompt = "";
                let isAction = false;
                let gameSchema = null; // raw schema object from the game

                if (options.body) {
                    const payload = JSON.parse(options.body);
                    userPrompt = payload.prompt || "";

                    if (settings.streamChats && payload.stream === true && payload.promptStage === 'chatWithUser' && ['google', 'vertex'].includes(settings.provider)) {
                        streamingRequest = true;
                        return createGeminiChatResponse(settings, userPrompt, payload.jsonSchema, options.signal,
                            function (result) {
                                if (resolveInflight) resolveInflight(result);
                                if (reqKey) delete _inflightRequests[reqKey];
                            },
                            function (error) {
                                if (resolveInflight) resolveInflight({ body: JSON.stringify({ error: error.message }), status: 502, headers: { 'Content-Type': 'application/json' } });
                                if (reqKey) delete _inflightRequests[reqKey];
                            });
                    }

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

                if (settings.provider === 'google' || settings.provider === 'vertex') {
                    responseText = await (async function () {
                        const isVertex = settings.provider === 'vertex';
                        const googleUrl = isVertex ? null : `https://generativelanguage.googleapis.com/v1beta/models/${settings.modelName}:generateContent?key=${settings.apiKey}`;

                        async function doGoogleRequest(useNativeSchema) {
                            const genConfig = isVertex ? getVertexGenerationConfig(settings) : getGoogleGenerationConfig(settings);
                            var promptText = finalPrompt;
                            if (isAction && gameSchema) {
                                if (useNativeSchema) {
                                    var converted = convertSchemaForGoogle(gameSchema);
                                    console.log("[PAX AI] Converted Google schema:", JSON.stringify(converted, null, 2));
                                    genConfig.responseMimeType = "application/json";
                                    genConfig.responseSchema = converted;
                                    console.log("%c[PAX AI] Using native responseSchema for: " + (gameSchema.name || "unknown"), "color: cyan");
                                } else {
                                    genConfig.responseMimeType = "application/json";
                                    var innerSchema = gameSchema.schema || gameSchema;
                                    promptText += "\n\nYou must respond with a valid JSON object matching this schema:\n" + JSON.stringify(innerSchema);
                                    console.log("%c[PAX AI] Fallback: injecting schema into prompt for: " + (gameSchema.name || "unknown"), "color: yellow");
                                }
                            }
                            const googlePayload = {
                                contents: [{ role: "user", parts: [{ text: promptText }] }],
                                generationConfig: genConfig
                            };
                            if (isVertex) return requestVertexApi(settings, googlePayload);
                            return await fetchApi(googleUrl, {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: googlePayload
                            });
                        }

                        var result = await doGoogleRequest(isAction && !!gameSchema);
                        if (!result.ok && result.status === 400 && isAction && gameSchema) {
                            console.warn("[PAX AI] Google rejected schema (400), retrying with prompt-injected schema...");
                            result = await doGoogleRequest(false);
                        }
                        if (!result.ok) {
                            if (isVertex) throw vertexApiError(result, "Vertex AI API Error");
                            const err = new Error("Google API Error: " + (result.text || "HTTP " + result.status));
                            err.status = result.status;
                            throw err;
                        }
                        const parts = result.data?.candidates?.[0]?.content?.parts || [];
                        const text = parts.filter(part => !part.thought && typeof part.text === 'string').map(part => part.text).join('');
                        if (isVertex) {
                            if (!text) throw new Error("Vertex AI: the model returned no text (" + (result.data?.promptFeedback?.blockReason || result.data?.candidates?.[0]?.finishReason || "empty response") + ").");
                        }
                        return text;
                    })();

                } else if (settings.provider === 'anthropic') {
                    responseText = await (async function () {
                        return callAnthropicApi(settings, finalPrompt, isAction && !!gameSchema, gameSchema);
                    })();
                } else {
                    responseText = await (async function () {
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
                            case 'deepseek':
                                chatBaseUrl = PROVIDER_URLS.deepseek;
                                modelId = settings.deepseekModel;
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
                        if (settings.provider === 'deepseek') {
                            payload.thinking = { type: "enabled" };
                        }
                        if (isAction && gameSchema) {
                            if (settings.provider === 'deepseek') {
                                payload.response_format = { type: "json_object" };
                                payload.max_tokens = 66666;
                                payload.messages[0].content += "\n\nPlease output the result in json format. Your response must be a valid json object matching this JSON Schema:\n" + JSON.stringify(gameSchema) + "\n\nDo not include any other text or markdown.";
                                console.log("%c[PAX AI] Using json_object format for DeepSeek: " + (gameSchema.name || "unknown"), "color: cyan");
                            } else {
                                payload.response_format = { type: "json_schema", json_schema: gameSchema };
                                console.log("%c[PAX AI] Using response_format for: " + (gameSchema.name || "unknown"), "color: cyan");
                            }
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

                        var choiceMsg = result.data?.choices?.[0]?.message;
                        if (choiceMsg && choiceMsg.reasoning_content) {
                            console.log("%c[PAX AI DeepSeek Think]\n" + choiceMsg.reasoning_content, "color: #b19cd9; font-style: italic;");
                        }

                        return choiceMsg ? (choiceMsg.content || "") : "";
                    })();
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

                    // Unwrap schema wrapper & Auto-Repair
                    let parsed = null;
                    try {
                        parsed = JSON.parse(cleanText);
                    } catch (e) {
                        const appendOptions = ['}', ']}', ']}}', '}]}', '"]}', '"}', '"]}}', '"]}]}', '}', ']}', '}]'];
                        for (let i = 0; i < appendOptions.length; i++) {
                            try {
                                parsed = JSON.parse(cleanText + appendOptions[i]);
                                cleanText = cleanText + appendOptions[i];
                                console.warn("[PAX AI] Auto-repaired truncated JSON by appending: " + appendOptions[i]);
                                break;
                            } catch (err) { }
                        }
                        if (!parsed) {
                            console.error("[PAX AI] INVALID JSON (Unrepairable):", cleanText);
                        }
                    }

                    if (parsed) {
                        if (parsed.schema && typeof parsed.schema === "object") {
                            cleanText = JSON.stringify(parsed.schema);
                        }
                        console.log("%c[PAX AI] JSON VALID.", "color: lime");
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

                var resultResponse = { body: responseBody, status: 200, headers: { "Content-Type": "application/json" } };
                if (resolveInflight) resolveInflight(resultResponse);
                if (reqKey) delete _inflightRequests[reqKey];

                return new unsafeWindow.Response(responseBody, {
                    status: 200,
                    headers: { "Content-Type": "application/json" }
                });

            } catch (e) {
                console.error("[PAX AI] Critical Failure:", e);
                if (settings.provider === 'vertex' || streamingRequest) {
                    const failure = {
                        body: JSON.stringify({ error: e.message || "Vertex AI request failed" }),
                        status: e.status >= 400 && e.status < 600 ? e.status : 502,
                        headers: { "Content-Type": "application/json" }
                    };
                    if (resolveInflight) resolveInflight(failure);
                    if (reqKey) delete _inflightRequests[reqKey];
                    return new unsafeWindow.Response(failure.body, { status: failure.status, headers: failure.headers });
                }
                if (rejectInflight) rejectInflight(e);
                if (reqKey) delete _inflightRequests[reqKey];
                return originalFetch(url, options);
            }
        }
        return originalFetch(url, options);
    };
})();
