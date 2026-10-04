import { z } from 'zod';
import { createApp } from './app.ts';

const PORT = z.coerce.number().int().min(0).max(65535).default(3000).parse(process.env.PORT);

createApp().listen(PORT, () => {
  process.stdout.write(`listening on http://localhost:${String(PORT)}\n`);
});
