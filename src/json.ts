export interface JsonParser<T> {
  parse(value: unknown): T;
}

export class InvalidJsonError extends Error {
  constructor(message = 'Request body does not match the expected JSON contract') {
    super(message);
    this.name = 'InvalidJsonError';
  }
}

function parseWith<T>(value: unknown, parser: JsonParser<T>): T {
  try {
    return parser.parse(value);
  } catch (error) {
    throw new InvalidJsonError(error instanceof Error ? error.message : undefined);
  }
}

export async function readResponseJson<T>(
  response: Response,
  parser: JsonParser<T>
): Promise<T> {
  const value: unknown = await response.json();
  return parseWith(value, parser);
}

export async function readRequestJson<T>(request: Request, parser: JsonParser<T>): Promise<T> {
  const value: unknown = await request.json();
  return parseWith(value, parser);
}

export function parseJson<T>(value: string, parser: JsonParser<T>): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new InvalidJsonError(error instanceof Error ? error.message : undefined);
  }
  return parseWith(parsed, parser);
}

export function invalidJsonResponse(error: unknown): Response | null {
  if (!(error instanceof InvalidJsonError)) return null;
  return Response.json({ error: 'Invalid JSON payload', details: error.message }, { status: 400 });
}
