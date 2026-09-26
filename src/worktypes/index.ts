export {
  loadWorkTypes,
  loadWorkType,
  validateWorkType,
  renderPrompt,
  renderTemplate,
  listPlaceholders,
  builtinWorkTypesDir,
  stagePlaceholders,
  WorkTypeError,
  COMMON_PLACEHOLDERS,
  STAGE_PLACEHOLDERS,
  PROMPT_STAGES,
  REQUIRED_PROMPT_STAGES,
  WORKTYPE_FILE,
} from "./loader.js";
export type { PromptStage, RenderedPrompt } from "./loader.js";
export { detectTestCommand, resolveTestCommand } from "./scoring.js";
export type { DetectedTestCommand } from "./scoring.js";
