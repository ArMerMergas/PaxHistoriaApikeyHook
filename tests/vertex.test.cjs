const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { generateKeyPairSync, verify, webcrypto } = require('node:crypto');
const vm = require('node:vm');

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const account = {
    type: 'service_account', project_id: 'test-project', client_email: 'test@test-project.iam.gserviceaccount.com',
    private_key_id: 'test-key', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    token_uri: 'https://untrusted.example/token'
};
const accountJson = JSON.stringify(account);
const source = readFileSync(join(__dirname, '..', 'PaxHistoriaAIHook.user.js'), 'utf8')
    .replace('    ensureIndicator();', '')
    .replace(/\}\)\(\);\s*$/, 'globalThis.api = { loadSettings, saveSettings, getVertexConfig, getVertexAccessToken, requestVertexApi, createSettingsModal, partialChatMessage }; })();');

function harness(overrides = {}, handler) {
    const storage = new Map(Object.entries({ provider: 'vertex', vertexServiceAccountJson: accountJson, ...overrides }));
    const calls = [], originalCalls = [], logs = [], htmls = [], elements = new Map();
    let clock = Date.now();
    class Element {
        constructor() { this.style = {}; this.value = ''; this.listeners = {}; this.files = []; this.children = []; }
        set value(value) { this.inputValue = String(value); }
        get value() { return this.inputValue; }
        set innerHTML(html) {
            this.html = html;
            htmls.push(html);
            for (const match of html.matchAll(/<\w+\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
                const el = new Element();
                el.id = match[2];
                el.value = /\bvalue="([^"]*)"/.exec(match[1])?.[1] || '';
                el.style.display = /display:\s*(\w+)/.exec(match[1])?.[1] || '';
                elements.set(el.id, el);
            }
            for (const match of html.matchAll(/<select\b[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
                const selected = /<option\b[^>]*value="([^"]*)"[^>]*selected/.exec(match[2]);
                elements.get(match[1]).value = selected?.[1] || /value="([^"]*)"/.exec(match[2])?.[1] || '';
            }
        }
        setAttribute(name, value) { this[name] = value; }
        addEventListener(event, listener) { this.listeners[event] = listener; }
        async fire(event) { return this.listeners[event]({ target: this, currentTarget: this }); }
        appendChild(child) { child.parentNode = this; this.children.push(child); if (child.id) elements.set(child.id, child); }
        remove() { elements.delete(this.id); this.removed = true; }
        querySelector() { return { textContent: '' }; }
    }
    const context = vm.createContext({
        crypto: webcrypto, TextEncoder, TextDecoder, AbortController, URLSearchParams, Uint8Array, Response,
        btoa: value => Buffer.from(value, 'binary').toString('base64'),
        atob: value => Buffer.from(value, 'base64').toString('binary'),
        Date: class extends Date { static now() { return clock; } },
        console: Object.fromEntries(['log', 'warn', 'error'].map(level => [level, (...args) => logs.push(args)])),
        setTimeout: fn => queueMicrotask(fn),
        document: { body: new Element(), getElementById: id => elements.get(id) || null, querySelector: () => null, querySelectorAll: () => [], createElement: () => new Element() },
        getComputedStyle: () => ({ display: 'flex' }),
        window: { location: { href: 'https://paxhistoria.co/games/test' } },
        GM_getValue: (key, fallback) => storage.has(key) ? storage.get(key) : fallback,
        GM_setValue: (key, value) => storage.set(key, value),
        GM_registerMenuCommand() {},
        GM_xmlhttpRequest(options) {
            calls.push(options);
            Promise.resolve().then(() => handler ? handler(options, calls) :
                options.url.includes('oauth2') ? { access_token: 'token-' + calls.filter(call => call.url.includes('oauth2')).length, expires_in: 3600 } :
                    { candidates: [{ content: { parts: [{ text: 'OK' }] } }] })
                .then(result => {
                    if (result.stream) options.onloadstart({ status: result.status || 200, response: result.stream });
                    else options.onload({ status: result.status || 200, responseText: JSON.stringify(result.data || result) });
                })
                .catch(error => options.onerror(error));
            return { abort() { options.onabort?.(); } };
        },
        unsafeWindow: { Response, ReadableStream, fetch: async (...args) => { originalCalls.push(args); return new Response('original'); } }
    });
    vm.runInContext(source, context);
    return {
        ...context.api, storage, calls, originalCalls, logs, htmls, elements,
        advance: ms => { clock += ms; },
        chat: (payload, signal) => context.unsafeWindow.fetch('/api/simple-chat', { body: JSON.stringify(payload), signal }),
        field: id => elements.get('ph-' + id),
        tokens: () => calls.filter(call => call.url.includes('oauth2')),
        requests: () => calls.filter(call => call.url.includes('aiplatform')),
        preview: () => context.document.body.children.findLast(el => el['aria-label'] === 'Live chat reply')
    };
}

