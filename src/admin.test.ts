import { TZDate } from "@date-fns/tz";
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { addDays, addMilliseconds, addMonths, endOfDay, endOfMonth } from "date-fns";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { testClient } from "hono/testing";

import { env } from "../env";
import type { AdminAppType } from "./admin";
import { createApp } from "./index";
import type { PublicAppType } from "./public";
import { COUPON_EXPIRE_MONTHS, MESSAGES, SURVEY_EXPIRE_DAYS, TIMEZONE } from "./utils";

let adminClient: ReturnType<typeof testClient<AdminAppType>>;
let publicClient: ReturnType<typeof testClient<PublicAppType>>;

beforeEach(async () => {
  const db = drizzle(env.DB_FILE_NAME);
  await migrate(db, { migrationsFolder: "./drizzle" });

  const app = createApp(db);
  adminClient = testClient<AdminAppType>(app);
  publicClient = testClient<PublicAppType>(app);
});

afterEach(async () => {
  setSystemTime();
});

const adminHeaders = {
  Authorization: `Basic ${btoa(`${env.BA_USERNAME}:${env.BA_PASSWORD}`)}`,
};

// /admin/issue 経由でトークンを発行する
async function issueToken() {
  const response = await adminClient.admin.issue.$post({}, { headers: adminHeaders });
  if (!response.ok) {
    throw new Error(`レスポンスステータス: ${response.status}`);
  }
  return response.json();
}

describe("POST /admin/issue", () => {
  test("Basic認証なしは401", async () => {
    const response = await adminClient.admin.issue.$post({});
    expect(response.status).toBe(401);
  });

  test("201でトークンが発行される", async () => {
    const response = await adminClient.admin.issue.$post({}, { headers: adminHeaders });
    expect(response.status).toBe(201);
  });

  test("アンケート回答期限はTIMEZONEでSURVEY_EXPIRE_DAYS日後末まで", async () => {
    const actual = await issueToken();
    const expected = endOfDay(addDays(TZDate.tz(TIMEZONE), SURVEY_EXPIRE_DAYS)).getTime();
    expect(actual.surveyExp).toBe(expected);
  });
});

describe("PUT /admin/use", () => {
  test("Basic認証なしは401", async () => {
    const { token } = await issueToken();
    const response = await adminClient.admin.use.$put({ query: { token } });
    expect(response.status).toBe(401);
  });

  test("クーポンを使用済みにできる", async () => {
    const { token } = await issueToken();
    await publicClient.public.answer.$post({ query: { token } });

    const response = await adminClient.admin.use.$put(
      { query: { token } },
      { headers: adminHeaders },
    );
    if (!response.ok) {
      throw new Error(`レスポンスステータス: ${response.status}`);
    }
    const actual = await response.json();
    expect(actual.usedAt).not.toBeNull();
  });

  test("クーポン未発行(アンケート未回答)は404", async () => {
    const { token } = await issueToken();

    const response = await adminClient.admin.use.$put(
      { query: { token } },
      { headers: adminHeaders },
    );
    if (response.status !== 404) {
      throw new Error(`レスポンスステータス: ${response.status}`);
    }
    const actual = await response.json();
    expect(actual.message).toBe(MESSAGES.COUPON_NOT_FOUND);
  });

  test("有効期限ちょうどのクーポンは使用可能", async () => {
    const { token } = await issueToken();
    await publicClient.public.answer.$post({ query: { token } });

    const couponExp = endOfMonth(addMonths(TZDate.tz(TIMEZONE), COUPON_EXPIRE_MONTHS));
    setSystemTime(couponExp);

    const response = await adminClient.admin.use.$put(
      { query: { token } },
      { headers: adminHeaders },
    );
    if (!response.ok) {
      throw new Error(`レスポンスステータス: ${response.status}`);
    }
    const actual = await response.json();
    expect(actual.usedAt).not.toBeNull();
  });

  test("有効期限切れのクーポンは使用不可", async () => {
    const { token } = await issueToken();
    await publicClient.public.answer.$post({ query: { token } });

    const couponExp = endOfMonth(addMonths(TZDate.tz(TIMEZONE), COUPON_EXPIRE_MONTHS));
    setSystemTime(addMilliseconds(couponExp, 1));

    const response = await adminClient.admin.use.$put(
      { query: { token } },
      { headers: adminHeaders },
    );
    if (response.status !== 400) {
      throw new Error(`レスポンスステータス: ${response.status}`);
    }
    const actual = await response.json();
    expect(actual.message).toBe(MESSAGES.COUPON_EXPIRED);
  });

  test("使用済みのクーポンは再使用不可", async () => {
    const { token } = await issueToken();
    await publicClient.public.answer.$post({ query: { token } });
    await adminClient.admin.use.$put({ query: { token } }, { headers: adminHeaders });

    const response = await adminClient.admin.use.$put(
      { query: { token } },
      { headers: adminHeaders },
    );
    if (response.status !== 400) {
      throw new Error(`レスポンスステータス: ${response.status}`);
    }
    const actual = await response.json();
    expect(actual.message).toBe(MESSAGES.COUPON_USED);
  });
});
