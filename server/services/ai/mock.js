import { AIProvider } from "./provider.js";

/**
 * Mock provider - deterministic, no external calls
 * Used when no API key is configured or for testing
 */
export class MockProvider extends AIProvider {
  async generate({ transcript, metadata }) {
    const title = metadata?.title || "Untitled";
    const channel = metadata?.channel || "Unknown";
    const hasTranscript = !!transcript && transcript.length > 50;

    // Build a simple deterministic summary based on available text
    const sourceText = hasTranscript ? transcript : (metadata?.description || title);
    const words = sourceText.split(/\s+/).slice(0, 80).join(" ");

    const overview = hasTranscript
      ? `This video "${title}" by ${channel} covers topics discussed in its transcript. ${words.slice(0, 180)}...`
      : `This video "${title}" by ${channel} is presented without an available transcript. Based on its title and description, it appears to be about ${title}. ${metadata?.description ? metadata.description.slice(0, 120) + "..." : ""}`;

    // Extract main topics by naive keyword extraction (first few capitalized phrases or frequent words)
    // For mock, just return generic topics derived from title
    const mainTopics = [];
    if (title) {
      const titleWords = title.split(/\s+/).filter((w) => w.length > 3).slice(0, 5);
      for (const w of titleWords) mainTopics.push(w.replace(/[^a-zA-Z0-9]/g, ""));
      while (mainTopics.length < 3) mainTopics.push(`Topic ${mainTopics.length + 1}`);
      mainTopics.splice(3);
    } else {
      mainTopics.push("General", "Overview", "Content");
    }

    const keyPoints = [];
    if (hasTranscript) {
      // Split transcript into sentences and take first 3-5
      const sentences = transcript.split(/[.!?]+/).map((s) => s.trim()).filter((s) => s.length > 20);
      for (let i = 0; i < Math.min(5, sentences.length); i++) {
        keyPoints.push(sentences[i].slice(0, 120));
      }
      while (keyPoints.length < 3) keyPoints.push(`Key point ${keyPoints.length + 1} from transcript`);
    } else {
      keyPoints.push(`Video titled "${title}" by ${channel}`);
      if (metadata?.description) keyPoints.push(`Description highlights: ${metadata.description.slice(0, 100)}...`);
      if (metadata?.viewCount) keyPoints.push(`View count: ${metadata.viewCount}`);
      while (keyPoints.length < 3) keyPoints.push(`Additional context from metadata ${keyPoints.length + 1}`);
    }

    return {
      overview: overview.slice(0, 500),
      mainTopics: mainTopics.slice(0, 5),
      keyPoints: keyPoints.slice(0, 5),
    };
  }
}
