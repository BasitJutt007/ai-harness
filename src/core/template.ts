/**
 * Template manifests: what the harness knows about a scaffold template lives IN the template
 * (`templates/<name>/harness.template.json`), never in core code. The core reads the manifest of
 * `task.template`; a template without one gets generic brief text and no extra read-only paths.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { HARNESS_ROOT, loadConfig } from './config.ts';

/** File name of a template's manifest (never copied into a scaffolded API). */
export const TEMPLATE_MANIFEST = 'harness.template.json';

/** Template a greenfield task uses when it names none. */
export const DEFAULT_TEMPLATE = 'express-zod';

/** Exported-signature globs for a template without a manifest. */
export const GENERIC_SIGNATURE_GLOBS = ['src/**/*.ts'];

const ManifestSchema = z
  .object({
    /** API-relative globs the agent may never write in a greenfield run (matched case-insensitively). */
    readOnly: z.array(z.string().min(1)).default([]),
    /** Lines added verbatim to the greenfield brief: the scaffold's conventions and helpers. */
    brief: z.array(z.string()).default([]),
    /** Module and export that build the app (for runtime probes). */
    entry: z.object({ module: z.string().min(1), export: z.string().min(1) }).strict().optional(),
    /** Files whose exported signatures go into the greenfield brief. */
    signatureGlobs: z.array(z.string().min(1)).default(GENERIC_SIGNATURE_GLOBS),
  })
  .strict();

export type TemplateManifest = z.infer<typeof ManifestSchema>;

const cache = new Map<string, { mtimeMs: number; manifest: TemplateManifest }>();

/** The configured templates directory (harness.config.json `templatesDir`, against the harness root). */
export function defaultTemplatesDir(): string {
  return resolve(HARNESS_ROOT, loadConfig(HARNESS_ROOT).templatesDir);
}

/**
 * The manifest of `template` under `templatesDir`, or null when the template has none.
 * A manifest that exists but is malformed is an error, never silently ignored.
 */
export function templateManifest(template: string, templatesDir: string = defaultTemplatesDir()): TemplateManifest | null {
  const file = join(templatesDir, template, TEMPLATE_MANIFEST);
  if (!existsSync(file)) return null;
  const mtimeMs = statSync(file).mtimeMs;
  const hit = cache.get(file);
  if (hit !== undefined && hit.mtimeMs === mtimeMs) return hit.manifest;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`template manifest ${file} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const parsed = ManifestSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.length > 0 ? i.path.join('.') : '(root)'}: ${i.message}`).join('; ');
    throw new Error(`invalid template manifest ${file}: ${issues}`);
  }
  cache.set(file, { mtimeMs, manifest: parsed.data });
  return parsed.data;
}
