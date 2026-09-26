import os from "node:os";
import path from "node:path";
import type { EngineConfig } from "./schema.js";

/**
 * Built-in defaults. Endpoint lists and price tables live here as DATA so that
 * nothing model-specific is hard-coded in the engine logic. Users override any
 * of this in config.local.json.
 */
export function defaultConfig(): EngineConfig {
  return {
    homeDir: path.join(os.homedir(), ".multi-model-team"),
    providers: {
      endpoints: [
        {
          id: "anthropic",
          providerId: "anthropic",
          displayName: "Anthropic (Claude)",
          baseUrl: "https://api.anthropic.com",
          protocol: "anthropic",
          envKeys: ["ANTHROPIC_API_KEY"],
        },
        {
          id: "openai",
          providerId: "openai",
          displayName: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
          protocol: "openai-responses",
          envKeys: ["OPENAI_API_KEY"],
        },
        {
          id: "xai",
          providerId: "xai",
          displayName: "xAI (Grok)",
          baseUrl: "https://api.x.ai/v1",
          protocol: "openai-responses",
          envKeys: ["XAI_API_KEY"],
        },
        {
          id: "zai-general",
          providerId: "zai",
          displayName: "Z.AI (GLM) general",
          baseUrl: "https://api.z.ai/api/paas/v4",
          protocol: "openai-chat",
          envKeys: ["ZAI_API_KEY", "ZHIPU_API_KEY"],
        },
        {
          id: "zai-coding",
          providerId: "zai",
          displayName: "Z.AI (GLM) coding plan",
          baseUrl: "https://api.z.ai/api/coding/paas/v4",
          protocol: "openai-chat",
          envKeys: ["ZAI_API_KEY", "ZHIPU_API_KEY", "ZAI_CODING_API_KEY"],
        },
        {
          id: "zai-cn",
          providerId: "zai",
          displayName: "Z.AI (GLM) mainland China (bigmodel.cn)",
          baseUrl: "https://open.bigmodel.cn/api/paas/v4",
          protocol: "openai-chat",
          envKeys: ["ZAI_API_KEY", "ZHIPU_API_KEY", "BIGMODEL_API_KEY"],
        },
        {
          id: "moonshot",
          providerId: "moonshot",
          displayName: "Moonshot (Kimi) international",
          baseUrl: "https://api.moonshot.ai/v1",
          protocol: "openai-chat",
          envKeys: ["MOONSHOT_API_KEY", "KIMI_API_KEY"],
        },
        {
          id: "moonshot-cn",
          providerId: "moonshot",
          displayName: "Moonshot (Kimi) China",
          baseUrl: "https://api.moonshot.cn/v1",
          protocol: "openai-chat",
          envKeys: ["MOONSHOT_API_KEY", "KIMI_API_KEY"],
        },
      ],
      extraCompatible: [],
      allowProbes: true,
      cacheTtlHours: 24,
      excludeModels: ["embedding", "tts", "whisper", "dall-e", "image", "audio", "realtime", "moderation", "transcribe", "search-preview", "babbage", "davinci", "computer-use"],
    },
    pricing: {},
    capabilityHints: {},
    pipeline: {
      maxDiscussionRounds: 6,
      maxMeetingRounds: 3,
      stallLimit: 3,
      maxToolIterations: 25,
      contextBudgetTokens: 60_000,
      minMembers: 2,
      defaultReasoning: "medium",
      maxTokensPerCall: 8192,
      callTimeoutMs: 300_000,
      retries: 3,
    },
    cost: { capUsd: null },
    safety: {
      maxResourceFraction: 0.6,
      heavyRamMb: 2048,
      commandTimeoutMs: 600_000,
      hardRssLimitMb: 0,
      heavyCommandPatterns: [
        "\\b(npm|pnpm|yarn|bun)\\s+(install|i|ci|add)\\b",
        "\\bpip3?\\s+install\\b",
        "\\b(cargo|go|dotnet|mvn|gradle|make|cmake|ninja)\\s+(build|install|test)?\\b",
        "\\bdocker\\b",
        "\\b(python3?|torch|accelerate|ollama|llama|vllm)\\b.*\\b(train|finetune|fine-tune|serve|run)\\b",
        "\\bwget\\b|\\bcurl\\b.*\\s-[oO]\\b",
        "\\bffmpeg\\b",
      ],
      destructivePatterns: [
        "\\brm\\s+(-[a-zA-Z]*[rf][a-zA-Z]*\\s+)+",
        "\\brmdir\\b",
        "\\b(del|erase|rd)\\s+(/[sq]\\s+)+",
        "Remove-Item\\b",
        "\\bmkfs\\b|\\bdiskutil\\s+erase|\\bformat\\s+[a-z]:",
        "\\b(sudo|doas)\\b",
        "\\b(apt(-get)?|brew|choco|winget|dnf|yum|pacman)\\s+(remove|uninstall|purge)\\b",
        "\\b(npm|pnpm|yarn|pip3?)\\s+(uninstall|remove)\\s+(-g|--global)",
        "\\bgit\\s+(push\\s+.*--force|reset\\s+--hard|clean\\s+-[a-z]*f)",
        "\\bdefaults\\s+write\\b|\\breg\\s+(add|delete)\\b|\\bsystemctl\\b|\\blaunchctl\\b",
        "\\bchmod\\s+(-R\\s+)?[0-7]*777\\b|\\bchown\\s+-R\\b",
        ">\\s*/dev/sd|\\bdd\\s+if=",
        "\\bkill(all)?\\s+-9\\b|\\btaskkill\\b",
        "\\bshutdown\\b|\\breboot\\b",
      ],
    },
    search: { provider: "mock", envKey: "SEARCH_API_KEY", maxResults: 5 },
    ui: { host: "127.0.0.1", port: 4310, openBrowser: true },
    workTypes: { extraDirs: [] },
  };
}
