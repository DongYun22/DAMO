# PostgresStore Write-Path Lightening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert every remaining meeting-mutating method in `apps/mock-api/src/postgres-store.ts` (`lookupMeeting`, `joinMeeting`, `createMeeting`, `deleteMeeting`, `createVote`, `closeVote`, `finalSelection`, `leaveMeeting`, `kickMember`, `updateUserPlace`, `unregisterUserPlace`, `repeatMeeting`) plus their shared dependency `voteResults`, off the full-database-snapshot `read()`/`write()` pattern and onto scoped, indexed SQL. Measured against the Render deployment: `lookupMeeting` (a `read()`) took ~1.1–1.24s; `createMeeting` and `deleteMeeting` (both `write()`, which re-saves every table) took ~30s each. `deleteMeeting` was added to this batch after that measurement — its business logic is a single status flip, so converting it is low-risk and high-payoff. `reset()` is intentionally excluded — it's a full-database wipe-and-reseed by design (used only for `db:seed`/test cleanup, gated behind `DAMO_ENABLE_DB_RESET` in Postgres mode), so "targeted SQL" doesn't apply to it the same way, and it doesn't participate in normal concurrent user traffic.

> **Scope expansion (added after Task 3's code review):** the plan originally deferred `leaveMeeting`, `kickMember`, `updateUserPlace`, `unregisterUserPlace` to a later cycle. Task 3's code-quality review found a Critical issue: once *any* method uses the new per-meeting `withMeetingLock` while *other* methods still use the global `write()`/`saveSnapshot()` path, they no longer serialize against each other (different advisory-lock keys) — but `saveSnapshot()` does unscoped `delete from vote_choices` / `delete from candidate_recommendations` (whole table) and reinserts only what was in its stale in-memory snapshot. A `write()`-based transaction for *any* meeting (even an unrelated one) can silently erase a `withMeetingLock`-based transaction's just-committed row for a *different* meeting, with no error. This risk exists for as long as any non-`reset` method still goes through `write()`. Rather than work around it with a temporary dual-lock, this plan now converts all four remaining methods so the `write()`/`saveSnapshot()` path is no longer reachable from any concurrent user-facing mutation — fully closing the gap and fully achieving cross-meeting parallelism, not just for the originally-scoped 8 methods.

**Architecture:** Add a `withMeetingLock(meetingId, operation)` transaction helper (per-meeting `pg_advisory_xact_lock`) and reuse it across the two already-converted methods (`replaceMyCandidates`, `saveChoice`) and all new conversions where the operation touches exactly one meeting (`lookupMeeting` has none since it's read-only, `createMeeting` has none since the meeting doesn't exist yet, `deleteMeeting`, `joinMeeting`, `createVote`, `closeVote`, `finalSelection`, `leaveMeeting`, `kickMember`). `updateUserPlace` and `unregisterUserPlace` can touch *multiple* meetings in one call (`applyToMeetingIds` / "every RECRUITING meeting the user is active in"), so they acquire multiple per-meeting advisory locks directly (not via `withMeetingLock`, which only takes one `meetingId`) — always in ascending sorted `meetingId` order, to prevent a lock-ordering deadlock against another concurrent multi-meeting call. Add a `computeVoteResults` SQL helper (targeted queries + the exact same in-memory ranking algorithm as `store.ts`) shared by `voteResults`, `closeVote`, `finalSelection`. Add a `createNextRecurringOccurrence` SQL helper shared by `closeVote`/`finalSelection` for recurring-meeting rollover.

**Tech Stack:** Node.js `pg` driver (raw SQL, no ORM), `node:test`, TypeScript, Supabase PostgreSQL.

---

## Task 0: Prerequisite — test database (human step, not automatable)

This plan adds Postgres-backed tests that must run against a real database that is **not** the Render/production database. This step cannot be done by an agent — a human must do it before Task 2's tests can run for real, but Tasks 0–1 and the SQL-writing parts of every later task can proceed without it (the new test suite self-skips if the env var is absent).

> **Actual approach taken (2026-07-29): local Homebrew PostgreSQL, not a second Supabase project.** The original plan called for a separate Supabase project, but the account's org had already hit Supabase's free-tier limit of 2 active projects (the Render project counts as one) and creating a third was blocked. Local Postgres via Homebrew avoids that limit entirely and needs no account. Steps actually run:

- [x] **Step 1: Install and start PostgreSQL locally**

```bash
brew install postgresql@16
brew services start postgresql@16
```

- [x] **Step 2: Create a dedicated test database**

```bash
export PATH="/opt/homebrew/opt/postgresql@16/bin:$PATH"
createdb damo_test
```

- [x] **Step 3: Add the connection string to `apps/mock-api/.env.local`**

```env
TEST_DATABASE_URL=postgresql://dongyunkwak@localhost:5432/damo_test
```

`config.ts`'s `isLocal` check (matches on `localhost`/`127.0.0.1`) disables SSL for this connection automatically, and no password is needed since Homebrew's default local Postgres uses trust/peer auth for the machine's own user.

- [x] **Step 4: Stub the Supabase-only roles the migrations expect**

`apps/mock-api/migrations/0001_initial.sql` ends with `revoke all on ... from anon, authenticated`, referencing roles that only exist on Supabase-hosted Postgres. A vanilla local Postgres needs them created as empty stub roles first:

```bash
psql -d damo_test -c "create role anon; create role authenticated;"
```

- [x] **Step 5: Apply migrations to the test database**

```bash
DATABASE_URL="postgresql://dongyunkwak@localhost:5432/damo_test" pnpm --filter @damo/mock-api db:migrate
```

Confirmed: both migrations applied, all 12 tables present (verified via `psql -d damo_test -c '\dt'`).

If a Supabase project frees up later (or the account upgrades), the same `TEST_DATABASE_URL` env var can just point at a Session pooler connection string instead — nothing else in this plan depends on which Postgres it is.

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
          and m.status in ('RECRUITING', 'VOTING', 'FINAL_SELECTION')
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
        // Postgres aborts the *entire* transaction on any statement error
        // (unique violations included) and refuses further statements until
        // a ROLLBACK or ROLLBACK TO SAVEPOINT. Wrap each attempt in its own
        // savepoint so a join-code collision only unwinds that attempt,
        // not the whole transaction — otherwise the *next* statement fails
        // with opaque `25P02` ("current transaction is aborted") instead of
        // retrying.
        await client.query("savepoint join_code_attempt");
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
            await client.query("rollback to savepoint join_code_attempt");
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

## Task 13: Convert `leaveMeeting` to SQL

**Files:**
- Modify: `apps/mock-api/src/postgres-store.ts`
- Test: `apps/mock-api/src/postgres-store.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
  it("lets an active member leave and rejects the host", async () => {
    const host = await store.signup("host-leave", "호스트", "pw1234");
    const guest = await store.signup("guest-leave", "게스트", "pw1234");
    const meeting = await store.createMeeting(host.user.id, {
      name: "탈퇴 테스트",
      capacity: 3,
      meetingAt: "2026-08-01T10:00:00+09:00",
      purpose: "STUDY",
      mood: "QUIET"
    });
    await store.joinMeeting(guest.user.id, meeting.id, meeting.joinCode!, "게스트닉");

    await assert.rejects(
      () => store.leaveMeeting(meeting.id, host.user.id),
      (error: unknown) => (error as { code?: string }).code === "HOST_CANNOT_LEAVE"
    );

    const result = await store.leaveMeeting(meeting.id, guest.user.id);
    assert.equal(result.left, true);

    const detail = await store.detail(meeting.id, host.user.id);
    assert.equal(detail.members.length, 1);
  });
```

- [ ] **Step 2: Run test to verify current behavior (should already pass)**

Run: `pnpm --filter @damo/mock-api test`
Expected: PASS via the old `write()` path.

- [ ] **Step 3: Replace `leaveMeeting`**

```ts
  async leaveMeeting(meetingId: string, userId: string) {
    return this.withMeetingLock(meetingId, async (client) => {
      const meetingResult = await client.query<{ status: MeetingStatus }>(
        `select status from meetings where id = $1 and status <> 'DELETED'`,
        [meetingId]
      );
      const meeting = meetingResult.rows[0];
      if (!meeting) {
        throw new StoreError(404, "MEETING_NOT_FOUND", "모임을 찾을 수 없습니다.");
      }
      if (meeting.status !== "RECRUITING") {
        throw new StoreError(409, "LEAVE_NOT_ALLOWED", "투표 시작 후에는 탈퇴할 수 없습니다.");
      }

      const memberResult = await client.query<{ id: string; role: "HOST" | "MEMBER" }>(
        `
          select id, role
          from meeting_members
          where meeting_id = $1 and user_id = $2 and status = 'ACTIVE'
        `,
        [meetingId, userId]
      );
      const member = memberResult.rows[0];
      if (!member) {
        throw new StoreError(404, "MEMBER_NOT_FOUND", "모임 참여 정보를 찾을 수 없습니다.");
      }
      if (member.role === "HOST") {
        throw new StoreError(403, "HOST_CANNOT_LEAVE", "모임장은 탈퇴 대신 모임을 삭제해야 합니다.");
      }

      await client.query(`update meeting_members set status = 'LEFT' where id = $1`, [member.id]);
      await client.query(
        `
          delete from candidate_recommendations recommendation
          using meeting_candidates candidate
          where recommendation.candidate_id = candidate.id
            and candidate.meeting_id = $1
            and recommendation.member_id = $2
        `,
        [meetingId, member.id]
      );
      await client.query(
        `
          delete from meeting_candidates candidate
          where candidate.meeting_id = $1
            and not exists (
              select 1 from candidate_recommendations r where r.candidate_id = candidate.id
            )
        `,
        [meetingId]
      );
      await client.query(`update meetings set updated_at = now() where id = $1`, [meetingId]);
      return { meetingId, left: true };
    });
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @damo/mock-api test`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @damo/mock-api typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/mock-api/src/postgres-store.ts apps/mock-api/src/postgres-store.test.ts
git commit -m "Convert leaveMeeting to targeted SQL"
```

---

## Task 14: Convert `kickMember` to SQL

**Files:**
- Modify: `apps/mock-api/src/postgres-store.ts`
- Test: `apps/mock-api/src/postgres-store.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
  it("lets the host kick a member and rejects non-hosts / kicking the host", async () => {
    const host = await store.signup("host-kick", "호스트", "pw1234");
    const guest = await store.signup("guest-kick", "게스트", "pw1234");
    const meeting = await store.createMeeting(host.user.id, {
      name: "강퇴 테스트",
      capacity: 3,
      meetingAt: "2026-08-01T10:00:00+09:00",
      purpose: "MEAL",
      mood: "FUN"
    });
    const joined = await store.joinMeeting(guest.user.id, meeting.id, meeting.joinCode!, "게스트닉");
    const guestMemberId = joined.members.find((member) => member.userId === guest.user.id)!.id;

    await assert.rejects(
      () => store.kickMember(meeting.id, guest.user.id, guestMemberId),
      (error: unknown) => (error as { code?: string }).code === "HOST_ONLY"
    );

    const detail = await store.kickMember(meeting.id, host.user.id, guestMemberId);
    assert.equal(detail.members.length, 1);
  });
```

- [ ] **Step 2: Run test to verify current behavior (should already pass)**

Run: `pnpm --filter @damo/mock-api test`
Expected: PASS via the old `write()` path.

- [ ] **Step 3: Replace `kickMember`**

```ts
  async kickMember(meetingId: string, hostUserId: string, memberId: string) {
    await this.withMeetingLock(meetingId, async (client) => {
      const meetingResult = await client.query<{
        status: MeetingStatus;
        hostUserId: string;
      }>(
        `select status, host_user_id as "hostUserId" from meetings where id = $1 and status <> 'DELETED'`,
        [meetingId]
      );
      const meeting = meetingResult.rows[0];
      if (!meeting) {
        throw new StoreError(404, "MEETING_NOT_FOUND", "모임을 찾을 수 없습니다.");
      }
      if (meeting.hostUserId !== hostUserId) {
        throw new StoreError(403, "HOST_ONLY", "모임장만 실행할 수 있습니다.");
      }
      if (meeting.status !== "RECRUITING") {
        throw new StoreError(409, "KICK_NOT_ALLOWED", "투표 시작 후에는 모임원을 내보낼 수 없습니다.");
      }

      const memberResult = await client.query<{ id: string; role: "HOST" | "MEMBER" }>(
        `select id, role from meeting_members where id = $1 and meeting_id = $2 and status = 'ACTIVE'`,
        [memberId, meetingId]
      );
      const member = memberResult.rows[0];
      if (!member || member.role === "HOST") {
        throw new StoreError(422, "INVALID_MEMBER", "내보낼 수 없는 모임원입니다.");
      }

      await client.query(`update meeting_members set status = 'KICKED' where id = $1`, [member.id]);
      await client.query(
        `
          delete from candidate_recommendations recommendation
          using meeting_candidates candidate
          where recommendation.candidate_id = candidate.id
            and candidate.meeting_id = $1
            and recommendation.member_id = $2
        `,
        [meetingId, member.id]
      );
      await client.query(
        `
          delete from meeting_candidates candidate
          where candidate.meeting_id = $1
            and not exists (
              select 1 from candidate_recommendations r where r.candidate_id = candidate.id
            )
        `,
        [meetingId]
      );
      await client.query(`update meetings set updated_at = now() where id = $1`, [meetingId]);
    });
    return this.detail(meetingId, hostUserId);
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @damo/mock-api test`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @damo/mock-api typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/mock-api/src/postgres-store.ts apps/mock-api/src/postgres-store.test.ts
git commit -m "Convert kickMember to targeted SQL"
```

---

## Task 15: Convert `updateUserPlace` to SQL

**Files:**
- Modify: `apps/mock-api/src/postgres-store.ts`
- Test: `apps/mock-api/src/postgres-store.test.ts`

This method can touch **multiple** meetings in one call (`applyToMeetingIds`), so it does not use `withMeetingLock` (which only locks one meeting). Instead it acquires one advisory lock per meeting directly, in ascending sorted `meetingId` order, inside its own transaction — sorted order prevents a lock-ordering deadlock if two concurrent calls (e.g. two different users' `updateUserPlace`/`unregisterUserPlace` calls) touch an overlapping set of meetings.

- [ ] **Step 1: Write the failing test**

```ts
  it("updates a user place and reflects the change onto an active RECRUITING candidate", async () => {
    const host = await store.signup("host-update-place", "호스트", "pw1234");
    const meeting = await store.createMeeting(host.user.id, {
      name: "장소수정 테스트",
      capacity: 2,
      meetingAt: "2026-08-01T10:00:00+09:00",
      purpose: "CAFE",
      mood: "QUIET"
    });
    const [place] = await store.upsertPlaces([
      {
        id: "place-update-a",
        naverPlaceId: "naver-update-a",
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
    const hostPlace = await store.registerUserPlace(host.user.id, place!.naverPlaceId, "CAFE", "QUIET");
    await store.replaceMyCandidates(meeting.id, host.user.id, [hostPlace.id]);

    const updated = await store.updateUserPlace(
      host.user.id,
      hostPlace.id,
      "MEAL",
      "FUN",
      [meeting.id]
    );
    assert.equal(updated.purpose, "MEAL");
    assert.equal(updated.mood, "FUN");

    const candidates = await store.publicCandidates(meeting.id, host.user.id);
    assert.equal(candidates.length, 1);
  });
```

- [ ] **Step 2: Run test to verify current behavior (should already pass)**

Run: `pnpm --filter @damo/mock-api test`
Expected: PASS via the old `write()` path.

- [ ] **Step 3: Replace `updateUserPlace`**

```ts
  async updateUserPlace(
    userId: string,
    userPlaceId: string,
    purpose: Purpose,
    mood: Mood,
    applyToMeetingIds: string[]
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const sortedMeetingIds = [...new Set(applyToMeetingIds)].sort();
      for (const meetingId of sortedMeetingIds) {
        await client.query("select pg_advisory_xact_lock(hashtext($1))", [`meeting:${meetingId}`]);
      }

      const placeResult = await client.query<{ userPlaceId: string; placeId: string }>(
        `
          update user_places
          set purpose = $3, mood = $4, updated_at = now()
          where id = $1 and user_id = $2 and is_active = true
          returning id as "userPlaceId", place_id as "placeId"
        `,
        [userPlaceId, userId, purpose, mood]
      );
      const place = placeResult.rows[0];
      if (!place) {
        throw new StoreError(404, "USER_PLACE_NOT_FOUND", "저장된 장소를 찾을 수 없습니다.");
      }

      for (const meetingId of sortedMeetingIds) {
        const meetingResult = await client.query<{ status: MeetingStatus }>(
          `select status from meetings where id = $1 and status <> 'DELETED'`,
          [meetingId]
        );
        const meeting = meetingResult.rows[0];
        if (!meeting) {
          throw new StoreError(404, "MEETING_NOT_FOUND", "모임을 찾을 수 없습니다.");
        }
        if (meeting.status !== "RECRUITING") continue;

        await client.query(
          `
            update candidate_recommendations recommendation
            set purpose = $4, mood = $5
            from meeting_candidates candidate, meeting_members member
            where recommendation.candidate_id = candidate.id
              and recommendation.member_id = member.id
              and candidate.meeting_id = $1
              and candidate.place_id = $2
              and member.meeting_id = $1
              and member.user_id = $3
              and member.status = 'ACTIVE'
          `,
          [meetingId, place.placeId, userId, purpose, mood]
        );
        await client.query(
          `
            delete from meeting_candidates candidate
            where candidate.meeting_id = $1
              and not exists (
                select 1 from candidate_recommendations r where r.candidate_id = candidate.id
              )
          `,
          [meetingId]
        );
        await client.query(`update meetings set updated_at = now() where id = $1`, [meetingId]);
      }

      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    const item = (await this.queryUserPlaces(userId, userPlaceId))[0];
    if (!item) {
      throw new StoreError(500, "USER_PLACE_SAVE_FAILED", "내 장소 저장 결과를 찾을 수 없습니다.");
    }
    return item;
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @damo/mock-api test`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @damo/mock-api typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/mock-api/src/postgres-store.ts apps/mock-api/src/postgres-store.test.ts
git commit -m "Convert updateUserPlace to targeted SQL with sorted multi-meeting locking"
```

---

## Task 16: Convert `unregisterUserPlace` to SQL

**Files:**
- Modify: `apps/mock-api/src/postgres-store.ts`
- Test: `apps/mock-api/src/postgres-store.test.ts`

Same multi-meeting locking approach as Task 15: when `applyToActiveMeetings` is true, the set of affected meetings isn't known in advance (it's every `RECRUITING` meeting where the user is an active member), so this queries that set first, then locks each one in sorted order before mutating.

- [ ] **Step 1: Write the failing test**

```ts
  it("unregisters a user place and removes it from an active candidate when requested", async () => {
    const host = await store.signup("host-unregister-place", "호스트", "pw1234");
    const meeting = await store.createMeeting(host.user.id, {
      name: "등록해제 테스트",
      capacity: 2,
      meetingAt: "2026-08-01T10:00:00+09:00",
      purpose: "DRINK",
      mood: "TIPSY"
    });
    const [place] = await store.upsertPlaces([
      {
        id: "place-unregister-a",
        naverPlaceId: "naver-unregister-a",
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
    const hostPlace = await store.registerUserPlace(host.user.id, place!.naverPlaceId, "DRINK", "TIPSY");
    await store.replaceMyCandidates(meeting.id, host.user.id, [hostPlace.id]);

    const result = await store.unregisterUserPlace(host.user.id, hostPlace.id, true);
    assert.equal(result.unregistered, true);
    assert.equal(result.appliedToActiveMeetings, true);

    const candidates = await store.publicCandidates(meeting.id, host.user.id);
    assert.equal(candidates.length, 0);

    const places = await store.listUserPlaces(host.user.id);
    assert.equal(places.some((item) => item.id === hostPlace.id), false);
  });
```

- [ ] **Step 2: Run test to verify current behavior (should already pass)**

Run: `pnpm --filter @damo/mock-api test`
Expected: PASS via the old `write()` path.

- [ ] **Step 3: Replace `unregisterUserPlace`**

```ts
  async unregisterUserPlace(
    userId: string,
    userPlaceId: string,
    applyToActiveMeetings: boolean
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");

      let meetingIds: string[] = [];
      if (applyToActiveMeetings) {
        const meetingsResult = await client.query<{ id: string }>(
          `
            select distinct m.id
            from meetings m
            join meeting_members member
              on member.meeting_id = m.id and member.user_id = $1 and member.status = 'ACTIVE'
            where m.status = 'RECRUITING'
            order by m.id
          `,
          [userId]
        );
        meetingIds = meetingsResult.rows.map((row) => row.id);
        for (const meetingId of meetingIds) {
          await client.query("select pg_advisory_xact_lock(hashtext($1))", [`meeting:${meetingId}`]);
        }
      }

      const placeResult = await client.query<{ userPlaceId: string }>(
        `
          update user_places
          set is_active = false, updated_at = now()
          where id = $1 and user_id = $2 and is_active = true
          returning id as "userPlaceId"
        `,
        [userPlaceId, userId]
      );
      if (!placeResult.rows[0]) {
        throw new StoreError(404, "USER_PLACE_NOT_FOUND", "저장된 장소를 찾을 수 없습니다.");
      }

      for (const meetingId of meetingIds) {
        await client.query(
          `
            delete from candidate_recommendations recommendation
            using meeting_candidates candidate, meeting_members member
            where recommendation.candidate_id = candidate.id
              and recommendation.member_id = member.id
              and candidate.meeting_id = $1
              and member.meeting_id = $1
              and member.user_id = $2
              and member.status = 'ACTIVE'
              and recommendation.user_place_id = $3
          `,
          [meetingId, userId, userPlaceId]
        );
        await client.query(
          `
            delete from meeting_candidates candidate
            where candidate.meeting_id = $1
              and not exists (
                select 1 from candidate_recommendations r where r.candidate_id = candidate.id
              )
          `,
          [meetingId]
        );
        await client.query(`update meetings set updated_at = now() where id = $1`, [meetingId]);
      }

      await client.query("commit");
      return { userPlaceId, unregistered: true, appliedToActiveMeetings: applyToActiveMeetings };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @damo/mock-api test`
Expected: PASS.

- [ ] **Step 5: Typecheck and run the full memory-store suite too**

Run: `pnpm --filter @damo/mock-api typecheck && pnpm test:api`
Expected: both pass.

- [ ] **Step 6: Commit**

```bash
git add apps/mock-api/src/postgres-store.ts apps/mock-api/src/postgres-store.test.ts
git commit -m "Convert unregisterUserPlace to targeted SQL with sorted multi-meeting locking"
```

---

## Task 17: Convert `repeatMeeting` to SQL

**Files:**
- Modify: `apps/mock-api/src/postgres-store.ts`
- Test: `apps/mock-api/src/postgres-store.test.ts`

> **Scope addition (found during Task 16's review, 2026-07-30):** `repeatMeeting` was never in this plan's original method list, but it's a real user-facing route (`POST /api/v1/meetings/:meetingId/repeat`) that still calls `this.write(...)`. Task 19's own verification step checks that `reset()` is the *only* remaining `write()`/`read()` caller — `repeatMeeting` would fail that check. Converting it here closes the gap for real, not just for the originally-scoped 12 methods.

- [ ] **Step 1: Write a failing test**

Add a test to `apps/mock-api/src/postgres-store.test.ts` covering the full `repeatMeeting` flow: create a meeting, join a guest, run it to a single-winner `closeVote` (COMPLETED, no recurrence), then call `repeatMeeting` with both members selected and assert the new meeting is `RECRUITING`, shares the source's `joinCode`, has `parentMeetingId` equal to the source, and has both members `ACTIVE`. Also cover the error paths using `assert.rejects`:
- Non-host caller → `HOST_ONLY`
- Calling on a meeting that isn't `COMPLETED` yet → `MEETING_NOT_COMPLETED`
- Calling a second time after a next meeting already exists → `NEXT_MEETING_ALREADY_EXISTS`
- `memberIds` that excludes the host → `HOST_MEMBER_REQUIRED`
- `memberIds` containing an id that wasn't an active member of the source meeting → `INVALID_MEMBER_SELECTION`
- `capacity` smaller than the selected member count → `CAPACITY_TOO_SMALL`
- `recurrence: { type: "CUSTOM", customNextMeetingAt: <a date at or before meetingAt> }` → `INVALID_CUSTOM_RECURRENCE_DATE`

Follow the existing test file's conventions (signup/createMeeting/joinMeeting/upsertPlaces/registerUserPlace/replaceMyCandidates/createVote/saveChoice/closeVote helpers already used throughout this file) for setup.

- [ ] **Step 2: Run test to verify current behavior (should already pass)**

Run: `pnpm --filter @damo/mock-api test`
Expected: PASS via the old `write()` path.

- [ ] **Step 3: Replace `repeatMeeting`**

```ts
  async repeatMeeting(
    sourceMeetingId: string,
    userId: string,
    input: RepeatMeetingInput
  ) {
    const newMeetingId = await this.withMeetingLock(sourceMeetingId, async (client) => {
      const sourceResult = await client.query<{
        hostUserId: string;
        status: MeetingStatus;
        joinCode: string;
        seriesId: string | null;
        nextMeetingId: string | null;
      }>(
        `
          select
            host_user_id as "hostUserId", status, join_code as "joinCode",
            series_id as "seriesId", next_meeting_id as "nextMeetingId"
          from meetings
          where id = $1 and status <> 'DELETED'
        `,
        [sourceMeetingId]
      );
      const source = sourceResult.rows[0];
      if (!source) {
        throw new StoreError(404, "MEETING_NOT_FOUND", "모임을 찾을 수 없습니다.");
      }
      if (source.hostUserId !== userId) {
        throw new StoreError(403, "HOST_ONLY", "모임장만 실행할 수 있습니다.");
      }
      if (source.status !== "COMPLETED") {
        throw new StoreError(409, "MEETING_NOT_COMPLETED", "완료된 모임에서만 다시 만나기를 시작할 수 있습니다.");
      }
      if (source.nextMeetingId) {
        throw new StoreError(
          409,
          "NEXT_MEETING_ALREADY_EXISTS",
          "이미 다음 회차가 만들어져 있습니다.",
          { meetingId: source.nextMeetingId }
        );
      }

      const memberResult = await client.query<{
        id: string;
        userId: string;
        meetingNickname: string;
        role: "HOST" | "MEMBER";
      }>(
        `
          select id, user_id as "userId", meeting_nickname as "meetingNickname", role
          from meeting_members
          where meeting_id = $1 and status = 'ACTIVE'
        `,
        [sourceMeetingId]
      );
      const sourceMembers = memberResult.rows;
      const selectedIds = new Set(input.memberIds);
      const selectedMembers = sourceMembers.filter((member) => selectedIds.has(member.id));
      const hostMember = sourceMembers.find((member) => member.role === "HOST");
      if (!hostMember || !selectedIds.has(hostMember.id)) {
        throw new StoreError(422, "HOST_MEMBER_REQUIRED", "모임장은 다음 회차에 반드시 포함되어야 합니다.");
      }
      if (selectedMembers.length !== selectedIds.size) {
        throw new StoreError(422, "INVALID_MEMBER_SELECTION", "이전 모임에 참여한 모임원만 선택할 수 있습니다.");
      }
      if (selectedMembers.length > input.capacity) {
        throw new StoreError(422, "CAPACITY_TOO_SMALL", "선택한 모임원 수보다 정원을 작게 설정할 수 없습니다.");
      }
      if (
        input.recurrence?.type === "CUSTOM" &&
        (!input.recurrence.customNextMeetingAt ||
          new Date(input.recurrence.customNextMeetingAt).getTime() <=
            new Date(input.meetingAt).getTime())
      ) {
        throw new StoreError(
          422,
          "INVALID_CUSTOM_RECURRENCE_DATE",
          "직접 입력한 다음 일정은 이번 회차보다 뒤여야 합니다."
        );
      }

      const seriesId = source.seriesId ?? sourceMeetingId;

      // Reuses the source's join_code (same continuity intent as
      // createNextRecurringOccurrence). The source is already COMPLETED
      // (checked above), so it's outside meetings_active_join_code_unique's
      // predicate — but an unrelated active meeting could coincidentally
      // hold the same code, so retry with a fresh random code on collision,
      // same savepoint pattern as createMeeting/createNextRecurringOccurrence.
      let newId = "";
      let inserted = false;
      for (let attempt = 0; attempt < 50 && !inserted; attempt += 1) {
        const candidateId = randomUUID();
        const joinCode = attempt === 0 ? source.joinCode : this.randomJoinCodeCandidate();
        await client.query("savepoint repeat_meeting_join_code_attempt");
        try {
          await client.query(
            `
              insert into meetings (
                id, name, host_user_id, capacity, meeting_at, purpose, mood,
                join_code, status, series_id, parent_meeting_id,
                recurrence_type, recurrence_next_at
              )
              values (
                $1, $2, $3, $4, $5, $6, $7, $8, 'RECRUITING', $9, $10, $11, $12
              )
            `,
            [
              candidateId,
              input.name,
              source.hostUserId,
              input.capacity,
              input.meetingAt,
              input.purpose,
              input.mood,
              joinCode,
              seriesId,
              sourceMeetingId,
              input.recurrence?.type ?? null,
              input.recurrence?.customNextMeetingAt ?? null
            ]
          );
          newId = candidateId;
          inserted = true;
        } catch (error) {
          if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "23505"
          ) {
            await client.query("rollback to savepoint repeat_meeting_join_code_attempt");
            continue;
          }
          throw error;
        }
      }
      if (!inserted) {
        throw new StoreError(500, "JOIN_CODE_EXHAUSTED", "가입 코드를 발급할 수 없습니다.");
      }

      for (const member of selectedMembers) {
        await client.query(
          `
            insert into meeting_members (id, meeting_id, user_id, meeting_nickname, role, status)
            values ($1, $2, $3, $4, $5, 'ACTIVE')
          `,
          [randomUUID(), newId, member.userId, member.meetingNickname, member.role]
        );
      }

      await client.query(
        `update meetings set next_meeting_id = $2, updated_at = now() where id = $1`,
        [sourceMeetingId, newId]
      );

      return newId;
    });

    return this.detail(newMeetingId, userId);
  }
```

Note: this mirrors `createNextRecurringOccurrence`'s join-code-reuse-with-retry pattern (Task 10), but unlike that helper, there's no ordering precondition to worry about here — `repeatMeeting` only runs once the source is already `COMPLETED` (checked at the top of this same method), so the source row is already outside `meetings_active_join_code_unique`'s predicate before the INSERT ever runs.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @damo/mock-api test`
Expected: PASS.

- [ ] **Step 5: Typecheck and run the full memory-store suite too**

Run: `pnpm --filter @damo/mock-api typecheck && pnpm test:api`
Expected: both pass.

- [ ] **Step 6: Commit**

```bash
git add apps/mock-api/src/postgres-store.ts apps/mock-api/src/postgres-store.test.ts
git commit -m "Convert repeatMeeting to targeted SQL, closing the write() gap entirely"
```

---

## Task 18: Update documentation

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
- PostgreSQL 저장소의 나머지 변경 작업(reset)을 개별 SQL로 전환 — `reset()`은 DB 전체 초기화가 목적이라 대상에서 제외, 그 외 모든 모임 관련 쓰기는 전환 완료
```

- [ ] **Step 2: Add a lock-strategy note to `docs/database.md`**

In `docs/database.md`, under section `## 1. 구성`, add a new bullet after the existing RLS bullet:

```
- 모임과 관련된 쓰기 작업은 모임별 advisory lock(`pg_advisory_xact_lock(hashtext('meeting:' || meetingId))`)으로 직렬화한다. 서로 다른 모임의 쓰기는 서로 막지 않는다.
```

- [ ] **Step 3: Add test-database setup instructions to `docs/local-development.md`**

Read `docs/local-development.md` first to find the right insertion point (likely near the existing Supabase connection instructions), then add a new subsection. **Note:** the original plan assumed a second Supabase project, but the account's org hit Supabase's free-tier 2-project limit during Task 0, so this repo's actual `TEST_DATABASE_URL` points at a local Homebrew PostgreSQL 16 instance instead — document both options, with local Postgres as the primary path since that's what's actually configured:

```markdown
## Postgres 통합 테스트용 데이터베이스

`apps/mock-api/src/postgres-store.test.ts`는 실제 Postgres에 대해 도는 통합 테스트다. Render/프로덕션이 쓰는 `DATABASE_URL`과는 별개로, 테스트 전용 DB를 `TEST_DATABASE_URL`로 등록한다.

**로컬 Postgres 사용 (권장, 계정 제한 없음):**

```powershell
brew install postgresql@16
brew services start postgresql@16
createdb damo_test
psql -d damo_test -c "create role anon; create role authenticated;"
```

`apps/mock-api/.env.local`:
```env
TEST_DATABASE_URL=postgresql://<로컬 사용자명>@localhost:5432/damo_test
```

`anon`/`authenticated` 역할은 `0001_initial.sql`의 `revoke ... from anon, authenticated` 구문이 Supabase 전용 역할을 가정하기 때문에 로컬에서는 빈 역할로 미리 만들어둬야 한다.

**별도 Supabase 프로젝트를 쓸 수 있다면:**

```env
TEST_DATABASE_URL=postgresql://postgres.<test-project-ref>:비밀번호@REGION.pooler.supabase.com:5432/postgres
```

어느 쪽이든, 값을 설정한 뒤 마이그레이션을 적용한다:

```powershell
DATABASE_URL="$TEST_DATABASE_URL" pnpm --filter @damo/mock-api db:migrate
```

`TEST_DATABASE_URL`이 없으면 `pnpm test:api`는 해당 스위트를 자동으로 건너뛴다. 이 값이 Render/프로덕션이 쓰는 `DATABASE_URL`과 절대 같은 값이면 안 된다 — 테스트가 `store.reset()`으로 데이터를 계속 지운다.
```

- [ ] **Step 4: Commit**

```bash
git add README.md docs/database.md docs/local-development.md
git commit -m "Document the meeting-scoped lock strategy and test-database setup"
```

---

## Task 19: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Confirm the Task 3 race condition is fully closed**

Run: `grep -n "return this.write(\|return this.read(" apps/mock-api/src/postgres-store.ts`
Expected: the only remaining match is inside `reset()` (`return this.write((store) => { store.reset(); }, true);`). If any other method still calls `this.write(` or `this.read(`, the interim data-loss race identified in Task 3's review (and the `repeatMeeting` gap found in Task 16's review) is NOT fully closed — stop and report BLOCKED rather than proceeding.

- [ ] **Step 2: Full local verification**

Run: `pnpm typecheck && pnpm test:api && pnpm build:render`
Expected: all three succeed.

- [ ] **Step 3: Full Postgres-backed verification**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" pnpm --filter @damo/mock-api test`
Expected: all tests pass, including every new integration test added in Tasks 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 15, 16, 17.

- [ ] **Step 4: Re-measure the original symptom against Render**

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

- [ ] **Step 5: Push and open a PR (only if the user asks for this step — do not push automatically)**

```bash
git push -u origin codex/postgres-write-path-lightening
```
