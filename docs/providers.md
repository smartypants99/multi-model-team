# Provider facts and the reasoning mapping

Collected from the official docs on 2026-09-26. Model names and parameters
change often; the engine discovers models live and only uses this file's
tables as hints, but adapters are built from the wire formats below.

## Common reasoning scale

`none | low | medium | high | xhigh | max`. Each model advertises which of
these it supports (`ReasoningControl`); the UI/CLI offer only those.

| Provider | Native control | Mapping |
|---|---|---|
| Anthropic (effort models) | `output_config.effort` = low/medium/high/xhigh/max; `thinking: {type:"adaptive", display:"summarized"}` | 1:1; `none` → `thinking.type:"disabled"` only where the models endpoint says `thinking.types.enabled`/disable is allowed, otherwise not offered |
| Anthropic (Haiku 4.5 and older) | `thinking: {type:"enabled", budget_tokens}` | budget: low 2048, medium 8192, high 16384, xhigh 24000, max 32000; `none` → `{type:"disabled"}` |
| OpenAI (Responses) | `reasoning: {effort, summary:"auto"}` | 1:1 with the model's allowed set (`none` rejected by gpt-6-astra) |
| xAI (Responses) | `reasoning: {effort}` | set from `/v1/models` `capabilities.reasoning_effort`; reasoning cannot be disabled on grok-4.5+ |
| Z.AI | `thinking: {type: enabled/disabled}` (+ `reasoning_effort` on GLM-5.2+) | toggle models: `none` → disabled, others → enabled; level models: low/medium/high/max (xhigh treated as max); GLM-5.3 cannot disable |
| Moonshot | kimi-k3: `reasoning_effort` low/high/max; kimi-k2.6: `thinking: {type}`; k2.7-code: always on | levels 1:1 where present (medium → low, xhigh → max); toggle as Z.AI |

## Anthropic — Messages API

- `POST https://api.anthropic.com/v1/messages`, headers `x-api-key`,
  `anthropic-version: 2023-06-01`, `content-type: application/json`.
- Body: `model`, `max_tokens`, `system` (string or text blocks), `messages`
  (alternating user/assistant; last must be user), `tools`
  (`{name, description, input_schema}`), `tool_choice: {type:"auto"}` only
  (`any`/`tool` return 400 on Fable 5.1 / Opus 5.5), `thinking`,
  `output_config: {effort}`. Do not send temperature (400 on Claude 5).
- Tool loop: echo the entire assistant `content` array back verbatim
  (including `thinking`/`redacted_thinking` blocks), then a user message with
  `{type:"tool_result", tool_use_id, content, is_error?}` blocks.
- Thinking: Claude 5 family and Opus 5.5 are always on, `disabled` → 400,
  `budget_tokens` → 400. Sonnet 5 accepts `disabled`. Haiku 4.5 needs
  `{type:"enabled", budget_tokens ≥ 1024}` and rejects `adaptive`/effort.
  Default `display` on Claude 5 is `omitted` (empty thinking text); ask for
  `display:"summarized"` to get readable summaries. Raw chain of thought is
  never returned.
- Response: `content[]` of `text | tool_use{id,name,input} | thinking | redacted_thinking`,
  `stop_reason: end_turn|max_tokens|tool_use|refusal|pause_turn|...`,
  `usage: {input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens_details.thinking_tokens}`.
- Models: `GET /v1/models?limit=1000` → `data[]: {id, display_name, created_at, max_input_tokens, max_tokens, capabilities: {image_input.supported, effort.{supported,low,medium,high,xhigh,max}, thinking.types.{adaptive,enabled}}}`.
- Errors: JSON `{type:"error", error:{type,message}}`; 401 authentication_error,
  429 rate_limit_error (+ `retry-after`), 529 overloaded_error, 500 api_error.
- Pricing ($/M in/out): fable-5-1 10/50, opus-5-5 4/20, opus-5 5/25, sonnet-5 2/10,
  sonnet-4-6 3/15, haiku-4-5 1/5. Context 1M (Haiku 200K), output 128K (Haiku 64K).

## OpenAI — Responses API

- `POST https://api.openai.com/v1/responses`, `Authorization: Bearer`.
- Body: `model`, `instructions` (system), `input[]` of
  `{role, content}` messages and `{type:"function_call_output", call_id, output}`,
  `tools[]` flat `{type:"function", name, description, parameters}`,
  `reasoning: {effort, summary:"auto"}`, `max_output_tokens`, `store:false`,
  `include:["reasoning.encrypted_content"]`. No temperature when reasoning.
- Output items: `message{content:[{type:"output_text",text}]}`,
  `function_call{call_id,name,arguments(json string)}`,
  `reasoning{summary:[{type:"summary_text",text}], encrypted_content}` (pass
  reasoning items back in `input` on the next turn of a tool loop).
