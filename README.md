# Lingua · Stable Demo

A browser-based demo for real-time speech recognition and translation. Translation requests are sent through the local Node.js service to the model provider selected in Settings.

## Run locally

Requires Node.js 18 or later. No additional npm dependencies are needed.

```sh
node server.js
```

Then open <http://127.0.0.1:4173/> and configure the model provider, model, and API key in Settings. Speech recognition requires a browser that supports the Web Speech API.

## Diagnostics

Enable diagnostic logging with `?debugSpeech=1`. Logs are written to `logs/diagnostics.jsonl` and may contain recognized speech. The `logs/` directory is excluded by `.gitignore` and is not included in the repository.
