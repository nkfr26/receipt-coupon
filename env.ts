import * as v from "valibot";
import { config } from "dotenv";

config({ override: true });

const EnvSchema = v.object({
  DB_FILE_NAME: v.pipe(v.string(), v.minLength(1)),
  SECRET: v.pipe(v.string(), v.minLength(1)),
  USERNAME: v.pipe(v.string(), v.minLength(1)),
  PASSWORD: v.pipe(v.string(), v.minLength(1)),
});

export const env = v.parse(EnvSchema, process.env);
