import { MockProvider } from "./mock.js";
import { OpenAIProvider } from "./openai.js";

/**
 * AI Provider Factory - abstraction so provider can be changed via env
 * Uses AI_PROVIDER env: "openai" | "mock" (default: openai if key present, else mock)
 * Also supports OPENAI_API_KEY / AI_API_KEY
 */
export function createAIProvider() {
  const providerName = (process.env.AI_PROVIDER || "").toLowerCase().trim();

  // Explicit mock
  if (providerName === "mock") {
    return new MockProvider();
  }

  // OpenAI-compatible (default)
  if (providerName === "openai" || providerName === "" || providerName === "openai-compatible") {
    const hasKey = !!(process.env.OPENAI_API_KEY || process.env.AI_API_KEY);
    if (!hasKey) {
      // No key configured → use mock but log
      console.warn("[AI] No API key configured (OPENAI_API_KEY / AI_API_KEY), using MockProvider. Set AI_PROVIDER=openai and provide key for real AI.");
      return new MockProvider();
    }
    return new OpenAIProvider();
  }

  // Future providers could be added here: anthropic, gemini, etc.
  console.warn(`[AI] Unknown provider "${providerName}", falling back to MockProvider`);
  return new MockProvider();
}

// Singleton for reuse
let singleton = null;
export function getAIProvider() {
  if (!singleton) singleton = createAIProvider();
  return singleton;
}

// For testing: allow reset
export function _resetAIProvider() {
  singleton = null;
}
