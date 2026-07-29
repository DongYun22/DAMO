# PostgresStore Write-Path Lightening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the highest-impact methods in `apps/mock-api/src/postgres-store.ts` (`lookupMeeting`, `joinMeeting`, `createMeeting`, `deleteMeeting`, `createVote`, `closeVote`, `finalSelection`) plus their shared dependency `voteResults`, off the full-database-snapshot `read()`/`write()` pattern and onto scoped, indexed SQL. Measured against the Render deployment: `lookupMeeting` (a `read()`) took ~1.1–1.24s; `createMeeting` and `deleteMeeting` (both `write()`, which re-saves every table) took ~30s each. `deleteMeeting` was added to this batch after that measurement — its business logic is a single status flip, so converting it is low-risk and high-payoff.

**Architecture:** Add a `withMeetingLock(meetingId, operation)` transaction helper (per-meeting `pg_advisory_xact_lock`) and reuse it across both the two already-converted methods (`replaceMyCandidates`, `saveChoice`) and the eight new conversions. Add a `computeVoteResults` SQL helper (targeted queries + the exact same in-memory ranking algorithm as `store.ts`) shared by `voteResults`, `closeVote`, `finalSelection`. Add a `createNextRecurringOccurrence` SQL helper shared by `closeVote`/`finalSelection` for recurring-meeting rollover.

**Tech Stack:** Node.js `pg` driver (raw SQL, no ORM), `node:test`, TypeScript, Supabase PostgreSQL.

---

## Task 0: Prerequisite — test Supabase project (human step, not automatable)

This plan adds Postgres-backed tests that must run against a real database that is **not** the Render/production database. This step cannot be done by an agent (it requires a Supabase account) — a human must do it before Task 2's tests can run for real, but Tasks 0–1 and the SQL-writing parts of every later task can proceed without it (the new test suite self-skips if the env var is absent).

- [ ] **Step 1: Create a separate Supabase project**

Go to https://supabase.com/dashboard and create a new project dedicated to testing (not the `fdidwlxtravwznpsbwmc` project used by Render). Any region/plan works; this holds throwaway data only.

- [ ] **Step 2: Get the connection string**

In the new project: `Connect → Direct → Connection string → Session pooler`. Copy it.

- [ ] **Step 3: Add it to `apps/mock-api/.env.local`**

```env
TEST_DATABASE_URL=postgresql://postgres.<new-project-ref>:<password>@<region>.pooler.supabase.com:5432/postgres
```

- [ ] **Step 4: Apply migrations to the test project**

```bash
DATABASE_URL="$TEST_DATABASE_URL" pnpm --filter @damo/mock-api db:migrate
```

