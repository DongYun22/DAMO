import { randomUUID } from "node:crypto";
import { webBaseUrl } from "./config.js";
import type {
  Candidate,
  CandidateMeetingTarget,
  ConfigureMeetingRecurrenceInput,
  CreateMeetingInput,
  HomeData,
  MeetingDetail,
  MeetingMember,
  MeetingStatus,
  MeetingSummary,
  Mood,
  Place,
  Purpose,
  RecurrenceType,
  RepeatMeetingInput,
  UpdateMeetingInput,
  User,
  UserPlace,
  VoteResults,
  VoteSessionStatus,
  VoteSessionView,
  VoteStatus
} from "@damo/contracts";

export interface UserRecord extends User {
  loginId: string;
  password: string;
}

export interface MeetingRecord {
  id: string;
  name: string;
  hostUserId: string;
  capacity: number;
  meetingAt: string;
  purpose: Purpose;
  mood: Mood;
  joinCode: string;
  status: MeetingStatus;
  finalCandidateId: string | null;
  seriesId: string | null;
  parentMeetingId: string | null;
  recurrenceType: RecurrenceType | null;
  recurrenceNextAt: string | null;
  nextMeetingId: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface MemberRecord extends MeetingMember {
  meetingId: string;
}

export interface RecommendationRecord {
  memberId: string;
  userPlaceId: string;
  purpose: Purpose;
  mood: Mood;
}

export interface CandidateRecord {
  id: string;
  meetingId: string;
  placeId: string;
  isFrozen: boolean;
  recommendations: RecommendationRecord[];
}

export interface ChoiceRecord {
  roundNumber: number;
  candidateAId: string;
  candidateBId: string;
  selectedCandidateId: string;
  selectedAt: string;
}

export interface VoteSessionRecord {
  id: string;
  voteId: string;
  meetingId: string;
  memberId: string;
  userId: string;
  status: VoteSessionStatus;
  totalRounds: number;
  completedRounds: number;
  candidateOrder: string[];
  currentWinnerCandidateId: string | null;
  choices: ChoiceRecord[];
  updatedAt: string;
}

export interface VoteRecord {
  id: string;
  meetingId: string;
  status: VoteStatus;
  createdAt: string;
  closedAt: string | null;
}

export interface StoreSnapshot {
  places: Place[];
  users: UserRecord[];
  tokens: Array<[string, string]>;
  userPlaces: UserPlace[];
  meetings: MeetingRecord[];
  members: MemberRecord[];
  candidates: CandidateRecord[];
  votes: VoteRecord[];
  sessions: VoteSessionRecord[];
}

export class StoreError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
  }
}

const iso = (value: string) => new Date(value).toISOString();
const now = () => new Date().toISOString();

const nextMonthlyMeetingAt = (meetingAt: string) => {
  const koreaOffsetMs = 9 * 60 * 60 * 1000;
  const local = new Date(new Date(meetingAt).getTime() + koreaOffsetMs);
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth();
  const day = local.getUTCDate();
  const lastDay = new Date(Date.UTC(year, month + 2, 0)).getUTCDate();
  const nextLocal = Date.UTC(
    year,
    month + 1,
    Math.min(day, lastDay),
    local.getUTCHours(),
    local.getUTCMinutes()
  );
  return new Date(nextLocal - koreaOffsetMs).toISOString();
};

export const nextRecurringMeetingAt = (
  meetingAt: string,
  recurrenceType: Exclude<RecurrenceType, "CUSTOM">
) => {
  let value =
    recurrenceType === "WEEKLY"
      ? new Date(new Date(meetingAt).getTime() + 7 * 24 * 60 * 60 * 1000).toISOString()
      : nextMonthlyMeetingAt(meetingAt);
  while (new Date(value).getTime() <= Date.now()) {
    value =
      recurrenceType === "WEEKLY"
        ? new Date(new Date(value).getTime() + 7 * 24 * 60 * 60 * 1000).toISOString()
        : nextMonthlyMeetingAt(value);
  }
  return value;
};

const seedPlaces: Place[] = [
  {
    id: "place-1",
    naverPlaceId: "naver-101",
    name: "오후의 테라스",
    category: "카페·브런치",
    address: "서울 성동구 성수동1가 12-4",
    roadAddress: "서울 성동구 서울숲2길 18",
    latitude: 37.5452,
    longitude: 127.0417,
    station: "서울숲역",
    distanceText: "도보 4분",
    imageUrl: "/place-terrace.svg"
  },
  {
    id: "place-2",
    naverPlaceId: "naver-102",
    name: "호호식당 성수",
    category: "일식·가정식",
    address: "서울 성동구 성수동2가 280-7",
    roadAddress: "서울 성동구 연무장길 25",
    latitude: 37.5437,
    longitude: 127.0551,
    station: "성수역",
    distanceText: "도보 5분",
    imageUrl: "/place-dining.svg"
  },
  {
    id: "place-3",
    naverPlaceId: "naver-103",
    name: "서울숲 피자클럽",
    category: "피자·양식",
    address: "서울 성동구 성수동1가 685-20",
    roadAddress: "서울 성동구 왕십리로 83-21",
    latitude: 37.5471,
    longitude: 127.0432,
    station: "서울숲역",
    distanceText: "도보 6분",
    imageUrl: "/place-pizza.svg"
  },
  {
    id: "place-4",
    naverPlaceId: "naver-104",
    name: "페이지 스터디라운지",
    category: "스터디카페",
    address: "서울 성동구 성수동2가 277-17",
    roadAddress: "서울 성동구 아차산로 92",
    latitude: 37.5444,
    longitude: 127.0577,
    station: "성수역",
    distanceText: "도보 2분",
    imageUrl: "/place-study.svg"
  },
  {
    id: "place-5",
    naverPlaceId: "naver-105",
    name: "커먼 라운지",
    category: "복합문화공간",
    address: "서울 광진구 자양동 17-1",
    roadAddress: "서울 광진구 아차산로 200",
    latitude: 37.5411,
    longitude: 127.0666,
    station: "건대입구역",
    distanceText: "도보 7분",
    imageUrl: "/place-lounge.svg"
  },
  {
    id: "place-6",
    naverPlaceId: "naver-106",
    name: "카페 온화",
    category: "카페·디저트",
    address: "서울 성동구 송정동 66-12",
    roadAddress: "서울 성동구 송정18가길 7",
    latitude: 37.552,
    longitude: 127.0692,
    station: "뚝섬유원지역",
    distanceText: "도보 8분",
    imageUrl: "/place-cafe.svg"
  }
];

