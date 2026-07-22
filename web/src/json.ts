import type { ZodType } from 'zod';

export async function readResponseJson<T>(response: Response, parser: ZodType<T>): Promise<T> {
  const value: unknown = await response.json();
  return parser.parse(value);
}