test('signs a valid RS256 JWT and sends a form-encoded OAuth exchange to Google', async () => {
    const h = harness();
    assert.equal(await h.getVertexAccessToken(h.loadSettings()), 'token-1');
    const request = h.tokens()[0];
    assert.equal(request.url, 'https://oauth2.googleapis.com/token');
    assert.equal(request.headers['Content-Type'], 'application/x-www-form-urlencoded');
    const form = new URLSearchParams(request.data);
    assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
    const jwt = form.get('assertion').split('.');
    const header = JSON.parse(Buffer.from(jwt[0], 'base64url'));
    const claims = JSON.parse(Buffer.from(jwt[1], 'base64url'));
    assert.deepEqual(header, { alg: 'RS256', typ: 'JWT', kid: 'test-key' });
    assert.equal(claims.iss, account.client_email);
    assert.equal(claims.scope, 'https://www.googleapis.com/auth/cloud-platform');
    assert.equal(claims.aud, request.url);
    assert.equal(claims.exp - claims.iat, 3600);
    assert(verify('RSA-SHA256', Buffer.from(jwt.slice(0, 2).join('.')), publicKey, Buffer.from(jwt[2], 'base64url')));
    assert(!JSON.stringify(h.logs).includes(form.get('assertion')));
    assert(!JSON.stringify(h.logs).includes(account.private_key));
    assert(![...h.storage.values()].includes('token-1'));
});

test('shares concurrent token requests, caches tokens, and renews before expiry', async () => {
    const h = harness(), settings = h.loadSettings();
    assert.deepEqual(await Promise.all([h.getVertexAccessToken(settings), h.getVertexAccessToken(settings)]), ['token-1', 'token-1']);
    assert.equal(h.tokens().length, 1);
    h.advance(3500 * 1000);
    assert.equal(await h.getVertexAccessToken(settings), 'token-1');
    h.advance(50 * 1000);
    assert.equal(await h.getVertexAccessToken(settings), 'token-2');
});

test('credential replacement and clearing invalidate the cached account', async () => {
    const h = harness();
    await h.getVertexAccessToken(h.loadSettings());
    h.saveSettings({ ...h.loadSettings(), vertexServiceAccountJson: JSON.stringify({ ...account, client_email: 'other@example.com' }) });
    assert.equal(await h.getVertexAccessToken(h.loadSettings()), 'token-2');
    h.saveSettings({ ...h.loadSettings(), provider: 'google', vertexServiceAccountJson: '' });
    await assert.rejects(h.getVertexAccessToken(h.loadSettings()), /valid service account JSON/);
});

test('builds global and regional endpoints and accepts a project override', () => {
    const h = harness({ vertexModel: 'gemini-2.5-flash' }), settings = h.loadSettings();
    assert.equal(h.getVertexConfig(settings).url, 'https://aiplatform.googleapis.com/v1/projects/test-project/locations/global/publishers/google/models/gemini-2.5-flash:generateContent');
    assert.equal(h.getVertexConfig({ ...settings, vertexProjectId: 'other-project', vertexLocation: 'europe-west4' }).url,
        'https://europe-west4-aiplatform.googleapis.com/v1/projects/other-project/locations/europe-west4/publishers/google/models/gemini-2.5-flash:generateContent');
    for (const invalid of [{ vertexProjectId: '../project' }, { vertexLocation: 'evil.example/path' }, { vertexModel: 'claude-sonnet' }, { vertexThinkingBudget: -2 }, { vertexThinkingBudget: 0.5 }]) {
        assert.throws(() => h.getVertexConfig({ ...settings, ...invalid }), /Vertex AI|Gemini/);
    }
});

test('rejects malformed credentials and private keys before making HTTP requests', async () => {
    for (const json of ['', '{}', JSON.stringify({ ...account, type: 'authorized_user' }), JSON.stringify({ ...account, private_key: 'bad' }),
        JSON.stringify({ ...account, private_key: '-----BEGIN PRIVATE KEY-----\nYWJj\n-----END PRIVATE KEY-----\n' })]) {
        const h = harness({ vertexServiceAccountJson: json });
        await assert.rejects(h.getVertexAccessToken(h.loadSettings()), /Vertex AI/);
        assert.equal(h.calls.length, 0);
    }
});

test('refreshes once on a 401 and retries generation with the new token', async () => {
    let generated = 0, authorized = 0;
    const h = harness({}, request => request.url.includes('oauth2') ? { access_token: 'token-' + ++authorized, expires_in: 3600 } :
        ++generated === 1 ? { status: 401, data: { error: { message: 'expired' } } } : { candidates: [{ content: { parts: [{ text: 'OK' }] } }] });
    assert.equal((await h.chat({ prompt: 'hello', promptStage: 'chatWithUser' })).status, 200);
    assert.deepEqual(h.requests().map(call => call.headers.Authorization), ['Bearer token-1', 'Bearer token-2']);
    assert.equal(h.tokens().length, 2);
    assert.equal(h.originalCalls.length, 0);
});

