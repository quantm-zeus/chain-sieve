import { z } from 'zod';

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  API_HOST: z.string().default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().default('postgres://ciag:ciag_dev_only@127.0.0.1:5432/ciag'),
  OBJECT_STORE_DRIVER: z.enum(['filesystem', 's3']).default('filesystem'),
  OBJECT_STORE_ROOT: z.string().default('.local/object-store'),
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_BUCKET: z.string().min(3).optional(),
  S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  S3_FORCE_PATH_STYLE: z.enum(['true', 'false']).default('true').transform((value) => value === 'true'),
  MCP_ALLOWED_ORIGINS: z.string().default('http://127.0.0.1:5173'),
  MCP_BOOTSTRAP_TOKEN: z.string().min(16).default('local-synthetic-bootstrap-token'),
  MCP_MAX_BODY_BYTES: z.coerce.number().int().min(1024).max(1_048_576).default(65_536),
  MCP_MAX_CONCURRENT: z.coerce.number().int().min(1).max(32).default(4),
  MCP_RATE_PER_MINUTE: z.coerce.number().int().min(1).max(600).default(60),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  CAPABILITY_MODE: z.literal('SYNTHETIC_SHADOW').default('SYNTHETIC_SHADOW'),
}).superRefine((config, context) => {
  if (config.OBJECT_STORE_DRIVER === 's3') {
    for (const key of ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const) if (!config[key]) context.addIssue({ code: 'custom', path: [key], message: `${key} is required for s3 object storage` });
  }
});

export type AppConfig = z.infer<typeof ConfigSchema>;
export const loadConfig = (source: NodeJS.ProcessEnv = process.env): AppConfig => {
  const nodeEnv = z.enum(['development', 'test', 'production']).default('development').parse(source.NODE_ENV);
  if (nodeEnv === 'production') {
    const required = ['API_HOST', 'API_PORT', 'DATABASE_URL', 'OBJECT_STORE_DRIVER', 'MCP_ALLOWED_ORIGINS', 'MCP_BOOTSTRAP_TOKEN'] as const;
    const missing = required.filter((key) => !source[key]);
    if (missing.length > 0) throw new Error(`PRODUCTION_CONFIG_REQUIRED:${missing.join(',')}`);
    if (source.OBJECT_STORE_DRIVER === 'filesystem' && !source.OBJECT_STORE_ROOT) throw new Error('PRODUCTION_CONFIG_REQUIRED:OBJECT_STORE_ROOT');
  }
  return ConfigSchema.parse({ ...source, NODE_ENV: nodeEnv });
};
