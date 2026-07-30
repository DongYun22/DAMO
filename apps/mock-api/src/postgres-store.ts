import { randomUUID } from "node:crypto";
import { compare, hash } from "bcryptjs";
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
import type { Pool, PoolClient } from "pg";
import { createDatabasePool } from "./database.js";
import { webBaseUrl } from "./config.js";
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

interface PlaceRow {
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
}

interface UserPlaceRow extends PlaceRow {
  userPlaceId: string;
  userId: string;
  purpose: Purpose;
  mood: Mood;
  isActive: boolean;
  createdAt: Date | string;
  updatedAt: Date | string;
}

interface CandidateQueryRow extends PlaceRow {
  candidateId: string;
  meetingId: string;
  isFrozen: boolean;
  recommendationCount: number;
  recommendedByMe: boolean;
  recommenderNames: string[];
}

interface VoteSessionQueryRow {
  id: string;
  status: VoteSessionView["status"];
  totalRounds: number;
  completedRounds: number;
  candidateOrder: string[];
  currentWinnerCandidateId: string | null;
}

const placeFromRow = (row: PlaceRow): Place => ({
  id: row.id,
  naverPlaceId: row.naverPlaceId,
  name: row.name,
  category: row.category,
  address: row.address,
  roadAddress: row.roadAddress,
  latitude: row.latitude,
  longitude: row.longitude,
  station: row.station,
  distanceText: row.distanceText,
  ...(row.imageUrl ? { imageUrl: row.imageUrl } : {})
});

const userPlaceFromRow = (row: UserPlaceRow): UserPlace => ({
  id: row.userPlaceId,
  userId: row.userId,
  place: placeFromRow(row),
  purpose: row.purpose,
  mood: row.mood,
  isActive: row.isActive,
  createdAt: timestamp(row.createdAt),
  updatedAt: timestamp(row.updatedAt)
});

export class PostgresStore {
  constructor(private readonly pool: Pool = createDatabasePool()) {}

  private randomJoinCodeCandidate() {
    return Math.floor(1000 + Math.random() * 9000).toString();
  }

  private async queryPublicCandidates(
    client: PoolClient,
    meetingId: string,
    userId: string,
    candidateIds?: string[]
  ): Promise<Candidate[]> {
    const result = await client.query<CandidateQueryRow>(
      `
        select
          candidate.id as "candidateId",
          candidate.meeting_id as "meetingId",
          candidate.is_frozen as "isFrozen",
          count(recommendation.member_id)::int as "recommendationCount",
          bool_or(member.user_id = $2) as "recommendedByMe",
          array_agg(member.meeting_nickname order by member.meeting_nickname)
            as "recommenderNames",
          p.id,
          p.naver_place_id as "naverPlaceId",
          p.name,
          p.category,
          p.address,
          p.road_address as "roadAddress",
          p.latitude,
          p.longitude,
          p.station,
          p.distance_text as "distanceText",
          p.image_url as "imageUrl"
        from meeting_candidates candidate
        join candidate_recommendations recommendation
          on recommendation.candidate_id = candidate.id
        join meeting_members member on member.id = recommendation.member_id
        join places p on p.id = candidate.place_id
        where candidate.meeting_id = $1
          and ($3::text[] is null or candidate.id = any($3::text[]))
        group by candidate.id, p.id
        order by p.name collate "C"
      `,
      [meetingId, userId, candidateIds ?? null]
    );
    return result.rows.map(
      (row): Candidate => ({
        id: row.candidateId,
        meetingId: row.meetingId,
        place: placeFromRow(row),
        recommendationCount: row.recommendationCount,
        recommendedByMe: row.recommendedByMe,
        recommenderNames: row.recommenderNames,
        isFrozen: row.isFrozen
      })
    );
  }

