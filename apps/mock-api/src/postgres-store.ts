import { randomUUID } from "node:crypto";
import { compare, hash } from "bcryptjs";
import type {
  CreateMeetingInput,
  Mood,
  Place,
  Purpose,
  User
} from "@damo/contracts";
import type { Pool, PoolClient } from "pg";
import { createDatabasePool } from "./database.js";
import {
  MockStore,
  StoreError,
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

const timestamp = (value: unknown) => {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
};

const nullableTimestamp = (value: unknown) =>
  value === null || value === undefined ? null : timestamp(value);

const hasBcryptHash = (value: string) => /^\$2[aby]\$\d{2}\$/.test(value);

export class PostgresStore {
  constructor(private readonly pool: Pool = createDatabasePool()) {}

  private async loadSnapshot(client: PoolClient): Promise<StoreSnapshot> {
    const usersResult = await client.query<{
      id: string;
      loginProvider: UserRecord["loginProvider"];
      loginId: string;
      password: string;
      nickname: string;
      email: string | null;
    }>(`
      select
        id,
        login_provider as "loginProvider",
        coalesce(login_id, '') as "loginId",
        coalesce(password_hash, '') as password,
        nickname,
        email
      from users
    `);

    const tokensResult = await client.query<{ accessToken: string; userId: string }>(`
      select access_token as "accessToken", user_id as "userId"
      from auth_sessions
    `);

    const placesResult = await client.query<{
      id: string;
      naverPlaceId: string;
      name: string;
      category: string;
      address: string;
      roadAddress: string;
      latitude: number;
      longitude: number;
      station: string;
      distanceText: string;
      imageUrl: string | null;
    }>(`
      select
        id,
        naver_place_id as "naverPlaceId",
        name,
        category,
        address,
        road_address as "roadAddress",
        latitude,
        longitude,
        station,
        distance_text as "distanceText",
        image_url as "imageUrl"
      from places
    `);

    const places = placesResult.rows.map((row) => ({
      ...row,
      imageUrl: row.imageUrl ?? undefined
    }));
    const placesById = new Map(places.map((place) => [place.id, place]));

    const userPlacesResult = await client.query<{
      id: string;
      userId: string;
      placeId: string;
      purpose: Purpose;
      mood: Mood;
      isActive: boolean;
      createdAt: Date | string;
      updatedAt: Date | string;
    }>(`
      select
        id,
        user_id as "userId",
        place_id as "placeId",
        purpose,
        mood,
        is_active as "isActive",
        created_at as "createdAt",
        updated_at as "updatedAt"
      from user_places
    `);

    const meetingsResult = await client.query<{
      id: string;
      name: string;
      hostUserId: string;
      capacity: number;
      meetingAt: Date | string;
      purpose: Purpose;
      mood: Mood;
      joinCode: string;
      status: MeetingRecord["status"];
      finalCandidateId: string | null;
      createdAt: Date | string;
      updatedAt: Date | string;
      deletedAt: Date | string | null;
    }>(`
      select
        id,
        name,
        host_user_id as "hostUserId",
        capacity,
        meeting_at as "meetingAt",
        purpose,
        mood,
        join_code as "joinCode",
        status,
        final_candidate_id as "finalCandidateId",
        created_at as "createdAt",
        updated_at as "updatedAt",
        deleted_at as "deletedAt"
      from meetings
    `);

    const membersResult = await client.query<{
      id: string;
      meetingId: string;
      userId: string;
      meetingNickname: string;
      role: MemberRecord["role"];
      status: MemberRecord["status"];
      joinedAt: Date | string;
    }>(`
      select
        id,
        meeting_id as "meetingId",
        user_id as "userId",
        meeting_nickname as "meetingNickname",
        role,
        status,
        joined_at as "joinedAt"
      from meeting_members
    `);

    const candidatesResult = await client.query<{
      id: string;
      meetingId: string;
      placeId: string;
      isFrozen: boolean;
    }>(`
      select
        id,
        meeting_id as "meetingId",
        place_id as "placeId",
        is_frozen as "isFrozen"
      from meeting_candidates
    `);

    const recommendationsResult = await client.query<
      RecommendationRecord & { candidateId: string }
    >(`
      select
        candidate_id as "candidateId",
        member_id as "memberId",
        user_place_id as "userPlaceId",
        purpose,
        mood
      from candidate_recommendations
    `);

    const recommendationsByCandidate = new Map<string, RecommendationRecord[]>();
    for (const row of recommendationsResult.rows) {
      const values = recommendationsByCandidate.get(row.candidateId) ?? [];
      values.push({
        memberId: row.memberId,
        userPlaceId: row.userPlaceId,
        purpose: row.purpose,
        mood: row.mood
      });
      recommendationsByCandidate.set(row.candidateId, values);
    }

    const votesResult = await client.query<{
      id: string;
      meetingId: string;
      status: VoteRecord["status"];
      createdAt: Date | string;
      closedAt: Date | string | null;
    }>(`
      select
        id,
        meeting_id as "meetingId",
        status,
        created_at as "createdAt",
        closed_at as "closedAt"
      from votes
    `);

    const sessionsResult = await client.query<{
      id: string;
      voteId: string;
      meetingId: string;
      memberId: string;
      userId: string;
      status: VoteSessionRecord["status"];
      totalRounds: number;
      completedRounds: number;
      candidateOrder: string[];
      currentWinnerCandidateId: string | null;
      updatedAt: Date | string;
    }>(`
      select
        id,
        vote_id as "voteId",
        meeting_id as "meetingId",
        member_id as "memberId",
        user_id as "userId",
        status,
        total_rounds as "totalRounds",
        completed_rounds as "completedRounds",
        candidate_order as "candidateOrder",
        current_winner_candidate_id as "currentWinnerCandidateId",
        updated_at as "updatedAt"
      from vote_sessions
    `);

    const choicesResult = await client.query<
      ChoiceRecord & { sessionId: string; selectedAt: Date | string }
    >(`
      select
        session_id as "sessionId",
        round_number as "roundNumber",
        candidate_a_id as "candidateAId",
        candidate_b_id as "candidateBId",
        selected_candidate_id as "selectedCandidateId",
        selected_at as "selectedAt"
      from vote_choices
      order by session_id, round_number
    `);

    const choicesBySession = new Map<string, ChoiceRecord[]>();
    for (const row of choicesResult.rows) {
      const values = choicesBySession.get(row.sessionId) ?? [];
      values.push({
        roundNumber: row.roundNumber,
        candidateAId: row.candidateAId,
        candidateBId: row.candidateBId,
        selectedCandidateId: row.selectedCandidateId,
        selectedAt: timestamp(row.selectedAt)
      });
      choicesBySession.set(row.sessionId, values);
    }

    return {
      users: usersResult.rows,
      tokens: tokensResult.rows.map((row) => [row.accessToken, row.userId]),
      places,
      userPlaces: userPlacesResult.rows.map((row) => {
        const place = placesById.get(row.placeId);
        if (!place) {
          throw new Error(`user_places(${row.id})의 장소 ${row.placeId}를 찾을 수 없습니다.`);
        }
        return {
          id: row.id,
          userId: row.userId,
          place,
          purpose: row.purpose,
          mood: row.mood,
          isActive: row.isActive,
          createdAt: timestamp(row.createdAt),
          updatedAt: timestamp(row.updatedAt)
        };
      }),
      meetings: meetingsResult.rows.map((row) => ({
        ...row,
        meetingAt: timestamp(row.meetingAt),
        createdAt: timestamp(row.createdAt),
        updatedAt: timestamp(row.updatedAt),
        deletedAt: nullableTimestamp(row.deletedAt)
      })),
      members: membersResult.rows.map((row) => ({
        ...row,
        joinedAt: timestamp(row.joinedAt)
      })),
      candidates: candidatesResult.rows.map((row) => ({
        ...row,
        recommendations: recommendationsByCandidate.get(row.id) ?? []
      })),
      votes: votesResult.rows.map((row) => ({
        ...row,
        createdAt: timestamp(row.createdAt),
        closedAt: nullableTimestamp(row.closedAt)
      })),
      sessions: sessionsResult.rows.map((row) => ({
        ...row,
        updatedAt: timestamp(row.updatedAt),
        choices: choicesBySession.get(row.id) ?? []
      }))
    };
  }

  private async hashPlainPasswords(snapshot: StoreSnapshot) {
    for (const user of snapshot.users) {
      if (user.password && !hasBcryptHash(user.password)) {
        user.password = await hash(user.password, 12);
      }
    }
  }

  private async saveSnapshot(client: PoolClient, snapshot: StoreSnapshot) {
    await this.hashPlainPasswords(snapshot);

    for (const user of snapshot.users) {
      await client.query(
        `
          insert into users (
            id, login_provider, login_id, password_hash, nickname, email, updated_at
          )
          values ($1, $2, nullif($3, ''), nullif($4, ''), $5, $6, now())
          on conflict (id) do update set
            login_provider = excluded.login_provider,
            login_id = excluded.login_id,
            password_hash = excluded.password_hash,
            nickname = excluded.nickname,
            email = excluded.email,
            updated_at = now()
        `,
        [
          user.id,
          user.loginProvider,
          user.loginId,
          user.password,
          user.nickname,
          user.email
        ]
      );
    }

    for (const place of snapshot.places) {
      await client.query(
        `
          insert into places (
            id, naver_place_id, name, category, address, road_address,
            latitude, longitude, station, distance_text, image_url, updated_at
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
          on conflict (naver_place_id) do update set
            name = excluded.name,
            category = excluded.category,
            address = excluded.address,
            road_address = excluded.road_address,
            latitude = excluded.latitude,
            longitude = excluded.longitude,
            station = excluded.station,
            distance_text = excluded.distance_text,
            image_url = coalesce(excluded.image_url, places.image_url),
            updated_at = now()
        `,
        [
          place.id,
          place.naverPlaceId,
          place.name,
          place.category,
          place.address,
          place.roadAddress,
          place.latitude,
          place.longitude,
          place.station,
          place.distanceText,
          place.imageUrl ?? null
        ]
      );
    }

    for (const userPlace of snapshot.userPlaces) {
      await client.query(
        `
          insert into user_places (
            id, user_id, place_id, purpose, mood, is_active, created_at, updated_at
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8)
          on conflict (id) do update set
            purpose = excluded.purpose,
            mood = excluded.mood,
            is_active = excluded.is_active,
            updated_at = excluded.updated_at
        `,
        [
          userPlace.id,
          userPlace.userId,
          userPlace.place.id,
          userPlace.purpose,
          userPlace.mood,
          userPlace.isActive,
          userPlace.createdAt,
          userPlace.updatedAt
        ]
      );
    }

    for (const meeting of snapshot.meetings) {
      await client.query(
        `
          insert into meetings (
            id, name, host_user_id, capacity, meeting_at, purpose, mood,
            join_code, status, final_candidate_id, created_at, updated_at, deleted_at
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
          on conflict (id) do update set
            name = excluded.name,
            capacity = excluded.capacity,
            meeting_at = excluded.meeting_at,
            purpose = excluded.purpose,
            mood = excluded.mood,
            join_code = excluded.join_code,
            status = excluded.status,
            final_candidate_id = excluded.final_candidate_id,
            updated_at = excluded.updated_at,
            deleted_at = excluded.deleted_at
        `,
        [
          meeting.id,
          meeting.name,
          meeting.hostUserId,
          meeting.capacity,
          meeting.meetingAt,
          meeting.purpose,
          meeting.mood,
          meeting.joinCode,
          meeting.status,
          meeting.finalCandidateId,
          meeting.createdAt,
          meeting.updatedAt,
          meeting.deletedAt
        ]
      );
    }

    for (const member of snapshot.members) {
      await client.query(
        `
          insert into meeting_members (
            id, meeting_id, user_id, meeting_nickname, role, status, joined_at
          )
          values ($1, $2, $3, $4, $5, $6, $7)
          on conflict (id) do update set
            meeting_nickname = excluded.meeting_nickname,
            role = excluded.role,
            status = excluded.status,
            joined_at = excluded.joined_at
        `,
        [
          member.id,
          member.meetingId,
          member.userId,
          member.meetingNickname,
          member.role,
          member.status,
          member.joinedAt
        ]
      );
    }

    for (const candidate of snapshot.candidates) {
      await client.query(
        `
          insert into meeting_candidates (id, meeting_id, place_id, is_frozen)
          values ($1, $2, $3, $4)
          on conflict (id) do update set
            is_frozen = excluded.is_frozen
        `,
        [candidate.id, candidate.meetingId, candidate.placeId, candidate.isFrozen]
      );
    }

    await client.query("delete from candidate_recommendations");
    for (const candidate of snapshot.candidates) {
      for (const recommendation of candidate.recommendations) {
        await client.query(
          `
            insert into candidate_recommendations (
              candidate_id, member_id, user_place_id, purpose, mood
            )
            values ($1, $2, $3, $4, $5)
          `,
          [
            candidate.id,
            recommendation.memberId,
            recommendation.userPlaceId,
            recommendation.purpose,
            recommendation.mood
          ]
        );
      }
    }

    for (const vote of snapshot.votes) {
      await client.query(
        `
          insert into votes (id, meeting_id, status, created_at, closed_at)
          values ($1, $2, $3, $4, $5)
          on conflict (id) do update set
            status = excluded.status,
            closed_at = excluded.closed_at
        `,
        [vote.id, vote.meetingId, vote.status, vote.createdAt, vote.closedAt]
      );
    }

    for (const session of snapshot.sessions) {
      await client.query(
        `
          insert into vote_sessions (
            id, vote_id, meeting_id, member_id, user_id, status,
            total_rounds, completed_rounds, candidate_order,
            current_winner_candidate_id, updated_at
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          on conflict (id) do update set
            status = excluded.status,
            total_rounds = excluded.total_rounds,
            completed_rounds = excluded.completed_rounds,
            candidate_order = excluded.candidate_order,
            current_winner_candidate_id = excluded.current_winner_candidate_id,
            updated_at = excluded.updated_at
        `,
        [
          session.id,
          session.voteId,
          session.meetingId,
          session.memberId,
          session.userId,
          session.status,
          session.totalRounds,
          session.completedRounds,
          session.candidateOrder,
          session.currentWinnerCandidateId,
          session.updatedAt
        ]
      );
    }

    await client.query("delete from vote_choices");
    for (const session of snapshot.sessions) {
      for (const choice of session.choices) {
        await client.query(
          `
            insert into vote_choices (
              session_id, round_number, candidate_a_id, candidate_b_id,
              selected_candidate_id, selected_at
            )
            values ($1, $2, $3, $4, $5, $6)
          `,
          [
            session.id,
            choice.roundNumber,
            choice.candidateAId,
            choice.candidateBId,
            choice.selectedCandidateId,
            choice.selectedAt
          ]
        );
      }
    }

    for (const [accessToken, userId] of snapshot.tokens) {
      await client.query(
        `
          insert into auth_sessions (access_token, refresh_token, user_id)
          values ($1, $2, $3)
          on conflict (access_token) do update set
            refresh_token = excluded.refresh_token,
            user_id = excluded.user_id
        `,
        [accessToken, `mock-refresh-${userId}`, userId]
      );
    }

    const candidateIds = snapshot.candidates.map((candidate) => candidate.id);
    if (candidateIds.length === 0) {
      await client.query("delete from meeting_candidates");
    } else {
      await client.query(
        "delete from meeting_candidates where not (id = any($1::text[]))",
        [candidateIds]
      );
    }
  }

  private async read<T>(operation: (store: MockStore) => T): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("begin transaction isolation level repeatable read read only");
      const store = new MockStore();
      store.hydrate(await this.loadSnapshot(client));
      const result = operation(store);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  private async write<T>(
    operation: (store: MockStore) => T | Promise<T>,
    replaceAll = false
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtext('damo-store-write'))");
      const store = new MockStore();
      if (!replaceAll) {
        store.hydrate(await this.loadSnapshot(client));
      }
      const result = await operation(store);
      if (replaceAll) {
        await client.query(`
          truncate table
            vote_choices, vote_sessions, votes, candidate_recommendations,
            meeting_candidates, meeting_members, meetings, user_places,
            auth_sessions, places, users
          restart identity cascade
        `);
      }
      await this.saveSnapshot(client, store.snapshot());
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async healthCheck() {
    await this.pool.query("select 1");
  }

  async close() {
    await this.pool.end();
  }

  async seedIfEmpty() {
    const result = await this.pool.query<{ count: string }>(
      "select count(*)::text as count from users"
    );
    if (Number(result.rows[0]?.count ?? 0) > 0) return { seeded: false };
    await this.reset();
    return { seeded: true };
  }

  async reset() {
    return this.write((store) => {
      store.reset();
    }, true);
  }

  async getPlace(id: string) {
    return this.read((store) => store.getPlace(id));
  }

  async getUser(userId: string) {
    return this.read((store) => store.getUser(userId));
  }

  async userIdForToken(token: string | undefined) {
    return this.read((store) => store.userIdForToken(token));
  }

  async signup(
    loginId: string,
    nickname: string,
    password: string,
    email?: string | null
  ) {
    return this.write(async (store) => {
      if (
        store.users.some(
          (user) => user.loginId.toLowerCase() === loginId.toLowerCase()
        )
      ) {
        throw new StoreError(
          409,
          "LOGIN_ID_ALREADY_EXISTS",
          "이미 사용 중인 아이디입니다."
        );
      }
      const id = randomUUID();
      const user: UserRecord = {
        id,
        loginId,
        password: await hash(password, 12),
        nickname,
        email: email ?? null,
        loginProvider: "TEST"
      };
      store.users.push(user);
      const accessToken = `mock-token-${id}`;
      store.tokens.set(accessToken, id);
      const safeUser: User = {
        id,
        loginProvider: user.loginProvider,
        nickname: user.nickname,
        email: user.email
      };
      return {
        user: safeUser,
        accessToken,
        refreshToken: `mock-refresh-${id}`
      };
    });
  }

  async login(loginId: string, password: string) {
    return this.write(async (store) => {
      const user = store.users.find(
        (item) => item.loginId.toLowerCase() === loginId.toLowerCase()
      );
      if (!user || !(await compare(password, user.password))) {
        throw new StoreError(
          401,
          "INVALID_CREDENTIALS",
          "아이디 또는 비밀번호가 올바르지 않습니다."
        );
      }
      const accessToken = `mock-token-${user.id}`;
      store.tokens.set(accessToken, user.id);
      const safeUser: User = {
        id: user.id,
        loginProvider: user.loginProvider,
        nickname: user.nickname,
        email: user.email
      };
      return {
        user: safeUser,
        accessToken,
        refreshToken: `mock-refresh-${user.id}`
      };
    });
  }

  async searchPlaces(query: string) {
    return this.read((store) => store.searchPlaces(query));
  }

  async upsertPlaces(items: Place[]) {
    return this.write((store) => store.upsertPlaces(items));
  }

  async listUserPlaces(userId: string) {
    return this.read((store) => store.listUserPlaces(userId));
  }

  async registerUserPlace(
    userId: string,
    naverPlaceId: string,
    purpose: Purpose,
    mood: Mood
  ) {
    return this.write((store) =>
      store.registerUserPlace(userId, naverPlaceId, purpose, mood)
    );
  }

  async updateUserPlace(
    userId: string,
    userPlaceId: string,
    purpose: Purpose,
    mood: Mood,
    applyToMeetingIds: string[]
  ) {
    return this.write((store) =>
      store.updateUserPlace(
        userId,
        userPlaceId,
        purpose,
        mood,
        applyToMeetingIds
      )
    );
  }

  async unregisterUserPlace(
    userId: string,
    userPlaceId: string,
    applyToActiveMeetings: boolean
  ) {
    return this.write((store) =>
      store.unregisterUserPlace(
        userId,
        userPlaceId,
        applyToActiveMeetings
      )
    );
  }

  async home(userId: string) {
    return this.read((store) => store.home(userId));
  }

  async createMeeting(userId: string, input: CreateMeetingInput) {
    return this.write((store) => store.createMeeting(userId, input));
  }

  async lookupMeeting(joinCode: string) {
    return this.read((store) => store.lookupMeeting(joinCode));
  }

  async joinMeeting(
    userId: string,
    meetingId: string,
    joinCode: string,
    meetingNickname: string
  ) {
    return this.write((store) =>
      store.joinMeeting(userId, meetingId, joinCode, meetingNickname)
    );
  }

  async detail(meetingId: string, userId: string) {
    return this.read((store) => store.detail(meetingId, userId));
  }

  async leaveMeeting(meetingId: string, userId: string) {
    return this.write((store) => store.leaveMeeting(meetingId, userId));
  }

  async kickMember(meetingId: string, hostUserId: string, memberId: string) {
    return this.write((store) =>
      store.kickMember(meetingId, hostUserId, memberId)
    );
  }

  async deleteMeeting(meetingId: string, userId: string) {
    return this.write((store) => store.deleteMeeting(meetingId, userId));
  }

  async eligiblePlaces(meetingId: string, userId: string) {
    return this.read((store) => store.eligiblePlaces(meetingId, userId));
  }

  async publicCandidates(meetingId: string, userId: string) {
    return this.read((store) => store.publicCandidates(meetingId, userId));
  }

  async replaceMyCandidates(
    meetingId: string,
    userId: string,
    userPlaceIds: string[]
  ) {
    return this.write((store) =>
      store.replaceMyCandidates(meetingId, userId, userPlaceIds)
    );
  }

  async createVote(meetingId: string, userId: string) {
    return this.write((store) => store.createVote(meetingId, userId));
  }

  async voteSession(meetingId: string, userId: string) {
    return this.read((store) => store.voteSession(meetingId, userId));
  }

  async saveChoice(
    meetingId: string,
    userId: string,
    roundNumber: number,
    selectedCandidateId: string
  ) {
    return this.write((store) =>
      store.saveChoice(
        meetingId,
        userId,
        roundNumber,
        selectedCandidateId
      )
    );
  }

  async voteResults(meetingId: string, userId: string) {
    return this.read((store) => store.voteResults(meetingId, userId));
  }

  async closeVote(meetingId: string, userId: string, force: boolean) {
    return this.write((store) =>
      store.closeVote(meetingId, userId, force)
    );
  }

  async finalSelection(
    meetingId: string,
    userId: string,
    candidateId: string
  ) {
    return this.write((store) =>
      store.finalSelection(meetingId, userId, candidateId)
    );
  }
}
