import * as v from "valibot";

const EnvSchema = v.object({
  DB_FILE_NAME: v.pipe(v.string(), v.minLength(1)),
  SECRET: v.pipe(v.string(), v.minLength(1)),
  BA_USERNAME: v.pipe(v.string(), v.minLength(1)),
  BA_PASSWORD: v.pipe(v.string(), v.minLength(1)),
});

export const env = v.parse(EnvSchema, process.env);
