# RB Code

An AI coding agent that runs in the browser, with optional local executors that touch real files and run real commands.

[中文说明](README.zh.md)

## What it does

- Chat with an LLM (OpenAI-compatible or Anthropic API) and let it read, edit and create files in a project.
- Runs shell commands; anything destructive asks for approval first, and file changes can be reverted or undone.
- Three execution backends: browser sandbox (file tools only), Windows desktop companion, Android app.
- Long sessions compact their own history, so the context stays usable.
- Mermaid diagrams, LaTeX math, syntax-highlighted code, built-in terminals.
- Voice input and read-aloud of replies.
- Several themes (dark, light, aurora, OreUI).

## Repository layout

| Path | What it is |
| --- | --- |
| `web/` | The web app (React + Vite) and the Cloudflare Worker that serves it |
| `companion/` | Desktop executor for Windows (Tauri + Rust) |
| `android/` | Android app (Java, with a Linux environment for shell commands) |

## Getting started

Web app:

```
cd web
npm install
npm run dev
```

Open the app, then add a provider and an API key under Settings > Model providers and pick a model.

Desktop executor (Windows):

```
cd companion
npm install
npm run tauri:dev
```

Build an installer with `powershell -File build.ps1`. Then paste the token shown in its window under Settings > Execution backend.

Android app:

```
cd android
gradle assembleRelease
```

The Linux root filesystem is not shipped here. Put an arm64 `ubuntu-base-*.tar.gz` and the Termux `proot` and dependency packages under `android/linux-assets/` before building. Release signing expects your own keystore at `android/app/keystore.properties`.

## License

AGPL-3.0-or-later; see [LICENSE](LICENSE).

Third-party components keep their own licenses and are listed in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
