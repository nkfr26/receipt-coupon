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

describe("GET /public/status", () => {
  test("トークンなしは400", async () => {
    const response = await publicClient.public.status.$get({ query: {} });
    if (response.status !== 400) {
      throw new Error(`レスポンスステータス: ${response.status}`);
    }
    const actual = await response.json();
    expect(actual.message).toBe(MESSAGES.TOKEN_INVALID);
  });

  test("不正なトークンは401", async () => {
    const response = await publicClient.public.status.$get({
      query: { token: "invalid.token.here" },
    });
    if (response.status !== 401) {
      throw new Error(`レスポンスステータス: ${response.status}`);
    }
    const actual = await response.json();
    expect(actual.message).toBe(MESSAGES.TOKEN_INVALID);
  });

  test("アンケート回答期限ちょうどは未回答", async () => {
    const { token } = await issueToken();

    const surveyExp = endOfDay(addDays(TZDate.tz(TIMEZONE), SURVEY_EXPIRE_DAYS));
    setSystemTime(surveyExp);

    const response = await publicClient.public.status.$get({ query: { token } });
    if (!response.ok) {
      throw new Error(`レスポンスステータス: ${response.status}`);
    }
    const actual = await response.json();
    expect(actual.status).toBe("unanswered");
  });

  test("アンケート回答期限切れ", async () => {
    const { token } = await issueToken();

    const surveyExp = endOfDay(addDays(TZDate.tz(TIMEZONE), SURVEY_EXPIRE_DAYS));
    setSystemTime(addMilliseconds(surveyExp, 1));

    const response = await publicClient.public.status.$get({ query: { token } });
    if (!response.ok) {
      throw new Error(`レスポンスステータス: ${response.status}`);
    }
    const actual = await response.json();
    expect(actual.status).toBe("survey expired");
  });

  test("アンケート未回答", async () => {
    const { token } = await issueToken();
    const response = await publicClient.public.status.$get({ query: { token } });
    if (!response.ok) {
      throw new Error(`レスポンスステータス: ${response.status}`);
    }
    const actual = await response.json();
    expect(actual.status).toBe("unanswered");
  });

  test("クーポン有効期限ちょうどは有効", async () => {
    const { token } = await issueToken();
    await publicClient.public.answer.$post({ query: { token } });

    const couponExp = endOfMonth(addMonths(TZDate.tz(TIMEZONE), COUPON_EXPIRE_MONTHS));
    setSystemTime(couponExp);

    const response = await publicClient.public.status.$get({ query: { token } });
    if (!response.ok) {
      throw new Error(`レスポンスステータス: ${response.status}`);
    }
    const actual = await response.json();
    expect(actual.status).toBe("active");
  });

  test("クーポン有効期限切れ", async () => {
    const { token } = await issueToken();
    await publicClient.public.answer.$post({ query: { token } });

    const couponExp = endOfMonth(addMonths(TZDate.tz(TIMEZONE), COUPON_EXPIRE_MONTHS));
    setSystemTime(addMilliseconds(couponExp, 1));

    const response = await publicClient.public.status.$get({ query: { token } });
    if (!response.ok) {
      throw new Error(`レスポンスステータス: ${response.status}`);
    }
    const actual = await response.json();
    expect(actual.status).toBe("coupon expired");
  });

  test("クーポン使用済み", async () => {
    const { token } = await issueToken();
    await publicClient.public.answer.$post({ query: { token } });
    await adminClient.admin.use.$put({ query: { token } }, { headers: adminHeaders });

    const response = await publicClient.public.status.$get({ query: { token } });
    if (!response.ok) {
      throw new Error(`レスポンスステータス: ${response.status}`);
    }
    const actual = await response.json();
    expect(actual.status).toBe("used");
  });

  test("有効なクーポン", async () => {
    const { token } = await issueToken();
    await publicClient.public.answer.$post({ query: { token } });

    const response = await publicClient.public.status.$get({ query: { token } });
    if (!response.ok) {
      throw new Error(`レスポンスステータス: ${response.status}`);
    }
    const actual = await response.json();
    expect(actual.status).toBe("active");
  });
});

describe("POST /public/answer", () => {
  test("回答すると201でクーポンが発行される", async () => {
    const { token } = await issueToken();
    const response = await publicClient.public.answer.$post({ query: { token } });
    expect(response.status).toBe(201);
  });

  test("クーポン有効期限はTIMEZONEでCOUPON_EXPIRE_MONTHSか月後末まで", async () => {
    setSystemTime(new Date("2026-01-01T00:00:00+09:00"));

    const { token } = await issueToken();
    const response = await publicClient.public.answer.$post({ query: { token } });
    if (!response.ok) {
      throw new Error(`レスポンスステータス: ${response.status}`);
    }
    const actual = await response.json();

    const expectedExp = endOfMonth(addMonths(TZDate.tz(TIMEZONE), COUPON_EXPIRE_MONTHS));
    expect(new Date(actual.exp)).toStrictEqual(expectedExp);
  });

  test("二重回答は200で既存クーポンを返す", async () => {
    const { token } = await issueToken();
    await publicClient.public.answer.$post({ query: { token } });

    const response = await publicClient.public.answer.$post({ query: { token } });
    if (response.status !== 200) {
      throw new Error(`レスポンスステータス: ${response.status}`);
    }
    const actual = await response.json();
    expect(actual.usedAt).toBeNull();
  });

  test("回答期限ちょうどのアンケートは回答可能", async () => {
    const { token } = await issueToken();
    const surveyExp = endOfDay(addDays(TZDate.tz(TIMEZONE), SURVEY_EXPIRE_DAYS));
    setSystemTime(surveyExp);

    const response = await publicClient.public.answer.$post({ query: { token } });
    if (!response.ok) {
      throw new Error(`レスポンスステータス: ${response.status}`);
    }
    const actual = await response.json();
    expect(actual.usedAt).toBeNull();
  });

  test("回答期限切れのアンケートは400", async () => {
    const { token } = await issueToken();
    const surveyExp = endOfDay(addDays(TZDate.tz(TIMEZONE), SURVEY_EXPIRE_DAYS));
    setSystemTime(addMilliseconds(surveyExp, 1));

    const response = await publicClient.public.answer.$post({ query: { token } });
    if (response.status !== 400) {
      throw new Error(`レスポンスステータス: ${response.status}`);
    }
    const actual = await response.json();
    expect(actual.message).toBe(MESSAGES.SURVEY_EXPIRED);
  });

  test("クーポンが使用済みの場合は400", async () => {
    const { token } = await issueToken();
    await publicClient.public.answer.$post({ query: { token } });
    await adminClient.admin.use.$put({ query: { token } }, { headers: adminHeaders });

    const response = await publicClient.public.answer.$post({ query: { token } });
    if (response.status !== 400) {
      throw new Error(`レスポンスステータス: ${response.status}`);
    }
    const actual = await response.json();
    expect(actual.message).toBe(MESSAGES.COUPON_USED);
  });
});
