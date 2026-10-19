export interface FormattedJsonPayload {
  formattedJson: string;
  extractedFromSurroundingText: boolean;
  removedTrailingCommas: boolean;
}

export function formatJsonPayload(payload: string, indent: number): FormattedJsonPayload {
  let candidate = payload.replace(/^\uFEFF/, "").trim();
  let extractedFromSurroundingText = false;

  const fencedPayload = candidate.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fencedPayload) candidate = fencedPayload[1].trim();

  try {
    return {
      formattedJson: JSON.stringify(JSON.parse(candidate), null, indent),
      extractedFromSurroundingText,
      removedTrailingCommas: false,
    };
  } catch {
    const extracted = extractFirstJsonValue(candidate);
    if (extracted !== undefined && extracted !== candidate) {
      candidate = extracted;
      extractedFromSurroundingText = true;
    }
  }

  const cleaned = removeTrailingCommas(candidate);
  try {
    return {
      formattedJson: JSON.stringify(JSON.parse(cleaned.value), null, indent),
      extractedFromSurroundingText,
      removedTrailingCommas: cleaned.changed,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not parse JSON after cleanup: ${detail}`);
  }
}

function extractFirstJsonValue(text: string): string | undefined {
  let start = -1;
  let inString = false;
  let escaped = false;
  const stack: string[] = [];

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (start === -1) {
      if (character === "{" || character === "[") {
        start = index;
        stack.push(character);
      }
      continue;
    }

    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }

    if (character === '"') {
      inString = true;
    } else if (character === "{" || character === "[") {
      stack.push(character);
    } else if (character === "}" || character === "]") {
      const opening = stack.pop();
      if ((character === "}" && opening !== "{") || (character === "]" && opening !== "[")) {
        return undefined;
      }
      if (stack.length === 0) return text.slice(start, index + 1).trim();
    }
  }

  return undefined;
}

function removeTrailingCommas(text: string): { value: string; changed: boolean } {
  let value = "";
  let inString = false;
  let escaped = false;
  let changed = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (inString) {
      value += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }

    if (character === '"') {
      inString = true;
      value += character;
      continue;
    }

    if (character === ",") {
      let next = index + 1;
      while (next < text.length && /\s/.test(text[next])) next += 1;
      if (text[next] === "}" || text[next] === "]") {
        changed = true;
        continue;
      }
    }

    value += character;
  }

  return { value, changed };
}