test('retries transient generation failures, but does not retry permission failures', async () => {
    let generated = 0;
    const h = harness({}, request => request.url.includes('oauth2') ? { access_token: 'token', expires_in: 3600 } :
        ++generated < 3 ? { status: 429, data: { error: { message: 'quota' } } } : { candidates: [{ content: { parts: [{ text: 'OK' }] } }] });
    assert.equal((await h.chat({ prompt: 'retry' })).status, 200);
    assert.equal(h.requests().length, 3);
    const denied = harness({}, request => request.url.includes('oauth2') ? { access_token: 'token', expires_in: 3600 } :
        { status: 403, data: { error: { message: 'permission denied' } } });
    const response = await denied.chat({ prompt: 'denied' });
    assert.equal(response.status, 403);
    assert.match((await response.json()).error, /permission denied/);
    assert.equal(denied.requests().length, 1);
    assert.equal(denied.originalCalls.length, 0);
});

test('OAuth failures clear pending requests and transient failures have bounded retries', async () => {
    const h = harness({}, () => ({ status: 503, data: { error: 'unavailable' } }));
    await assert.rejects(h.getVertexAccessToken(h.loadSettings()), /unavailable/);
    assert.equal(h.tokens().length, 3);
    await assert.rejects(h.getVertexAccessToken(h.loadSettings()), /unavailable/);
    assert.equal(h.tokens().length, 6);
    const invalid = harness({}, () => ({ access_token: 'token', expires_in: 'invalid' }));
    await assert.rejects(invalid.getVertexAccessToken(invalid.loadSettings()), /invalid OAuth token response/);
});

test('chat joins text parts, excludes thoughts, and does not require an AI Studio key', async () => {
    const h = harness({ vertexModel: 'gemini-2.5-flash', vertexThinkingBudget: 0 }, request => request.url.includes('oauth2') ? { access_token: 'token', expires_in: 3600 } :
        { candidates: [{ content: { parts: [{ text: 'private thought', thought: true }, { text: 'Hello ' }, { text: 'world' }] } }] });
    const response = await h.chat({ prompt: 'hello', promptStage: 'chatWithUser' });
    assert.deepEqual(await response.json(), { message: 'Hello world' });
    const body = JSON.parse(h.requests()[0].data);
    assert.equal(body.contents[0].role, 'user');
    assert.equal(body.generationConfig.thinkingConfig.thinkingBudget, 0);
    assert.equal(h.originalCalls.length, 0);
});

test('Gemini 3 uses default thinking instead of the Gemini 2.5 budget', async () => {
    const h = harness({ vertexModel: 'gemini-3-flash-preview' });
    await h.chat({ prompt: 'hello' });
    assert.equal(JSON.parse(h.requests()[0].data).generationConfig.thinkingConfig, undefined);
});

test('action schema conversion, schema fallback and game response formatting work together', async () => {
    let generated = 0;
    const h = harness({}, request => request.url.includes('oauth2') ? { access_token: 'token', expires_in: 3600 } :
        ++generated === 1 ? { status: 400, data: { error: { message: 'schema rejected' } } } :
            { candidates: [{ content: { parts: [{ text: '```json\n{"message":"done","events":[]}\n```' }] } }] });
    const jsonSchema = { name: 'action', schema: { type: 'object', properties: { message: { type: ['string', 'null'] }, events: { type: 'array', items: { type: 'string' } } }, additionalProperties: false } };
    const response = await h.chat({ prompt: 'act', jsonSchema });
    assert.deepEqual(await response.json(), { message: 'done', events: [] });
    const first = JSON.parse(h.requests()[0].data), fallback = JSON.parse(h.requests()[1].data);
    assert.equal(first.generationConfig.responseSchema.properties.message.nullable, true);
    assert.equal(first.generationConfig.responseSchema.additionalProperties, undefined);
    assert.equal(fallback.generationConfig.responseSchema, undefined);
    assert.equal(fallback.generationConfig.responseMimeType, 'application/json');
    assert.match(fallback.contents[0].parts[0].text, /matching this schema/);
    assert.deepEqual(jsonSchema.schema.properties.message.type, ['string', 'null']);
});

test('blocked responses and duplicate failures return errors without a game backend request', async () => {
    const h = harness({}, request => request.url.includes('oauth2') ? { access_token: 'token', expires_in: 3600 } :
        { promptFeedback: { blockReason: 'SAFETY' } });
    const responses = await Promise.all([h.chat({ prompt: 'blocked' }), h.chat({ prompt: 'blocked' })]);
    for (const response of responses) {
        assert.equal(response.status, 502);
        assert.match((await response.json()).error, /SAFETY/);
    }
    assert.equal(h.requests().length, 1);
    assert.equal(h.originalCalls.length, 0);
});

test('settings keep the saved key out of HTML, preserve it on save, and allow clearing', async () => {
    const h = harness();
    h.createSettingsModal();
    const html = h.htmls.join('');
    assert(!html.includes(account.private_key));
    assert.equal(h.field('vertex-service-account-json').value, '');
    assert.equal(h.field('api-key-container').style.display, 'none');
    h.field('vertex-thinking-budget').value = '0';
    await h.field('save-btn').fire('click');
    assert.equal(h.storage.get('vertexServiceAccountJson'), accountJson);
    assert.equal(h.storage.get('vertexThinkingBudget'), 0);
    h.createSettingsModal();
    await h.field('vertex-clear-btn').fire('click');
    await h.field('save-btn').fire('click');
    assert(!h.elements.has('ph-ai-settings-modal'));
    assert.equal(h.storage.get('vertexServiceAccountJson'), '');
});

