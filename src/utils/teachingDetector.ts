// src/utils/teachingDetector.ts

export interface TeachingExtraction {
  term: string;
  definition: string;
}

/**
 * Try to extract a (term, definition) pair from a natural-language message
 * where the user is "teaching" Merlin a concept.
 *
 * Examples it should catch:
 *  - "Merlin, puchaina significa inventarse algo raro."
 *  - "Merlin puchaina es cuando alguien se inventa algo raro."
 *  - "Aquí le decimos puchaina a cuando alguien se inventa algo raro."
 */
export function extractTeachingFromMessage(rawContent: string): TeachingExtraction | null {
  const text = rawContent.trim();
  if (!text) return null;

  const lowered = text.toLowerCase();

  // Normalize multiple spaces
  const normalized = text.replace(/\s+/g, " ");

  // 1) Pattern: "Merlin, X significa Y"
  // e.g. "Merlin, puchaina significa inventarse algo raro."
  let match = normalized.match(/merlin[,:]?\s+["“]?(.+?)["”]?\s+significa\s+(.+?)\.?$/i);
  if (match) {
    const term = match[1].trim();
    const definition = match[2].trim();
    if (term && definition) {
      return { term, definition };
    }
  }

  // 2) Pattern: "X significa Y" (without Merlin, but clearly definitional)
  // e.g. "Puchaina significa inventarse algo raro."
  match = normalized.match(/^["“]?(.+?)["”]?\s+significa\s+(.+?)\.?$/i);
  if (match) {
    const term = match[1].trim();
    const definition = match[2].trim();
    if (term && definition) {
      return { term, definition };
    }
  }

  // 3) Pattern: "Merlin, X es cuando Y"
  // e.g. "Merlin, puchaina es cuando alguien se inventa algo raro."
  match = normalized.match(/merlin[,:]?\s+["“]?(.+?)["”]?\s+es\s+cuando\s+(.+?)\.?$/i);
  if (match) {
    const term = match[1].trim();
    const definition = ("Es cuando " + match[2]).trim();
    if (term && definition) {
      return { term, definition };
    }
  }

  // 4) Pattern: "Aquí le decimos X a Y"
  // e.g. "Aquí le decimos puchaina a cuando alguien se inventa algo raro."
  match = normalized.match(/aquí le decimos\s+["“]?(.+?)["”]?\s+a\s+(.+?)\.?$/i);
  if (match) {
    const term = match[1].trim();
    const definition = match[2].trim();
    if (term && definition) {
      return { term, definition };
    }
  }

  // 5) Pattern: "X es Y" in a Merlin-directed message, simple definition
  // We only accept this if the message clearly mentions Merlin somewhere.
  if (lowered.includes("merlin")) {
    match = normalized.match(/merlin[,:]?\s+["“]?(.+?)["”]?\s+es\s+(.+?)\.?$/i);
    if (match) {
      const term = match[1].trim();
      const definition = match[2].trim();
      if (term && definition) {
        return { term, definition };
      }
    }
  }

  return null;
}
