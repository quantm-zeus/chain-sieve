import { z } from 'zod';

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_HOST: z.string().default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().default('postgres://ciag:ciag_dev_only@127.0.0.1:5432/ciag'),
  OBJECT_STORE_DRIVER: z.enum(['filesystem', 's3']).default('filesystem'),
  OBJECT_STORE_ROOT: z.string().default('.local/object-store'),
  MCP_ALLOWED_ORIGINS: z.string().default('http://127.0.0.1:5173'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  CAPABILITY_MODE: z.literal('SYNTHETIC_SHADOW').default('SYNTHETIC_SHADOW'),
});

export type AppConfig = z.infer<typeof ConfigSchema>;
export const loadConfig = (source: NodeJS.ProcessEnv = process.env): AppConfig => ConfigSchema.parse(source);
