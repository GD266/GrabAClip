/**
 * Base AI Provider interface
 * Implement generate() to return structured summary
 */
export class AIProvider {
  /**
   * @param {Object} params
   * @param {string|null} params.transcript - plain text transcript or null
   * @param {Object} params.metadata - video metadata { title, channel, description, viewCount, etc. }
   * @returns {Promise<{overview:string, mainTopics:string[], keyPoints:string[]}>}
   */
  async generate({ transcript, metadata }) {
    throw new Error("Not implemented");
  }

  get name() {
    return this.constructor.name;
  }
}
