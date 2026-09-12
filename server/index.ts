import { getConfig } from './config.js';
import { createApp } from './app.js';
const config = getConfig();
const { app } = createApp(config);
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT) || 3001;
app.listen(port, host, () => {
  console.log(`Lumori is listening at http://${host}:${port}`);
  if (!config.configured) console.log('Setup needed: set APP_PASSWORD and SESSION_SECRET in .env.');
  console.log('Codex bridge: ' + config.codexUrl);
});
