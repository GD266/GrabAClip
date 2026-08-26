import { Router } from "express";
import { validateInfoRequest } from "../utils/validation.js";
import { buildIntelligence } from "../services/intelligence.js";

const router = Router();

router.post("/", async (req, res) => {
  const validation = validateInfoRequest(req.body);
  if (!validation.valid) {
    return res.status(400).json({ error: validation.error });
  }

  try {
    const result = await buildIntelligence(validation.normalizedUrl);
    return res.json(result);
  } catch (e) {
    const status = e.status || 500;
    const message = e.message || "Failed to generate video intelligence.";
    console.error(`[intelligence] error for ${validation.normalizedUrl}:`, e.original || e.message);
    // Do not expose internal details
    return res.status(status).json({ error: message });
  }
});

export default router;
