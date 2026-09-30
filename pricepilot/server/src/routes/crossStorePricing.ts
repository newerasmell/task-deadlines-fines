import { Router } from "express";
import { buildCrossStoreDiff } from "../services/crossStorePricing";

export const crossStorePricingRouter = Router();

// Read-only: computes the diff a colleague reviews before applying. The
// actual publish reuses the existing POST /api/publish endpoint (mode:
// "bulk") with the productId/newPrice/newCompareAtPrice this diff computed
// — same audited, revertible code path as any other bulk publish, so a
// cross-store price copy shows up in the target store's own publish log
// and can be reverted the same way.
crossStorePricingRouter.get("/", async (req, res) => {
  const sourceStoreId = typeof req.query.sourceStoreId === "string" ? req.query.sourceStoreId : undefined;
  const targetStoreId = typeof req.query.targetStoreId === "string" ? req.query.targetStoreId : undefined;
  if (!sourceStoreId || !targetStoreId) return res.status(400).json({ error: "sourceStoreId and targetStoreId are required" });
  if (sourceStoreId === targetStoreId) return res.status(400).json({ error: "Source and target store must be different" });

  try {
    const diff = await buildCrossStoreDiff(sourceStoreId, targetStoreId);
    res.json(diff);
  } catch {
    res.status(404).json({ error: "Store not found" });
  }
});