const seedUsers: UserRecord[] = [
  {
    id: "user-1",
    loginId: "damo",
    password: "1234",
    loginProvider: "TEST",
    nickname: "가은",
    email: "gaeun@example.com"
  },
  {
    id: "user-2",
    loginId: "minsu",
    password: "1234",
    loginProvider: "TEST",
    nickname: "민수",
    email: "minsu@example.com"
  },
  {
    id: "user-3",
    loginId: "jiyun",
    password: "1234",
    loginProvider: "TEST",
    nickname: "지윤",
    email: "jiyun@example.com"
  }
];

export class MockStore {
  places: Place[] = [];
  users: UserRecord[] = [];
  tokens = new Map<string, string>();
  userPlaces: UserPlace[] = [];
  meetings: MeetingRecord[] = [];
  members: MemberRecord[] = [];
  candidates: CandidateRecord[] = [];
  votes: VoteRecord[] = [];
  sessions: VoteSessionRecord[] = [];

  constructor() {
    this.reset();
  }

  reset() {
    this.places = structuredClone(seedPlaces);
    this.users = structuredClone(seedUsers);
    this.tokens = new Map([
      ["mock-token-user-1", "user-1"],
      ["mock-token-user-2", "user-2"],
      ["mock-token-user-3", "user-3"]
    ]);
    this.userPlaces = [
      this.makeUserPlace("up-1", "user-1", "place-1", "CAFE", "FUN"),
      this.makeUserPlace("up-2", "user-1", "place-2", "MEAL", "QUIET"),
      this.makeUserPlace("up-3", "user-1", "place-3", "MEAL", "FUN"),
      this.makeUserPlace("up-4", "user-1", "place-4", "STUDY", "QUIET"),
      this.makeUserPlace("up-5", "user-1", "place-5", "STUDY", "BUSINESS"),
      this.makeUserPlace("up-6", "user-2", "place-1", "CAFE", "FUN"),
      this.makeUserPlace("up-7", "user-2", "place-4", "STUDY", "QUIET"),
      this.makeUserPlace("up-8", "user-2", "place-6", "CAFE", "QUIET"),
      this.makeUserPlace("up-9", "user-3", "place-3", "MEAL", "FUN"),
      this.makeUserPlace("up-10", "user-3", "place-5", "STUDY", "BUSINESS"),
      this.makeUserPlace("up-11", "user-3", "place-6", "CAFE", "QUIET")
    ];

    this.meetings = [
      {
        id: "meeting-1",
        name: "성수 저녁 모임",
        hostUserId: "user-1",
        capacity: 6,
        meetingAt: iso("2026-08-02T19:30:00+09:00"),
        purpose: "MEAL",
        mood: "FUN",
        joinCode: "4821",
        status: "RECRUITING",
        finalCandidateId: null,
        seriesId: null,
        parentMeetingId: null,
        recurrenceType: null,
        recurrenceNextAt: null,
        nextMeetingId: null,
        createdAt: iso("2026-07-20T10:00:00+09:00"),
        updatedAt: iso("2026-07-25T18:10:00+09:00"),
        deletedAt: null
      },
      {
        id: "meeting-2",
        name: "토요 스터디",
        hostUserId: "user-2",
        capacity: 5,
        meetingAt: iso("2026-08-09T14:00:00+09:00"),
        purpose: "STUDY",
        mood: "QUIET",
        joinCode: "7314",
        status: "VOTING",
        finalCandidateId: null,
        seriesId: null,
        parentMeetingId: null,
        recurrenceType: null,
        recurrenceNextAt: null,
        nextMeetingId: null,
        createdAt: iso("2026-07-18T09:00:00+09:00"),
        updatedAt: iso("2026-07-25T18:20:00+09:00"),
        deletedAt: null
      },
      {
        id: "meeting-3",
        name: "봄날 카페투어",
        hostUserId: "user-3",
        capacity: 4,
        meetingAt: iso("2026-06-15T13:30:00+09:00"),
        purpose: "CAFE",
        mood: "FUN",
        joinCode: "1208",
        status: "COMPLETED",
        finalCandidateId: "candidate-31",
        seriesId: null,
        parentMeetingId: null,
        recurrenceType: null,
        recurrenceNextAt: null,
        nextMeetingId: null,
        createdAt: iso("2026-06-01T10:00:00+09:00"),
        updatedAt: iso("2026-06-10T20:00:00+09:00"),
        deletedAt: null
      }
    ];

    this.members = [
      this.member("member-11", "meeting-1", "user-1", "가은", "HOST"),
      this.member("member-12", "meeting-1", "user-2", "민수", "MEMBER"),
      this.member("member-13", "meeting-1", "user-3", "지윤", "MEMBER"),
      this.member("member-21", "meeting-2", "user-2", "민수", "HOST"),
      this.member("member-22", "meeting-2", "user-1", "가은", "MEMBER"),
      this.member("member-23", "meeting-2", "user-3", "지윤", "MEMBER"),
      this.member("member-31", "meeting-3", "user-3", "지윤", "HOST"),
      this.member("member-32", "meeting-3", "user-1", "가은", "MEMBER")
    ];

    this.candidates = [
      this.candidate("candidate-11", "meeting-1", "place-1", false, [
        this.rec("member-11", "up-1", "CAFE", "FUN"),
        this.rec("member-12", "up-6", "CAFE", "FUN")
      ]),
      this.candidate("candidate-12", "meeting-1", "place-2", false, [
        this.rec("member-11", "up-2", "MEAL", "QUIET")
      ]),
      this.candidate("candidate-13", "meeting-1", "place-3", false, [
        this.rec("member-13", "up-9", "MEAL", "FUN")
      ]),
      this.candidate("candidate-21", "meeting-2", "place-4", true, [
        this.rec("member-21", "up-7", "STUDY", "QUIET"),
        this.rec("member-22", "up-4", "STUDY", "QUIET")
      ]),
      this.candidate("candidate-22", "meeting-2", "place-5", true, [
        this.rec("member-23", "up-10", "STUDY", "BUSINESS")
      ]),
      this.candidate("candidate-23", "meeting-2", "place-6", true, [
        this.rec("member-21", "up-8", "CAFE", "QUIET"),
        this.rec("member-23", "up-11", "CAFE", "QUIET")
      ]),
      this.candidate("candidate-31", "meeting-3", "place-1", true, [
        this.rec("member-31", "up-11", "CAFE", "FUN"),
        this.rec("member-32", "up-1", "CAFE", "FUN")
      ])
    ];

    this.votes = [
      {
        id: "vote-2",
        meetingId: "meeting-2",
        status: "OPEN",
        createdAt: iso("2026-07-25T18:20:00+09:00"),
        closedAt: null
      },
      {
        id: "vote-3",
        meetingId: "meeting-3",
        status: "CLOSED",
        createdAt: iso("2026-06-08T18:00:00+09:00"),
        closedAt: iso("2026-06-10T20:00:00+09:00")
      }
    ];

    this.sessions = [
      this.session("session-21", "vote-2", "meeting-2", "member-22", "user-1", [
        "candidate-21",
        "candidate-22",
        "candidate-23"
      ]),
      this.session(
        "session-22",
        "vote-2",
        "meeting-2",
        "member-21",
        "user-2",
        ["candidate-21", "candidate-22", "candidate-23"],
        [
          this.choice(1, "candidate-21", "candidate-22", "candidate-21"),
          this.choice(2, "candidate-23", "candidate-21", "candidate-23")
        ]
      ),
      this.session(
        "session-23",
        "vote-2",
        "meeting-2",
        "member-23",
        "user-3",
        ["candidate-22", "candidate-23", "candidate-21"],
        [
          this.choice(1, "candidate-22", "candidate-23", "candidate-22"),
          this.choice(2, "candidate-22", "candidate-21", "candidate-21")
        ]
      )
    ];
  }

