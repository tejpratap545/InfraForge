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
  if (!trimmed.startsWith("```")) return trimmed;
  // Remove opening fence (```json or ```)
  const withoutOpen = trimmed.replace(/^```(?:json)?\s*/i, "");
  // Remove everything from the last closing fence onward
  const lastFence = withoutOpen.lastIndexOf("```");
  if (lastFence !== -1) return withoutOpen.slice(0, lastFence).trim();
  return withoutOpen.trim();
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