  private async voteSessionWithClient(
    client: PoolClient,
    meetingId: string,
    userId: string
  ): Promise<VoteSessionView> {
    const meetingResult = await client.query<{ status: MeetingStatus }>(
      `
        select status
        from meetings
        where id = $1 and deleted_at is null
      `,
      [meetingId]
    );
    const meeting = meetingResult.rows[0];
    if (!meeting) {
      throw new StoreError(404, "MEETING_NOT_FOUND", "모임을 찾을 수 없습니다.");
    }
    if (meeting.status !== "VOTING") {
      throw new StoreError(409, "VOTE_NOT_OPEN", "진행 중인 투표가 없습니다.");
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
        limit 1
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
    if (session.status === "COMPLETED") {
      return {
        sessionId: session.id,
        status: session.status,
        totalRounds: session.totalRounds,
        completedRounds: session.completedRounds,
        round: null
      };
    }

    const roundNumber = session.completedRounds + 1;
    const nextCandidateId = session.candidateOrder[roundNumber];
    const currentWinnerId =
      session.currentWinnerCandidateId ?? session.candidateOrder[0];
    if (!nextCandidateId || !currentWinnerId) {
      throw new StoreError(
        500,
        "INVALID_VOTE_SESSION",
        "투표 순서가 올바르지 않습니다."
      );
    }
    const swap = roundNumber % 2 === 0;
    const candidateAId = swap ? nextCandidateId : currentWinnerId;
    const candidateBId = swap ? currentWinnerId : nextCandidateId;
    const candidates = await this.queryPublicCandidates(
      client,
      meetingId,
      userId,
      [candidateAId, candidateBId]
    );
    const candidateById = new Map(
      candidates.map((candidate) => [candidate.id, candidate])
    );
    const candidateA = candidateById.get(candidateAId);
    const candidateB = candidateById.get(candidateBId);
    if (!candidateA || !candidateB) {
      throw new StoreError(
        500,
        "INVALID_VOTE_SESSION",
        "투표 후보 정보를 찾을 수 없습니다."
      );
    }

    return {
      sessionId: session.id,
      status: session.completedRounds === 0 ? "NOT_STARTED" : "IN_PROGRESS",
      totalRounds: session.totalRounds,
      completedRounds: session.completedRounds,
      round: {
        roundNumber,
        totalRounds: session.totalRounds,
        completedRounds: session.completedRounds,
        candidateA,
        candidateB
      }
    };
  }

  private async computeVoteResults(
    client: PoolClient,
    meetingId: string,
    userId: string
  ): Promise<VoteResults> {
    const meetingResult = await client.query<{
      status: MeetingStatus;
      finalCandidateId: string | null;
      memberId: string | null;
    }>(
      `
        select m.status, m.final_candidate_id as "finalCandidateId", member.id as "memberId"
        from meetings m
        left join meeting_members member
          on member.meeting_id = m.id
          and member.user_id = $2
          and member.status = 'ACTIVE'
        where m.id = $1 and m.status <> 'DELETED'
      `,
      [meetingId, userId]
    );
    const meeting = meetingResult.rows[0];
    if (!meeting) {
      throw new StoreError(404, "MEETING_NOT_FOUND", "모임을 찾을 수 없습니다.");
    }
    if (!meeting.memberId) {
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

  private async queryUserPlaces(
    userId: string,
    userPlaceId?: string
  ): Promise<UserPlace[]> {
    const result = await this.pool.query<UserPlaceRow>(
      `
        select
          up.id as "userPlaceId",
          up.user_id as "userId",
          up.purpose,
          up.mood,
          up.is_active as "isActive",
          up.created_at as "createdAt",
          up.updated_at as "updatedAt",
          p.id,
          p.naver_place_id as "naverPlaceId",
          p.name,
          p.category,
          p.address,
          p.road_address as "roadAddress",
          p.latitude,
          p.longitude,
          p.station,
          p.distance_text as "distanceText",
          p.image_url as "imageUrl"
        from user_places up
        join places p on p.id = up.place_id
        where up.user_id = $1
          and up.is_active = true
          and ($2::text is null or up.id = $2)
        order by up.updated_at desc
      `,
      [userId, userPlaceId ?? null]
    );
    return result.rows.map(userPlaceFromRow);
  }

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
      seriesId: string | null;
      parentMeetingId: string | null;
      recurrenceType: RecurrenceType | null;
      recurrenceNextAt: Date | string | null;
      nextMeetingId: string | null;
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
        series_id as "seriesId",
        parent_meeting_id as "parentMeetingId",
        recurrence_type as "recurrenceType",
        recurrence_next_at as "recurrenceNextAt",
        next_meeting_id as "nextMeetingId",
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
        recurrenceNextAt: nullableTimestamp(row.recurrenceNextAt),
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
            join_code, status, final_candidate_id, series_id, parent_meeting_id,
            recurrence_type, recurrence_next_at, next_meeting_id,
            created_at, updated_at, deleted_at
          )
          values (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
            $13, $14, $15, $16, $17, $18
          )
          on conflict (id) do update set
            name = excluded.name,
            capacity = excluded.capacity,
            meeting_at = excluded.meeting_at,
            purpose = excluded.purpose,
            mood = excluded.mood,
            join_code = excluded.join_code,
            status = excluded.status,
            final_candidate_id = excluded.final_candidate_id,
            series_id = excluded.series_id,
            parent_meeting_id = excluded.parent_meeting_id,
            recurrence_type = excluded.recurrence_type,
            recurrence_next_at = excluded.recurrence_next_at,
            next_meeting_id = excluded.next_meeting_id,
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
          meeting.seriesId,
          meeting.parentMeetingId,
          meeting.recurrenceType,
          meeting.recurrenceNextAt,
          meeting.nextMeetingId,
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
    const result = await this.pool.query<PlaceRow>(
      `
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
        where id = $1 or naver_place_id = $1
        limit 1
      `,
      [id]
    );
    const row = result.rows[0];
    if (!row) throw new StoreError(404, "PLACE_NOT_FOUND", "장소를 찾을 수 없습니다.");
    return placeFromRow(row);
  }

  async getUser(userId: string) {
    const result = await this.pool.query<{
      id: string;
      loginProvider: User["loginProvider"];
      nickname: string;
      email: string | null;
    }>(
      `
        select
          id,
          login_provider as "loginProvider",
          nickname,
          email
        from users
        where id = $1
      `,
      [userId]
    );
    const user = result.rows[0];
    if (!user) throw new StoreError(401, "AUTH_REQUIRED", "로그인이 필요합니다.");
    return user;
  }

  async userIdForToken(token: string | undefined) {
    if (!token) throw new StoreError(401, "INVALID_TOKEN", "로그인 정보가 만료되었습니다.");
    const result = await this.pool.query<{ userId: string }>(
      `select user_id as "userId" from auth_sessions where access_token = $1`,
      [token]
    );
    const userId = result.rows[0]?.userId;
    if (!userId) throw new StoreError(401, "INVALID_TOKEN", "로그인 정보가 만료되었습니다.");
    return userId;
  }

  async signup(
    loginId: string,
    nickname: string,
    password: string,
    email?: string | null
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const id = randomUUID();
      const accessToken = `mock-token-${id}`;
      const refreshToken = `mock-refresh-${id}`;
      const result = await client.query<{
        id: string;
        loginProvider: User["loginProvider"];
        nickname: string;
        email: string | null;
      }>(
        `
          insert into users (
            id, login_provider, login_id, password_hash, nickname, email
          )
          values ($1, 'TEST', $2, $3, $4, $5)
          returning
            id,
            login_provider as "loginProvider",
            nickname,
            email
        `,
        [id, loginId, await hash(password, 12), nickname, email ?? null]
      );
      await client.query(
        `
          insert into auth_sessions (access_token, refresh_token, user_id)
          values ($1, $2, $3)
        `,
        [accessToken, refreshToken, id]
      );
      await client.query("commit");
      return { user: result.rows[0]!, accessToken, refreshToken };
    } catch (error) {
      await client.query("rollback");
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23505"
      ) {
        throw new StoreError(409, "LOGIN_ID_ALREADY_EXISTS", "이미 사용 중인 아이디입니다.");
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async login(loginId: string, password: string) {
    const result = await this.pool.query<{
      id: string;
      loginProvider: User["loginProvider"];
      password: string;
      nickname: string;
      email: string | null;
    }>(
      `
        select
          id,
          login_provider as "loginProvider",
          coalesce(password_hash, '') as password,
          nickname,
          email
        from users
        where login_provider = 'TEST' and lower(login_id) = lower($1)
      `,
      [loginId]
    );
    const row = result.rows[0];
    if (!row || !(await compare(password, row.password))) {
      throw new StoreError(
        401,
        "INVALID_CREDENTIALS",
        "아이디 또는 비밀번호가 올바르지 않습니다."
      );
    }
    const accessToken = `mock-token-${row.id}`;
    const refreshToken = `mock-refresh-${row.id}`;
    await this.pool.query(
      `
        insert into auth_sessions (access_token, refresh_token, user_id)
        values ($1, $2, $3)
        on conflict (access_token) do update set
          refresh_token = excluded.refresh_token,
          user_id = excluded.user_id,
          created_at = now()
      `,
      [accessToken, refreshToken, row.id]
    );
    const user: User = {
      id: row.id,
      loginProvider: row.loginProvider,
      nickname: row.nickname,
      email: row.email
    };
    return { user, accessToken, refreshToken };
  }

  async searchPlaces(query: string) {
    const normalized = query.trim().replace(/역$/, "");
    const result = await this.pool.query<PlaceRow>(
      `
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
        where $1 = ''
          or concat_ws(' ', name, station, category, address, road_address)
            ilike '%' || $1 || '%'
        order by name collate "C"
      `,
      [normalized]
    );
    return result.rows.map(placeFromRow);
  }

  async upsertPlaces(items: Place[]) {
    if (items.length === 0) return [];
    const values: unknown[] = [];
    const tuples = items.map((item, index) => {
      const offset = index * 11;
      values.push(
        item.id,
        item.naverPlaceId,
        item.name,
        item.category,
        item.address,
        item.roadAddress,
        item.latitude,
        item.longitude,
        item.station,
        item.distanceText,
        item.imageUrl ?? null
      );
      return `(${Array.from({ length: 11 }, (_, valueIndex) => `$${offset + valueIndex + 1}`).join(", ")})`;
    });
    const result = await this.pool.query<PlaceRow>(
      `
        insert into places (
          id, naver_place_id, name, category, address, road_address,
          latitude, longitude, station, distance_text, image_url
        )
        values ${tuples.join(", ")}
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
        returning
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
      `,
      values
    );
    return result.rows.map(placeFromRow);
  }

  async listUserPlaces(userId: string) {
    return this.queryUserPlaces(userId);
  }

  async registerUserPlace(
    userId: string,
    naverPlaceId: string,
    purpose: Purpose,
    mood: Mood
  ) {
    const result = await this.pool.query<{ userPlaceId: string }>(
      `
        insert into user_places (
          id, user_id, place_id, purpose, mood, is_active
        )
        select $1, $2, p.id, $4, $5, true
        from places p
        where p.naver_place_id = $3
        on conflict (user_id, place_id) do update set
          purpose = excluded.purpose,
          mood = excluded.mood,
          is_active = true,
          updated_at = now()
        returning id as "userPlaceId"
      `,
      [randomUUID(), userId, naverPlaceId, purpose, mood]
    );
    const userPlaceId = result.rows[0]?.userPlaceId;
    if (!userPlaceId) throw new StoreError(404, "PLACE_NOT_FOUND", "장소를 찾을 수 없습니다.");
    const item = (await this.queryUserPlaces(userId, userPlaceId))[0];
    if (!item) throw new StoreError(500, "USER_PLACE_SAVE_FAILED", "내 장소 저장 결과를 찾을 수 없습니다.");
    return item;
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
    const result = await this.pool.query<{
      id: string;
      name: string;
      role: "HOST" | "MEMBER";
      status: MeetingStatus;
      purpose: Purpose;
      mood: Mood;
      meetingAt: Date | string;
      currentMembers: number;
      capacity: number;
      joinCode: string;
      sessionStatus: VoteSessionRecord["status"] | null;
      updatedAt: Date | string;
      seriesId: string | null;
      parentMeetingId: string | null;
      recurrenceType: RecurrenceType | null;
      recurrenceNextAt: Date | string | null;
      finalId: string | null;
      finalNaverPlaceId: string | null;
      finalName: string | null;
      finalCategory: string | null;
      finalAddress: string | null;
      finalRoadAddress: string | null;
      finalLatitude: number | null;
      finalLongitude: number | null;
      finalStation: string | null;
      finalDistanceText: string | null;
      finalImageUrl: string | null;
    }>(
      `
        select
          m.id,
          m.name,
          mine.role,
          m.status,
          m.purpose,
          m.mood,
          m.meeting_at as "meetingAt",
          (
            select count(*)::int
            from meeting_members active_member
            where active_member.meeting_id = m.id
              and active_member.status = 'ACTIVE'
          ) as "currentMembers",
          m.capacity,
          m.join_code as "joinCode",
          session.status as "sessionStatus",
          m.updated_at as "updatedAt",
          m.series_id as "seriesId",
          m.parent_meeting_id as "parentMeetingId",
          m.recurrence_type as "recurrenceType",
          m.recurrence_next_at as "recurrenceNextAt",
          final_place.id as "finalId",
          final_place.naver_place_id as "finalNaverPlaceId",
          final_place.name as "finalName",
          final_place.category as "finalCategory",
          final_place.address as "finalAddress",
          final_place.road_address as "finalRoadAddress",
          final_place.latitude as "finalLatitude",
          final_place.longitude as "finalLongitude",
          final_place.station as "finalStation",
          final_place.distance_text as "finalDistanceText",
          final_place.image_url as "finalImageUrl"
        from meeting_members mine
        join meetings m on m.id = mine.meeting_id
        left join vote_sessions session
          on session.meeting_id = m.id and session.user_id = mine.user_id
        left join meeting_candidates final_candidate
          on final_candidate.id = m.final_candidate_id
        left join places final_place on final_place.id = final_candidate.place_id
        where mine.user_id = $1
          and mine.status = 'ACTIVE'
          and m.status <> 'DELETED'
        order by m.meeting_at
      `,
      [userId]
    );
    const summaries = result.rows.map((row) => {
      const myVoteCompleted = row.sessionStatus === "COMPLETED";
      return {
        id: row.id,
        name: row.name,
        role: row.role,
        status: row.status,
        purpose: row.purpose,
        mood: row.mood,
        meetingAt: timestamp(row.meetingAt),
        currentMembers: row.currentMembers,
        capacity: row.capacity,
        ...(row.role === "HOST" ? { joinCode: row.joinCode } : {}),
        voteAlert: row.status === "VOTING" && !myVoteCompleted,
        myVoteCompleted,
        finalPlace:
          row.finalId &&
          row.finalNaverPlaceId &&
          row.finalName &&
          row.finalCategory &&
          row.finalAddress &&
          row.finalRoadAddress &&
          row.finalLatitude !== null &&
          row.finalLongitude !== null
            ? {
                id: row.finalId,
                naverPlaceId: row.finalNaverPlaceId,
                name: row.finalName,
                category: row.finalCategory,
                address: row.finalAddress,
                roadAddress: row.finalRoadAddress,
                latitude: row.finalLatitude,
                longitude: row.finalLongitude,
                station: row.finalStation ?? "",
                distanceText: row.finalDistanceText ?? "",
                ...(row.finalImageUrl ? { imageUrl: row.finalImageUrl } : {})
              }
            : null,
        isPastDue: new Date(row.meetingAt).getTime() < Date.now(),
        seriesId: row.seriesId,
        parentMeetingId: row.parentMeetingId,
        recurrence: row.recurrenceType
          ? {
              type: row.recurrenceType,
              customNextMeetingAt: nullableTimestamp(row.recurrenceNextAt)
            }
          : null,
        updatedAt: timestamp(row.updatedAt)
      };
    });
    const ongoingMeetings = summaries.filter(
      (meeting) => meeting.status !== "COMPLETED" && !meeting.isPastDue
    );
    const completedMeetings = summaries
      .filter((meeting) => meeting.status === "COMPLETED" || meeting.isPastDue)
      .sort((a, b) => b.meetingAt.localeCompare(a.meetingAt));
    const data: HomeData = {
      ongoingMeetings,
      completedMeetings,
      hasVoteAlert: summaries.some((meeting) => meeting.voteAlert),
      updatedAt: new Date().toISOString()
    };
    return data;
  }

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

  async repeatMeeting(
    sourceMeetingId: string,
    userId: string,
    input: RepeatMeetingInput
  ) {
    return this.write((store) =>
      store.repeatMeeting(sourceMeetingId, userId, input)
    );
  }

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

  async detail(meetingId: string, userId: string) {
    const home = await this.home(userId);
    const summary = [...home.ongoingMeetings, ...home.completedMeetings].find(
      (meeting) => meeting.id === meetingId
    );
    if (!summary) {
      throw new StoreError(403, "MEETING_ACCESS_DENIED", "이 모임에 참여하고 있지 않습니다.");
    }
    const [meetingResult, memberResult, candidates] = await Promise.all([
      this.pool.query<{
        hostUserId: string;
        joinCode: string;
        finalCandidateId: string | null;
      }>(
        `
          select
            host_user_id as "hostUserId",
            join_code as "joinCode",
            final_candidate_id as "finalCandidateId"
          from meetings
          where id = $1
        `,
        [meetingId]
      ),
      this.pool.query<{
        id: string;
        userId: string;
        meetingNickname: string;
        role: "HOST" | "MEMBER";
        status: "ACTIVE" | "LEFT" | "KICKED";
        joinedAt: Date | string;
      }>(
        `
          select
            id,
            user_id as "userId",
            meeting_nickname as "meetingNickname",
            role,
            status,
            joined_at as "joinedAt"
          from meeting_members
          where meeting_id = $1 and status = 'ACTIVE'
          order by case when role = 'HOST' then 0 else 1 end, joined_at
        `,
        [meetingId]
      ),
      this.publicCandidates(meetingId, userId)
    ]);
    const meeting = meetingResult.rows[0];
    if (!meeting) throw new StoreError(404, "MEETING_NOT_FOUND", "모임을 찾을 수 없습니다.");
    const detail: MeetingDetail = {
      ...summary,
      hostUserId: meeting.hostUserId,
      joinCode: meeting.joinCode,
      shareUrl: `${webBaseUrl()}/meetings/join?meetingId=${meetingId}`,
      members: memberResult.rows.map((member) => ({
        ...member,
        joinedAt: timestamp(member.joinedAt)
      })),
      candidates,
      finalCandidateId: meeting.finalCandidateId
    };
    return detail;
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

  async eligiblePlaces(meetingId: string, userId: string) {
    const result = await this.pool.query<
      UserPlaceRow & {
        selected: boolean;
        purposeMatch: boolean;
        moodMatch: boolean;
      }
    >(
      `
        with meeting_context as (
          select
            m.purpose,
            m.mood,
            member.id as member_id
          from meetings m
          join meeting_members member
            on member.meeting_id = m.id
            and member.user_id = $2
            and member.status = 'ACTIVE'
          where m.id = $1 and m.status <> 'DELETED'
        )
        select
          up.id as "userPlaceId",
          up.user_id as "userId",
          up.purpose,
          up.mood,
          up.is_active as "isActive",
          up.created_at as "createdAt",
          up.updated_at as "updatedAt",
          p.id,
          p.naver_place_id as "naverPlaceId",
          p.name,
          p.category,
          p.address,
          p.road_address as "roadAddress",
          p.latitude,
          p.longitude,
          p.station,
          p.distance_text as "distanceText",
          p.image_url as "imageUrl",
          up.purpose = context.purpose as "purposeMatch",
          up.mood = context.mood as "moodMatch",
          exists (
            select 1
            from candidate_recommendations recommendation
            join meeting_candidates candidate
              on candidate.id = recommendation.candidate_id
            where candidate.meeting_id = $1
              and recommendation.member_id = context.member_id
              and recommendation.user_place_id = up.id
          ) as selected
        from user_places up
        join places p on p.id = up.place_id
        cross join meeting_context context
        where up.user_id = $2 and up.is_active = true
      `,
      [meetingId, userId]
    );
    if (result.rows.length === 0) {
      const access = await this.pool.query(
        `
          select 1
          from meetings m
          join meeting_members member
            on member.meeting_id = m.id
            and member.user_id = $2
            and member.status = 'ACTIVE'
          where m.id = $1 and m.status <> 'DELETED'
        `,
        [meetingId, userId]
      );
      if (access.rowCount === 0) {
        throw new StoreError(403, "MEETING_ACCESS_DENIED", "모임원이 아닙니다.");
      }
    }
    return result.rows
      .map((row): EligiblePlace => {
        const matchCount = Number(row.purposeMatch) + Number(row.moodMatch) as 0 | 1 | 2;
        return {
          ...userPlaceFromRow(row),
          selected: row.selected,
          purposeMatch: row.purposeMatch,
          moodMatch: row.moodMatch,
          matchCount
        };
      })
      .sort(
        (a, b) =>
          b.matchCount - a.matchCount ||
          a.place.name.localeCompare(b.place.name, "ko-KR")
      );
  }

  async publicCandidates(meetingId: string, userId: string) {
    const client = await this.pool.connect();
    try {
      const access = await client.query(
        `
          select 1
          from meeting_members
          where meeting_id = $1 and user_id = $2 and status = 'ACTIVE'
        `,
        [meetingId, userId]
      );
      if (access.rowCount === 0) {
        throw new StoreError(
          403,
          "MEETING_ACCESS_DENIED",
          "모임원이 아닙니다."
        );
      }
      return await this.queryPublicCandidates(client, meetingId, userId);
    } finally {
      client.release();
    }
  }

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

  async createVote(meetingId: string, userId: string) {
    return this.write((store) => store.createVote(meetingId, userId));
  }

  async voteSession(meetingId: string, userId: string) {
    const client = await this.pool.connect();
    try {
      return await this.voteSessionWithClient(client, meetingId, userId);
    } finally {
      client.release();
    }
  }

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
        const nextCandidateId =
          session.candidateOrder[currentRoundNumber];
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
          completedRounds >= session.totalRounds
            ? "COMPLETED"
            : "IN_PROGRESS";
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
          [
            session.id,
            roundNumber,
            candidateAId,
            candidateBId,
            selectedCandidateId
          ]
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

  async voteResults(meetingId: string, userId: string) {
    const client = await this.pool.connect();
    try {
      return await this.computeVoteResults(client, meetingId, userId);
    } finally {
      client.release();
    }
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
