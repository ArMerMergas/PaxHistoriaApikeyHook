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
    .replace(/\}\)\(\);\s*$/, 'globalThis.api = { loadSettings, saveSettings, getVertexConfig, getVertexAccessToken, requestVertexApi, createSettingsModal }; })();');

function harness(overrides = {}, handler) {
    const storage = new Map(Object.entries({ provider: 'vertex', vertexServiceAccountJson: accountJson, ...overrides }));
    const calls = [], originalCalls = [], logs = [], htmls = [], elements = new Map();
    let clock = Date.now();
    class Element {
        constructor() { this.style = {}; this.value = ''; this.listeners = {}; this.files = []; }
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
        addEventListener(event, listener) { this.listeners[event] = listener; }
        async fire(event) { return this.listeners[event]({ target: this, currentTarget: this }); }
        appendChild(child) { child.parentNode = this; if (child.id) elements.set(child.id, child); }
        remove() { elements.delete(this.id); }
        querySelector() { return { textContent: '' }; }
    }
    const context = vm.createContext({
        crypto: webcrypto, TextEncoder, URLSearchParams, Uint8Array, Response,
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
                .then(result => options.onload({ status: result.status || 200, responseText: JSON.stringify(result.data || result) }))
                .catch(error => options.onerror(error));
        },
        unsafeWindow: { Response, fetch: async (...args) => { originalCalls.push(args); return new Response('original'); } }
    });
    vm.runInContext(source, context);
    return {
        ...context.api, storage, calls, originalCalls, logs, htmls, elements,
        advance: ms => { clock += ms; },
        chat: payload => context.unsafeWindow.fetch('/api/simple-chat', { body: JSON.stringify(payload) }),
        field: id => elements.get('ph-' + id),
        tokens: () => calls.filter(call => call.url.includes('oauth2')),
        requests: () => calls.filter(call => call.url.includes('aiplatform'))
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
    const h = harness(), settings = h.loadSettings();
    assert.equal(h.getVertexConfig(settings).url, 'https://aiplatform.googleapis.com/v1/projects/test-project/locations/global/publishers/google/models/gemini-2.5-flash:generateContent');
    assert.equal(h.getVertexConfig({ ...settings, vertexProjectId: 'other-project', vertexLocation: 'europe-west4' }).url,
        'https://europe-west4-aiplatform.googleapis.com/v1/projects/other-project/locations/europe-west4/publishers/google/models/gemini-2.5-flash:generateContent');
    for (const invalid of [{ vertexProjectId: '../project' }, { vertexLocation: 'evil.example/path' }, { vertexModel: 'claude-sonnet' }, { vertexThinkingBudget: -2 }, { vertexThinkingBudget: 0.5 }]) {
        assert.throws(() => h.getVertexConfig({ ...settings, ...invalid }), /Vertex AI/);
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
    const h = harness({ vertexThinkingBudget: 0 }, request => request.url.includes('oauth2') ? { access_token: 'token', expires_in: 3600 } :
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
    const google = harness({ provider: 'google', apiKey: 'studio-key' }, () => ({ candidates: [{ content: { parts: [{ text: 'studio' }] } }] }));
    assert.deepEqual(await (await google.chat({ prompt: 'hello' })).json(), { message: 'studio' });
    assert.match(google.calls[0].url, /generativelanguage.googleapis.com.*key=studio-key/);
    assert.equal(JSON.parse(google.calls[0].data).generationConfig.thinkingConfig.thinking_budget, 4096);
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
