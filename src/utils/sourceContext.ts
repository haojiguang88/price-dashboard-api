export interface NormalizedSourceContext {
  sourceType: string | null;
  sourceId: string | null;
  sourceContextJson: string | null;
}

const normalizeText = (value: unknown, maxLength: number) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text.slice(0, maxLength) : null;
};

export const normalizeSourceContext = (input: Record<string, unknown>): NormalizedSourceContext => {
  const sourceType = normalizeText(input.source_type, 120);
  const sourceId = normalizeText(input.source_id, 240);
  const rawContext = input.source_context;

  if (!sourceType && !sourceId && (rawContext === null || rawContext === undefined)) {
    return { sourceType: null, sourceId: null, sourceContextJson: null };
  }

  let sourceContextJson: string | null = null;
  if (rawContext !== null && rawContext !== undefined) {
    try {
      const encoded = JSON.stringify(rawContext);
      sourceContextJson = encoded.length <= 12000 ? encoded : null;
    } catch {
      sourceContextJson = null;
    }
  }

  return { sourceType, sourceId, sourceContextJson };
};

export const parseSourceContextJson = (value: unknown) => {
  if (!value) return null;
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
};

export const serializeSourceContext = <T extends Record<string, any>>(record: T) => {
  const { source_context_json: sourceContextJson, ...rest } = record;
  return {
    ...rest,
    source_context: parseSourceContextJson(sourceContextJson)
  };
};
