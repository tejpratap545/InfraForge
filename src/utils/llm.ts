/**
 * Strips markdown code fences from LLM responses.
 * Many models wrap JSON in ```json ... ``` blocks even when instructed not to.
 *
 * Uses lastIndexOf for the closing fence so that:
 *  - HCL content inside JSON string values that contains ``` doesn't trip the parser.
 *  - Extra text the model appends after the closing fence is ignored.
 */
export function extractJsonPayload(response: string): string {
  const trimmed = response.trim();

  // Fast path: already bare JSON.
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return trimmed;

  // Strip an opening code fence (```json or ```).
  if (trimmed.startsWith("```")) {
    const withoutOpen = trimmed.replace(/^```(?:json)?\s*/i, "");
    // Find the FIRST closing fence that appears AFTER the opening brace,
    // so backtick sequences inside JSON string values don't trip the parser.
    const bracePos = withoutOpen.indexOf("{");
    if (bracePos === -1) return withoutOpen.trim();
    const searchFrom = bracePos;
    const closingFence = withoutOpen.indexOf("\n```", searchFrom);
    if (closingFence !== -1) return withoutOpen.slice(0, closingFence).trim();
    // No closing fence found — return everything after the opening fence.
    return withoutOpen.trim();
  }

  // No fence — return as-is and let JSON.parse surface the error.
  return trimmed;
}

/**
 * Extract and parse JSON from an LLM response in one step.
 * Throws a consistent error including context and the raw response on failure.
 */
export function parseJsonPayload(response: string, context: string): unknown {
  const payload = extractJsonPayload(response);
  try {
    return JSON.parse(payload);
  } catch {
    throw new Error(`${context} returned non-JSON. raw=${response.slice(0, 300)}`);
  }
}
