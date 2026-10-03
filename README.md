# Pax Historia: Custom AI Backend Hook

Tampermonkey userscript that replaces **Pax Historia**'s default AI backend with multiple providers. Use your own API keys or local proxies (Ollama, LM Studio, Copilot API) for AI chats and actions.

## Supported Providers

| Provider | API Key | Description |
|----------|---------|-------------|
| **Google AI Studio** | Yes | Gemini (including Thinking models) |
| **Vertex AI** | Service account JSON | Gemini via Google Cloud, with automatic OAuth token refresh |
| **OpenRouter** | Yes | Multiple models via [openrouter.ai](https://openrouter.ai) |
| **OpenAI** | Yes | Direct OpenAI API (GPT-4, etc.) |
| **Groq** | Yes | Fast inference, free tier available |
| **Ollama** | No | Local models at `http://localhost:11434` |
| **LM Studio** | No | Local models at `http://localhost:1234` |
| **Together AI** | Yes | Open and fine-tuned models |
| **Fireworks AI** | Yes | Fast inference API |
| **Mistral AI** | Yes | Mistral models |
| **Anthropic (Claude)** | Yes | Claude models |
| **DeepSeek** | Yes | DeepSeek models |
| **Copilot API** | No | Local proxy via [copilot-api](https://github.com/caozhiyuan/copilot-api) |
| **Generic** | Optional | Any OpenAI-compatible API (custom Base URL) |

## Features

- **14 providers**: Google, Vertex AI, OpenRouter, OpenAI, Groq, Ollama, LM Studio, Together, Fireworks, Mistral, Anthropic, DeepSeek, Copilot, Generic
- **Vertex AI service accounts**: Import a JSON key, choose a project/region, and test the selected Gemini model; OAuth tokens refresh automatically
- **Separate provider keys**: Switching providers restores their own API keys. Save keeps keys edited during the session; Cancel discards those edits. The existing shared key migrates to the currently selected API-key provider.
- **Connection test**: Verifies Base URL for Copilot, LM Studio, Ollama, Generic before saving
- **Model selector**: Auto-loads models from local proxies (Copilot, LM Studio)
- **Gemini thinking controls**: Default / LOW / MEDIUM / HIGH for Gemini 3 (including 3.8) in Google AI Studio and Vertex AI; token budgets for Gemini 2.5
- **Indicator badge**: Shows current provider and model in the header (click to open settings)
- **Privacy**: Prompts go to your chosen provider, not the game's default backend

## Installation

1. Install **Tampermonkey** in your browser (Chrome, Firefox, Edge).
2. Create a new script in Tampermonkey.
3. Copy and paste the contents of `PaxHistoriaAIHook.user.js`.
4. Save (Ctrl+S).

## Configuration

1. Open [Pax Historia](https://paxhistoria.co).
2. Click **Tampermonkey** icon and select **"Open AI Settings"**, or click the indicator badge in the header.
3. Choose provider and configure:

### Google AI Studio
- **API Key**: [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey)
- **Model**: e.g. `gemini-3.8-flash`
- **Thinking Level (Gemini 3)**: Default, LOW, MEDIUM or HIGH. Default omits `thinkingLevel` and uses the model's own setting (`MEDIUM` for Gemini 3.8 Flash). Explicit levels are sent as `generationConfig.thinkingConfig.thinkingLevel`, with no legacy token budget. See [Google's thinking guide](https://ai.google.dev/gemini-api/docs/generate-content/thinking?hl=en).
- **Thinking Budget (Gemini 2.5)**: `-1` by default (automatic). The form switches between a level selector and a token budget when you change the model.

### Vertex AI (Gemini / service account)

1. Select or create a Google Cloud project, enable billing, and enable the **Vertex AI API** (`aiplatform.googleapis.com`). See [Google's setup guide](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/start/quickstart).
2. In [IAM & Admin → Service Accounts](https://console.cloud.google.com/iam-admin/serviceaccounts), create a service account and grant it **Vertex AI User** (`roles/aiplatform.user`) on the project used for requests.
3. Open the account's **Keys → Add key → Create new key → JSON** and download the key. See [Google's service account guide](https://developers.google.com/identity/protocols/oauth2/service-account#creatinganaccount).
4. In the script's AI Settings, choose **Vertex AI (Gemini / service account)** and import the JSON file, or paste its contents.
5. Leave **Project ID** empty to use `project_id` from the JSON, or enter another project where the account has the required role. Set **Location** to `global` or a supported region such as `us-central1`, and enter a **Gemini model ID**, such as `gemini-3.8-flash` (default: `gemini-3.5-flash`). Model availability varies by location; see [Google's endpoint list](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/learn/locations).
6. Use **Test connection** to send a short request to that model, then click **Save**. The test uses Google Cloud quota and may incur usage charges.

The script signs an RS256 JWT using the browser's Web Crypto API, exchanges it for a Google OAuth access token, and refreshes it before expiry. No proxy or manual token copying is needed. Gemini chat and structured JSON actions use the same game response format as Google AI Studio.

- **Thinking Level (Gemini 3, including 3.8)**: Default, LOW, MEDIUM or HIGH. Gemini 3.8 Flash uses `MEDIUM` by default. Selecting a level sends `generationConfig.thinkingConfig.thinkingLevel`; the numeric budget is omitted. Settings are saved separately from Google AI Studio and apply to chats, structured actions and Test connection. See [Google's thinking configuration](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/thinking).
- **Thinking Budget (Gemini 2.5)**: `-1` by default (automatic). Use a value supported by your selected model (some models cannot disable thinking with `0`). Only the numeric budget is sent for these models; a saved Gemini 3 level is ignored. Other model versions use their default thinking settings.
- The JSON key is stored in **Tampermonkey storage**. Access tokens stay in memory; the saved private key is not inserted into the settings form when reopened. Treat the JSON as a private credential.
- An empty JSON field keeps the saved account. **Clear account → Save** removes it. **Cancel** discards credential changes.
- This provider supports Google Gemini models; partner models such as Claude on Vertex use a different API and are not included.
- Vertex errors are returned to the game without forwarding the prompt to the game's default backend.

### OpenRouter
- **API Key**: [openrouter.ai/keys](https://openrouter.ai/keys)
- **Model**: e.g. `google/gemini-2.0-flash-thinking-exp:free`

### OpenAI / Groq / Together / Fireworks / Mistral / Anthropic
- **API Key**: From each provider's dashboard
- **Model**: Provider-specific model ID

### Ollama / LM Studio (local)
- **Base URL**: `http://localhost:11434` (Ollama) or `http://localhost:1234` (LM Studio)
- **Model**: Name of loaded model. Use "Test" to list available models (LM Studio).

### Copilot API (no API key)
- **Provider**: Copilot API (local)
- **Base URL**: `http://localhost:4141` 
(default). The [copilot-api](https://github.com/
caozhiyuan/copilot-api) proxy must be running.
- **Model**: Use "Test connection" to load 
models and select one (e.g. `gpt-4.1`, 
`claude-opus-4.6`).

### Generic (OpenAI-compatible)
- **Base URL**: e.g. `https://api.openai.com/v1` or Azure/custom endpoint
- **Model**: Model ID
- **API Key (optional)**: Leave empty for local or public endpoints

5. Save and reload the page.

## Streaming country chats

**Stream chats with live preview** is enabled by default for Google AI Studio and Vertex AI. It applies to country conversations (`chatWithUser`) when the game requests streaming. Gemini's [`streamGenerateContent`](https://ai.google.dev/api/generate-content#method:-models.streamgeneratecontent) SSE response is read through [Tampermonkey's stream API](https://www.tampermonkey.net/documentation.php?q=GM_xmlhttpRequest), and text chunks are forwarded through `Response.body`.

The game's current country-chat parser displays a JSON `message` only after its closing quote. A small live preview shows the message during generation and disappears after success; the completed reply stays in the normal chat. The preview's close button hides it without cancelling generation. JSON replies preserve `leaveChat`, and thinking text is excluded. Actions, advisor calls and other providers keep the existing buffered behavior.

Disable the checkbox in **AI Settings** to return to buffered replies. Streaming requires a Tampermonkey version with `responseType: "stream"` support. Cancellation, an interrupted stream, blocked output or invalid JSON produces an error; a partially streamed request is never retried or forwarded to the game's default backend. A Vertex HTTP 401 refreshes the token once before any text has been emitted.

## Troubleshooting

- **"No events" error**: The model did not return valid JSON. Try a more capable model or increase the thinking budget.
- **Copilot API: Network error or no connection**: Ensure the proxy is running (`npx copilot-api@latest start`) and the Base URL is correct.
- **Script not working**: Check that the script is enabled in Tampermonkey and that you have accepted the requested permissions (including `GM_xmlhttpRequest` for Copilot API).
- **API errors**: Check the browser console (F12) for logs tagged with `[PAX AI]`.
- **Vertex AI: 403**: Check that billing and the Vertex AI API are enabled and the service account has `roles/aiplatform.user` in the selected project.
- **Vertex AI: 404**: Check the Gemini model ID and its availability in the selected location; try `global` if the model supports it.
- **Vertex AI: invalid_grant / invalid JWT**: Reimport a current service account JSON key and check your computer's clock.

## Development checks

With Node.js installed, run `node --check PaxHistoriaAIHook.user.js` and `node --test tests/vertex.test.cjs`. These tests use generated RSA keys and mocked HTTP/browser APIs; they do not call Google Cloud or verify a live Tampermonkey session.

## Disclaimer

This script is for educational and personal use only. Use at your own risk.
