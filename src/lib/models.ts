export const MODELS = [
  {
    id: "deepseek-ai/DeepSeek-V4-Pro",
    label: "DeepSeek V4 Pro",
    hint: "Best coding quality. Uses free HF credits fastest.",
  },
  {
    id: "deepseek-ai/DeepSeek-V4-Flash",
    label: "DeepSeek V4 Flash",
    hint: "Cheaper, still strong. Better for the $0.10 free quota.",
  },
  {
    id: "Qwen/Qwen3-Coder-Next",
    label: "Qwen3-Coder-Next",
    hint: "Smallest coding specialist. Stretches free credits the longest.",
  },
] as const;

export const DEFAULT_MODEL = MODELS[0].id;

export type ModelId = (typeof MODELS)[number]["id"];

export function isAllowedModel(id: string): id is ModelId {
  return MODELS.some((model) => model.id === id);
}
