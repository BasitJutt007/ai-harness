import { z } from 'zod';
import { CursorQuerySchema, pageSchema } from '../../lib/pagination.ts';

export const ProjectStatusSchema = z.enum(['active', 'archived']);

export const ProjectSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  status: ProjectStatusSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const ProjectParamsSchema = z.object({ projectId: z.uuid() });

export const CreateProjectSchema = z.strictObject({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  status: ProjectStatusSchema.default('active'),
});
export type CreateProject = z.infer<typeof CreateProjectSchema>;

export const UpdateProjectSchema = z
  .strictObject({
    name: z.string().min(1).max(100).optional(),
    description: z.string().max(500).optional(),
    status: ProjectStatusSchema.optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, { message: 'at least one field is required' });
export type UpdateProject = z.infer<typeof UpdateProjectSchema>;

export const ListProjectsQuerySchema = CursorQuerySchema;
export type ListProjectsQuery = z.infer<typeof ListProjectsQuerySchema>;

export const ProjectPageSchema = pageSchema(ProjectSchema);
export type ProjectPage = z.infer<typeof ProjectPageSchema>;
