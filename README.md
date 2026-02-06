# Pax Historia: Custom AI Backend Hook

Tampermonkey userscript that replaces **Pax Historia**'s default AI backend with Google Gemini, OpenRouter, or **Copilot API**. Use your own API keys or a local GitHub Copilot proxy (no API key required) for AI chats and actions.

## Supported Providers

| Provider | API Key Required | Description |
|----------|------------------|-------------|
| **Google AI Studio** | Yes | Gemini (including Thinking models) with your own API key |
| **OpenRouter** | Yes | Multiple models via [openrouter.ai](https://openrouter.ai) |
| **Copilot API** | No | Local OpenAI/Anthropic-compatible proxy. Use GitHub Copilot with [copilot-api](https://github.com/caozhiyuan/copilot-api) |

## Features

- **Google Gemini / OpenRouter / Copilot API**: Three configurable providers from the GUI.
- **Copilot API**: No API key; only Base URL (e.g. `http://localhost:4141`). Supports [caozhiyuan/copilot-api](https://github.com/caozhiyuan/copilot-api).
- **Model selector**: With Copilot API, models are loaded automatically from the proxy.
- **Connection test**: Verifies if Copilot API is online before saving.
- **Thinking Budget**: Configurable for Gemini models.
- **Privacy**: Your prompts are sent to your chosen provider, not to the game's default backend.

## Installation

1. Install the **Tampermonkey** extension in your browser (Chrome, Firefox, Edge, etc.).
2. Create a new script in Tampermonkey.
3. Copy and paste the contents of `PaxHistoriaAIHook.user.js` into the editor.
4. Save the script (Ctrl+S).

## Configuration

1. Open [Pax Historia](https://paxhistoria.co).
2. Click the **Tampermonkey** icon in your browser toolbar.
3. Select **"Open AI Settings"**.
4. Configure according to your provider:

### Google AI Studio
- **Provider**: Google AI Studio
- **API Key**: [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey)
- **Model Name**: e.g. `gemini-3-flash-preview`
- **Thinking Budget**: 4096 (recommended)

### OpenRouter
- **Provider**: OpenRouter
- **API Key**: [openrouter.ai/keys](https://openrouter.ai/keys)
- **OpenRouter Model**: e.g. `google/gemini-2.0-flash-thinking-exp:free`

### Copilot API (no API key)
- **Provider**: Copilot API (local)
- **Base URL**: `http://localhost:4141` (default). The [copilot-api](https://github.com/caozhiyuan/copilot-api) proxy must be running.
- **Model**: Use "Test connection" to load models and select one (e.g. `gpt-4.1`, `claude-opus-4.6`).

**Run Copilot API:**
```bash
npx copilot-api@latest start
# or from source:
bun run src/main.ts start
```

5. Save and reload the page.

## Troubleshooting

- **"No events" error**: The model did not return valid JSON. Try a more capable model or increase the thinking budget.
- **Copilot API: Network error or no connection**: Ensure the proxy is running (`npx copilot-api@latest start`) and the Base URL is correct.
- **Script not working**: Check that the script is enabled in Tampermonkey and that you have accepted the requested permissions (including `GM_xmlhttpRequest` for Copilot API).
- **API errors**: Check the browser console (F12) for logs tagged with `[PAX AI]`.

## Disclaimer

This script is for educational and personal use only. Use at your own risk.
