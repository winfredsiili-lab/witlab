# AI Provider Decision

Decided during Batch 4 (October 2026). **Provider: Groq free tier. Model: `openai/gpt-oss-120b`.** The integration is a generic OpenAI-compatible chat client with a configurable base URL, key and model, so changing provider is a configuration change, not a code change.

## What was checked (and where)

| item | finding | source |
|---|---|---|
| Groq free-plan models and limits | `openai/gpt-oss-120b`, `openai/gpt-oss-20b`, `qwen/qwen3.8-27b`: **30 requests/min, 1,000 requests/day, 8K tokens/min, 200K tokens/day**. No credit card needed | https://console.groq.com/docs/rate-limits |
| Structured output | `openai/gpt-oss-120b` supports `response_format: json_schema` including `strict: true` (constrained decoding) | https://console.groq.com/docs/structured-outputs |
| Gemini free tier | Models exist and are free, but the docs give **no numeric free limits**, and every free-tier model is marked "Content used to improve our products" | https://ai.google.dev/gemini-api/docs/pricing , https://ai.google.dev/gemini-api/docs/rate-limits |
| Other options | OpenRouter free models: about 50 requests/day. Mistral's free experiment tier requires opting in to training. Cerebras: about 1M tokens/day | https://openrouter.ai/blog/tutorials/free-llm-apis-compared/ |

## Why Groq

1. **Privacy.** Learners paste their own study material. Gemini's free tier explicitly uses content to improve Google's products. No such term was found for Groq.
2. **Known limits.** Groq publishes concrete numbers; Gemini's free numbers were not published in the docs.
3. **Strict JSON.** Constrained decoding makes malformed output rare (we still validate everything).
4. **Reversible.** OpenAI-compatible endpoints are offered by Groq, OpenRouter, Cerebras, Mistral and Gemini, so the same adapter works with any of them.

## NOT verified. Check before relying on it

- **Groq's data-handling terms for the free plan.** The data-controls page could not be fetched here. Read https://console.groq.com/docs/data-controls and the terms of service before real learners use the app.
- **The live call.** No API key was available during development, so the adapter is tested against a local server that imitates the documented response format, not against Groq itself. First live test: set `AI_API_KEY`, generate cards from a small source, and read the job's error message if it fails.
- **Limits drift.** These numbers were read in October 2026 and providers change free tiers often. The account's limits page is authoritative.
- The rate-limits page was ambiguous about which column is the free plan; the numbers above are the base limits shown, which match third-party reports for the free plan.

## How the limits shape the design

- **8K tokens per minute** is the tightest limit. One generation request sends the source text, instructions and a schema, and receives the cards. To stay well under it, the text read in one generation is capped at **12,000 characters (about 3,000 tokens)** and output at **2,500 tokens**, and reasoning is set to `low`. A larger selection is refused with a message asking the learner to narrow it (a smaller section or page range), never silently truncated.
- **1,000 requests per day** is shared by everyone using the app's key. The app caps itself below that: **20 generations per user per day** and **500 per day in total** (both configurable), counted from the `generation_jobs` table. The user sees a clear message when a cap is reached.
- **429 and other provider errors** are reported to the learner honestly (including "try again in N seconds" when the provider says so). The job is recorded as failed, no cards are created, and the source is untouched.
- **Cost if moved to a paid tier**: not applicable on the free tier. When changing provider, re-check pricing and update this document.

## Written-answer evaluation (Batch 6b)

The same provider judges written answers (Explain, Connections, Apply). A request sends the question, model answer, criteria, up to three source passages and the learner's answer (as delimited data), and asks for a verdict plus structured feedback, with at most 900 output tokens. The learner's confidence is never sent. The prompt version is stored with every result (`EVAL_PROMPT_VERSION`). **Judgement quality has not been tried against a real model**; expect to tune the prompt once a key is available. Failures never produce a verdict: see `LEARNING_ENGINE.md`.

## Configuration

| variable | default | meaning |
|---|---|---|
| `AI_API_KEY` | none | secret; backend only. Without it, generation answers `503 ai_not_configured` and everything else keeps working |
| `AI_BASE_URL` | `https://api.groq.com/openai/v1` | any OpenAI-compatible endpoint |
| `AI_MODEL` | `openai/gpt-oss-120b` | model id |
| `AI_STRICT_SCHEMA` | `true` | `false` falls back to plain JSON mode for models without strict schema support |
| `AI_REASONING_EFFORT` | `low` | `low`, `medium`, `high` or `off`. `off` sends no reasoning parameter, for models that reject it |
| `AI_TIMEOUT_MS` | `45000` | per request |
| `GENERATION_DAILY_LIMIT` | `20` | per user per 24 hours |
| `GENERATION_GLOBAL_DAILY_LIMIT` | `500` | all users per 24 hours |
| `EVALUATION_DAILY_LIMIT` | `60` | AI-judged written answers per user per 24 hours. Failed attempts count: they use provider quota |
| `EVALUATION_GLOBAL_DAILY_LIMIT` | `300` | all users per 24 hours. Generation and evaluation share the provider's 1,000 requests/day, so keep `GENERATION_GLOBAL_DAILY_LIMIT + EVALUATION_GLOBAL_DAILY_LIMIT` below it |
