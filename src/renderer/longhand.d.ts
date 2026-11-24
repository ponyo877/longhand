import type { LonghandApi } from '../shared/types';

declare global {
  interface Window {
    longhand: LonghandApi;
  }
}

export {};

declare module '*.css';
