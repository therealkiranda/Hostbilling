import 'dotenv/config';
import { buildApp } from './app.js';

const app = buildApp();
const port = Number.parseInt(process.env.PORT ?? '4000', 10);
const host = process.env.HOST ?? '0.0.0.0';

try {
  await app.listen({ port, host });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
