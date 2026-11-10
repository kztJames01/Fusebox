import { z } from "zod";

// Deterministic impact ranking weights used by export-context and later
// ticket materialization. All weights are non-negative and normalized at
// scoring time, so users may supply relative values (for example 2 / 1 / 1).
export const ImpactWeightsSchema = z
  .object({
    changeSize: z.number().finite().nonnegative().default(0.2),
    exportChange: z.number().finite().nonnegative().default(0.3),
    category: z.number().finite().nonnegative().default(0.25),
    recency: z.number().finite().nonnegative().default(0.15),
    dependents: z.number().finite().nonnegative().default(0.1),
  })
  .strict();

export type ImpactWeights = z.infer<typeof ImpactWeightsSchema>;

export const DEFAULT_IMPACT_WEIGHTS: ImpactWeights = {
  changeSize: 0.2,
  exportChange: 0.3,
  category: 0.25,
  recency: 0.15,
  dependents: 0.1,
};

export const RankingConfigSchema = z
  .object({
    weights: ImpactWeightsSchema.default(DEFAULT_IMPACT_WEIGHTS),
  })
  .strict();

export type RankingConfig = z.infer<typeof RankingConfigSchema>;

export const DEFAULT_RANKING_CONFIG: RankingConfig = {
  weights: DEFAULT_IMPACT_WEIGHTS,
};