  snapshot(): StoreSnapshot {
    return structuredClone({
      places: this.places,
      users: this.users,
      tokens: [...this.tokens.entries()],
      userPlaces: this.userPlaces,
      meetings: this.meetings,
      members: this.members,
      candidates: this.candidates,
      votes: this.votes,
      sessions: this.sessions
    });
  }

  hydrate(snapshot: StoreSnapshot) {
    const value = structuredClone(snapshot);
    this.places = value.places;
    this.users = value.users;
    this.tokens = new Map(value.tokens);
    this.userPlaces = value.userPlaces;
    this.meetings = value.meetings;
    this.members = value.members;
    this.candidates = value.candidates;
    this.votes = value.votes;
    this.sessions = value.sessions;
  }

  private makeUserPlace(
    id: string,
    userId: string,
    placeId: string,
    purpose: Purpose,
    mood: Mood
  ): UserPlace {
    const place = this.getPlace(placeId);
    return {
      id,
      userId,
      place,
      purpose,
      mood,
      isActive: true,
      createdAt: iso("2026-07-01T12:00:00+09:00"),
      updatedAt: iso("2026-07-20T12:00:00+09:00")
    };
  }

  private member(
    id: string,
    meetingId: string,
    userId: string,
    nickname: string,
    role: "HOST" | "MEMBER"
  ): MemberRecord {
    return {
      id,
      meetingId,
      userId,
      meetingNickname: nickname,
      role,
      status: "ACTIVE",
      joinedAt: iso("2026-07-20T10:00:00+09:00")
    };
  }

  private rec(
    memberId: string,
    userPlaceId: string,
    purpose: Purpose,
    mood: Mood
  ): RecommendationRecord {
    return { memberId, userPlaceId, purpose, mood };
  }

  private candidate(
    id: string,
    meetingId: string,
    placeId: string,
    isFrozen: boolean,
    recommendations: RecommendationRecord[]
  ): CandidateRecord {
    return { id, meetingId, placeId, isFrozen, recommendations };
  }

  private choice(
    roundNumber: number,
    candidateAId: string,
    candidateBId: string,
    selectedCandidateId: string
  ): ChoiceRecord {
    return {
      roundNumber,
      candidateAId,
      candidateBId,
      selectedCandidateId,
      selectedAt: iso(`2026-07-25T18:${20 + roundNumber}:00+09:00`)
    };
  }

  private session(
    id: string,
    voteId: string,
    meetingId: string,
    memberId: string,
    userId: string,
    candidateOrder: string[],
    choices: ChoiceRecord[] = []
  ): VoteSessionRecord {
    return {
      id,
      voteId,
      meetingId,
      memberId,
      userId,
      status: choices.length === candidateOrder.length - 1 ? "COMPLETED" : "NOT_STARTED",
      totalRounds: candidateOrder.length - 1,
      completedRounds: choices.length,
      candidateOrder,
      currentWinnerCandidateId: choices.at(-1)?.selectedCandidateId ?? null,
      choices,
      updatedAt: now()
    };
  }

  getPlace(id: string): Place {
    const place = this.places.find((item) => item.id === id || item.naverPlaceId === id);
    if (!place) throw new StoreError(404, "PLACE_NOT_FOUND", "장소를 찾을 수 없습니다.");
    return structuredClone(place);
  }

  getUser(userId: string): User {
    const user = this.users.find((item) => item.id === userId);
    if (!user) throw new StoreError(401, "AUTH_REQUIRED", "로그인이 필요합니다.");
    const { loginId: _loginId, password: _password, ...safeUser } = user;
    return safeUser;
  }

  userIdForToken(token: string | undefined): string {
    const userId = token ? this.tokens.get(token) : undefined;
    if (!userId) throw new StoreError(401, "INVALID_TOKEN", "로그인 정보가 만료되었습니다.");
    return userId;
  }

  signup(loginId: string, nickname: string, password: string, email?: string | null) {
    if (this.users.some((user) => user.loginId.toLowerCase() === loginId.toLowerCase())) {
      throw new StoreError(409, "LOGIN_ID_ALREADY_EXISTS", "이미 사용 중인 아이디입니다.");
    }
    const id = randomUUID();
    const user: UserRecord = {
      id,
      loginId,
      password,
      nickname,
      email: email ?? null,
      loginProvider: "TEST"
    };
    this.users.push(user);
    const accessToken = `mock-token-${id}`;
    this.tokens.set(accessToken, id);
    return { user: this.getUser(id), accessToken, refreshToken: `mock-refresh-${id}` };
  }

  login(loginId: string, password: string) {
    const user = this.users.find(
      (item) => item.loginId.toLowerCase() === loginId.toLowerCase() && item.password === password
    );
    if (!user) throw new StoreError(401, "INVALID_CREDENTIALS", "아이디 또는 비밀번호가 올바르지 않습니다.");
    const accessToken = `mock-token-${user.id}`;
    this.tokens.set(accessToken, user.id);
    return { user: this.getUser(user.id), accessToken, refreshToken: `mock-refresh-${user.id}` };
  }

  searchPlaces(query: string): Place[] {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return structuredClone(this.places);
    return structuredClone(
      this.places.filter((place) =>
        [place.name, place.station, place.category, place.address, place.roadAddress]
          .join(" ")
          .toLowerCase()
          .includes(normalized.replace(/역$/, ""))
      )
    );
  }

  upsertPlaces(items: Place[]): Place[] {
    for (const item of items) {
      const index = this.places.findIndex(
        (place) => place.naverPlaceId === item.naverPlaceId
      );
      if (index >= 0) this.places[index] = structuredClone(item);
      else this.places.push(structuredClone(item));
    }
    return structuredClone(items);
  }

