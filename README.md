# AI Radio Station

AI Radio Station is a source-first experiment for an AI-hosted music station: chat with a host persona, analyze the conversation mood, generate a playlist prompt, and synthesize short host voiceovers for the listening experience.

This public version is intentionally cleaned for open source:

- No real API keys, cookies, session tokens, or request captures are included
- No generated audio, local databases, or private snapshots are shipped
- Real third-party integrations must be configured by the user in their own local environment

## Who This Is For

- Developers exploring AI-native media or companion experiences
- Builders who want a small Next.js + Fastify example with optional LLM and TTS providers
- Teams experimenting with private Suno workflows on their own credentials

## What Works Out Of The Box

Without any external credentials, you can still:

- run the frontend and backend locally
- use the UI and API surface
- fall back to non-network host voice placeholders when TTS providers are unavailable

To get real model-backed chat, real TTS, or direct Suno generation, you must provide your own credentials and local request templates.

## Tech Stack

- Frontend: Next.js 15, React 19, TypeScript
- Backend: Fastify 5, Node.js ESM
- Optional LLM providers: DeepSeek, OpenAI-compatible APIs, MiniMax
- Optional TTS providers: MiniMax, ByteDance OpenSpeech, Edge
- Optional music generation: direct Suno request flow from user-supplied local template

## Project Structure

```text
ai-radio-station/
├── apps/
│   ├── api/              # Fastify backend
│   └── web/              # Next.js frontend
├── data/
│   ├── demo-chat-history.example.json
│   └── manual-generate-request.example.json
├── .env.example
└── package.json
```

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Create your local environment file

```bash
cp .env.example .env
```

The default template is safe for local development and does not contain any real secrets.

### 3. Start the backend

```bash
npm run dev:api
```

### 4. Start the frontend

In a second terminal:

```bash
npm run dev:web
```

### 5. Open the app

Visit [http://localhost:3000](http://localhost:3000).

## Configuration Modes

### Minimal local mode

Recommended for first run.

- Keep `AI_LLM_PROVIDER=deepseek` with no key, or switch providers later
- Keep `AI_TTS_PROVIDER=mock`
- Keep `SUNO_ENABLE_REAL=false`

This lets you boot the app safely without shipping or exposing any private credentials.

### Real LLM chat

Choose one provider and add only the matching credentials.

DeepSeek:

```env
AI_LLM_PROVIDER=deepseek
DEEPSEEK_API_KEY=your_key_here
```

OpenAI-compatible:

```env
AI_LLM_PROVIDER=openai
OPENAI_API_KEY=your_key_here
OPENAI_CHAT_BASE_URL=https://api.openai.com
OPENAI_MODEL=gpt-4o-mini
```

MiniMax:

```env
AI_LLM_PROVIDER=minimax
MINIMAX_API_KEY=your_key_here
MINIMAX_CHAT_BASE_URL=https://api.minimaxi.com
MINIMAX_CHAT_MODEL=MiniMax-M2.7
```

### Real host TTS

MiniMax:

```env
AI_TTS_PROVIDER=minimax
MINIMAX_API_KEY=your_key_here
MINIMAX_TTS_BASE_URL=https://api.minimaxi.com
MINIMAX_TTS_MODEL=speech-2.8-hd
```

ByteDance / OpenSpeech:

```env
AI_TTS_PROVIDER=bytedance
BYTEDANCE_TTS_API_KEY=your_key_here
BYTEDANCE_TTS_RESOURCE_ID=seed-tts-2.0
```

### Real Suno generation

This repository does not include a reusable Suno token, cookie, browser token, or request capture.

To enable real Suno generation locally:

1. Set `SUNO_ENABLE_REAL=true` in `.env`
2. Copy [`data/manual-generate-request.example.json`](./data/manual-generate-request.example.json) to `data/manual-generate-request.json`
3. Fill that local file with your own fresh request values
4. Optionally set `SUNO_AUTHORIZATION`, `SUNO_BROWSER_TOKEN`, `SUNO_SESSION_TOKEN`, or related env vars if you prefer env-based overrides

If those values are missing or invalid, the backend will not use the direct Suno flow.

## Example Files

- [`data/demo-chat-history.example.json`](./data/demo-chat-history.example.json): safe example conversation payload
- [`data/manual-generate-request.example.json`](./data/manual-generate-request.example.json): redacted shape of the local Suno request template

## API Endpoints

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/health` | GET | Health check |
| `/api/chat` | POST | Chat with the radio host |
| `/api/chat/analyze` | POST | Analyze mood and music direction |
| `/api/playlist/from-chat` | POST | Analyze chat and generate a playlist request |
| `/api/playlist/generate` | POST | Generate a playlist |
| `/api/playlist/current` | GET | Read the current in-memory playlist |
| `/api/host/voice` | POST | Generate host voice audio |
| `/api/audio/music/:trackId` | GET | Stream track audio |
| `/api/audio/generated/:filename` | GET | Stream generated local audio |

## Notes For Publishing

If you want to publish this project as a brand-new public GitHub repository, use a clean repository root created from this sanitized working tree rather than exposing older local Git history that may contain private artifacts.

## License

MIT
