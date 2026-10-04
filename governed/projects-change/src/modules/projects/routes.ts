import { Router } from 'express';
import { idempotency } from '../../lib/idempotency.ts';
import { notFound } from '../../lib/problem.ts';
import {
  CreateProjectSchema,
  ListProjectsQuerySchema,
  ProjectPageSchema,
  ProjectParamsSchema,
  ProjectSchema,
  UpdateProjectSchema,
} from './schema.ts';
import { createProject, deleteProject, getProject, listProjects, updateProject } from './store.ts';

export const projectsRouter = Router();

projectsRouter.get('/v1/projects', (req, res) => {
  const query = ListProjectsQuerySchema.parse(req.query);
  res.json(ProjectPageSchema.parse(listProjects(query)));
});

projectsRouter.post('/v1/projects', idempotency(), (req, res) => {
  const body = CreateProjectSchema.parse(req.body);
  const project = createProject(body);
  res.status(201).location(`/v1/projects/${project.id}`).json(ProjectSchema.parse(project));
});

projectsRouter.get('/v1/projects/:projectId', (req, res) => {
  const { projectId } = ProjectParamsSchema.parse(req.params);
  const project = getProject(projectId);
  if (project === undefined) throw notFound(`project ${projectId} not found`);
  res.json(ProjectSchema.parse(project));
});

projectsRouter.patch('/v1/projects/:projectId', idempotency(), (req, res) => {
  const { projectId } = ProjectParamsSchema.parse(req.params);
  const patch = UpdateProjectSchema.parse(req.body);
  const project = updateProject(projectId, patch);
  if (project === undefined) throw notFound(`project ${projectId} not found`);
  res.json(ProjectSchema.parse(project));
});

projectsRouter.delete('/v1/projects/:projectId', (req, res) => {
  const { projectId } = ProjectParamsSchema.parse(req.params);
  if (!deleteProject(projectId)) throw notFound(`project ${projectId} not found`);
  res.status(204).send();
});
