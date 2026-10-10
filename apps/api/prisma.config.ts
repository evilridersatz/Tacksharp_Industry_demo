import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// Prisma CLI needs a URL; the app itself uses DB_* variables. Build one from DB_* if DATABASE_URL is not set.
const databaseUrl =
  process.env.DATABASE_URL ??
  `mysql://${encodeURIComponent(process.env.DB_USER ?? 'root')}:${encodeURIComponent(process.env.DB_PASSWORD ?? 'password')}` +
    `@${process.env.DB_HOST ?? 'localhost'}:${process.env.DB_PORT ?? '3306'}/${process.env.DB_NAME ?? 'tacksharp'}`;

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: { url: databaseUrl },
});
