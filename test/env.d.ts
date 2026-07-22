import type { Env } from '../src/types';

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}

declare global {
  interface Headers {
    getSetCookie(): string[];
  }
}

export {};
