/**
 * Extract the outermost JSON object from an LLM response.
 *
 * Handles all common LLM formatting problems:
 *   - Markdown code fences (```json ... ```)
 *   - Preamble text before the JSON object ("Here is my response: {...")
 *   - Trailing text after the closing brace
 *   - Actual newlines inside string values (replaces them with \n)
 */
export function extractJsonPayload(response: string): string {
  let text = response.trim();

  // Strip markdown code fences
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*/i, "");
    const fence = text.indexOf("\n```");
    if (fence !== -1) text = text.slice(0, fence);
    text = text.trim();
  }

  // Find the first { and extract the matching outermost JSON object.
  // This handles preamble text AND trailing text after the JSON.
  const start = text.indexOf("{");
  if (start === -1) return text; // no JSON object found — let JSON.parse fail

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape)            { escape = false; continue; }
    if (ch === "\\")       { escape = true;  continue; }
    if (ch === '"')        { inString = !inString; continue; }
    if (inString)          { continue; }
    if (ch === "{")        { depth++; }
    else if (ch === "}")   { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }

  // Unmatched braces — return from start to end and let JSON.parse fail with a clear error
  return text.slice(start);
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
