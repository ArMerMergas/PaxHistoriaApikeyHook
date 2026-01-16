# Pax Historia: Custom AI Backend Hook

This Tampermonkey script allows you to replace the default AI backend of **Pax Historia** with your own **Google Gemini** or **OpenRouter** API key. This gives you control over the model used (including Thinking models), saves you money (if using free tiers), and ensures privacy. It basically allows you to use Google Cloud free credits, and use most intelligent AI model, Gemini 3 pro, for free in Pax Historia.

## Features

-   **Custom API Key**: Use your own Google AI Studio or OpenRouter API key.
-   **Model Selection**: Choose any model you want (e.g., `Gemini-3-pro-preview, Gemini-3-flash-preview, etc.`).
-   **Thinking Budget**: Configure the "thinking" budget for Gemini 2.0 Flash Thinking models.
-   **GUI Settings**: Easy-to-use settings menu directly in the game.
-   **Privacy**: Your prompts go directly to Google/OpenRouter, not through third-party proxies.

## Installation

1.  Install the **Tampermonkey** extension for your browser (Chrome, Firefox, Edge, etc.).
2.  Create a new script in Tampermonkey.
3.  Copy and paste the content of `Pax Historia- Gemini 3 Flash Hook-3.0.user.js` into the editor.
4.  Save the script (Ctrl+S).

## Configuration

1.  Open [Pax Historia](https://paxhistoria.co).
2.  Click on the **Tampermonkey extension icon** in your browser toolbar.
3.  You should see a menu item called **"Open AI Settings"**. Click it.
4.  A settings modal will appear:
    -   **Provider**: Select **Google AI Studio** or **OpenRouter**.
    -   **API Key**: Paste your API key here.
        -   Get Google Key: [aistudio.google.com](https://aistudio.google.com/app/apikey)
        -   Get OpenRouter Key: [openrouter.ai/keys](https://openrouter.ai/keys)
    -   **Model Name**: Enter the model ID you want to use.
        -   Default Google: `gemini-2.0-flash-thinking-exp-1219`
        -   Default OpenRouter: `google/gemini-2.0-flash-thinking-exp:free`
    -   **Thinking Budget**: (Google only) Set the token budget for the model's internal thought process (default 4096).
5.  Click **Save**.
6.  Reload the page.

## Troubleshooting

-   **"No events" error**: This usually means the model didn't return valid JSON. Try a "smarter" model or increase the thinking budget.
-   **Script not working**: Make sure the script is enabled in Tampermonkey and that you have granted the necessary permissions (`GM_setValue`, `GM_getValue`, `GM_registerMenuCommand`) if asked.
-   **API Errors**: Check the browser console (F12) for detailed error logs tagged with `[PAX AI]`.

## Disclaimer

This script is for educational purposes and personal use. Use at your own risk.
