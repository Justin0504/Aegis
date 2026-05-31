/**
 * Detector plugin layer — public entry. Composes:
 *
 *   DetectorRegistry          contract + runner
 *   PiiDetector               content-kind built-in (regex patterns)
 *   ClassifierDetector        classify-kind built-in (tool category + risk)
 *   AnomalyDetectorPlugin     behavior-kind built-in (Isolation Forest)
 *
 * Third-party detectors implement `Detector` from `@agentguard/core-schema`
 * and register against the same registry.
 */

export { DetectorRegistry } from './registry';
export type { DetectorRegistryOptions } from './registry';
export { PiiDetector } from './built-in/pii-detector';
export { ClassifierDetector } from './built-in/classifier-detector';
export { AnomalyDetectorPlugin } from './built-in/anomaly-detector-plugin';
export { BudgetDetector } from './built-in/budget-detector';
export { ToolScopeDetector } from './built-in/tool-scope-detector';
export { DiscoveryDetector } from './built-in/discovery-detector';
export { ExfilDetector } from './built-in/exfil-detector';
export { LateralMovementDetector } from './built-in/lateral-movement-detector';
export { CrossAgentDetector } from './built-in/cross-agent-detector';
export { MemoryPoisonDetector } from './built-in/memory-poison-detector';
export { AttackPatternDetector } from './built-in/attack-pattern-detector';
export type { PatternRule, HistoryEntry, AttackPatternDetectorOptions } from './built-in/attack-pattern-detector';
