/**
 * Mirror of plugins/lib/plugin-helpers.ts so the examples type-check where they sit.
 * Example plugins import '../lib/<x>.ts'; once copied into plugins/<kind>/ that same
 * path resolves to the real plugins/lib/<x>.ts. This directory is never copied.
 */
export * from '../../../plugins/lib/plugin-helpers.ts';
