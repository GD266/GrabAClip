import { AIProvider } from "./provider.js";

const DEFAULT_MODEL = process.env.OPENAI_MODEL || process.env.AI_MODEL || "gpt-4o-mini";
const DEFAULT_BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";

/**
 * OpenAI-compatible provider (works for OpenAI, Groq, OpenRouter, etc. with baseUrl override)
 */
export class OpenAIProvider extends AIProvider {
  constructor(options = {}) {
    super();
    this.apiKey = options.apiKey || process.env.OPENAI_API_KEY || process.env.AI_API_KEY;
    this.model = options.model || DEFAULT_MODEL;
    this.baseUrl = options.baseUrl || DEFAULT_BASE_URL;
    this.timeoutMs = options.timeoutMs || 30000;
  }

  async generate({ transcript, metadata }) {
    if (!this.apiKey) {
      const err = new Error("AI API key not configured");
      err.code = "NO_API_KEY";
      err.status = 401;
      throw err;
    }

    const hasTranscript = !!transcript && transcript.length > 30;
    const transcriptSnippet = hasTranscript
      ? transcript.slice(0, 12000) // ~3000 tokens, handle long transcripts
      : null;

    const systemPrompt = `You are a helpful YouTube video summarizer. Generate a concise "About this video" section.

Requirements:
- Base overview primarily on transcript content when available.
- Do NOT copy YouTube description verbatim.
- Return strict JSON with keys: overview (2-3 sentences), mainTopics (3-5 strings), keyPoints (3-5 bullet strings).
- Keep tone neutral and concise.
- If transcript is unavailable, gracefully use title/description but indicate transcript was unavailable.
- No markdown formatting inside JSON values.`;

    let userContent = `Video metadata:
Title: ${metadata?.title || "Untitled"}
Channel: ${metadata?.channel || "Unknown"}
Description: ${(metadata?.description || "").slice(0, 1000) || "No description"}
View count: ${metadata?.viewCount ?? "unknown"}
Upload date: ${metadata?.uploadDate || "unknown"}`;

    if (hasTranscript) {
      userContent += `\n\nTranscript (plain text, may be auto-generated):\n${transcriptSnippet}\n\n---\n`;
      if (transcript.length > 12000) {
        userContent += `(Transcript truncated for length; original length ${transcript.length} chars)\n`;
      }
      userContent += `Generate overview/mainTopics/keyPoints based primarily on transcript.`;
    } else {
      userContent += `\n\nTranscript: UNAVAILABLE. Generate summary based on title/description, noting transcript unavailable.`;
    }

    userContent += `\n\nRespond with JSON only, no extra text. Example:\n{"overview":"...","mainTopics":["...","..."],"keyPoints":["...","..."]}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userContent },
          ],
          temperature: 0.4,
          max_tokens: 600,
          response_format: { type: "json_object" },
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        let errMsg = `AI provider error ${res.status}`;
        try {
          const j = JSON.parse(text);
          errMsg = j.error?.message || j.error || text.slice(0, 300);
        } catch {
          errMsg = text.slice(0, 300) || res.statusText;
        }
        const err = new Error(errMsg);
        err.status = res.status;
        if (res.status === 401) err.code = "INVALID_API_KEY";
        else if (res.status === 429) err.code = "RATE_LIMIT";
        else if (res.status >= 500) err.code = "PROVIDER_ERROR";
        throw err;
      }

      const data = await res.json();
      const content = data.choices?.[0]?.message?.content;
      if (!content) {
        const err = new Error("AI provider returned empty response");
        err.code = "EMPTY_RESPONSE";
        throw err;
      }

      // Parse JSON content (may be stringified JSON)
      let parsed;
      try {
        parsed = JSON.parse(content);
      } catch {
        // Try to extract JSON block
        const match = content.match(/\{[\s\S]*\}/);
        if (match) parsed = JSON.parse(match[0]);
        else throw new Error("Failed to parse AI JSON response");
      }

      // Validate and normalize
      const overview = String(parsed.overview || "").slice(0, 800).trim();
      const mainTopics = Array.isArray(parsed.mainTopics) ? parsed.mainTopics.map(String).slice(0, 5) : [];
      const keyPoints = Array.isArray(parsed.keyPoints) ? parsed.keyPoints.map(String).slice(0, 5) : [];

      if (!overview || mainTopics.length === 0 || keyPoints.length === 0) {
        throw new Error("AI response missing required fields");
      }

      return { overview, mainTopics, keyPoints };
    } catch (e) {
      clearTimeout(timeout);
      if (e.name === "AbortError") {
        const err = new Error("AI request timed out");
        err.code = "TIMEOUT";
        err.status = 504;
        throw err;
      }
      // Preserve status/code if already set
      if (!e.status && e.code === "NO_API_KEY") e.status = 401;
      throw e;
    }
  }
}
