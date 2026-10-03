import { createApp } from './app.js';

createApp().listen(Number(process.env['PORT'] ?? 8080));
