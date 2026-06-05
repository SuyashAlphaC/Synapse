import { SYNAPSE_LANGGRAPH_STRATEGY } from '../types.js';
import type { Strategy } from '../types.js';

/** Lightweight marker check — no LangGraph / adapter imports (browser-safe). */
export function isLangGraphStrategy(strategy: Strategy): boolean {
  return (strategy as unknown as Record<symbol, unknown>)[SYNAPSE_LANGGRAPH_STRATEGY] === true;
}