(Or temporarily set `TEST_DATABASE_URL`'s value as `DATABASE_URL` in `.env.local`, run `pnpm db:migrate`, then move it back to `TEST_DATABASE_URL` — either works, this just needs the schema from `apps/mock-api/migrations/` applied once.)

---

## Task 1: Export `nextRecurringMeetingAt` from `store.ts`

**Files:**
- Modify: `apps/mock-api/src/store.ts:142`

`postgres-store.ts` needs this pure date-math function later (Task 9) to compute the next occurrence date without reimplementing Korea-timezone month/week arithmetic in SQL.

- [ ] **Step 1: Export the function**

In `apps/mock-api/src/store.ts`, change line 142 from:

```ts
const nextRecurringMeetingAt = (
```

to:

```ts
export const nextRecurringMeetingAt = (
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @damo/mock-api typecheck`
Expected: no errors (this is a pure export addition, nothing consumes it yet).

- [ ] **Step 3: Commit**

```bash
git add apps/mock-api/src/store.ts
git commit -m "Export nextRecurringMeetingAt for reuse in PostgresStore"
```

---

## Task 2: Postgres integration test harness

**Files:**
- Create: `apps/mock-api/src/postgres-store.test.ts`
- Modify: `apps/mock-api/package.json:14`

- [ ] **Step 1: Write the test file skeleton**

```ts
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { PostgresStore } from "./postgres-store.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

describe("PostgresStore (integration)", { skip: !testDatabaseUrl }, () => {
  let store: PostgresStore;

  before(() => {
    process.env.DATABASE_URL = testDatabaseUrl;
    store = new PostgresStore();
  });

  beforeEach(async () => {
    await store.reset();
  });

  after(async () => {
    await store.close();
  });

  it("connects to the test database", async () => {
    await store.healthCheck();
  });
});
```

- [ ] **Step 2: Wire it into the test script**

In `apps/mock-api/package.json`, change line 14 from:

```json
    "test": "tsx --test src/server.test.ts src/naver-search.test.ts"
```

to:

```json
    "test": "tsx --test src/server.test.ts src/naver-search.test.ts src/postgres-store.test.ts"
```

- [ ] **Step 3: Run without `TEST_DATABASE_URL` — confirm it skips cleanly**

Run: `pnpm test:api`
Expected: all existing tests pass, and output shows the new `PostgresStore (integration)` suite as skipped (not failed).

- [ ] **Step 4: Run with `TEST_DATABASE_URL` — confirm it connects**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" pnpm --filter @damo/mock-api test`
(reads the value you put in `.env.local` in Task 0 — if your shell doesn't auto-load `.env.local`, export it manually first)
Expected: `PostgresStore (integration) > connects to the test database` passes.

If this fails with a connection error, stop and fix the `TEST_DATABASE_URL` / migration setup (Task 0) before continuing — every later task's tests depend on this working.

- [ ] **Step 5: Commit**

```bash
git add apps/mock-api/src/postgres-store.test.ts apps/mock-api/package.json
git commit -m "Add Postgres-backed integration test harness"
```

---

## Task 3: `withMeetingLock` helper + migrate existing SQL methods onto it

**Files:**
- Modify: `apps/mock-api/src/postgres-store.ts:909` (insert helper before `read`)
- Modify: `apps/mock-api/src/postgres-store.ts` (`replaceMyCandidates`, `saveChoice`)
- Test: `apps/mock-api/src/postgres-store.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/mock-api/src/postgres-store.test.ts` (inside the `describe` block, after the existing `it`):

```ts
  it("replaceMyCandidates and saveChoice still work after the lock refactor", async () => {
    const host = await store.signup("host-lock", "호스트", "pw1234");
    const guest = await store.signup("guest-lock", "게스트", "pw1234");
    const meeting = await store.createMeeting(host.user.id, {
      name: "락 테스트",
      capacity: 4,
      meetingAt: "2026-08-01T10:00:00+09:00",
      purpose: "CAFE",
      mood: "FUN"
    });
    const joined = await store.joinMeeting(
      guest.user.id,
      meeting.id,
      meeting.joinCode!,
      "게스트닉"
    );
    assert.equal(joined.members.length, 2);

    const [placeA] = await store.upsertPlaces([
      {
        id: "place-lock-a",
        naverPlaceId: "naver-lock-a",
        name: "A카페",
        category: "카페",
        address: "서울",
        roadAddress: "서울",
        latitude: 37.5,
        longitude: 127.0,
        station: "강남",
        distanceText: "1분"
      }
    ]);
    const [placeB] = await store.upsertPlaces([
      {
        id: "place-lock-b",
        naverPlaceId: "naver-lock-b",
        name: "B카페",
        category: "카페",
        address: "서울",
        roadAddress: "서울",
        latitude: 37.6,
        longitude: 127.1,
        station: "역삼",
        distanceText: "2분"
      }
    ]);
    const hostPlace = await store.registerUserPlace(
      host.user.id,
      placeA!.naverPlaceId,
      "CAFE",
      "FUN"
    );
    const guestPlace = await store.registerUserPlace(
      guest.user.id,
      placeB!.naverPlaceId,
      "CAFE",
      "FUN"
    );

    const hostCandidates = await store.replaceMyCandidates(meeting.id, host.user.id, [
      hostPlace.id
    ]);
    assert.equal(hostCandidates.length, 1);
    const guestCandidates = await store.replaceMyCandidates(meeting.id, guest.user.id, [
      guestPlace.id
    ]);
    assert.equal(guestCandidates.length, 2);

    const vote = await store.createVote(meeting.id, host.user.id);
    const session = await store.voteSession(meeting.id, host.user.id);
    assert.ok(session.round);
    const saved = await store.saveChoice(
      meeting.id,
      host.user.id,
      1,
      session.round!.candidateA.id
    );
    assert.equal(saved.completedRounds, 1);
    assert.equal(vote.voteId.length > 0, true);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" pnpm --filter @damo/mock-api test`
Expected: FAIL — at this point `createVote` still uses the old `write()` path so it should actually still pass functionally. The point of this test is to lock in current behavior *before* refactoring the lock, so if it already passes, that's fine — proceed to Step 3 and re-run after the refactor to confirm no regression.

- [ ] **Step 3: Add the `withMeetingLock` helper**

In `apps/mock-api/src/postgres-store.ts`, insert immediately before `private async read<T>` (currently line 909):

```ts
  private async withMeetingLock<T>(
    meetingId: string,
    operation: (client: PoolClient) => Promise<T>
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        "select pg_advisory_xact_lock(hashtext($1))",
        [`meeting:${meetingId}`]
      );
      const result = await operation(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

```

- [ ] **Step 4: Migrate `replaceMyCandidates` onto the helper**

Replace the whole `replaceMyCandidates` method body (currently uses `candidate:${meetingId}` lock and manual `client.connect()`/`begin`/`commit`/`rollback`/`release`) with:

```ts
  async replaceMyCandidates(
    meetingId: string,
    userId: string,
    userPlaceIds: string[]
  ) {
    const uniqueIds = [...new Set(userPlaceIds)];
    if (uniqueIds.length > 2) {
      throw new StoreError(422, "CANDIDATE_LIMIT_EXCEEDED", "후보는 최대 2개까지 선택할 수 있습니다.");
    }
    await this.withMeetingLock(meetingId, async (client) => {
      const context = await client.query<{
        status: MeetingStatus;
        memberId: string;
      }>(
        `
          select m.status, member.id as "memberId"
          from meetings m
          join meeting_members member
            on member.meeting_id = m.id
            and member.user_id = $2
            and member.status = 'ACTIVE'
          where m.id = $1 and m.status <> 'DELETED'
        `,
        [meetingId, userId]
      );
      const meeting = context.rows[0];
      if (!meeting) {
        throw new StoreError(403, "MEETING_ACCESS_DENIED", "모임원이 아닙니다.");
      }
      if (meeting.status !== "RECRUITING") {
        throw new StoreError(409, "CANDIDATES_FROZEN", "투표가 시작되어 후보를 변경할 수 없습니다.");
      }
      const places = uniqueIds.length
        ? await client.query<{
            userPlaceId: string;
            placeId: string;
            purpose: Purpose;
            mood: Mood;
          }>(
            `
              select
                id as "userPlaceId",
                place_id as "placeId",
                purpose,
                mood
              from user_places
              where user_id = $1 and is_active = true and id = any($2::text[])
            `,
            [userId, uniqueIds]
          )
        : { rows: [] };
      if (places.rows.length !== uniqueIds.length) {
        throw new StoreError(422, "PLACE_NOT_FOUND_IN_MY_PLACES", "내 장소에서 선택할 수 없는 장소입니다.");
      }
      await client.query(
        `
          delete from candidate_recommendations recommendation
          using meeting_candidates candidate
          where recommendation.candidate_id = candidate.id
            and candidate.meeting_id = $1
            and recommendation.member_id = $2
        `,
        [meetingId, meeting.memberId]
      );
      await client.query(
        `
          delete from meeting_candidates candidate
          where candidate.meeting_id = $1
            and not exists (
              select 1
              from candidate_recommendations recommendation
              where recommendation.candidate_id = candidate.id
            )
        `,
        [meetingId]
      );
      for (const place of places.rows) {
        const candidate = await client.query<{ id: string }>(
          `
            insert into meeting_candidates (id, meeting_id, place_id, is_frozen)
            values ($1, $2, $3, false)
            on conflict (meeting_id, place_id) do update set
              is_frozen = meeting_candidates.is_frozen
            returning id
          `,
          [randomUUID(), meetingId, place.placeId]
        );
        await client.query(
          `
            insert into candidate_recommendations (
              candidate_id, member_id, user_place_id, purpose, mood
            )
            values ($1, $2, $3, $4, $5)
            on conflict (candidate_id, member_id) do update set
              user_place_id = excluded.user_place_id,
              purpose = excluded.purpose,
              mood = excluded.mood
          `,
          [
            candidate.rows[0]!.id,
            meeting.memberId,
            place.userPlaceId,
            place.purpose,
            place.mood
          ]
        );
      }
      await client.query("update meetings set updated_at = now() where id = $1", [
        meetingId
      ]);
    });
    return this.publicCandidates(meetingId, userId);
  }
```

- [ ] **Step 5: Migrate `saveChoice` onto the helper**

Replace the whole `saveChoice` method body (currently uses the global `damo-store-write` lock) with:

```ts
  async saveChoice(
    meetingId: string,
    userId: string,
    roundNumber: number,
    selectedCandidateId: string
  ) {
    await this.withMeetingLock(meetingId, async (client) => {
      const meetingResult = await client.query<{ status: MeetingStatus }>(
        `
          select status
          from meetings
          where id = $1 and deleted_at is null
          for update
        `,
        [meetingId]
      );
      const meeting = meetingResult.rows[0];
      if (!meeting) {
        throw new StoreError(404, "MEETING_NOT_FOUND", "모임을 찾을 수 없습니다.");
      }
      if (meeting.status !== "VOTING") {
        throw new StoreError(409, "VOTE_CLOSED", "투표가 종료되었습니다.");
      }

      const sessionResult = await client.query<VoteSessionQueryRow>(
        `
          select
            id,
            status,
            total_rounds as "totalRounds",
            completed_rounds as "completedRounds",
            candidate_order as "candidateOrder",
            current_winner_candidate_id as "currentWinnerCandidateId"
          from vote_sessions
          where meeting_id = $1 and user_id = $2
          for update
        `,
        [meetingId, userId]
      );
      const session = sessionResult.rows[0];
      if (!session) {
        throw new StoreError(
          404,
          "VOTE_SESSION_NOT_FOUND",
          "개인 투표 세션을 찾을 수 없습니다."
        );
      }

      const existingChoice = await client.query(
        `
          select 1
          from vote_choices
          where session_id = $1 and round_number = $2
        `,
        [session.id, roundNumber]
      );
      if (existingChoice.rowCount === 0) {
        const currentRoundNumber = session.completedRounds + 1;
        const nextCandidateId = session.candidateOrder[currentRoundNumber];
        const currentWinnerId =
          session.currentWinnerCandidateId ?? session.candidateOrder[0];
        if (
          session.status === "COMPLETED" ||
          roundNumber !== currentRoundNumber ||
          !nextCandidateId ||
          !currentWinnerId
        ) {
          throw new StoreError(
            409,
            "INVALID_ROUND",
            "현재 진행할 차례가 아닌 라운드입니다."
          );
        }

        const swap = currentRoundNumber % 2 === 0;
        const candidateAId = swap ? nextCandidateId : currentWinnerId;
        const candidateBId = swap ? currentWinnerId : nextCandidateId;
        if (
          selectedCandidateId !== candidateAId &&
          selectedCandidateId !== candidateBId
        ) {
          throw new StoreError(
            422,
            "INVALID_SELECTED_CANDIDATE",
            "A 또는 B 후보 중 하나를 선택해야 합니다."
          );
        }

        const completedRounds = session.completedRounds + 1;
        const status: VoteSessionView["status"] =
          completedRounds >= session.totalRounds ? "COMPLETED" : "IN_PROGRESS";
        await client.query(
          `
            insert into vote_choices (
              session_id,
              round_number,
              candidate_a_id,
              candidate_b_id,
              selected_candidate_id
            )
            values ($1, $2, $3, $4, $5)
          `,
          [session.id, roundNumber, candidateAId, candidateBId, selectedCandidateId]
        );
        await client.query(
          `
            update vote_sessions
            set
              status = $2,
              completed_rounds = $3,
              current_winner_candidate_id = $4,
              updated_at = now()
            where id = $1
          `,
          [session.id, status, completedRounds, selectedCandidateId]
        );
        await client.query(
          "update meetings set updated_at = now() where id = $1",
          [meetingId]
        );
      }
    });
    return this.voteSession(meetingId, userId);
  }
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" pnpm --filter @damo/mock-api test`
Expected: PASS.

- [ ] **Step 7: Typecheck and run the full memory-store suite too**

Run: `pnpm --filter @damo/mock-api typecheck && pnpm test:api`
Expected: both pass (this refactor must not change behavior against the existing memory-store tests either, since `store.ts` wasn't touched).

- [ ] **Step 8: Commit**

```bash
git add apps/mock-api/src/postgres-store.ts apps/mock-api/src/postgres-store.test.ts
git commit -m "Unify PostgresStore locking onto a per-meeting withMeetingLock helper"
```

---

## Task 4: `computeVoteResults` SQL helper + convert `voteResults()`

**Files:**
- Modify: `apps/mock-api/src/postgres-store.ts` (imports, new private helper, `voteResults` method)
- Test: `apps/mock-api/src/postgres-store.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/mock-api/src/postgres-store.test.ts`:

```ts
  it("computes vote results with correct ranking and tie detection", async () => {
    const host = await store.signup("host-results", "호스트", "pw1234");
    const guest = await store.signup("guest-results", "게스트", "pw1234");
    const meeting = await store.createMeeting(host.user.id, {
      name: "결과 테스트",
      capacity: 4,
      meetingAt: "2026-08-01T10:00:00+09:00",
      purpose: "MEAL",
      mood: "FUN"
    });
    await store.joinMeeting(guest.user.id, meeting.id, meeting.joinCode!, "게스트닉");

    const [placeA] = await store.upsertPlaces([
      {
        id: "place-results-a",
        naverPlaceId: "naver-results-a",
        name: "가나다식당",
        category: "식당",
        address: "서울",
        roadAddress: "서울",
        latitude: 37.5,
        longitude: 127.0,
        station: "강남",
        distanceText: "1분"
      }
    ]);
    const [placeB] = await store.upsertPlaces([
      {
        id: "place-results-b",
        naverPlaceId: "naver-results-b",
        name: "마바사식당",
        category: "식당",
        address: "서울",
        roadAddress: "서울",
        latitude: 37.6,
        longitude: 127.1,
        station: "역삼",
        distanceText: "2분"
      }
    ]);
    const hostPlace = await store.registerUserPlace(
      host.user.id,
      placeA!.naverPlaceId,
      "MEAL",
      "FUN"
    );
    const guestPlace = await store.registerUserPlace(
      guest.user.id,
      placeB!.naverPlaceId,
      "MEAL",
      "FUN"
    );
    await store.replaceMyCandidates(meeting.id, host.user.id, [hostPlace.id]);
    await store.replaceMyCandidates(meeting.id, guest.user.id, [guestPlace.id]);
    await store.createVote(meeting.id, host.user.id);

    const hostSession = await store.voteSession(meeting.id, host.user.id);
    await store.saveChoice(meeting.id, host.user.id, 1, hostSession.round!.candidateA.id);
    const guestSession = await store.voteSession(meeting.id, guest.user.id);
    await store.saveChoice(meeting.id, guest.user.id, 1, guestSession.round!.candidateA.id);

    const results = await store.voteResults(meeting.id, host.user.id);
    assert.equal(results.totalMembers, 2);
    assert.equal(results.completedMembers, 2);
    assert.equal(results.incompleteMembers, 0);
    assert.equal(
      results.results.reduce((sum, item) => sum + item.voteCount, 0),
      2
    );
    assert.equal(results.results.filter((item) => item.rank === 1).length >= 1, true);
  });
```

- [ ] **Step 2: Run test to verify current behavior (should already pass — this locks in the contract before refactoring the implementation)**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" pnpm --filter @damo/mock-api test`
Expected: PASS (still using the old `read()` snapshot path). Keep this test — it will now guard the upcoming refactor.

- [ ] **Step 3: Add `VoteResults` and `VoteStatus` to the contracts import**

In `apps/mock-api/src/postgres-store.ts`, change the `@damo/contracts` import block (currently lines 3–18) to add `VoteResults` and `VoteStatus`:

```ts
import type {
  Candidate,
  CreateMeetingInput,
  EligiblePlace,
  HomeData,
  MeetingDetail,
  MeetingStatus,
  Mood,
  Place,
  Purpose,
  RecurrenceType,
  RepeatMeetingInput,
  User,
  UserPlace,
  VoteResults,
  VoteSessionView,
  VoteStatus
} from "@damo/contracts";
```

- [ ] **Step 4: Add the `computeVoteResults` helper**

Insert immediately after the `voteSessionWithClient` method (currently ends at line 267, before `private async queryUserPlaces`):

```ts
  private async computeVoteResults(
    client: PoolClient,
    meetingId: string,
    userId: string
  ): Promise<VoteResults> {
    const meetingResult = await client.query<{
      status: MeetingStatus;
      finalCandidateId: string | null;
    }>(
      `
        select status, final_candidate_id as "finalCandidateId"
        from meetings
        where id = $1 and status <> 'DELETED'
      `,
      [meetingId]
    );
    const meeting = meetingResult.rows[0];
    if (!meeting) {
      throw new StoreError(404, "MEETING_NOT_FOUND", "모임을 찾을 수 없습니다.");
    }

    const memberResult = await client.query(
      `
        select 1
        from meeting_members
        where meeting_id = $1 and user_id = $2 and status = 'ACTIVE'
      `,
      [meetingId, userId]
    );
    if (memberResult.rowCount === 0) {
      throw new StoreError(403, "MEETING_ACCESS_DENIED", "모임원이 아닙니다.");
    }

    const voteResult = await client.query<{ status: VoteStatus }>(
      `select status from votes where meeting_id = $1`,
      [meetingId]
    );
    const vote = voteResult.rows[0];
    if (!vote) {
      throw new StoreError(404, "VOTE_NOT_FOUND", "투표를 찾을 수 없습니다.");
    }

    const sessionResult = await client.query<{
      userId: string;
      status: "NOT_STARTED" | "IN_PROGRESS" | "COMPLETED";
    }>(
      `select user_id as "userId", status from vote_sessions where meeting_id = $1`,
      [meetingId]
    );
    const sessions = sessionResult.rows;

    const voteCountResult = await client.query<{ candidateId: string; voteCount: number }>(
      `
        select
          choice.selected_candidate_id as "candidateId",
          count(*)::int as "voteCount"
        from vote_choices choice
        join vote_sessions session on session.id = choice.session_id
        where session.meeting_id = $1
        group by choice.selected_candidate_id
      `,
      [meetingId]
    );
    const voteCounts = new Map(
      voteCountResult.rows.map((row) => [row.candidateId, row.voteCount])
    );

    const candidates = await this.queryPublicCandidates(client, meetingId, userId);
    const raw = candidates
      .map((candidate) => ({
        candidate,
        voteCount: voteCounts.get(candidate.id) ?? 0,
        recommendationCount: candidate.recommendationCount
      }))
      .sort(
        (a, b) =>
          b.voteCount - a.voteCount ||
          b.recommendationCount - a.recommendationCount ||
          a.candidate.place.name.localeCompare(b.candidate.place.name)
      );

    let previousKey = "";
    let rank = 0;
    const results = raw.map((item, index) => {
      const key = `${item.voteCount}:${item.recommendationCount}`;
      if (key !== previousKey) rank = index + 1;
      previousKey = key;
      const sameRankCount = raw.filter(
        (other) =>
          other.voteCount === item.voteCount &&
          other.recommendationCount === item.recommendationCount
      ).length;
      return {
        ...item,
        rank,
        isJointRank: sameRankCount > 1,
        isFinal: meeting.finalCandidateId === item.candidate.id
      };
    });

    const tiedFirstCandidateIds = results
      .filter((result) => result.rank === 1)
      .map((result) => result.candidate.id);
    const mySession = sessions.find((session) => session.userId === userId);

    return {
      meetingId,
      voteStatus: vote.status,
      meetingStatus: meeting.status,
      myVoteCompleted: mySession?.status === "COMPLETED",
      completedMembers: sessions.filter((session) => session.status === "COMPLETED").length,
      totalMembers: sessions.length,
      incompleteMembers: sessions.filter((session) => session.status !== "COMPLETED").length,
      results,
      tiedFirstCandidateIds,
      finalCandidateId: meeting.finalCandidateId,
      updatedAt: new Date().toISOString()
    };
  }

```

- [ ] **Step 5: Convert the public `voteResults` method**

Replace the current `voteResults` method:

```ts
  async voteResults(meetingId: string, userId: string) {
    return this.read((store) => store.voteResults(meetingId, userId));
  }
```

with:

```ts
  async voteResults(meetingId: string, userId: string) {
    const client = await this.pool.connect();
    try {
      return await this.computeVoteResults(client, meetingId, userId);
    } finally {
      client.release();
    }
  }
```

- [ ] **Step 6: Run the test to verify it still passes**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" pnpm --filter @damo/mock-api test`
Expected: PASS — same assertions, now served by targeted SQL instead of a full snapshot load.

- [ ] **Step 7: Typecheck**

Run: `pnpm --filter @damo/mock-api typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add apps/mock-api/src/postgres-store.ts apps/mock-api/src/postgres-store.test.ts
git commit -m "Convert voteResults to targeted SQL via computeVoteResults helper"
```

---

## Task 5: Convert `lookupMeeting` to SQL

**Files:**
- Modify: `apps/mock-api/src/postgres-store.ts`
- Test: `apps/mock-api/src/postgres-store.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
  it("looks up a meeting by join code without loading the whole database", async () => {
    const host = await store.signup("host-lookup", "호스트", "pw1234");
    const meeting = await store.createMeeting(host.user.id, {
      name: "조회 테스트",
      capacity: 2,
      meetingAt: "2026-08-01T10:00:00+09:00",
      purpose: "CAFE",
      mood: "QUIET"
    });

    const found = await store.lookupMeeting(meeting.joinCode!);
    assert.equal(found.id, meeting.id);
    assert.equal(found.currentMembers, 1);
    assert.equal(found.canJoin, true);

    await assert.rejects(() => store.lookupMeeting("0000"), (error: unknown) => {
      return (error as { code?: string }).code === "MEETING_NOT_FOUND";
    });
  });
```

- [ ] **Step 2: Run test to verify current behavior (should already pass)**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" pnpm --filter @damo/mock-api test`
Expected: PASS via the old `read()` path — this test now guards the conversion.

- [ ] **Step 3: Replace `lookupMeeting`**

```ts
  async lookupMeeting(joinCode: string) {
    const result = await this.pool.query<{
      id: string;
      name: string;
      purpose: Purpose;
      mood: Mood;
      meetingAt: Date | string;
      capacity: number;
      status: MeetingStatus;
      currentMembers: number;
    }>(
      `
        select
          m.id,
          m.name,
          m.purpose,
          m.mood,
          m.meeting_at as "meetingAt",
          m.capacity,
          m.status,
          (
            select count(*)::int
            from meeting_members active_member
            where active_member.meeting_id = m.id
              and active_member.status = 'ACTIVE'
          ) as "currentMembers"
        from meetings m
        where m.join_code = $1
          and m.status not in ('COMPLETED', 'DELETED')
        limit 1
      `,
      [joinCode]
    );
    const row = result.rows[0];
    if (!row) {
      throw new StoreError(404, "MEETING_NOT_FOUND", "가입 가능한 모임을 찾을 수 없습니다.");
    }
    return {
      id: row.id,
      name: row.name,
      purpose: row.purpose,
      mood: row.mood,
      meetingAt: timestamp(row.meetingAt),
      currentMembers: row.currentMembers,
      capacity: row.capacity,
      canJoin: row.status === "RECRUITING" && row.currentMembers < row.capacity
    };
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" pnpm --filter @damo/mock-api test`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @damo/mock-api typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/mock-api/src/postgres-store.ts apps/mock-api/src/postgres-store.test.ts
git commit -m "Convert lookupMeeting to a single targeted SQL query"
```

---

## Task 6: Convert `createMeeting` to SQL

**Files:**
- Modify: `apps/mock-api/src/postgres-store.ts`
- Test: `apps/mock-api/src/postgres-store.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
  it("creates a meeting with a unique join code and a host member", async () => {
    const host = await store.signup("host-create", "호스트", "pw1234");
    const meeting = await store.createMeeting(host.user.id, {
      name: "생성 테스트",
      capacity: 3,
      meetingAt: "2026-08-01T10:00:00+09:00",
      purpose: "DRINK",
      mood: "TIPSY"
    });

    assert.equal(meeting.hostUserId, host.user.id);
    assert.match(meeting.joinCode!, /^\d{4}$/);
    assert.equal(meeting.members.length, 1);
    assert.equal(meeting.members[0]!.role, "HOST");
    assert.equal(meeting.status, "RECRUITING");
  });
```

- [ ] **Step 2: Run test to verify current behavior (should already pass)**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" pnpm --filter @damo/mock-api test`
Expected: PASS via the old `write()` path.

- [ ] **Step 3: Add a join-code candidate generator and replace `createMeeting`**

Add this private method right after the class opens (after the constructor, currently line 113):

```ts
  private randomJoinCodeCandidate() {
    return Math.floor(1000 + Math.random() * 9000).toString();
  }

```

Replace the current `createMeeting`:

```ts
  async createMeeting(userId: string, input: CreateMeetingInput) {
    return this.write((store) => store.createMeeting(userId, input));
  }
```

with:

```ts
  async createMeeting(userId: string, input: CreateMeetingInput) {
    const client = await this.pool.connect();
    let meetingId = "";
    try {
      await client.query("begin");
      const userResult = await client.query<{ nickname: string }>(
        `select nickname from users where id = $1`,
        [userId]
      );
      const nickname = userResult.rows[0]?.nickname;
      if (!nickname) {
        throw new StoreError(401, "AUTH_REQUIRED", "로그인이 필요합니다.");
      }

      let inserted = false;
      for (let attempt = 0; attempt < 50 && !inserted; attempt += 1) {
        const candidateId = randomUUID();
        const joinCode = this.randomJoinCodeCandidate();
        try {
          await client.query(
            `
              insert into meetings (
                id, name, host_user_id, capacity, meeting_at, purpose, mood,
                join_code, status
              )
              values ($1, $2, $3, $4, $5, $6, $7, $8, 'RECRUITING')
            `,
            [
              candidateId,
              input.name,
              userId,
              input.capacity,
              input.meetingAt,
              input.purpose,
              input.mood,
              joinCode
            ]
          );
          meetingId = candidateId;
          inserted = true;
        } catch (error) {
          if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "23505"
          ) {
            continue;
          }
          throw error;
        }
      }
      if (!inserted) {
        throw new StoreError(500, "JOIN_CODE_EXHAUSTED", "가입 코드를 발급할 수 없습니다.");
      }

      await client.query(
        `
          insert into meeting_members (id, meeting_id, user_id, meeting_nickname, role, status)
          values ($1, $2, $3, $4, 'HOST', 'ACTIVE')
        `,
        [randomUUID(), meetingId, userId, nickname]
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    return this.detail(meetingId, userId);
  }
```

Note: the join-code retry is capped at 50 attempts (random 4-digit codes, collision only possible if a large fraction of the ~9000 codes are already active) rather than `store.ts`'s exhaustive 1000–9999 fallback scan — at this app's scale that fallback would never trigger, and 50 DB round-trips is already a generous safety margin. If `createMeeting` ever starts throwing `JOIN_CODE_EXHAUSTED` in practice, that means thousands of meetings are simultaneously active and this trade-off should be revisited.

- [ ] **Step 4: Run the test to verify it passes**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" pnpm --filter @damo/mock-api test`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @damo/mock-api typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/mock-api/src/postgres-store.ts apps/mock-api/src/postgres-store.test.ts
git commit -m "Convert createMeeting to targeted SQL with a bounded join-code retry"
```

---

## Task 7: Convert `deleteMeeting` to SQL

**Files:**
- Modify: `apps/mock-api/src/postgres-store.ts`
- Test: `apps/mock-api/src/postgres-store.test.ts`

Added to this batch after measuring `deleteMeeting` at ~30s against the Render deployment (same `write()` full-snapshot pattern as the other conversions, but the logic itself is trivial — a single status flip — so the risk of converting it is low).

- [ ] **Step 1: Write the failing test**

```ts
  it("deletes a meeting and rejects non-hosts", async () => {
    const host = await store.signup("host-delete", "호스트", "pw1234");
    const guest = await store.signup("guest-delete", "게스트", "pw1234");
    const meeting = await store.createMeeting(host.user.id, {
      name: "삭제 테스트",
      capacity: 2,
      meetingAt: "2026-08-01T10:00:00+09:00",
      purpose: "STUDY",
      mood: "QUIET"
    });
    await store.joinMeeting(guest.user.id, meeting.id, meeting.joinCode!, "게스트닉");

    await assert.rejects(
      () => store.deleteMeeting(meeting.id, guest.user.id),
      (error: unknown) => (error as { code?: string }).code === "HOST_ONLY"
    );

    const result = await store.deleteMeeting(meeting.id, host.user.id);
    assert.equal(result.deleted, true);

    await assert.rejects(
      () => store.detail(meeting.id, host.user.id),
      (error: unknown) => (error as { code?: string }).code === "MEETING_ACCESS_DENIED"
    );
  });
```

- [ ] **Step 2: Run test to verify current behavior (should already pass)**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" pnpm --filter @damo/mock-api test`
Expected: PASS via the old `write()` path — this test now guards the conversion.

- [ ] **Step 3: Replace `deleteMeeting`**

```ts
  async deleteMeeting(meetingId: string, userId: string) {
    return this.withMeetingLock(meetingId, async (client) => {
      const result = await client.query<{ hostUserId: string }>(
        `
          select host_user_id as "hostUserId"
          from meetings
          where id = $1 and status <> 'DELETED'
        `,
        [meetingId]
      );
      const meeting = result.rows[0];
      if (!meeting) {
        throw new StoreError(404, "MEETING_NOT_FOUND", "모임을 찾을 수 없습니다.");
      }
      if (meeting.hostUserId !== userId) {
        throw new StoreError(403, "HOST_ONLY", "모임장만 실행할 수 있습니다.");
      }
      await client.query(
        `
          update meetings
          set status = 'DELETED', deleted_at = now(), updated_at = now()
          where id = $1
        `,
        [meetingId]
      );
      return { meetingId, deleted: true };
    });
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" pnpm --filter @damo/mock-api test`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @damo/mock-api typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/mock-api/src/postgres-store.ts apps/mock-api/src/postgres-store.test.ts
git commit -m "Convert deleteMeeting to targeted SQL"
```

---

## Task 8: Convert `joinMeeting` to SQL

**Files:**
- Modify: `apps/mock-api/src/postgres-store.ts`
- Test: `apps/mock-api/src/postgres-store.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
  it("joins a meeting, rejects wrong codes, and enforces capacity", async () => {
    const host = await store.signup("host-join", "호스트", "pw1234");
    const guest = await store.signup("guest-join", "게스트", "pw1234");
    const bystander = await store.signup("bystander-join", "구경꾼", "pw1234");
    const meeting = await store.createMeeting(host.user.id, {
      name: "가입 테스트",
      capacity: 2,
      meetingAt: "2026-08-01T10:00:00+09:00",
      purpose: "STUDY",
      mood: "BUSINESS"
    });

    await assert.rejects(
      () => store.joinMeeting(guest.user.id, meeting.id, "0000", "게스트닉"),
      (error: unknown) => (error as { code?: string }).code === "INVALID_JOIN_CODE"
    );

    const joined = await store.joinMeeting(
      guest.user.id,
      meeting.id,
      meeting.joinCode!,
      "게스트닉"
    );
    assert.equal(joined.members.length, 2);

    await assert.rejects(
      () => store.joinMeeting(bystander.user.id, meeting.id, meeting.joinCode!, "구경꾼닉"),
      (error: unknown) => (error as { code?: string }).code === "MEETING_CAPACITY_EXCEEDED"
    );
  });
```

- [ ] **Step 2: Run test to verify current behavior (should already pass)**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" pnpm --filter @damo/mock-api test`
Expected: PASS via the old `write()` path.

- [ ] **Step 3: Replace `joinMeeting`**

```ts
  async joinMeeting(
    userId: string,
    meetingId: string,
    joinCode: string,
    meetingNickname: string
  ) {
    await this.withMeetingLock(meetingId, async (client) => {
      const meetingResult = await client.query<{
        joinCode: string;
        status: MeetingStatus;
        capacity: number;
      }>(
        `
          select join_code as "joinCode", status, capacity
          from meetings
          where id = $1 and status <> 'DELETED'
        `,
        [meetingId]
      );
      const meeting = meetingResult.rows[0];
      if (!meeting) {
        throw new StoreError(404, "MEETING_NOT_FOUND", "모임을 찾을 수 없습니다.");
      }
      if (meeting.joinCode !== joinCode) {
        throw new StoreError(422, "INVALID_JOIN_CODE", "가입 코드가 올바르지 않습니다.");
      }
      if (meeting.status !== "RECRUITING") {
        throw new StoreError(409, "MEETING_NOT_RECRUITING", "이미 투표가 시작된 모임입니다.");
      }

      const existingResult = await client.query<{ id: string }>(
        `select id from meeting_members where meeting_id = $1 and user_id = $2`,
        [meetingId, userId]
      );
      const existing = existingResult.rows[0];

      if (!existing) {
        const countResult = await client.query<{ count: number }>(
          `
            select count(*)::int as count
            from meeting_members
            where meeting_id = $1 and status = 'ACTIVE'
          `,
          [meetingId]
        );
        if ((countResult.rows[0]?.count ?? 0) >= meeting.capacity) {
          throw new StoreError(409, "MEETING_CAPACITY_EXCEEDED", "모임 정원이 모두 찼습니다.");
        }
        await client.query(
          `
            insert into meeting_members (id, meeting_id, user_id, meeting_nickname, role, status)
            values ($1, $2, $3, $4, 'MEMBER', 'ACTIVE')
          `,
          [randomUUID(), meetingId, userId, meetingNickname]
        );
      } else {
        await client.query(
          `
            update meeting_members
            set status = 'ACTIVE', meeting_nickname = $2, joined_at = now()
            where id = $1
          `,
          [existing.id, meetingNickname]
        );
      }

      await client.query("update meetings set updated_at = now() where id = $1", [meetingId]);
    });
    return this.detail(meetingId, userId);
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" pnpm --filter @damo/mock-api test`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @damo/mock-api typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/mock-api/src/postgres-store.ts apps/mock-api/src/postgres-store.test.ts
git commit -m "Convert joinMeeting to targeted SQL under the per-meeting lock"
```

---

## Task 9: Convert `createVote` to SQL

**Files:**
- Modify: `apps/mock-api/src/postgres-store.ts`
- Test: `apps/mock-api/src/postgres-store.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
  it("creates a vote with frozen candidates and rotated N-1 sessions", async () => {
    const host = await store.signup("host-vote", "호스트", "pw1234");
    const guest = await store.signup("guest-vote", "게스트", "pw1234");
    const meeting = await store.createMeeting(host.user.id, {
      name: "투표 생성 테스트",
      capacity: 2,
      meetingAt: "2026-08-01T10:00:00+09:00",
      purpose: "MEAL",
      mood: "FUN"
    });
    await store.joinMeeting(guest.user.id, meeting.id, meeting.joinCode!, "게스트닉");

    const [placeA] = await store.upsertPlaces([
      {
        id: "place-vote-a",
        naverPlaceId: "naver-vote-a",
        name: "가식당",
        category: "식당",
        address: "서울",
        roadAddress: "서울",
        latitude: 37.5,
        longitude: 127.0,
        station: "강남",
        distanceText: "1분"
      }
    ]);
    const [placeB] = await store.upsertPlaces([
      {
        id: "place-vote-b",
        naverPlaceId: "naver-vote-b",
        name: "나식당",
        category: "식당",
        address: "서울",
        roadAddress: "서울",
        latitude: 37.6,
        longitude: 127.1,
        station: "역삼",
        distanceText: "2분"
      }
    ]);
    const [placeC] = await store.upsertPlaces([
      {
        id: "place-vote-c",
        naverPlaceId: "naver-vote-c",
        name: "다식당",
        category: "식당",
        address: "서울",
        roadAddress: "서울",
        latitude: 37.7,
        longitude: 127.2,
        station: "홍대",
        distanceText: "3분"
      }
    ]);
    const hostPlaceA = await store.registerUserPlace(host.user.id, placeA!.naverPlaceId, "MEAL", "FUN");
    const hostPlaceB = await store.registerUserPlace(host.user.id, placeB!.naverPlaceId, "MEAL", "FUN");
    const guestPlaceC = await store.registerUserPlace(guest.user.id, placeC!.naverPlaceId, "MEAL", "FUN");
    await store.replaceMyCandidates(meeting.id, host.user.id, [hostPlaceA.id, hostPlaceB.id]);
    await store.replaceMyCandidates(meeting.id, guest.user.id, [guestPlaceC.id]);

    await assert.rejects(
      () => store.createVote(meeting.id, guest.user.id),
      (error: unknown) => (error as { code?: string }).code === "HOST_ONLY"
    );

    const { meeting: detail, voteId } = await store.createVote(meeting.id, host.user.id);
    assert.equal(detail.status, "VOTING");
    assert.ok(voteId);
    assert.equal(
      detail.candidates.every((candidate) => candidate.isFrozen),
      true
    );

    const hostSession = await store.voteSession(meeting.id, host.user.id);
    assert.equal(hostSession.totalRounds, 2);
    const guestSession = await store.voteSession(meeting.id, guest.user.id);
    assert.equal(guestSession.totalRounds, 2);

    await assert.rejects(
      () => store.createVote(meeting.id, host.user.id),
      (error: unknown) => (error as { code?: string }).code === "VOTE_ALREADY_CREATED"
    );
  });
```

- [ ] **Step 2: Run test to verify current behavior (should already pass)**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" pnpm --filter @damo/mock-api test`
Expected: PASS via the old `write()` path.

- [ ] **Step 3: Replace `createVote`**

```ts
  async createVote(meetingId: string, userId: string) {
    const voteId = await this.withMeetingLock(meetingId, async (client) => {
      const meetingResult = await client.query<{
        status: MeetingStatus;
        hostUserId: string;
      }>(
        `
          select status, host_user_id as "hostUserId"
          from meetings
          where id = $1 and status <> 'DELETED'
        `,
        [meetingId]
      );
      const meeting = meetingResult.rows[0];
      if (!meeting) {
        throw new StoreError(404, "MEETING_NOT_FOUND", "모임을 찾을 수 없습니다.");
      }
      if (meeting.hostUserId !== userId) {
        throw new StoreError(403, "HOST_ONLY", "모임장만 실행할 수 있습니다.");
      }
      if (meeting.status !== "RECRUITING") {
        throw new StoreError(409, "VOTE_ALREADY_CREATED", "이미 투표가 생성됐습니다.");
      }

      const candidateResult = await client.query<{ id: string }>(
        `
          select distinct candidate.id
          from meeting_candidates candidate
          join candidate_recommendations recommendation
            on recommendation.candidate_id = candidate.id
          where candidate.meeting_id = $1
          order by candidate.id
        `,
        [meetingId]
      );
      const candidateIds = candidateResult.rows.map((row) => row.id);
      if (candidateIds.length < 2) {
        throw new StoreError(422, "NOT_ENOUGH_CANDIDATES", "투표 후보가 2개 이상 필요합니다.");
      }

      await client.query(
        `update meeting_candidates set is_frozen = true where id = any($1::text[])`,
        [candidateIds]
      );

      const newVoteId = randomUUID();
      await client.query(
        `insert into votes (id, meeting_id, status) values ($1, $2, 'OPEN')`,
        [newVoteId, meetingId]
      );

      const memberResult = await client.query<{ id: string; userId: string }>(
        `
          select id, user_id as "userId"
          from meeting_members
          where meeting_id = $1 and status = 'ACTIVE'
          order by case when role = 'HOST' then 0 else 1 end, joined_at
        `,
        [meetingId]
      );

      for (const [index, member] of memberResult.rows.entries()) {
        const offset = index % candidateIds.length;
        const rotated = [...candidateIds.slice(offset), ...candidateIds.slice(0, offset)];
        await client.query(
          `
            insert into vote_sessions (
              id, vote_id, meeting_id, member_id, user_id, status,
              total_rounds, completed_rounds, candidate_order
            )
            values ($1, $2, $3, $4, $5, 'NOT_STARTED', $6, 0, $7::text[])
          `,
          [
            randomUUID(),
            newVoteId,
            meetingId,
            member.id,
            member.userId,
            candidateIds.length - 1,
            rotated
          ]
        );
      }

      await client.query(
        `update meetings set status = 'VOTING', updated_at = now() where id = $1`,
        [meetingId]
      );

      return newVoteId;
    });

    return { meeting: await this.detail(meetingId, userId), voteId };
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" pnpm --filter @damo/mock-api test`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @damo/mock-api typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/mock-api/src/postgres-store.ts apps/mock-api/src/postgres-store.test.ts
git commit -m "Convert createVote to targeted SQL with rotated per-member sessions"
```

---

## Task 10: `createNextRecurringOccurrence` SQL helper

**Files:**
- Modify: `apps/mock-api/src/postgres-store.ts` (imports, new private helper)

No standalone test here — this helper has no public entry point yet (Tasks 10–11 wire it in and test it end-to-end through `closeVote`/`finalSelection`).

- [ ] **Step 1: Import `nextRecurringMeetingAt` from `store.ts`**

In `apps/mock-api/src/postgres-store.ts`, change the `./store.js` import block (currently lines 21–33) to add `nextRecurringMeetingAt`:

```ts
import {
  MockStore,
  StoreError,
  nextRecurringMeetingAt,
  type CandidateRecord,
  type ChoiceRecord,
  type MeetingRecord,
  type MemberRecord,
  type RecommendationRecord,
  type StoreSnapshot,
  type UserRecord,
  type VoteRecord,
  type VoteSessionRecord
} from "./store.js";
```

- [ ] **Step 2: Add the helper**

Insert immediately after `withMeetingLock` (added in Task 3, right before `private async read<T>`):

```ts
  private async createNextRecurringOccurrence(
    client: PoolClient,
    meeting: {
      id: string;
      name: string;
      hostUserId: string;
      capacity: number;
      meetingAt: string;
      purpose: Purpose;
      mood: Mood;
      joinCode: string;
      seriesId: string | null;
      recurrenceType: RecurrenceType | null;
      recurrenceNextAt: string | null;
      nextMeetingId: string | null;
    }
  ) {
    if (!meeting.recurrenceType || meeting.nextMeetingId) return;
    const meetingAt =
      meeting.recurrenceType === "CUSTOM"
        ? meeting.recurrenceNextAt
        : nextRecurringMeetingAt(meeting.meetingAt, meeting.recurrenceType);
    if (!meetingAt) return;

    const recurrenceType = meeting.recurrenceType === "CUSTOM" ? null : meeting.recurrenceType;
    const seriesId = meeting.seriesId ?? meeting.id;
    const nextMeetingId = randomUUID();

    await client.query(
      `
        insert into meetings (
          id, name, host_user_id, capacity, meeting_at, purpose, mood,
          join_code, status, series_id, parent_meeting_id, recurrence_type
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, 'RECRUITING', $9, $10, $11)
      `,
      [
        nextMeetingId,
        meeting.name,
        meeting.hostUserId,
        meeting.capacity,
        meetingAt,
        meeting.purpose,
        meeting.mood,
        meeting.joinCode,
        seriesId,
        meeting.id,
        recurrenceType
      ]
    );

    const memberRows = await client.query<{
      userId: string;
      meetingNickname: string;
      role: "HOST" | "MEMBER";
    }>(
      `
        select user_id as "userId", meeting_nickname as "meetingNickname", role
        from meeting_members
        where meeting_id = $1 and status = 'ACTIVE'
      `,
      [meeting.id]
    );
    for (const member of memberRows.rows) {
      await client.query(
        `
          insert into meeting_members (id, meeting_id, user_id, meeting_nickname, role, status)
          values ($1, $2, $3, $4, $5, 'ACTIVE')
        `,
        [randomUUID(), nextMeetingId, member.userId, member.meetingNickname, member.role]
      );
    }

    await client.query(
      `update meetings set next_meeting_id = $2, updated_at = now() where id = $1`,
      [meeting.id, nextMeetingId]
    );
  }

```

Note: this INSERTs the next occurrence with the **same `join_code`** as the source meeting. That's safe only because callers (Tasks 10–11) update the source meeting's `status` to `COMPLETED` *before* calling this helper, in the same transaction — the partial unique index `meetings_active_join_code_unique` only covers `RECRUITING`/`VOTING`/`FINAL_SELECTION`, so by the time this INSERT runs, the source row is already outside that index.

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @damo/mock-api typecheck`
Expected: no errors (the helper is unused so far — that's fine, Tasks 10–11 call it next).

- [ ] **Step 4: Commit**

```bash
git add apps/mock-api/src/postgres-store.ts
git commit -m "Add createNextRecurringOccurrence SQL helper"
```

---

## Task 11: Convert `closeVote` to SQL

**Files:**
- Modify: `apps/mock-api/src/postgres-store.ts`
- Test: `apps/mock-api/src/postgres-store.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
  it("closes a vote with a single winner and rejects incomplete closes without force", async () => {
    const host = await store.signup("host-close", "호스트", "pw1234");
    const guest = await store.signup("guest-close", "게스트", "pw1234");
    const meeting = await store.createMeeting(host.user.id, {
      name: "종료 테스트",
      capacity: 2,
      meetingAt: "2026-08-01T10:00:00+09:00",
      purpose: "CAFE",
      mood: "QUIET"
    });
    await store.joinMeeting(guest.user.id, meeting.id, meeting.joinCode!, "게스트닉");

    const [placeA] = await store.upsertPlaces([
      {
        id: "place-close-a",
        naverPlaceId: "naver-close-a",
        name: "가카페",
        category: "카페",
        address: "서울",
        roadAddress: "서울",
        latitude: 37.5,
        longitude: 127.0,
        station: "강남",
        distanceText: "1분"
      }
    ]);
    const [placeB] = await store.upsertPlaces([
      {
        id: "place-close-b",
        naverPlaceId: "naver-close-b",
        name: "나카페",
        category: "카페",
        address: "서울",
        roadAddress: "서울",
        latitude: 37.6,
        longitude: 127.1,
        station: "역삼",
        distanceText: "2분"
      }
    ]);
    const hostPlace = await store.registerUserPlace(host.user.id, placeA!.naverPlaceId, "CAFE", "QUIET");
    const guestPlace = await store.registerUserPlace(guest.user.id, placeB!.naverPlaceId, "CAFE", "QUIET");
    await store.replaceMyCandidates(meeting.id, host.user.id, [hostPlace.id]);
    await store.replaceMyCandidates(meeting.id, guest.user.id, [guestPlace.id]);
    await store.createVote(meeting.id, host.user.id);

    await assert.rejects(
      () => store.closeVote(meeting.id, host.user.id, false),
      (error: unknown) => (error as { code?: string }).code === "VOTE_HAS_INCOMPLETE_MEMBERS"
    );

    // Candidate order is rotated per member, so "candidateA" for the host and
    // "candidateA" for the guest are not guaranteed to be the same underlying
    // candidate. Resolve the host's pick to a concrete id, then have the guest
    // vote for that same id (whichever label it appears under in their own
    // session) so the outcome is deterministically a single 2-0 winner.
    const hostSession = await store.voteSession(meeting.id, host.user.id);
    const hostChoiceId = hostSession.round!.candidateA.id;
    await store.saveChoice(meeting.id, host.user.id, 1, hostChoiceId);
    const guestSession = await store.voteSession(meeting.id, guest.user.id);
    const guestChoiceId =
      guestSession.round!.candidateA.id === hostChoiceId
        ? guestSession.round!.candidateA.id
        : guestSession.round!.candidateB.id;
    await store.saveChoice(meeting.id, guest.user.id, 1, guestChoiceId);

    const results = await store.closeVote(meeting.id, host.user.id, false);
    assert.equal(results.voteStatus, "CLOSED");
    assert.equal(results.meetingStatus, "COMPLETED");
    assert.equal(results.finalCandidateId !== null, true);
  });
```

- [ ] **Step 2: Run test to verify current behavior (should already pass)**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" pnpm --filter @damo/mock-api test`
Expected: PASS via the old `write()` path.

- [ ] **Step 3: Replace `closeVote`**

```ts
  async closeVote(meetingId: string, userId: string, force: boolean) {
    return this.withMeetingLock(meetingId, async (client) => {
      const meetingResult = await client.query<{
        status: MeetingStatus;
        hostUserId: string;
        name: string;
        capacity: number;
        meetingAt: Date | string;
        purpose: Purpose;
        mood: Mood;
        joinCode: string;
        seriesId: string | null;
        recurrenceType: RecurrenceType | null;
        recurrenceNextAt: Date | string | null;
        nextMeetingId: string | null;
      }>(
        `
          select
            status, host_user_id as "hostUserId", name, capacity,
            meeting_at as "meetingAt", purpose, mood, join_code as "joinCode",
            series_id as "seriesId", recurrence_type as "recurrenceType",
            recurrence_next_at as "recurrenceNextAt", next_meeting_id as "nextMeetingId"
          from meetings
          where id = $1 and status <> 'DELETED'
          for update
        `,
        [meetingId]
      );
      const meeting = meetingResult.rows[0];
      if (!meeting) {
        throw new StoreError(404, "MEETING_NOT_FOUND", "모임을 찾을 수 없습니다.");
      }
      if (meeting.hostUserId !== userId) {
        throw new StoreError(403, "HOST_ONLY", "모임장만 실행할 수 있습니다.");
      }
      if (meeting.status !== "VOTING") {
        throw new StoreError(409, "VOTE_NOT_OPEN", "종료할 수 있는 투표가 없습니다.");
      }

      const results = await this.computeVoteResults(client, meetingId, userId);
      if (results.incompleteMembers > 0 && !force) {
        throw new StoreError(
          409,
          "VOTE_HAS_INCOMPLETE_MEMBERS",
          "아직 투표를 완료하지 않은 인원이 있습니다.",
          { incompleteMembers: results.incompleteMembers }
        );
      }

      const isSingleWinner = results.tiedFirstCandidateIds.length === 1;
      const voteStatus: "CLOSED" | "FINAL_SELECTION" = isSingleWinner
        ? "CLOSED"
        : "FINAL_SELECTION";
      const meetingStatus: "COMPLETED" | "FINAL_SELECTION" = isSingleWinner
        ? "COMPLETED"
        : "FINAL_SELECTION";
      const finalCandidateId = isSingleWinner ? results.tiedFirstCandidateIds[0]! : null;

      await client.query(
        `update votes set status = $2, closed_at = now() where meeting_id = $1`,
        [meetingId, voteStatus]
      );
      await client.query(
        `
          update meetings
          set status = $2, final_candidate_id = coalesce($3, final_candidate_id), updated_at = now()
          where id = $1
        `,
        [meetingId, meetingStatus, finalCandidateId]
      );

      if (isSingleWinner) {
        await this.createNextRecurringOccurrence(client, {
          id: meetingId,
          name: meeting.name,
          hostUserId: meeting.hostUserId,
          capacity: meeting.capacity,
          meetingAt: timestamp(meeting.meetingAt),
          purpose: meeting.purpose,
          mood: meeting.mood,
          joinCode: meeting.joinCode,
          seriesId: meeting.seriesId,
          recurrenceType: meeting.recurrenceType,
          recurrenceNextAt: nullableTimestamp(meeting.recurrenceNextAt),
          nextMeetingId: meeting.nextMeetingId
        });
      }

      return this.computeVoteResults(client, meetingId, userId);
    });
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" pnpm --filter @damo/mock-api test`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @damo/mock-api typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/mock-api/src/postgres-store.ts apps/mock-api/src/postgres-store.test.ts
git commit -m "Convert closeVote to targeted SQL, sharing computeVoteResults"
```

---

## Task 12: Convert `finalSelection` to SQL

**Files:**
- Modify: `apps/mock-api/src/postgres-store.ts`
- Test: `apps/mock-api/src/postgres-store.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
  it("resolves a tied vote via finalSelection and starts the next recurring occurrence", async () => {
    const host = await store.signup("host-final", "호스트", "pw1234");
    const guest = await store.signup("guest-final", "게스트", "pw1234");
    const meeting = await store.createMeeting(host.user.id, {
      name: "최종선택 테스트",
      capacity: 2,
      meetingAt: "2026-08-01T10:00:00+09:00",
      purpose: "DRINK",
      mood: "TIPSY"
    });
    await store.joinMeeting(guest.user.id, meeting.id, meeting.joinCode!, "게스트닉");

    const [placeA] = await store.upsertPlaces([
      {
        id: "place-final-a",
        naverPlaceId: "naver-final-a",
        name: "가호프",
        category: "호프",
        address: "서울",
        roadAddress: "서울",
        latitude: 37.5,
        longitude: 127.0,
        station: "강남",
        distanceText: "1분"
      }
    ]);
    const [placeB] = await store.upsertPlaces([
      {
        id: "place-final-b",
        naverPlaceId: "naver-final-b",
        name: "나호프",
        category: "호프",
        address: "서울",
        roadAddress: "서울",
        latitude: 37.6,
        longitude: 127.1,
        station: "역삼",
        distanceText: "2분"
      }
    ]);
    const hostPlace = await store.registerUserPlace(host.user.id, placeA!.naverPlaceId, "DRINK", "TIPSY");
    const guestPlace = await store.registerUserPlace(guest.user.id, placeB!.naverPlaceId, "DRINK", "TIPSY");
    await store.replaceMyCandidates(meeting.id, host.user.id, [hostPlace.id]);
    await store.replaceMyCandidates(meeting.id, guest.user.id, [guestPlace.id]);
    await store.createVote(meeting.id, host.user.id);

    // Same rotation caveat as the closeVote test, inverted: resolve the host's
    // pick to a concrete id, then have the guest deliberately vote for the
    // *other* candidate id so the outcome is deterministically a 1-1 tie.
    const hostSession = await store.voteSession(meeting.id, host.user.id);
    const hostChoiceId = hostSession.round!.candidateA.id;
    await store.saveChoice(meeting.id, host.user.id, 1, hostChoiceId);
    const guestSession = await store.voteSession(meeting.id, guest.user.id);
    const guestChoiceId =
      guestSession.round!.candidateA.id === hostChoiceId
        ? guestSession.round!.candidateB.id
        : guestSession.round!.candidateA.id;
    await store.saveChoice(meeting.id, guest.user.id, 1, guestChoiceId);

    const closed = await store.closeVote(meeting.id, host.user.id, false);
    assert.equal(closed.meetingStatus, "FINAL_SELECTION");
    assert.equal(closed.tiedFirstCandidateIds.length, 2);

    await assert.rejects(
      () => store.finalSelection(meeting.id, host.user.id, "not-a-real-candidate-id"),
      (error: unknown) => (error as { code?: string }).code === "INVALID_FINAL_CANDIDATE"
    );

    const finalPick = closed.tiedFirstCandidateIds[0]!;
    const final = await store.finalSelection(meeting.id, host.user.id, finalPick);
    assert.equal(final.meetingStatus, "COMPLETED");
    assert.equal(final.finalCandidateId, finalPick);
  });
```

- [ ] **Step 2: Run test to verify current behavior (should already pass)**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" pnpm --filter @damo/mock-api test`
Expected: PASS via the old `write()` path.

- [ ] **Step 3: Replace `finalSelection`**

```ts
  async finalSelection(meetingId: string, userId: string, candidateId: string) {
    return this.withMeetingLock(meetingId, async (client) => {
      const meetingResult = await client.query<{
        status: MeetingStatus;
        hostUserId: string;
        name: string;
        capacity: number;
        meetingAt: Date | string;
        purpose: Purpose;
        mood: Mood;
        joinCode: string;
        seriesId: string | null;
        recurrenceType: RecurrenceType | null;
        recurrenceNextAt: Date | string | null;
        nextMeetingId: string | null;
      }>(
        `
          select
            status, host_user_id as "hostUserId", name, capacity,
            meeting_at as "meetingAt", purpose, mood, join_code as "joinCode",
            series_id as "seriesId", recurrence_type as "recurrenceType",
            recurrence_next_at as "recurrenceNextAt", next_meeting_id as "nextMeetingId"
          from meetings
          where id = $1 and status <> 'DELETED'
          for update
        `,
        [meetingId]
      );
      const meeting = meetingResult.rows[0];
      if (!meeting) {
        throw new StoreError(404, "MEETING_NOT_FOUND", "모임을 찾을 수 없습니다.");
      }
      if (meeting.hostUserId !== userId) {
        throw new StoreError(403, "HOST_ONLY", "모임장만 실행할 수 있습니다.");
      }
      if (meeting.status !== "FINAL_SELECTION") {
        throw new StoreError(
          409,
          "FINAL_SELECTION_NOT_REQUIRED",
          "최종 선택이 필요한 상태가 아닙니다."
        );
      }

      const results = await this.computeVoteResults(client, meetingId, userId);
      if (!results.tiedFirstCandidateIds.includes(candidateId)) {
        throw new StoreError(422, "INVALID_FINAL_CANDIDATE", "공동 1위 후보 중에서 선택해야 합니다.");
      }

      await client.query(
        `
          update meetings
          set status = 'COMPLETED', final_candidate_id = $2, updated_at = now()
          where id = $1
        `,
        [meetingId, candidateId]
      );
      await client.query(`update votes set status = 'CLOSED' where meeting_id = $1`, [
        meetingId
      ]);

      await this.createNextRecurringOccurrence(client, {
        id: meetingId,
        name: meeting.name,
        hostUserId: meeting.hostUserId,
        capacity: meeting.capacity,
        meetingAt: timestamp(meeting.meetingAt),
        purpose: meeting.purpose,
        mood: meeting.mood,
        joinCode: meeting.joinCode,
        seriesId: meeting.seriesId,
        recurrenceType: meeting.recurrenceType,
        recurrenceNextAt: nullableTimestamp(meeting.recurrenceNextAt),
        nextMeetingId: meeting.nextMeetingId
      });

      return this.computeVoteResults(client, meetingId, userId);
    });
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" pnpm --filter @damo/mock-api test`
Expected: PASS.

- [ ] **Step 5: Typecheck and full suite**

Run: `pnpm --filter @damo/mock-api typecheck && pnpm test:api`
Expected: both pass.

- [ ] **Step 6: Commit**

```bash
git add apps/mock-api/src/postgres-store.ts apps/mock-api/src/postgres-store.test.ts
git commit -m "Convert finalSelection to targeted SQL, sharing computeVoteResults"
```

---

## Task 13: Update documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/database.md`
- Modify: `docs/local-development.md`

- [ ] **Step 1: Update README's remaining-work list**

In `README.md`, find the "현재 MVP에서 남은 작업" section and replace the line:

```
- PostgreSQL 저장소의 나머지 변경 작업을 개별 SQL로 전환
```

with:

```
- PostgreSQL 저장소의 나머지 변경 작업(leaveMeeting, kickMember, deleteMeeting, updateUserPlace, unregisterUserPlace, reset)을 개별 SQL로 전환
```

- [ ] **Step 2: Add a lock-strategy note to `docs/database.md`**

In `docs/database.md`, under section `## 1. 구성`, add a new bullet after the existing RLS bullet:

```
- 모임과 관련된 쓰기 작업은 모임별 advisory lock(`pg_advisory_xact_lock(hashtext('meeting:' || meetingId))`)으로 직렬화한다. 서로 다른 모임의 쓰기는 서로 막지 않는다.
```

- [ ] **Step 3: Add test-database setup instructions to `docs/local-development.md`**

Read `docs/local-development.md` first to find the right insertion point (likely near the existing Supabase connection instructions), then add a new subsection:

```markdown
## Postgres 통합 테스트용 별도 프로젝트

`apps/mock-api/src/postgres-store.test.ts`는 실제 Postgres에 대해 도는 통합 테스트다. Render/프로덕션이 쓰는 `DATABASE_URL`과는 별개로, 테스트 전용 Supabase 프로젝트를 하나 더 만들어 `TEST_DATABASE_URL`로 등록한다.

```env
TEST_DATABASE_URL=postgresql://postgres.<test-project-ref>:비밀번호@REGION.pooler.supabase.com:5432/postgres
```

이 값이 없으면 `pnpm test:api`는 해당 스위트를 자동으로 건너뛴다.
```

- [ ] **Step 4: Commit**

```bash
git add README.md docs/database.md docs/local-development.md
git commit -m "Document the meeting-scoped lock strategy and test-database setup"
```

---

## Task 14: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Full local verification**

Run: `pnpm typecheck && pnpm test:api && pnpm build:render`
Expected: all three succeed.

- [ ] **Step 2: Full Postgres-backed verification**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" pnpm --filter @damo/mock-api test`
Expected: all tests pass, including every new integration test added in Tasks 3–11.

- [ ] **Step 3: Re-measure the original symptom against Render**

This won't reflect the fix until the branch is merged and Render redeploys, but as a sanity check against a local Postgres-backed server:

```bash
DATABASE_URL="$TEST_DATABASE_URL" pnpm --filter @damo/mock-api start &
sleep 2
TOKEN=$(curl -s -X POST http://127.0.0.1:4010/api/v1/auth/test/login \
  -H "content-type: application/json" \
  -d '{"loginId":"damo","password":"1234"}' | grep -o '"accessToken":"[^"]*"' | cut -d'"' -f4)
curl -s -o /dev/null -w "lookupMeeting: %{time_total}s\n" -X POST \
  http://127.0.0.1:4010/api/v1/meetings/lookup \
  -H "content-type: application/json" -H "authorization: Bearer $TOKEN" \
  -d '{"joinCode":"4821"}'
kill %1
```

Expected: well under the ~1.1–1.24s measured against Render before this work (exact number will vary by network, but it should no longer be dominated by a full-database round trip).

- [ ] **Step 4: Push and open a PR (only if the user asks for this step — do not push automatically)**

```bash
git push -u origin main
```
