export type LoginProvider = "TEST" | "KAKAO" | "NAVER" | "GOOGLE";

export type Purpose = "STUDY" | "CAFE" | "MEAL" | "DRINK";
export type Mood = "FUN" | "QUIET" | "BUSINESS" | "TIPSY";
export type MeetingStatus =
  | "RECRUITING"
  | "VOTING"
  | "FINAL_SELECTION"
  | "COMPLETED"
  | "DELETED";
export type MeetingRole = "HOST" | "MEMBER";
export type MemberStatus = "ACTIVE" | "LEFT" | "KICKED";
export type VoteStatus = "OPEN" | "FINAL_SELECTION" | "CLOSED";
export type VoteSessionStatus = "NOT_STARTED" | "IN_PROGRESS" | "COMPLETED";

export interface User {
  id: string;
  loginProvider: LoginProvider;
  nickname: string;
  email: string | null;
}

export interface Place {
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
  imageUrl?: string;
}

export interface UserPlace {
  id: string;
  userId: string;
  place: Place;
  purpose: Purpose;
  mood: Mood;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface EligiblePlace extends UserPlace {
  selected: boolean;
  purposeMatch: boolean;
  moodMatch: boolean;
  matchCount: 0 | 1 | 2;
}

export interface MeetingMember {
  id: string;
  userId: string;
  meetingNickname: string;
  role: MeetingRole;
  status: MemberStatus;
  joinedAt: string;
}

export interface Candidate {
  id: string;
  meetingId: string;
  place: Place;
  recommendationCount: number;
  recommendedByMe: boolean;
  recommenderNames: string[];
  isFrozen: boolean;
}

export interface MeetingSummary {
  id: string;
  name: string;
  role: MeetingRole;
  status: MeetingStatus;
  purpose: Purpose;
  mood: Mood;
  meetingAt: string;
  currentMembers: number;
  capacity: number;
  joinCode?: string;
  voteAlert: boolean;
  myVoteCompleted: boolean;
  finalPlace?: Place | null;
  updatedAt: string;
}

export interface MeetingDetail extends MeetingSummary {
  hostUserId: string;
  shareUrl: string;
  members: MeetingMember[];
  candidates: Candidate[];
  finalCandidateId?: string | null;
}

export interface HomeData {
  ongoingMeetings: MeetingSummary[];
  completedMeetings: MeetingSummary[];
  hasVoteAlert: boolean;
  updatedAt: string;
}

export interface VoteRound {
  roundNumber: number;
  totalRounds: number;
  completedRounds: number;
  candidateA: Candidate;
  candidateB: Candidate;
}

export interface VoteSessionView {
  sessionId: string;
  status: VoteSessionStatus;
  totalRounds: number;
  completedRounds: number;
  round: VoteRound | null;
}

export interface VoteResultItem {
  candidate: Candidate;
  voteCount: number;
  recommendationCount: number;
  rank: number;
  isJointRank: boolean;
  isFinal: boolean;
}

export interface VoteResults {
  meetingId: string;
  voteStatus: VoteStatus;
  meetingStatus: MeetingStatus;
  myVoteCompleted: boolean;
  completedMembers: number;
  totalMembers: number;
  incompleteMembers: number;
  results: VoteResultItem[];
  tiedFirstCandidateIds: string[];
  finalCandidateId: string | null;
  updatedAt: string;
}

export interface ApiEnvelope<T> {
  data: T;
  meta?: {
    nextCursor?: string | null;
    updatedAt?: string;
  };
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

export interface CreateMeetingInput {
  name: string;
  capacity: number;
  meetingAt: string;
  purpose: Purpose;
  mood: Mood;
}

export const PURPOSE_LABELS: Record<Purpose, string> = {
  STUDY: "스터디",
  CAFE: "카페",
  MEAL: "식사",
  DRINK: "술 한잔"
};

export const MOOD_LABELS: Record<Mood, string> = {
  FUN: "즐거운",
  QUIET: "조용한",
  BUSINESS: "비즈니스",
  TIPSY: "알딸딸"
};

export const STATUS_LABELS: Record<MeetingStatus, string> = {
  RECRUITING: "후보 선택 중",
  VOTING: "투표 진행 중",
  FINAL_SELECTION: "최종 장소 선택 중",
  COMPLETED: "투표 완료",
  DELETED: "삭제됨"
};
