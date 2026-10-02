/**
 * Mirror of plugins/lib/contract.ts so the examples type-check where they sit.
 * Example plugins import '../lib/<x>.ts'; once copied into plugins/<kind>/ that same
 * path resolves to the real plugins/lib/<x>.ts. This directory is never copied.
 */
export * from '../../../plugins/lib/contract.ts';
