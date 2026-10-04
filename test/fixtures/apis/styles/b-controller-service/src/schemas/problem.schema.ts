import { z } from 'zod';

export const ProblemDocument = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string(),
  instance: z.string(),
});
export type ProblemDocument = z.infer<typeof ProblemDocument>;