- Images: `{type:"input_image", image_url:"data:image/png;base64,..."}` inside a user message content array.
- Usage: `input_tokens, output_tokens, output_tokens_details.reasoning_tokens, input_tokens_details.cached_tokens`.
- Models: `GET /v1/models` gives only ids → capabilities from the hint table.
  Effort sets: gpt-6-astra low..max (no none); gpt-6-sol/luna, gpt-5.6-*
  none..max; gpt-5.5 none..xhigh; gpt-5.4* none..xhigh; o-series low/medium/high; gpt-4.1* none.
- Pricing ($/M): gpt-6-astra 10/50, gpt-6-sol 2/10, gpt-6-luna 0.10/0.50, gpt-5.6-sol 4/20,
  gpt-5.5 5/30, gpt-5.4 2.5/15, gpt-5.4-mini 0.75/4.5, gpt-5.1 1.25/10, gpt-4.1 2/8, o3 2/8, o4-mini 1.1/4.4.
- Errors: `{error:{message,type,code}}`; headers `x-ratelimit-*`, `retry-after`.

## xAI — Responses API (OpenAI-compatible clone)

- `POST https://api.x.ai/v1/responses`, same shapes as OpenAI (`reasoning:{effort}`,
  `include:["reasoning.encrypted_content"]`). Chat completions is legacy.
- `GET /v1/models` → `data[]: {id, aliases, context_length, prompt_text_token_price,
  cached_prompt_text_token_price, completion_text_token_price, capabilities:{reasoning_effort:[...], default_reasoning_effort}}`.
  Prices are USD cents per 100M tokens → divide by 10 000 for $/M.
  `GET /v1/language-models` adds `input_modalities` (vision when it contains "image").
- Models: grok-4.7 / 4.6 (500K, low..xhigh), grok-4.5 (low..high), grok-4.3 (1M, none..xhigh),
  grok-4.20-*, grok-build-0.1. Reasoning cannot be disabled on 4.5+.
- Do not send presence/frequency penalties or stop to reasoning models.

## Z.AI (GLM) — chat completions

- General `https://api.z.ai/api/paas/v4/chat/completions`; coding plan
  `https://api.z.ai/api/coding/paas/v4/...` (coding-plan keys only work
  there); mainland `https://open.bigmodel.cn/api/paas/v4`.
- Body: OpenAI chat shape; `tools` (function), `tool_choice:"auto"` only,
  `max_tokens`, `thinking:{type:"enabled"|"disabled", clear_thinking?}`,
  `reasoning_effort` (GLM-5.2+: low/high/max; 5.2 also medium…).
  GLM-5.3 / 5.3-flash: thinking forced (disabled → error).
- Response `choices[0].message.{content, reasoning_content, tool_calls}`;
  echo `reasoning_content` back on assistant messages in tool loops.
- Models list is undocumented but answers on every endpoint, even for keys
  that cannot be used there (verified live: a coding-plan key lists models on
  the general endpoint but completions fail with HTTP 429 code 1113
  "insufficient balance or no resource package"). The probe therefore sends a
  1-token completion to the first *paid* model in
  `config.providers.fallbackModels.zai` and treats that 429 as "key not valid
  on this endpoint". Free models (glm-4.5-flash) answer everywhere, so they
  come last in the list.
- Errors `{error:{code:"1302", message}}`; 429 codes 1113 balance, 1302 rate, 1305 overloaded.
- Pricing ($/M): glm-5.3 1.4/4.4, glm-5.3-flash 0.15/0.5, glm-5.2 1.4/4.4, glm-5 1/3.2, glm-4.7 0.6/2.2,
  glm-4.6 0.6/2.2, glm-4.5 0.6/2.2, glm-4.5-air 0.2/1.1, glm-4.6v 0.3/0.9 (vision), glm-4.5v 0.6/1.8 (vision).
- Vision: `{type:"image_url", image_url:{url}}` parts on glm-*v and 5.3-flash.

## Moonshot (Kimi) — chat completions

- `https://api.moonshot.ai/v1/chat/completions` (China: api.moonshot.cn).
- `GET /v1/models` → `data[]: {id, context_length, supports_image_in, supports_video_in, supports_reasoning}`.
- kimi-k3: `reasoning_effort` low/high/max (default max), no `thinking` param, vision.
  kimi-k2.6: `thinking:{type:"enabled"|"disabled"}`, vision. kimi-k2.7-code: always on.
  Do not send temperature. Use `max_completion_tokens` (≥ 16000 recommended).
- `reasoning_content` must be sent back verbatim in tool loops.
- Images: base64 data URLs only.
- Pricing ($/M): kimi-k3 3/15, kimi-k2.7-code 0.95/4, kimi-k2.7-code-highspeed 1.9/8, kimi-k2.6 0.95/4.
- Errors `{error:{type,message}}`; 429 carries `X-RateLimit-*` headers.
