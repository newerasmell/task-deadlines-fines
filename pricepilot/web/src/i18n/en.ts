import { layout } from "./dict.layout";
import { logsAndMatching } from "./dict.logsAndMatching";
import { pricingTable } from "./dict.pricingTable";
import { sources } from "./dict.sources";
import { storeConfig } from "./dict.storeConfig";

// Flat BG-text -> EN-text lookup, assembled from one partial dictionary per
// page/component so several files can be translated independently without
// colliding on one shared object. Add a new dict.<name>.ts and spread it in
// below when translating a new file.
export const en: Record<string, string> = {
  ...layout,
  ...logsAndMatching,
  ...pricingTable,
  ...sources,
  ...storeConfig,
};