  listUserPlaces(userId: string): UserPlace[] {
    return structuredClone(
      this.userPlaces
        .filter((item) => item.userId === userId && item.isActive)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    );
  }

  candidateMeetingTargets(
    userId: string,
    userPlaceId: string
  ): CandidateMeetingTarget[] {
    const item = this.userPlaces.find(
      (userPlace) =>
        userPlace.id === userPlaceId &&
        userPlace.userId === userId &&
        userPlace.isActive
    );
    if (!item) {
      throw new StoreError(
        404,
        "USER_PLACE_NOT_FOUND",
        "저장된 장소를 찾을 수 없습니다."
      );
    }

    return this.meetings
      .filter((meeting) => {
        if (meeting.status !== "RECRUITING" || meeting.deletedAt) return false;
        const member = this.activeMember(meeting.id, userId);
        if (!member) return false;
        return this.candidates.some(
          (candidate) =>
            candidate.meetingId === meeting.id &&
            candidate.placeId === item.place.id &&
            candidate.recommendations.some(
              (recommendation) =>
                recommendation.memberId === member.id &&
                recommendation.userPlaceId === userPlaceId
            )
        );
      })
      .map((meeting) => ({
        id: meeting.id,
        name: meeting.name,
        meetingAt: meeting.meetingAt,
        purpose: meeting.purpose,
        mood: meeting.mood
      }))
      .sort((a, b) => a.meetingAt.localeCompare(b.meetingAt));
  }

  registerUserPlace(userId: string, naverPlaceId: string, purpose: Purpose, mood: Mood) {
    const place = this.getPlace(naverPlaceId);
    const existing = this.userPlaces.find(
      (item) => item.userId === userId && item.place.id === place.id
    );
    if (existing) {
      existing.isActive = true;
      existing.purpose = purpose;
      existing.mood = mood;
      existing.updatedAt = now();
      return structuredClone(existing);
    }
    const item: UserPlace = {
      id: randomUUID(),
      userId,
      place,
      purpose,
      mood,
      isActive: true,
      createdAt: now(),
      updatedAt: now()
    };
    this.userPlaces.push(item);
    return structuredClone(item);
  }

  updateUserPlace(
    userId: string,
    userPlaceId: string,
    purpose: Purpose,
    mood: Mood,
    applyToMeetingIds: string[]
  ) {
    const item = this.userPlaces.find(
      (userPlace) => userPlace.id === userPlaceId && userPlace.userId === userId && userPlace.isActive
    );
    if (!item) throw new StoreError(404, "USER_PLACE_NOT_FOUND", "저장된 장소를 찾을 수 없습니다.");
    item.purpose = purpose;
    item.mood = mood;
    item.updatedAt = now();
    for (const meetingId of applyToMeetingIds) {
      const meeting = this.requireMeeting(meetingId);
      if (meeting.status !== "RECRUITING") continue;
      const member = this.activeMember(meetingId, userId);
      const candidate = this.candidates.find(
        (value) => value.meetingId === meetingId && value.placeId === item.place.id
      );
      if (candidate && member) {
        const rec = candidate.recommendations.find((value) => value.memberId === member.id);
        if (rec) {
          rec.purpose = purpose;
          rec.mood = mood;
        }
      }
      this.cleanupCandidates(meetingId);
      meeting.updatedAt = now();
    }
    return structuredClone(item);
  }

  unregisterUserPlace(userId: string, userPlaceId: string, applyToActiveMeetings: boolean) {
    const item = this.userPlaces.find(
      (userPlace) => userPlace.id === userPlaceId && userPlace.userId === userId && userPlace.isActive
    );
    if (!item) throw new StoreError(404, "USER_PLACE_NOT_FOUND", "저장된 장소를 찾을 수 없습니다.");
    item.isActive = false;
    item.updatedAt = now();
    if (applyToActiveMeetings) {
      for (const meeting of this.meetings.filter((value) => value.status === "RECRUITING")) {
        const member = this.activeMember(meeting.id, userId);
        if (!member) continue;
        for (const candidate of this.candidates.filter((value) => value.meetingId === meeting.id)) {
          candidate.recommendations = candidate.recommendations.filter(
            (rec) => !(rec.memberId === member.id && rec.userPlaceId === userPlaceId)
          );
        }
        this.cleanupCandidates(meeting.id);
        meeting.updatedAt = now();
      }
    }
    return { userPlaceId, unregistered: true, appliedToActiveMeetings: applyToActiveMeetings };
  }

  home(userId: string): HomeData {
    const summaries = this.meetings
      .filter((meeting) => meeting.status !== "DELETED" && this.activeMember(meeting.id, userId))
      .map((meeting) => this.toSummary(meeting, userId))
      .sort((a, b) => a.meetingAt.localeCompare(b.meetingAt));
    const ongoingMeetings = summaries.filter(
      (meeting) => meeting.status !== "COMPLETED" && !meeting.isPastDue
    );
    const completedMeetings = summaries
      .filter((meeting) => meeting.status === "COMPLETED" || meeting.isPastDue)
      .sort((a, b) => b.meetingAt.localeCompare(a.meetingAt));
    return {
      ongoingMeetings,
      completedMeetings,
      hasVoteAlert: summaries.some((meeting) => meeting.voteAlert),
      updatedAt: now()
    };
  }

  createMeeting(userId: string, input: CreateMeetingInput): MeetingDetail {
    const meeting: MeetingRecord = {
      id: randomUUID(),
      name: input.name,
      hostUserId: userId,
      capacity: input.capacity,
      meetingAt: input.meetingAt,
      purpose: input.purpose,
      mood: input.mood,
      joinCode: this.createJoinCode(),
      status: "RECRUITING",
      finalCandidateId: null,
      seriesId: null,
      parentMeetingId: null,
      recurrenceType: null,
      recurrenceNextAt: null,
      nextMeetingId: null,
      createdAt: now(),
      updatedAt: now(),
      deletedAt: null
    };
    this.meetings.push(meeting);
    const user = this.getUser(userId);
    this.members.push(this.member(randomUUID(), meeting.id, userId, user.nickname, "HOST"));
    return this.detail(meeting.id, userId);
  }

  updateMeeting(meetingId: string, userId: string, input: UpdateMeetingInput): MeetingDetail {
    const meeting = this.requireHost(meetingId, userId);
    if (meeting.status !== "RECRUITING") {
      throw new StoreError(409, "MEETING_NOT_RECRUITING", "이미 투표가 시작된 모임입니다.");
    }
    if (input.capacity < this.activeMembers(meetingId).length) {
      throw new StoreError(
        422,
        "CAPACITY_TOO_SMALL",
        "선택한 모임원 수보다 정원을 작게 설정할 수 없습니다."
      );
    }

    meeting.name = input.name;
    meeting.capacity = input.capacity;
    meeting.meetingAt = input.meetingAt;
    meeting.purpose = input.purpose;
    meeting.mood = input.mood;
    meeting.updatedAt = now();
    return this.detail(meeting.id, userId);
  }

