import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import cors from "cors";
import express, {
  type ErrorRequestHandler,
  type NextFunction,
  type Request,
  type Response
} from "express";
import { z, ZodError } from "zod";
import type { Mood, Purpose } from "@damo/contracts";
import { checkStorage, storageKind, store } from "./app-store.js";
import {
  naverSearchCredentials,
  searchNaverLocalPlaces
} from "./naver-search.js";
import { StoreError } from "./store.js";

declare global {
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

const purposeSchema = z.enum(["STUDY", "CAFE", "MEAL", "DRINK"]);
const moodSchema = z.enum(["FUN", "QUIET", "BUSINESS", "TIPSY"]);
const recurrenceSchema = z
  .object({
    type: z.enum(["WEEKLY", "MONTHLY", "CUSTOM"]),
    customNextMeetingAt: z.string().datetime({ offset: true }).nullable().optional()
  })
  .nullable()
  .optional();

export const app = express();
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const webDistDirectory = path.resolve(moduleDirectory, "../../web/dist");
const webIndexPath = path.join(webDistDirectory, "index.html");
const servesWeb = process.env.DAMO_SERVE_WEB === "true";

app.use(
  cors({
    origin: true,
    credentials: true,
    exposedHeaders: ["Location"]
  })
);
app.use(express.json());
app.use((req, res, next) => {
  const startedAt = performance.now();
  res.on("finish", () => {
    const durationMs = Math.round(performance.now() - startedAt);
    if (durationMs >= 1_000) {
      console.warn("Slow API request", {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs
      });
    }
  });
  next();
});

const ok = <T>(res: Response, data: T, status = 200) =>
  res.status(status).json({ data, meta: { updatedAt: new Date().toISOString() } });

const asyncRoute =
  (handler: (req: Request, res: Response, next: NextFunction) => unknown) =>
  (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(handler(req, res, next)).catch(next);

const pathParam = (req: Request, name: string) =>
  z.string().min(1).parse(req.params[name]);

const auth = asyncRoute(async (req, _res, next) => {
  const header = req.header("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  req.userId = await store.userIdForToken(token);
  next();
});

app.get(
  "/health",
  asyncRoute(async (_req, res) => {
    await checkStorage();
    res.json({
      status: "ok",
      service: "damo-api",
      storage: storageKind,
      time: new Date().toISOString()
    });
  })
);

app.post(
  "/api/v1/auth/test/signup",
  asyncRoute(async (req, res) => {
    const body = z
      .object({
        loginId: z.string().min(3).max(40),
        nickname: z.string().min(1).max(20),
        password: z.string().min(4).max(100),
        email: z.string().email().nullable().optional()
      })
      .parse(req.body);
    return ok(
      res,
      await store.signup(body.loginId, body.nickname, body.password, body.email),
      201
    );
  })
);

app.post(
  "/api/v1/auth/test/login",
  asyncRoute(async (req, res) => {
    const body = z
      .object({ loginId: z.string().min(1), password: z.string().min(1) })
      .parse(req.body);
    return ok(res, await store.login(body.loginId, body.password));
  })
);

app.get(
  "/api/v1/auth/oauth/:provider",
  asyncRoute(async (req, res) => {
    const provider = z.enum(["kakao", "naver", "google"]).parse(pathParam(req, "provider"));
    const redirectUri = z
      .string()
      .url()
      .catch("http://localhost:5173/oauth/callback")
      .parse(req.query.redirectUri);
    const separator = redirectUri.includes("?") ? "&" : "?";
    return res.redirect(
      302,
      `${redirectUri}${separator}provider=${provider.toUpperCase()}&accessToken=mock-token-user-1`
    );
  })
);

app.get(
  "/api/v1/auth/oauth/:provider/callback",
  asyncRoute(async (req, res) => {
    const provider = z.enum(["kakao", "naver", "google"]).parse(pathParam(req, "provider"));
    const redirectUri = z
      .string()
      .url()
      .catch("http://localhost:5173/oauth/callback")
      .parse(req.query.redirectUri);
    return res.redirect(
      302,
      `${redirectUri}?provider=${provider.toUpperCase()}&accessToken=mock-token-user-1`
    );
  })
);

app.post(
  "/api/v1/auth/refresh",
  asyncRoute(async (req, res) => {
    const body = z.object({ refreshToken: z.string().min(1) }).parse(req.body);
    const userId = body.refreshToken.replace("mock-refresh-", "");
    await store.getUser(userId);
    return ok(res, {
      accessToken: `mock-token-${userId}`,
      refreshToken: body.refreshToken
    });
  })
);

app.post("/api/v1/auth/logout", auth, (_req, res) => ok(res, { loggedOut: true }));

app.get(
  "/api/v1/me",
  auth,
  asyncRoute(async (req, res) => ok(res, await store.getUser(req.userId!)))
);
app.get(
  "/api/v1/me/home",
  auth,
  asyncRoute(async (req, res) => ok(res, await store.home(req.userId!)))
);

app.get(
  "/api/v1/map/places/search",
  auth,
  asyncRoute(async (req, res) => {
    const query = z.string().trim().max(100).catch("").parse(req.query.query);
    const credentials = naverSearchCredentials();
    if (query && credentials) {
      try {
        const result = await searchNaverLocalPlaces(query, credentials);
        return ok(res, await store.upsertPlaces(result));
      } catch (error) {
        console.error("Naver local search failed", error);
        throw new StoreError(
          502,
          "NAVER_PLACE_SEARCH_FAILED",
          "네이버 장소 검색에 실패했습니다. 잠시 후 다시 시도해 주세요."
        );
      }
    }
    return ok(res, await store.searchPlaces(query));
  })
);

app.get(
  "/api/v1/map/places/:naverPlaceId",
  auth,
  asyncRoute(async (req, res) =>
    ok(res, await store.getPlace(pathParam(req, "naverPlaceId")))
  )
);

app.get(
  "/api/v1/me/places",
  auth,
  asyncRoute(async (req, res) =>
    ok(res, await store.listUserPlaces(req.userId!))
  )
);

app.post(
  "/api/v1/me/places",
  auth,
  asyncRoute(async (req, res) => {
    const body = z
      .object({
        naverPlaceId: z.string().min(1),
        purpose: purposeSchema,
        mood: moodSchema
      })
      .parse(req.body);
    return ok(
      res,
      await store.registerUserPlace(
        req.userId!,
        body.naverPlaceId,
        body.purpose as Purpose,
        body.mood as Mood
      ),
      201
    );
  })
);

app.patch(
  "/api/v1/me/places/:userPlaceId",
  auth,
  asyncRoute(async (req, res) => {
    const body = z
      .object({
        purpose: purposeSchema,
        mood: moodSchema,
        applyToMeetingIds: z.array(z.string()).default([])
      })
      .parse(req.body);
    return ok(
      res,
      await store.updateUserPlace(
        req.userId!,
        pathParam(req, "userPlaceId"),
        body.purpose,
        body.mood,
        body.applyToMeetingIds
      )
    );
  })
);

app.post(
  "/api/v1/me/places/:userPlaceId/unregister",
  auth,
  asyncRoute(async (req, res) => {
    const body = z
      .object({ applyToActiveMeetings: z.boolean().default(false) })
      .parse(req.body);
    return ok(
      res,
      await store.unregisterUserPlace(
        req.userId!,
        pathParam(req, "userPlaceId"),
        body.applyToActiveMeetings
      )
    );
  })
);

app.post(
  "/api/v1/meetings",
  auth,
  asyncRoute(async (req, res) => {
    const body = z
      .object({
        name: z.string().min(1).max(20),
        capacity: z.number().int().min(2),
        meetingAt: z.string().datetime({ offset: true }),
        purpose: purposeSchema,
        mood: moodSchema
      })
      .parse(req.body);
    return ok(res, await store.createMeeting(req.userId!, body), 201);
  })
);

app.post(
  "/api/v1/meetings/lookup",
  auth,
  asyncRoute(async (req, res) => {
    const body = z.object({ joinCode: z.string().regex(/^\d{4}$/) }).parse(req.body);
    return ok(res, await store.lookupMeeting(body.joinCode));
  })
);

app.get(
  "/api/v1/meetings/:meetingId",
  auth,
  asyncRoute(async (req, res) =>
    ok(res, await store.detail(pathParam(req, "meetingId"), req.userId!))
  )
);

app.post(
  "/api/v1/meetings/:meetingId/join",
  auth,
  asyncRoute(async (req, res) => {
    const body = z
      .object({
        joinCode: z.string().regex(/^\d{4}$/),
        meetingNickname: z.string().min(1).max(20)
      })
      .parse(req.body);
    return ok(
      res,
      await store.joinMeeting(
        req.userId!,
        pathParam(req, "meetingId"),
        body.joinCode,
        body.meetingNickname
      )
    );
  })
);

app.post(
  "/api/v1/meetings/:meetingId/leave",
  auth,
  asyncRoute(async (req, res) =>
    ok(res, await store.leaveMeeting(pathParam(req, "meetingId"), req.userId!))
  )
);

app.post(
  "/api/v1/meetings/:meetingId/members/:memberId/kick",
  auth,
  asyncRoute(async (req, res) =>
    ok(
      res,
      await store.kickMember(
        pathParam(req, "meetingId"),
        req.userId!,
        pathParam(req, "memberId")
      )
    )
  )
);

app.delete(
  "/api/v1/meetings/:meetingId",
  auth,
  asyncRoute(async (req, res) =>
    ok(res, await store.deleteMeeting(pathParam(req, "meetingId"), req.userId!))
  )
);

app.get(
  "/api/v1/meetings/:meetingId/eligible-places",
  auth,
  asyncRoute(async (req, res) =>
    ok(res, await store.eligiblePlaces(pathParam(req, "meetingId"), req.userId!))
  )
);

app.get(
  "/api/v1/meetings/:meetingId/candidates",
  auth,
  asyncRoute(async (req, res) =>
    ok(res, await store.publicCandidates(pathParam(req, "meetingId"), req.userId!))
  )
);

app.put(
  "/api/v1/meetings/:meetingId/candidates/me",
  auth,
  asyncRoute(async (req, res) => {
    const body = z.object({ userPlaceIds: z.array(z.string()).max(2) }).parse(req.body);
    return ok(
      res,
      await store.replaceMyCandidates(
        pathParam(req, "meetingId"),
        req.userId!,
        body.userPlaceIds
      )
    );
  })
);

app.post(
  "/api/v1/meetings/:meetingId/vote",
  auth,
  asyncRoute(async (req, res) =>
    ok(res, await store.createVote(pathParam(req, "meetingId"), req.userId!), 201)
  )
);

app.get(
  "/api/v1/meetings/:meetingId/vote/session",
  auth,
  asyncRoute(async (req, res) =>
    ok(res, await store.voteSession(pathParam(req, "meetingId"), req.userId!))
  )
);

app.post(
  "/api/v1/meetings/:meetingId/vote/choices",
  auth,
  asyncRoute(async (req, res) => {
    const body = z
      .object({
        roundNumber: z.number().int().min(1),
        selectedCandidateId: z.string().min(1)
      })
      .parse(req.body);
    return ok(
      res,
      await store.saveChoice(
        pathParam(req, "meetingId"),
        req.userId!,
        body.roundNumber,
        body.selectedCandidateId
      )
    );
  })
);

app.get(
  "/api/v1/meetings/:meetingId/vote/results",
  auth,
  asyncRoute(async (req, res) =>
    ok(res, await store.voteResults(pathParam(req, "meetingId"), req.userId!))
  )
);

app.post(
  "/api/v1/meetings/:meetingId/vote/close",
  auth,
  asyncRoute(async (req, res) => {
    const body = z.object({ force: z.boolean().default(false) }).parse(req.body);
    return ok(
      res,
      await store.closeVote(pathParam(req, "meetingId"), req.userId!, body.force)
    );
  })
);

app.post(
  "/api/v1/meetings/:meetingId/vote/final-selection",
  auth,
  asyncRoute(async (req, res) => {
    const body = z.object({ candidateId: z.string().min(1) }).parse(req.body);
    return ok(
      res,
      await store.finalSelection(
        pathParam(req, "meetingId"),
        req.userId!,
        body.candidateId
      )
    );
  })
);

app.post(
  "/api/v1/__mock/reset",
  asyncRoute(async (_req, res) => {
    if (
      storageKind === "postgres" &&
      process.env.DAMO_ENABLE_DB_RESET !== "true"
    ) {
      throw new StoreError(
        404,
        "ROUTE_NOT_FOUND",
        "요청한 API 경로를 찾을 수 없습니다."
      );
    }
    await store.reset();
    return ok(res, { reset: true });
  })
);

app.post(
  "/api/v1/meetings/:meetingId/repeat",
  auth,
  asyncRoute(async (req, res) => {
    const body = z
      .object({
        name: z.string().min(1).max(20),
        capacity: z.number().int().min(2),
        meetingAt: z.string().datetime({ offset: true }),
        purpose: purposeSchema,
        mood: moodSchema,
        memberIds: z.array(z.string().min(1)).min(1),
        recurrence: recurrenceSchema
      })
      .parse(req.body);
    return ok(
      res,
      await store.repeatMeeting(
        pathParam(req, "meetingId"),
        req.userId!,
        body
      ),
      201
    );
  })
);

if (servesWeb) {
  app.use(express.static(webDistDirectory));
  app.use((req, res, next) => {
    if (
      req.method !== "GET" ||
      req.path.startsWith("/api/") ||
      req.path === "/health" ||
      !req.accepts("html")
    ) {
      next();
      return;
    }

    res.sendFile(webIndexPath, (error) => {
      if (error) next(error);
    });
  });
}

app.use((_req, _res, next) => {
  next(new StoreError(404, "ROUTE_NOT_FOUND", "요청한 API 경로를 찾을 수 없습니다."));
});

const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  if (error instanceof StoreError) {
    res.status(error.status).json({
      error: {
        code: error.code,
        message: error.message,
        details: error.details
      }
    });
    return;
  }
  if (error instanceof ZodError) {
    res.status(400).json({
      error: {
        code: "INVALID_REQUEST",
        message: "요청 형식을 확인해 주세요.",
        details: { issues: error.issues }
      }
    });
    return;
  }
  console.error("Unhandled API error", {
    method: req.method,
    path: req.path,
    name: error instanceof Error ? error.name : "UnknownError",
    message: error instanceof Error ? error.message : String(error),
    code:
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : undefined
  });
  res.status(500).json({
    error: {
      code: "INTERNAL_SERVER_ERROR",
      message: "API 서버에서 오류가 발생했습니다."
    }
  });
};

app.use(errorHandler);

const port = Number(process.env.PORT ?? 4010);
const host = process.env.DAMO_HOST ?? "127.0.0.1";
const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";

if (import.meta.url === entry) {
  if (servesWeb && !existsSync(webIndexPath)) {
    throw new Error(
      `웹 빌드 결과를 찾을 수 없습니다: ${webIndexPath}. 먼저 pnpm build:render를 실행해 주세요.`
    );
  }

  app.listen(port, host, () => {
    console.log(`DAMO preview: http://${host}:${port}`);
  });
}
