import { createApp } from './app.ts';

const port = Number(process.env['PORT'] ?? 3000);
createApp().listen(port, () => {
  process.stdout.write(`orders api on :${port}\n`);
});