  repeatMeeting(
    sourceMeetingId: string,
    userId: string,
    input: RepeatMeetingInput
  ): MeetingDetail {
    const source = this.requireHost(sourceMeetingId, userId);
    if (
      source.status !== "COMPLETED" &&
      new Date(source.meetingAt).getTime() >= Date.now()
    ) {
      throw new StoreError(
        409,
        "MEETING_NOT_COMPLETED",
        "완료되었거나 날짜가 지난 모임에서만 다시 만나기를 시작할 수 있습니다."
      );
    }
    if (source.nextMeetingId) {
      throw new StoreError(
        409,
        "NEXT_MEETING_ALREADY_EXISTS",
        "이미 다음 회차가 만들어져 있습니다.",
        { meetingId: source.nextMeetingId }
      );
    }

    const selectedIds = new Set(input.memberIds);
    const sourceMembers = this.activeMembers(source.id);
    const selectedMembers = sourceMembers.filter((member) => selectedIds.has(member.id));
    const hostMember = sourceMembers.find((member) => member.role === "HOST");
    if (!hostMember || !selectedIds.has(hostMember.id)) {
      throw new StoreError(
        422,
        "HOST_MEMBER_REQUIRED",
        "모임장은 다음 회차에 반드시 포함되어야 합니다."
      );
    }
    if (selectedMembers.length !== selectedIds.size) {
      throw new StoreError(
        422,
        "INVALID_MEMBER_SELECTION",
        "이전 모임에 참여한 모임원만 선택할 수 있습니다."
      );
    }
    if (selectedMembers.length > input.capacity) {
      throw new StoreError(
        422,
        "CAPACITY_TOO_SMALL",
        "선택한 모임원 수보다 정원을 작게 설정할 수 없습니다."
      );
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

    const meeting = this.createOccurrence(
      source,
      input,
      selectedMembers,
      source.seriesId ?? source.id
    );
    source.nextMeetingId = meeting.id;
    source.updatedAt = now();
    return this.detail(meeting.id, userId);
  }

  configureMeetingRecurrence(
    meetingId: string,
    userId: string,
    input: ConfigureMeetingRecurrenceInput
  ): MeetingDetail {
    const meeting = this.requireHost(meetingId, userId);
    if (
      meeting.status === "COMPLETED" ||
      new Date(meeting.meetingAt).getTime() < Date.now()
    ) {
      throw new StoreError(
        409,
        "MEETING_ALREADY_FINISHED",
        "완료된 모임은 다시 만나기로 새 회차를 만들어 주세요."
      );
    }
    if (
      input.recurrence.type === "CUSTOM" &&
      (!input.recurrence.customNextMeetingAt ||
        new Date(input.recurrence.customNextMeetingAt).getTime() <=
          new Date(meeting.meetingAt).getTime())
    ) {
      throw new StoreError(
        422,
        "INVALID_CUSTOM_RECURRENCE_DATE",
        "직접 입력한 다음 일정은 현재 회차보다 뒤여야 합니다."
      );
    }

    meeting.seriesId ??= meeting.id;
    meeting.recurrenceType = input.recurrence.type;
    meeting.recurrenceNextAt =
      input.recurrence.type === "CUSTOM"
        ? input.recurrence.customNextMeetingAt ?? null
        : null;
    meeting.updatedAt = now();
    return this.detail(meeting.id, userId);
  }

  lookupMeeting(joinCode: string) {
    const meeting = this.meetings.find(
      (item) =>
        item.joinCode === joinCode &&
        item.status !== "COMPLETED" &&
        item.status !== "DELETED"
    );
    if (!meeting) throw new StoreError(404, "MEETING_NOT_FOUND", "가입 가능한 모임을 찾을 수 없습니다.");
    return {
      id: meeting.id,
      name: meeting.name,
      purpose: meeting.purpose,
      mood: meeting.mood,
      meetingAt: meeting.meetingAt,
      currentMembers: this.activeMembers(meeting.id).length,
      capacity: meeting.capacity,
      canJoin:
        meeting.status === "RECRUITING" &&
        this.activeMembers(meeting.id).length < meeting.capacity
    };
  }

  joinMeeting(userId: string, meetingId: string, joinCode: string, meetingNickname: string) {
    const meeting = this.requireMeeting(meetingId);
    if (meeting.joinCode !== joinCode) throw new StoreError(422, "INVALID_JOIN_CODE", "가입 코드가 올바르지 않습니다.");
    if (meeting.status !== "RECRUITING") throw new StoreError(409, "MEETING_NOT_RECRUITING", "이미 투표가 시작된 모임입니다.");
    const existing = this.members.find((member) => member.meetingId === meetingId && member.userId === userId);
    // A KICKED member was removed by the host and must never be able to
    // walk back in with the join code, regardless of capacity.
    if (existing && existing.status === "KICKED") {
      throw new StoreError(
        403,
        "PREVIOUSLY_KICKED",
        "모임장에 의해 내보내진 모임에는 다시 가입할 수 없습니다."
      );
    }
    // A brand-new member and a LEFT member rejoining both add a new
    // ACTIVE seat, so both must be checked against capacity. An already-ACTIVE
    // member calling joinMeeting again (e.g. a duplicate request) doesn't
    // change the ACTIVE count, so it's exempt from the check.
    if (!existing || existing.status !== "ACTIVE") {
      const members = this.activeMembers(meetingId);
      if (members.length >= meeting.capacity) {
        throw new StoreError(409, "MEETING_CAPACITY_EXCEEDED", "모임 정원이 모두 찼습니다.");
      }
    }
    if (existing) {
      existing.status = "ACTIVE";
      existing.meetingNickname = meetingNickname;
      existing.joinedAt = now();
    } else {
      this.members.push(this.member(randomUUID(), meetingId, userId, meetingNickname, "MEMBER"));
    }
    meeting.updatedAt = now();
    return this.detail(meetingId, userId);
  }

  detail(meetingId: string, userId: string): MeetingDetail {
    const meeting = this.requireMeeting(meetingId);
    const member = this.activeMember(meetingId, userId);
    if (!member) throw new StoreError(403, "MEETING_ACCESS_DENIED", "이 모임에 참여하고 있지 않습니다.");
    const summary = this.toSummary(meeting, userId);
    return {
      ...summary,
      hostUserId: meeting.hostUserId,
      joinCode: meeting.joinCode,
      shareUrl: `${webBaseUrl()}/meetings/join?meetingId=${meeting.id}`,
      members: structuredClone(this.activeMembers(meeting.id)),
      candidates: this.publicCandidates(meeting.id, userId),
      finalCandidateId: meeting.finalCandidateId
    };
  }

  leaveMeeting(meetingId: string, userId: string) {
    const meeting = this.requireMeeting(meetingId);
    if (meeting.status !== "RECRUITING") throw new StoreError(409, "LEAVE_NOT_ALLOWED", "투표 시작 후에는 탈퇴할 수 없습니다.");
    const member = this.activeMember(meetingId, userId);
    if (!member) throw new StoreError(404, "MEMBER_NOT_FOUND", "모임 참여 정보를 찾을 수 없습니다.");
    if (member.role === "HOST") throw new StoreError(403, "HOST_CANNOT_LEAVE", "모임장은 탈퇴 대신 모임을 삭제해야 합니다.");
    member.status = "LEFT";
    this.removeMemberRecommendations(meetingId, member.id);
    meeting.updatedAt = now();
    return { meetingId, left: true };
  }

  kickMember(meetingId: string, hostUserId: string, memberId: string) {
    const meeting = this.requireHost(meetingId, hostUserId);
    if (meeting.status !== "RECRUITING") throw new StoreError(409, "KICK_NOT_ALLOWED", "투표 시작 후에는 모임원을 내보낼 수 없습니다.");
    const member = this.members.find(
      (value) => value.id === memberId && value.meetingId === meetingId && value.status === "ACTIVE"
    );
    if (!member || member.role === "HOST") throw new StoreError(422, "INVALID_MEMBER", "내보낼 수 없는 모임원입니다.");
    member.status = "KICKED";
    this.removeMemberRecommendations(meetingId, member.id);
    meeting.updatedAt = now();
    return this.detail(meetingId, hostUserId);
  }

  deleteMeeting(meetingId: string, userId: string) {
    const meeting = this.requireHost(meetingId, userId);
    meeting.status = "DELETED";
    meeting.deletedAt = now();
    meeting.updatedAt = now();
    return { meetingId, deleted: true };
  }

  eligiblePlaces(meetingId: string, userId: string) {
    const meeting = this.requireMeeting(meetingId);
    if (!this.activeMember(meetingId, userId)) throw new StoreError(403, "MEETING_ACCESS_DENIED", "모임원이 아닙니다.");
    const selectedIds = new Set(
      this.candidates
        .filter((candidate) => candidate.meetingId === meetingId)
        .flatMap((candidate) =>
          candidate.recommendations
            .filter((rec) => this.members.find((member) => member.id === rec.memberId)?.userId === userId)
            .map((rec) => rec.userPlaceId)
        )
    );
    return this.listUserPlaces(userId)
      .map((item) => {
        const purposeMatch = item.purpose === meeting.purpose;
        const moodMatch = item.mood === meeting.mood;
        return {
          ...item,
          selected: selectedIds.has(item.id),
          purposeMatch,
          moodMatch,
          matchCount: Number(purposeMatch) + Number(moodMatch) as 0 | 1 | 2
        };
      })
      .sort(
        (a, b) =>
          b.matchCount - a.matchCount ||
          a.place.name.localeCompare(b.place.name, "ko-KR")
      );
  }

  publicCandidates(meetingId: string, userId: string): Candidate[] {
    const member = this.activeMember(meetingId, userId);
    return this.candidates
      .filter((item) => item.meetingId === meetingId && item.recommendations.length > 0)
      .map((candidate) => {
        const names = candidate.recommendations.map((rec) => {
          const recommender = this.members.find((value) => value.id === rec.memberId);
          return recommender?.meetingNickname ?? "알 수 없음";
        });
        return {
          id: candidate.id,
          meetingId,
          place: this.getPlace(candidate.placeId),
          recommendationCount: candidate.recommendations.length,
          recommendedByMe: member
            ? candidate.recommendations.some((rec) => rec.memberId === member.id)
            : false,
          recommenderNames: names,
          isFrozen: candidate.isFrozen
        };
      });
  }

  replaceMyCandidates(meetingId: string, userId: string, userPlaceIds: string[]) {
    const meeting = this.requireMeeting(meetingId);
    if (meeting.status !== "RECRUITING") throw new StoreError(409, "CANDIDATES_FROZEN", "투표가 시작되어 후보를 변경할 수 없습니다.");
    if (userPlaceIds.length > 2) throw new StoreError(422, "CANDIDATE_LIMIT_EXCEEDED", "후보는 최대 2개까지 선택할 수 있습니다.");
    const member = this.activeMember(meetingId, userId);
    if (!member) throw new StoreError(403, "MEETING_ACCESS_DENIED", "모임원이 아닙니다.");
    const uniqueIds = [...new Set(userPlaceIds)];
    const eligible = new Map(this.eligiblePlaces(meetingId, userId).map((item) => [item.id, item]));
    for (const id of uniqueIds) {
      if (!eligible.has(id)) throw new StoreError(422, "PLACE_NOT_FOUND_IN_MY_PLACES", "내 장소에서 선택할 수 없는 장소입니다.");
    }
    for (const candidate of this.candidates.filter((item) => item.meetingId === meetingId)) {
      candidate.recommendations = candidate.recommendations.filter((rec) => rec.memberId !== member.id);
    }
    this.cleanupCandidates(meetingId);
    for (const userPlaceId of uniqueIds) {
      const userPlace = eligible.get(userPlaceId)!;
      let candidate = this.candidates.find(
        (item) => item.meetingId === meetingId && item.placeId === userPlace.place.id
      );
      if (!candidate) {
        candidate = this.candidate(randomUUID(), meetingId, userPlace.place.id, false, []);
        this.candidates.push(candidate);
      }
      candidate.recommendations.push(
        this.rec(member.id, userPlaceId, userPlace.purpose, userPlace.mood)
      );
    }
    meeting.updatedAt = now();
    return this.publicCandidates(meetingId, userId);
  }

  createVote(meetingId: string, userId: string) {
    const meeting = this.requireHost(meetingId, userId);
    if (meeting.status !== "RECRUITING") throw new StoreError(409, "VOTE_ALREADY_CREATED", "이미 투표가 생성됐습니다.");
    const candidates = this.candidates.filter(
      (candidate) => candidate.meetingId === meetingId && candidate.recommendations.length > 0
    );
    if (candidates.length < 2) throw new StoreError(422, "NOT_ENOUGH_CANDIDATES", "투표 후보가 2개 이상 필요합니다.");
    for (const candidate of candidates) candidate.isFrozen = true;
    const vote: VoteRecord = {
      id: randomUUID(),
      meetingId,
      status: "OPEN",
      createdAt: now(),
      closedAt: null
    };
    this.votes.push(vote);
    const candidateIds = candidates.map((candidate) => candidate.id);
    for (const [index, member] of this.activeMembers(meetingId).entries()) {
      const rotated = [...candidateIds.slice(index % candidateIds.length), ...candidateIds.slice(0, index % candidateIds.length)];
      this.sessions.push(this.session(randomUUID(), vote.id, meetingId, member.id, member.userId, rotated));
    }
    meeting.status = "VOTING";
    meeting.updatedAt = now();
    return { meeting: this.detail(meetingId, userId), voteId: vote.id };
  }

  voteSession(meetingId: string, userId: string): VoteSessionView {
    const meeting = this.requireMeeting(meetingId);
    if (meeting.status !== "VOTING") throw new StoreError(409, "VOTE_NOT_OPEN", "진행 중인 투표가 없습니다.");
    const session = this.sessions.find((item) => item.meetingId === meetingId && item.userId === userId);
    if (!session) throw new StoreError(404, "VOTE_SESSION_NOT_FOUND", "개인 투표 세션을 찾을 수 없습니다.");
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
    if (!nextCandidateId || !currentWinnerId) throw new StoreError(500, "INVALID_VOTE_SESSION", "투표 순서가 올바르지 않습니다.");
    const swap = roundNumber % 2 === 0;
    const aId = swap ? nextCandidateId : currentWinnerId;
    const bId = swap ? currentWinnerId : nextCandidateId;
    return {
      sessionId: session.id,
      status: session.completedRounds === 0 ? "NOT_STARTED" : "IN_PROGRESS",
      totalRounds: session.totalRounds,
      completedRounds: session.completedRounds,
      round: {
        roundNumber,
        totalRounds: session.totalRounds,
        completedRounds: session.completedRounds,
        candidateA: this.publicCandidate(aId, userId),
        candidateB: this.publicCandidate(bId, userId)
      }
    };
  }

  saveChoice(meetingId: string, userId: string, roundNumber: number, selectedCandidateId: string) {
    const meeting = this.requireMeeting(meetingId);
    if (meeting.status !== "VOTING") throw new StoreError(409, "VOTE_CLOSED", "투표가 종료되었습니다.");
    const session = this.sessions.find((item) => item.meetingId === meetingId && item.userId === userId);
    if (!session) throw new StoreError(404, "VOTE_SESSION_NOT_FOUND", "개인 투표 세션을 찾을 수 없습니다.");
    const existing = session.choices.find((choice) => choice.roundNumber === roundNumber);
    if (existing) return this.voteSession(meetingId, userId);
    const view = this.voteSession(meetingId, userId);
    if (!view.round || view.round.roundNumber !== roundNumber) {
      throw new StoreError(409, "INVALID_ROUND", "현재 진행할 차례가 아닌 라운드입니다.");
    }
    const candidateIds = [view.round.candidateA.id, view.round.candidateB.id];
    if (!candidateIds.includes(selectedCandidateId)) {
      throw new StoreError(422, "INVALID_SELECTED_CANDIDATE", "A 또는 B 후보 중 하나를 선택해야 합니다.");
    }
    session.choices.push({
      roundNumber,
      candidateAId: view.round.candidateA.id,
      candidateBId: view.round.candidateB.id,
      selectedCandidateId,
      selectedAt: now()
    });
    session.completedRounds = session.choices.length;
    session.currentWinnerCandidateId = selectedCandidateId;
    session.status =
      session.completedRounds >= session.totalRounds ? "COMPLETED" : "IN_PROGRESS";
    session.updatedAt = now();
    meeting.updatedAt = now();
    return this.voteSession(meetingId, userId);
  }

  voteResults(meetingId: string, userId: string): VoteResults {
    const meeting = this.requireMeeting(meetingId);
    if (!this.activeMember(meetingId, userId)) throw new StoreError(403, "MEETING_ACCESS_DENIED", "모임원이 아닙니다.");
    const vote = this.votes.find((item) => item.meetingId === meetingId);
    if (!vote) throw new StoreError(404, "VOTE_NOT_FOUND", "투표를 찾을 수 없습니다.");
    const sessions = this.sessions.filter((item) => item.meetingId === meetingId);
    const counts = new Map<string, number>();
    for (const choice of sessions.flatMap((session) => session.choices)) {
      counts.set(choice.selectedCandidateId, (counts.get(choice.selectedCandidateId) ?? 0) + 1);
    }
    const raw = this.publicCandidates(meetingId, userId)
      .map((candidate) => ({
        candidate,
        voteCount: counts.get(candidate.id) ?? 0,
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
    const tiedFirstCandidateIds = results.filter((result) => result.rank === 1).map((result) => result.candidate.id);
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
      updatedAt: now()
    };
  }

  closeVote(meetingId: string, userId: string, force: boolean) {
    const meeting = this.requireHost(meetingId, userId);
    if (meeting.status !== "VOTING") throw new StoreError(409, "VOTE_NOT_OPEN", "종료할 수 있는 투표가 없습니다.");
    const results = this.voteResults(meetingId, userId);
    if (results.incompleteMembers > 0 && !force) {
      throw new StoreError(
        409,
        "VOTE_HAS_INCOMPLETE_MEMBERS",
        "아직 투표를 완료하지 않은 인원이 있습니다.",
        { incompleteMembers: results.incompleteMembers }
      );
    }
    const vote = this.votes.find((item) => item.meetingId === meetingId)!;
    vote.closedAt = now();
    if (results.tiedFirstCandidateIds.length === 1) {
      vote.status = "CLOSED";
      meeting.status = "COMPLETED";
      meeting.finalCandidateId = results.tiedFirstCandidateIds[0] ?? null;
      this.createNextRecurringOccurrence(meeting);
    } else {
      vote.status = "FINAL_SELECTION";
      meeting.status = "FINAL_SELECTION";
    }
    meeting.updatedAt = now();
    return this.voteResults(meetingId, userId);
  }

  finalSelection(meetingId: string, userId: string, candidateId: string) {
    const meeting = this.requireHost(meetingId, userId);
    if (meeting.status !== "FINAL_SELECTION") throw new StoreError(409, "FINAL_SELECTION_NOT_REQUIRED", "최종 선택이 필요한 상태가 아닙니다.");
    const results = this.voteResults(meetingId, userId);
    if (!results.tiedFirstCandidateIds.includes(candidateId)) {
      throw new StoreError(422, "INVALID_FINAL_CANDIDATE", "공동 1위 후보 중에서 선택해야 합니다.");
    }
    meeting.finalCandidateId = candidateId;
    meeting.status = "COMPLETED";
    meeting.updatedAt = now();
    const vote = this.votes.find((item) => item.meetingId === meetingId);
    if (vote) vote.status = "CLOSED";
    this.createNextRecurringOccurrence(meeting);
    return this.voteResults(meetingId, userId);
  }

  private createOccurrence(
    source: MeetingRecord,
    input: RepeatMeetingInput,
    selectedMembers: MemberRecord[],
    seriesId: string
  ) {
    const createdAt = now();
    const meeting: MeetingRecord = {
      id: randomUUID(),
      name: input.name,
      hostUserId: source.hostUserId,
      capacity: input.capacity,
      meetingAt: input.meetingAt,
      purpose: input.purpose,
      mood: input.mood,
      joinCode: source.joinCode,
      status: "RECRUITING",
      finalCandidateId: null,
      seriesId,
      parentMeetingId: source.id,
      recurrenceType: input.recurrence?.type ?? null,
      recurrenceNextAt: input.recurrence?.customNextMeetingAt ?? null,
      nextMeetingId: null,
      createdAt,
      updatedAt: createdAt,
      deletedAt: null
    };
    this.meetings.push(meeting);
    for (const member of selectedMembers) {
      this.members.push({
        ...member,
        id: randomUUID(),
        meetingId: meeting.id,
        status: "ACTIVE",
        joinedAt: createdAt
      });
    }
    return meeting;
  }

  private createNextRecurringOccurrence(meeting: MeetingRecord) {
    if (!meeting.recurrenceType || meeting.nextMeetingId) return;
    const selectedMembers = this.activeMembers(meeting.id);
    const meetingAt =
      meeting.recurrenceType === "CUSTOM"
        ? meeting.recurrenceNextAt
        : nextRecurringMeetingAt(meeting.meetingAt, meeting.recurrenceType);
    if (!meetingAt) return;

    const recurrence =
      meeting.recurrenceType === "CUSTOM"
        ? null
        : { type: meeting.recurrenceType };
    const nextMeeting = this.createOccurrence(
      meeting,
      {
        name: meeting.name,
        capacity: meeting.capacity,
        meetingAt,
        purpose: meeting.purpose,
        mood: meeting.mood,
        memberIds: selectedMembers.map((member) => member.id),
        recurrence
      },
      selectedMembers,
      meeting.seriesId ?? meeting.id
    );
    meeting.nextMeetingId = nextMeeting.id;
    meeting.updatedAt = now();
  }

  private activeMembers(meetingId: string) {
    return this.members.filter((member) => member.meetingId === meetingId && member.status === "ACTIVE");
  }

  private activeMember(meetingId: string, userId: string) {
    return this.members.find(
      (member) =>
        member.meetingId === meetingId &&
        member.userId === userId &&
        member.status === "ACTIVE"
    );
  }

  private requireMeeting(meetingId: string) {
    const meeting = this.meetings.find(
      (item) => item.id === meetingId && item.status !== "DELETED"
    );
    if (!meeting) throw new StoreError(404, "MEETING_NOT_FOUND", "모임을 찾을 수 없습니다.");
    return meeting;
  }

  private requireHost(meetingId: string, userId: string) {
    const meeting = this.requireMeeting(meetingId);
    if (meeting.hostUserId !== userId) throw new StoreError(403, "HOST_ONLY", "모임장만 실행할 수 있습니다.");
    return meeting;
  }

  private removeMemberRecommendations(meetingId: string, memberId: string) {
    for (const candidate of this.candidates.filter((item) => item.meetingId === meetingId)) {
      candidate.recommendations = candidate.recommendations.filter((rec) => rec.memberId !== memberId);
    }
    this.cleanupCandidates(meetingId);
  }

  private cleanupCandidates(meetingId: string) {
    this.candidates = this.candidates.filter(
      (candidate) => candidate.meetingId !== meetingId || candidate.recommendations.length > 0
    );
  }

  private publicCandidate(candidateId: string, userId: string) {
    const record = this.candidates.find((item) => item.id === candidateId);
    if (!record) throw new StoreError(404, "CANDIDATE_NOT_FOUND", "후보 장소를 찾을 수 없습니다.");
    const candidate = this.publicCandidates(record.meetingId, userId).find((item) => item.id === candidateId);
    if (!candidate) throw new StoreError(404, "CANDIDATE_NOT_FOUND", "후보 장소를 찾을 수 없습니다.");
    return candidate;
  }

  private createJoinCode() {
    const activeCodes = new Set(
      this.meetings
        .filter((meeting) => ["RECRUITING", "VOTING", "FINAL_SELECTION"].includes(meeting.status))
        .map((meeting) => meeting.joinCode)
    );

    // 진행 중인 모임끼리 겹치지 않는 임의의 4자리 코드를 우선 발급한다.
    // 충돌이 반복되더라도 발급이 멈추지 않도록 마지막에는 빈 코드를 순회한다.
    for (let attempt = 0; attempt < 128; attempt += 1) {
      const value = Math.floor(1000 + Math.random() * 9000).toString();
      if (!activeCodes.has(value)) return value;
    }

    for (let code = 1000; code <= 9999; code += 1) {
      const value = code.toString();
      if (!activeCodes.has(value)) return value;
    }
    throw new StoreError(500, "JOIN_CODE_EXHAUSTED", "가입 코드를 발급할 수 없습니다.");
  }

  private toSummary(meeting: MeetingRecord, userId: string): MeetingSummary {
    const member = this.activeMember(meeting.id, userId);
    if (!member) throw new StoreError(403, "MEETING_ACCESS_DENIED", "모임원이 아닙니다.");
    const session = this.sessions.find((item) => item.meetingId === meeting.id && item.userId === userId);
    const finalCandidate = meeting.finalCandidateId
      ? this.candidates.find((candidate) => candidate.id === meeting.finalCandidateId)
      : undefined;
    return {
      id: meeting.id,
      name: meeting.name,
      role: member.role,
      status: meeting.status,
      purpose: meeting.purpose,
      mood: meeting.mood,
      meetingAt: meeting.meetingAt,
      currentMembers: this.activeMembers(meeting.id).length,
      capacity: meeting.capacity,
      joinCode: member.role === "HOST" ? meeting.joinCode : undefined,
      voteAlert: meeting.status === "VOTING" && session?.status !== "COMPLETED",
      myVoteCompleted: session?.status === "COMPLETED",
      finalPlace: finalCandidate ? this.getPlace(finalCandidate.placeId) : null,
      isPastDue: new Date(meeting.meetingAt).getTime() < Date.now(),
      seriesId: meeting.seriesId,
      parentMeetingId: meeting.parentMeetingId,
      recurrence: meeting.recurrenceType
        ? {
            type: meeting.recurrenceType,
            customNextMeetingAt: meeting.recurrenceNextAt
          }
        : null,
      updatedAt: meeting.updatedAt
    };
  }
}