test('file import and pasted keys are validated, and cancel discards imported credentials', async () => {
    const h = harness();
    h.createSettingsModal();
    const replacement = JSON.stringify({ ...account, client_email: 'replacement@example.com' });
    h.field('vertex-service-account-file').files = [{ text: async () => replacement }];
    await h.field('vertex-service-account-file').fire('change');
    assert.match(h.field('vertex-account-status').textContent, /replacement@example.com/);
    await h.field('cancel-btn').fire('click');
    assert.equal(h.storage.get('vertexServiceAccountJson'), accountJson);
    h.createSettingsModal();
    h.field('vertex-service-account-json').value = 'invalid JSON';
    await h.field('save-btn').fire('click');
    assert(h.elements.has('ph-ai-settings-modal'));
    assert.equal(h.storage.get('vertexServiceAccountJson'), accountJson);
    h.field('vertex-service-account-json').value = replacement;
    await h.field('save-btn').fire('click');
    assert.equal(h.storage.get('vertexServiceAccountJson'), replacement);
});

test('connection test uses unsaved settings and validates the model response', async () => {
    const h = harness();
    h.createSettingsModal();
    h.field('vertex-project').value = 'draft-project';
    await h.field('test-vertex-btn').fire('click');
    assert.match(h.requests()[0].url, /projects\/draft-project\//);
    assert.match(h.field('vertex-status').textContent, /OK/);
    assert.equal(h.field('test-vertex-btn').disabled, false);
    assert.equal(h.storage.get('vertexProjectId'), undefined);
});

test('Google AI Studio and OpenAI still route with their original credentials', async () => {
    const google = harness({ provider: 'google', apiKey: 'studio-key', modelName: 'gemini-2.5-flash', thinkingBudget: 4096 }, () => ({ candidates: [{ content: { parts: [{ text: 'studio' }] } }] }));
    assert.deepEqual(await (await google.chat({ prompt: 'hello' })).json(), { message: 'studio' });
    assert.match(google.calls[0].url, /generativelanguage.googleapis.com.*key=studio-key/);
    assert.equal(JSON.parse(google.calls[0].data).generationConfig.thinkingConfig.thinkingBudget, 4096);
    const openai = harness({ provider: 'openai', apiKey: 'openai-key' }, () => ({ choices: [{ message: { content: 'openai' } }] }));
    assert.deepEqual(await (await openai.chat({ prompt: 'hello' })).json(), { message: 'openai' });
    assert.equal(openai.calls[0].url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(openai.calls[0].headers.Authorization, 'Bearer openai-key');
});

test('the legacy shared key migrates only to its current provider', () => {
    const h = harness({ provider: 'google', apiKey: 'legacy-google-key' });
    assert.equal(h.loadSettings().apiKey, 'legacy-google-key');
    assert.equal(h.storage.get('providerApiKeys').google, 'legacy-google-key');
    h.storage.set('provider', 'openai');
    assert.equal(h.loadSettings().apiKey, '');
    h.storage.set('provider', 'google');
    assert.equal(h.loadSettings().apiKey, 'legacy-google-key');
    const cleared = harness({ provider: 'google', apiKey: 'legacy-key', providerApiKeys: { google: '' } });
    assert.equal(cleared.loadSettings().apiKey, '');
});

test('switching providers restores individual drafts and Save persists all edited keys', async () => {
    const h = harness({ provider: 'google', apiKey: 'google-key' });
    h.createSettingsModal();
    h.field('api-key').value = 'edited-google-key';
    h.field('provider').value = 'openai';
    await h.field('provider').fire('change');
    assert.equal(h.field('api-key').value, '');
    h.field('api-key').value = 'openai-key';
    h.field('provider').value = 'google';
    await h.field('provider').fire('change');
    assert.equal(h.field('api-key').value, 'edited-google-key');
    h.field('provider').value = 'groq';
    await h.field('provider').fire('change');
    assert.equal(h.field('api-key').value, '');
    h.field('provider').value = 'openai';
    await h.field('provider').fire('change');
    assert.equal(h.field('api-key').value, 'openai-key');
    await h.field('save-btn').fire('click');
    assert.equal(h.storage.get('providerApiKeys').google, 'edited-google-key');
    assert.equal(h.storage.get('providerApiKeys').openai, 'openai-key');
    assert.equal(h.loadSettings().apiKey, 'openai-key');
    h.createSettingsModal();
    assert.equal(h.field('api-key').value, 'openai-key');
    h.field('provider').value = 'google';
    await h.field('provider').fire('change');
    assert.equal(h.field('api-key').value, 'edited-google-key');
});

test('Cancel discards key drafts and clearing one key preserves the other providers', async () => {
    const h = harness({ provider: 'google', providerApiKeys: { google: 'google-key', openai: 'openai-key' }, apiKey: 'legacy-key' });
    h.createSettingsModal();
    h.field('api-key').value = 'unsaved-key';
    h.field('provider').value = 'openai';
    await h.field('provider').fire('change');
    await h.field('cancel-btn').fire('click');
    assert.equal(h.storage.get('providerApiKeys').google, 'google-key');
    assert.equal(h.storage.get('provider'), 'google');
    h.createSettingsModal();
    assert.equal(h.field('api-key').value, 'google-key');
    h.field('api-key').value = '';
    await h.field('save-btn').fire('click');
    assert.equal(h.loadSettings().apiKey, '');
    assert.equal(h.storage.get('providerApiKeys').openai, 'openai-key');
});

test('local, Generic and Vertex providers preserve saved cloud keys', async () => {
    const h = harness({ provider: 'google', apiKey: 'google-key', genericApiKey: 'generic-key' });
    h.createSettingsModal();
    for (const provider of ['vertex', 'ollama', 'lmstudio', 'copilot', 'generic']) {
        h.field('provider').value = provider;
        await h.field('provider').fire('change');
        assert.equal(h.field('api-key').value, '');
        assert.equal(h.field('api-key-container').style.display, 'none');
    }
    assert.equal(h.field('generic-api-key').value, 'generic-key');
    await h.field('save-btn').fire('click');
    assert.equal(h.storage.get('providerApiKeys').google, 'google-key');
    assert.equal(h.storage.get('genericApiKey'), 'generic-key');
    assert.equal(h.storage.get('vertexServiceAccountJson'), accountJson);
});

test('all API-key providers use their own stored credentials for actual requests', async () => {
    const providers = ['google', 'openrouter', 'openai', 'groq', 'together', 'fireworks', 'mistral', 'anthropic', 'deepseek'];
    const keys = Object.fromEntries(providers.map(provider => [provider, provider + '-key']));
    const h = harness({ provider: 'google', providerApiKeys: keys, apiKey: 'obsolete-shared-key' }, request =>
        request.url.includes('generativelanguage') ? { candidates: [{ content: { parts: [{ text: 'OK' }] } }] } :
            request.url.includes('anthropic') ? { content: [{ type: 'text', text: 'OK' }] } :
                { choices: [{ message: { content: 'OK' } }] });
    for (const provider of providers) {
        h.storage.set('provider', provider);
        const response = await h.chat({ prompt: provider, promptStage: 'chatWithUser' });
        assert.equal(response.status, 200);
        const request = h.calls.at(-1);
        if (provider === 'google') assert.match(request.url, /key=google-key/);
        else if (provider === 'anthropic') assert.equal(request.headers['x-api-key'], 'anthropic-key');
        else assert.equal(request.headers.Authorization, 'Bearer ' + provider + '-key');
    }
});

for (const provider of ['google', 'vertex']) {
    for (const level of ['default', 'LOW', 'MEDIUM', 'HIGH']) {
        test(`Gemini 3.8 ${provider} sends ${level} without a legacy budget`, async () => {
            const h = harness({
                provider, apiKey: 'studio-key', modelName: 'gemini-3.8-flash', vertexModel: 'gemini-3.8-flash',
                thinkingLevel: level, vertexThinkingLevel: level, thinkingBudget: -2, vertexThinkingBudget: -2
            }, request => request.url.includes('oauth2') ? { access_token: 'token', expires_in: 3600 } :
                { candidates: [{ content: { parts: [{ text: 'first ' }, { text: 'answer' }, { text: 'summary', thought: true }] } }] });
            const response = await h.chat({ prompt: 'hello', promptStage: 'chatWithUser' });
            assert.deepEqual(await response.json(), { message: 'first answer' });
            const config = JSON.parse(h.calls.at(-1).data).generationConfig;
            assert.deepEqual(config.thinkingConfig, level === 'default' ? undefined : { thinkingLevel: level });
            assert.equal(h.originalCalls.length, 0);
        });
    }
}

test('model changes show thinking levels or budgets and preserve separate provider choices', async () => {
    const h = harness({
        provider: 'google', apiKey: 'studio-key', modelName: 'gemini-3.8-flash', vertexModel: 'gemini-3.8-flash',
        thinkingLevel: 'HIGH', vertexThinkingLevel: 'LOW'
    });
    h.createSettingsModal();
    assert.equal(h.field('thinking-level').value, 'HIGH');
    assert.equal(h.field('vertex-thinking-level').value, 'LOW');
    assert.equal(h.field('google-thinking-level-fields').style.display, 'block');
    assert.equal(h.field('google-thinking-budget-fields').style.display, 'none');
    assert.equal(h.field('vertex-thinking-level-fields').style.display, 'block');
    h.field('model-name').value = 'gemini-2.5-flash';
    await h.field('model-name').fire('input');
    assert.equal(h.field('google-thinking-level-fields').style.display, 'none');
    assert.equal(h.field('google-thinking-budget-fields').style.display, 'block');
    h.field('thinking-budget').value = '0';
    await h.field('save-btn').fire('click');
    assert.equal(h.loadSettings().thinkingBudget, 0);
    assert.equal(h.loadSettings().thinkingLevel, 'HIGH');
    assert.equal(h.loadSettings().vertexThinkingLevel, 'LOW');
    h.createSettingsModal();
    h.field('model-name').value = 'gemini-3.8-flash';
    await h.field('model-name').fire('change');
    assert.equal(h.field('thinking-level').value, 'HIGH');
    assert.equal(h.field('google-thinking-level-fields').style.display, 'block');
    h.field('vertex-thinking-level').value = 'MEDIUM';
    await h.field('cancel-btn').fire('click');
    assert.equal(h.loadSettings().vertexThinkingLevel, 'LOW');
});

test('Vertex connection test and schema fallback retain the selected Gemini 3.8 level', async () => {
    let generated = 0;
    const h = harness({ vertexModel: 'gemini-3.8-flash' }, request => request.url.includes('oauth2') ? { access_token: 'token', expires_in: 3600 } :
        ++generated === 2 ? { status: 400, data: { error: { message: 'schema rejected' } } } :
            { candidates: [{ content: { parts: [{ text: '{"message":"done","events":[]}' }] } }] });
    h.createSettingsModal();
    h.field('vertex-thinking-level').value = 'HIGH';
    await h.field('test-vertex-btn').fire('click');
    assert.equal(JSON.parse(h.requests()[0].data).generationConfig.thinkingConfig.thinkingLevel, 'HIGH');
    await h.field('save-btn').fire('click');
    assert.equal(h.loadSettings().vertexThinkingLevel, 'HIGH');
    h.createSettingsModal();
    assert.equal(h.field('vertex-thinking-level').value, 'HIGH');
    const response = await h.chat({ prompt: 'act', jsonSchema: { type: 'object', properties: { message: { type: 'string' }, events: { type: 'array', items: { type: 'string' } } } } });
    assert.deepEqual(await response.json(), { message: 'done', events: [] });
    assert.equal(h.requests().length, 3);
    for (const request of h.requests()) assert.deepEqual(JSON.parse(request.data).generationConfig.thinkingConfig, { thinkingLevel: 'HIGH' });
});

test('Gemini 2.5 sends its budget alone even with a saved Gemini 3 level', async () => {
    for (const provider of ['google', 'vertex']) {
        for (const budget of [-1, 0, 4096]) {
            const h = harness({
                provider, apiKey: 'studio-key', modelName: 'gemini-2.5-flash', vertexModel: 'gemini-2.5-flash',
                thinkingBudget: budget, vertexThinkingBudget: budget, thinkingLevel: 'HIGH', vertexThinkingLevel: 'HIGH'
            }, request => request.url.includes('oauth2') ? { access_token: 'token', expires_in: 3600 } : { candidates: [{ content: { parts: [{ text: 'OK' }] } }] });
            assert.equal((await h.chat({ prompt: 'hello' })).status, 200);
            assert.deepEqual(JSON.parse(h.calls.at(-1).data).generationConfig.thinkingConfig, { thinkingBudget: budget });
        }
    }
});

test('invalid thinking levels stop requests and saving without changing existing settings', async () => {
    const h = harness({ vertexModel: 'gemini-3.8-flash', vertexThinkingLevel: 'MINIMAL' });
    const response = await h.chat({ prompt: 'invalid level' });
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /thinking level/);
    assert.equal(h.calls.length, 0);
    const google = harness({ provider: 'google', apiKey: 'studio-key', modelName: 'gemini-3.8-flash' });
    google.createSettingsModal();
    google.field('thinking-level').value = 'MINIMAL';
    await google.field('save-btn').fire('click');
    assert.match(google.field('google-thinking-status').textContent, /thinking level/);
    assert(google.elements.has('ph-ai-settings-modal'));
    assert.equal(google.loadSettings().thinkingLevel, 'default');
});

const chatSchema = { type: 'object', properties: { message: { type: 'string' }, leaveChat: { type: ['string', 'null'] } }, required: ['message'] };
function sse(text, finishReason, thought = false) {
    return new TextEncoder().encode('data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ text, thought }] }, ...(finishReason ? { finishReason } : {}) }] }) + '\r\n\r\n');
}
function finiteStream(...chunks) {
    return new ReadableStream({ start(controller) { chunks.forEach(chunk => controller.enqueue(chunk)); controller.close(); } });
}
async function until(predicate) {
    for (let attempt = 0; attempt < 300; attempt++) {
        if (predicate()) return;
        await new Promise(resolve => setImmediate(resolve));
    }
    assert.fail('Timed out waiting for mocked stream');
}

for (const provider of ['google', 'vertex']) {
    test(`${provider} delivers JSON chunks and live preview before completion, preserving leaveChat`, async () => {
        let input;
        const stream = new ReadableStream({ start(controller) { input = controller; } });
        const h = harness({ provider, apiKey: 'studio-key', modelName: 'gemini-3.8-flash', vertexModel: 'gemini-3.8-flash', thinkingLevel: 'HIGH', vertexThinkingLevel: 'HIGH' }, request =>
            request.url.includes('oauth2') ? { access_token: 'token', expires_in: 3600 } : { stream });
        const payload = { prompt: 'hello', promptStage: 'chatWithUser', stream: true, jsonSchema: chatSchema };
        const response = await h.chat(payload);
        assert.equal(response.status, 200);
        const duplicate = h.chat(payload);
        const reader = response.body.getReader();
        const firstRead = reader.read();
        await until(() => h.calls.some(call => call.responseType === 'stream'));
        input.enqueue(sse('hidden thoughts', undefined, true));
        const first = sse('{"message":"Прив');
        for (const byte of first) input.enqueue(Uint8Array.of(byte));
        const firstChunk = await firstRead;
        assert.equal(new TextDecoder().decode(firstChunk.value), '{"message":"Прив');
        assert.equal(h.preview().children[2].textContent, 'Прив');
        assert(!h.preview().removed);
        const request = h.calls.at(-1);
        assert.match(request.url, /:streamGenerateContent\?alt=sse$/);
        assert.equal(request.responseType, 'stream');
        const config = JSON.parse(request.data).generationConfig;
        assert.deepEqual(config.thinkingConfig, { thinkingLevel: 'HIGH' });
        assert.equal(config.responseMimeType, 'application/json');
        if (provider === 'google') {
            assert(!request.url.includes('studio-key'));
            assert.equal(request.headers['x-goog-api-key'], 'studio-key');
        } else assert.equal(request.headers.Authorization, 'Bearer token');
        input.enqueue(sse('ет\\n\\"мир\\"","leaveChat":"Ушёл"}', 'STOP'));
        input.close();
        let all = new TextDecoder().decode(firstChunk.value);
        for (;;) { const chunk = await reader.read(); if (chunk.done) break; all += new TextDecoder().decode(chunk.value); }
        assert.deepEqual(JSON.parse(all), { message: 'Привет\n"мир"', leaveChat: 'Ушёл' });
        assert.deepEqual(await (await duplicate).json(), JSON.parse(all));
        assert.equal(h.calls.filter(call => call.responseType === 'stream').length, 1);
        assert(h.preview().removed);
        assert.equal(h.originalCalls.length, 0);
    });
}

test('streaming plain chat escapes chunks into the existing message wrapper', async () => {
    const h = harness({}, request => request.url.includes('oauth2') ? { access_token: 'token', expires_in: 3600 } :
        { stream: finiteStream(sse('Hello "'), sse('world"\n😀', 'STOP')) });
    const response = await h.chat({ prompt: 'hello', promptStage: 'chatWithUser', stream: true });
    assert.deepEqual(await response.json(), { message: 'Hello "world"\n😀' });
});

test('Vertex streaming refreshes a rejected token once before emitting text', async () => {
    let attempts = 0;
    const h = harness({}, request => request.url.includes('oauth2') ? { access_token: 'token-' + ++attempts, expires_in: 3600 } :
        attempts === 1 ? { status: 401, stream: finiteStream(new TextEncoder().encode('{"error":{"message":"expired"}}')) } :
            { stream: finiteStream(sse('OK', 'STOP')) });
    assert.deepEqual(await (await h.chat({ prompt: 'hello', promptStage: 'chatWithUser', stream: true })).json(), { message: 'OK' });
    assert.equal(h.tokens().length, 2);
    assert.equal(h.requests().length, 2);
});

for (const [name, result, expected] of [
    ['HTTP permission failure', () => ({ status: 403, stream: finiteStream(new TextEncoder().encode('{"error":{"message":"denied"}}')) }), /denied/],
    ['blocked response', () => ({ stream: finiteStream(new TextEncoder().encode('data: {"promptFeedback":{"blockReason":"SAFETY"}}\n\n')) }), /SAFETY/],
    ['connection closing without finish reason', () => ({ stream: finiteStream(sse('partial')) }), /before generation completed/],
    ['truncated model output', () => ({ stream: finiteStream(sse('partial', 'MAX_TOKENS')) }), /MAX_TOKENS/],
    ['invalid chat JSON', () => ({ stream: finiteStream(sse('{"message":', 'STOP')) }), /JSON/],
    ['missing streaming support', () => ({ candidates: [] }), /Update Tampermonkey/]
]) {
    test(`stream ${name} fails without retries or fallback to the game backend`, async () => {
        const h = harness({ provider: 'google', apiKey: 'studio-key' }, result);
        const response = await h.chat({ prompt: 'hello', promptStage: 'chatWithUser', stream: true, jsonSchema: chatSchema });
        await assert.rejects(response.text(), expected);
        assert.equal(h.originalCalls.length, 0);
        assert.equal(h.calls.length, 1);
        assert.match(h.preview().children[1].textContent, /^Ошибка:/);
    });
}

test('AbortSignal cancels an active provider stream and clears inflight state', async () => {
    const h = harness({ provider: 'google', apiKey: 'studio-key' }, () => ({ stream: new ReadableStream() }));
    const abort = new AbortController();
    const payload = { prompt: 'hello', promptStage: 'chatWithUser', stream: true };
    const response = await h.chat(payload, abort.signal);
    const read = response.text();
    await until(() => h.calls.length === 1);
    abort.abort();
    await assert.rejects(read, { name: 'AbortError' });
    assert.equal(h.preview().children[1].textContent, 'Генерация отменена');
    const secondAbort = new AbortController();
    const second = await h.chat(payload, secondAbort.signal);
    const secondRead = second.text();
    await until(() => h.calls.length === 2);
    secondAbort.abort();
    await assert.rejects(secondRead, { name: 'AbortError' });
    assert.equal(h.originalCalls.length, 0);
});

test('cancelling the returned body aborts generation without an unhandled rejection', async () => {
    const h = harness({ provider: 'google', apiKey: 'studio-key' }, () => ({ stream: new ReadableStream() }));
    const response = await h.chat({ prompt: 'hello', promptStage: 'chatWithUser', stream: true });
    await until(() => h.calls.length === 1);
    await response.body.cancel();
    await until(() => h.preview().children[1].textContent === 'Генерация отменена');
    assert.equal(h.originalCalls.length, 0);
});

test('partial message preview decodes escapes and waits for incomplete sequences', () => {
    const h = harness();
    assert.equal(h.partialChatMessage('{"message":"Hi\\n\\"😀\\"\\u041f\\u04'), 'Hi\n"😀"П');
    assert.equal(h.partialChatMessage('{"message":"Hi\\'), 'Hi');
    assert.equal(h.partialChatMessage('{"message":"Hi","leaveChat":"bye"}'), 'Hi');
});

test('actions, advisor and other providers stay buffered; streaming preference is saved', async () => {
    for (const payload of [{ promptStage: 'jumpForward', stream: true, jsonSchema: chatSchema }, { promptStage: 'chatWithAdvisor', stream: true, jsonSchema: chatSchema }, { promptStage: 'chatWithUser' }]) {
        const h = harness();
        await h.chat({ prompt: 'hello', ...payload });
        assert(h.requests().every(call => !call.responseType));
    }
    const h = harness();
    h.createSettingsModal();
    assert.equal(h.field('stream-chats').checked, true);
    h.field('stream-chats').checked = false;
    await h.field('save-btn').fire('click');
    assert.equal(h.loadSettings().streamChats, false);
    await h.chat({ prompt: 'hello', promptStage: 'chatWithUser', stream: true });
    assert(h.requests().every(call => !call.responseType));
    const openai = harness({ provider: 'openai', apiKey: 'key' }, () => ({ choices: [{ message: { content: 'OK' } }] }));
    assert.deepEqual(await (await openai.chat({ prompt: 'hello', promptStage: 'chatWithUser', stream: true })).json(), { message: 'OK' });
    assert(!openai.calls[0].responseType);
});

test('invalid streaming settings return an error without using the game backend', async () => {
    const h = harness({ provider: 'google', apiKey: 'key', modelName: 'gemini-3.8-flash', thinkingLevel: 'invalid' });
    const response = await h.chat({ prompt: 'hello', promptStage: 'chatWithUser', stream: true });
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /thinking level/);
    assert.equal(h.calls.length, 0);
    assert.equal(h.originalCalls.length, 0);
});

test('already aborted streaming requests do not start an OAuth or model request', async () => {
    for (const provider of ['google', 'vertex']) {
        const h = harness({ provider, apiKey: 'key' });
        const abort = new AbortController();
        abort.abort();
        const response = await h.chat({ prompt: 'hello', promptStage: 'chatWithUser', stream: true }, abort.signal);
        await assert.rejects(response.text(), { name: 'AbortError' });
        assert.equal(h.calls.length, 0);
    }
});

test('requests with the same metadata prefix and length are not falsely deduplicated', async () => {
    const h = harness({ provider: 'google', apiKey: 'key' }, () => ({ stream: finiteStream(sse('OK', 'STOP')) }));
    const base = { gameID: 'x'.repeat(130), promptStage: 'chatWithUser', stream: true };
    const responses = await Promise.all([h.chat({ ...base, prompt: 'A' }), h.chat({ ...base, prompt: 'B' })]);
    await Promise.all(responses.map(response => response.text()));
    assert.equal(h.calls.length, 2);
});

test('a network error after a text delta errors the response without issuing another request', async () => {
    let input;
    const h = harness({ provider: 'google', apiKey: 'key' }, () => ({ stream: new ReadableStream({ start(controller) { input = controller; } }) }));
    const response = await h.chat({ prompt: 'hello', promptStage: 'chatWithUser', stream: true });
    const reader = response.body.getReader();
    await until(() => h.calls.length === 1);
    input.enqueue(sse('partial'));
    assert.equal(new TextDecoder().decode((await reader.read()).value), '{"message":"');
    assert.equal(new TextDecoder().decode((await reader.read()).value), 'partial');
    h.calls[0].onerror();
    await assert.rejects(reader.read(), /network error/);
    assert.equal(h.calls.length, 1);
    assert.equal(h.originalCalls.length, 0);
});
