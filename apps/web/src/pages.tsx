import {
  AlertTriangle,
  CalendarDays,
  Check,
  ChevronRight,
  CircleEllipsis,
  Clock3,
  Copy,
  DoorOpen,
  LogOut,
  MapPin,
  Minus,
  Pencil,
  Plus,
  Repeat2,
  RotateCcw,
  Share2,
  Trash2,
  Trophy,
  UserMinus,
  UsersRound,
  Vote
} from "lucide-react";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import type {
  Candidate,
  CandidateMeetingTarget,
  ConfigureMeetingRecurrenceInput,
  CreateMeetingInput,
  EligiblePlace,
  MeetingDetail,
  Mood,
  Place,
  Purpose,
  RecurrenceType,
  RepeatMeetingInput,
  UpdateMeetingInput,
  UserPlace,
  VoteResults,
  VoteSessionView
} from "@damo/contracts";
import {
  MOOD_LABELS,
  PURPOSE_LABELS,
  STATUS_LABELS
} from "@damo/contracts";
import {
  Link,
  Navigate,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams
} from "react-router-dom";
import { ApiError, api } from "./api";
import { useAuth } from "./auth";
import {
  CandidateRow,
  EmptyState,
  formatMeetingAt,
  Loading,
  Logo,
  MapCanvas,
  MeetingCard,
  Modal,
  PlaceMeta,
  PlaceThumbnail,
  PrimaryButton,
  ProfileButton,
  PurposeMoodFields,
  ScreenHeader,
  SearchInput,
  SecondaryButton,
  SummaryBanner,
  UserPlaceRow
} from "./components";
import { useShell } from "./shell";

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "요청을 처리하지 못했습니다.";

function InlineError({ message }: { message: string }) {
  return message ? (
    <p className="inline-error" role="alert">
      <AlertTriangle size={17} />
      {message}
    </p>
  ) : null;
}

function SectionTitle({
  title,
  count,
  action
}: {
  title: string;
  count?: number;
  action?: React.ReactNode;
}) {
  return (
    <div className="section-title">
      <div>
        <h2>{title}</h2>
        {count !== undefined ? <span>{count}</span> : null}
      </div>
      {action}
    </div>
  );
}

export function LoginPage() {
  const { user, loading, login, signup } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [loginId, setLoginId] = useState("");
  const [nickname, setNickname] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const from =
    (location.state as { from?: { pathname?: string } } | null)?.from?.pathname ?? "/";

  if (loading) return <Loading label="로그인 확인 중" />;
  if (user) return <Navigate to={from} replace />;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      if (mode === "login") await login(loginId, password);
      else await signup({ loginId, nickname, email, password });
      navigate(from, { replace: true });
    } catch (submitError) {
      setError(errorMessage(submitError));
    } finally {
      setSubmitting(false);
    }
  };

  // 카카오 실연동 전까지는 mock 리다이렉트로 넘어가지 않도록 막아둔다 —
  // 안 그러면 버튼을 누르는 즉시 "가은" 테스트 계정으로 로그인돼 버린다.
  const oauth = (_provider: "kakao") => {
    setError("카카오 로그인 서비스 준비중입니다.\n즉시 가입으로 이용 부탁드립니다.");
  };

  return (
    <div className="auth-page">
      <div className="auth-page__ambient auth-page__ambient--one" />
      <div className="auth-page__ambient auth-page__ambient--two" />
      <section className="auth-card">
        <Logo />
        <div className="auth-card__intro">
          <span className="eyebrow">장소 고민은 모으고, 선택은 가볍게.</span>
          <h1>모임의 다음을 정하다</h1>
          <p>각자 저장한 장소로 빠르게 정하고, 정기 모임으로 오래 만나요.</p>
        </div>

        <div className="segmented" role="tablist" aria-label="테스트 계정">
          <button
            type="button"
            className={mode === "login" ? "is-active" : ""}
            onClick={() => setMode("login")}
          >
            로그인
          </button>
          <button
            type="button"
            className={mode === "signup" ? "is-active" : ""}
            onClick={() => setMode("signup")}
          >
            즉시 가입
          </button>
        </div>

        <form className="auth-form" onSubmit={submit}>
          <label>
            <span>아이디</span>
            <input
              value={loginId}
              onChange={(event) => setLoginId(event.target.value)}
              placeholder="아이디를 입력하세요"
              maxLength={40}
              autoComplete="username"
              required
            />
          </label>
          {mode === "signup" ? (
            <>
              <label>
                <span>닉네임</span>
                <input
                  value={nickname}
                  onChange={(event) => setNickname(event.target.value)}
                  placeholder="DAMO"
                  maxLength={20}
                  required
                />
              </label>
              <label>
                <span>이메일 <small>선택</small></span>
                <input
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  type="email"
                  placeholder="DAMO@naver.com"
                  autoComplete="email"
                />
              </label>
            </>
          ) : null}
          <label>
            <span>비밀번호</span>
            <input
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              type="password"
              placeholder="비밀번호를 입력하세요 (4자 이상)"
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              minLength={4}
              required
            />
          </label>
          <InlineError message={error} />
          <PrimaryButton type="submit" disabled={submitting}>
            {submitting ? "처리 중…" : mode === "login" ? "로그인" : "계정 만들고 시작"}
          </PrimaryButton>
        </form>

        <div className="auth-divider"><span>또는 소셜 로그인</span></div>
        <div className="oauth-list">
          <button className="oauth-button oauth-button--kakao" type="button" onClick={() => oauth("kakao")}>
            <span>K</span> 카카오로 계속
          </button>
        </div>
      </section>
    </div>
  );
}

export function OAuthCallbackPage() {
  const { acceptOAuthToken } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState("");

  useEffect(() => {
    const token = params.get("accessToken");
    if (!token) {
      setError("OAuth 토큰을 받지 못했습니다.");
      return;
    }
    void acceptOAuthToken(token)
      .then(() => navigate("/", { replace: true }))
      .catch((reason) => setError(errorMessage(reason)));
  }, [acceptOAuthToken, navigate, params]);

  return (
    <div className="center-page">
      {error ? (
        <>
          <InlineError message={error} />
          <Link className="button button--primary" to="/login">로그인으로 돌아가기</Link>
        </>
      ) : (
        <Loading label="OAuth 로그인 완료 중" />
      )}
    </div>
  );
}

export function HomePage() {
  const { user, logout } = useAuth();
  const { home } = useShell();
  const [profileOpen, setProfileOpen] = useState(false);

  if (!home || !user) return <Loading label="모임을 불러오는 중" />;

  return (
    <div className="page page--home">
      <ScreenHeader
        title={`${user.nickname}님, 어디서 만날까요?`}
        description="모임과 투표 상태를 한눈에 확인해요."
        back={false}
        action={
          <button type="button" className="profile-action" onClick={() => setProfileOpen(true)}>
            <ProfileButton nickname={user.nickname} />
          </button>
        }
      />

      {home.hasVoteAlert ? (
        <SummaryBanner
          title="새 투표가 도착했어요"
          description="분홍색으로 표시된 모임에서 선택을 이어가세요."
          alert
        />
      ) : (
        <SummaryBanner
          title="다음 장소를 함께 모아보세요"
          description="지도에서 내 장소를 저장하면 모임 후보로 바로 꺼낼 수 있어요."
        />
      )}

      <section className="meeting-section">
        <SectionTitle title="진행 중인 모임" count={home.ongoingMeetings.length} />
        <div className="meeting-list">
          {home.ongoingMeetings.length ? (
            home.ongoingMeetings.map((meeting) => (
              <MeetingCard key={meeting.id} meeting={meeting} />
            ))
          ) : (
            <EmptyState
              title="진행 중인 모임이 없어요"
              description="새 모임을 만들거나 받은 코드로 가입해 보세요."
            />
          )}
        </div>
      </section>

      <section className="meeting-section meeting-section--completed">
        <SectionTitle title="완료된 모임" count={home.completedMeetings.length} />
        <div className="meeting-list">
          {home.completedMeetings.length ? (
            home.completedMeetings.map((meeting) => (
              <MeetingCard key={meeting.id} meeting={meeting} />
            ))
          ) : (
            <p className="muted-copy">장소가 확정된 모임이 여기에 쌓여요.</p>
          )}
        </div>
      </section>

      <div className="home-actions">
        <Link
          to="/meetings/new"
          className="button button--primary home-actions__create"
        >
          <Plus size={18} /> 모임 만들기
        </Link>
        <Link
          to="/meetings/join"
          className="button button--secondary home-actions__join"
        >
          <DoorOpen size={18} /> 모임 가입
        </Link>
      </div>

      <Modal open={profileOpen} title="계정" onClose={() => setProfileOpen(false)}>
        <div className="profile-sheet">
          <div className="profile-sheet__avatar">{user.nickname.slice(0, 1)}</div>
          <strong>{user.nickname}</strong>
          <span>{user.email ?? "이메일 없음"}</span>
        </div>
        <SecondaryButton
          type="button"
          onClick={() => void logout()}
          className="button--danger-text"
        >
          <LogOut size={18} /> 로그아웃
        </SecondaryButton>
      </Modal>
    </div>
  );
}

export function MapPage() {
  const { showToast } = useShell();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const meetingId = searchParams.get("meetingId") ?? "";
  const candidatePath = meetingId ? `/meetings/${meetingId}/candidates` : "";
  // Default search on load — a single bounded query (capped at 5 Naver
  // Search API results) instead of an empty query, which falls back to
  // returning every place ever saved in the local `places` table.
  const [query, setQuery] = useState("연세대학교 이윤재관");
  const [places, setPlaces] = useState<Place[]>([]);
  const [saved, setSaved] = useState<UserPlace[]>([]);
  const [selected, setSelected] = useState<Place | null>(null);
  const [purpose, setPurpose] = useState<Purpose>("CAFE");
  const [mood, setMood] = useState<Mood>("FUN");
  const [registerOpen, setRegisterOpen] = useState(false);
  const [unregisterOpen, setUnregisterOpen] = useState(false);
  const [candidatePrompt, setCandidatePrompt] = useState<"ASK" | "LIMIT" | null>(null);
  const [pendingUserPlaceId, setPendingUserPlaceId] = useState("");
  const [existingCandidateIds, setExistingCandidateIds] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [suggestions, setSuggestions] = useState<Place[]>([]);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [suggestionsError, setSuggestionsError] = useState(false);
  const suggestionCache = useRef(new Map<string, Place[]>());
  const resultCarouselRef = useRef<HTMLUListElement>(null);

  const loadSaved = useCallback(async () => {
    setSaved(await api<UserPlace[]>("/me/places"));
  }, []);

  const search = useCallback(async (searchQuery = query) => {
    setLoading(true);
    setError("");
    try {
      const result = await api<Place[]>(
        `/map/places/search?query=${encodeURIComponent(searchQuery.trim())}`
      );
      suggestionCache.current.set(searchQuery.trim().toLowerCase(), result);
      setPlaces(result);
      setSelected((current) =>
        current && result.some((place) => place.id === current.id)
          ? current
          : result[0] ?? null
      );
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    void Promise.all([search(), loadSaved()]);
  }, []); // initial local prototype load

  useEffect(() => {
    const normalized = query.trim();
    if (!suggestionsOpen || normalized.length < 2) {
      setSuggestions([]);
      setSuggestionsLoading(false);
      setSuggestionsError(false);
      return;
    }

    const cacheKey = normalized.toLowerCase();
    const cached = suggestionCache.current.get(cacheKey);
    if (cached) {
      setSuggestions(cached);
      setSuggestionsLoading(false);
      setSuggestionsError(false);
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setSuggestionsLoading(true);
      setSuggestionsError(false);
      void api<Place[]>(
        `/map/places/search?query=${encodeURIComponent(normalized)}`,
        { signal: controller.signal }
      )
        .then((result) => {
          suggestionCache.current.set(cacheKey, result);
          setSuggestions(result);
        })
        .catch((reason: unknown) => {
          if (!(reason instanceof DOMException && reason.name === "AbortError")) {
            setSuggestions([]);
            setSuggestionsError(true);
          }
        })
        .finally(() => setSuggestionsLoading(false));
    }, 350);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, suggestionsOpen]);

  const selectSuggestion = (place: Place) => {
    setQuery(place.name);
    setPlaces(suggestions);
    setSelected(place);
    setSuggestionsOpen(false);
    setError("");
  };

  useEffect(() => {
    if (!selected || !resultCarouselRef.current) return;
    const selectedCard = Array.from(
      resultCarouselRef.current.querySelectorAll<HTMLButtonElement>("[data-place-id]")
    ).find((card) => card.dataset.placeId === selected.id);
    selectedCard?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
      inline: "center"
    });
  }, [selected]);

  const selectedSaved = selected
    ? saved.find((item) => item.place.naverPlaceId === selected.naverPlaceId)
    : undefined;

  const register = async () => {
    if (!selected) return;
    setError("");
    try {
      const registered = await api<UserPlace>("/me/places", {
        method: "POST",
        body: JSON.stringify({
          naverPlaceId: selected.naverPlaceId,
          purpose,
          mood
        })
      });
      await loadSaved();
      setRegisterOpen(false);
      if (!meetingId) {
        showToast("내 장소에 저장했어요.");
        return;
      }
      const eligible = await api<EligiblePlace[]>(
        `/meetings/${meetingId}/eligible-places`
      );
      const selectedCandidateIds = eligible
        .filter((item) => item.selected)
        .map((item) => item.id);
      setPendingUserPlaceId(registered.id);
      setExistingCandidateIds(selectedCandidateIds);
      setCandidatePrompt(
        selectedCandidateIds.includes(registered.id)
          ? null
          : selectedCandidateIds.length >= 2
            ? "LIMIT"
            : "ASK"
      );
      if (selectedCandidateIds.includes(registered.id)) {
        showToast("이미 현재 모임의 후보로 등록된 장소예요.");
        navigate(candidatePath, { replace: true });
      }
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };

  const returnToCandidates = () => {
    setCandidatePrompt(null);
    navigate(candidatePath, { replace: true });
  };

  const addToCurrentMeeting = async () => {
    if (!meetingId || !pendingUserPlaceId) return;
    setError("");
    try {
      await api(`/meetings/${meetingId}/candidates/me`, {
        method: "PUT",
        body: JSON.stringify({
          userPlaceIds: [...existingCandidateIds, pendingUserPlaceId]
        })
      });
      showToast("현재 모임의 후보로 추가했어요.");
      returnToCandidates();
    } catch (reason) {
      setError(errorMessage(reason));
      setCandidatePrompt(null);
    }
  };

  const unregister = async (applyToActiveMeetings: boolean) => {
    if (!selectedSaved) return;
    try {
      await api(`/me/places/${selectedSaved.id}/unregister`, {
        method: "POST",
        body: JSON.stringify({ applyToActiveMeetings })
      });
      await loadSaved();
      setUnregisterOpen(false);
      showToast("내 장소 등록을 해제했어요.");
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };

  return (
    <div className="page page--map">
      <ScreenHeader
        title="장소 탐색"
        description={
          meetingId
            ? "새 장소를 내 장소에 저장한 뒤 현재 모임 후보로 추가할 수 있어요."
            : "역 주변에서 관심 장소를 찾아보세요."
        }
        back={Boolean(meetingId)}
      />
      <SearchInput
        value={query}
        onChange={setQuery}
        onSubmit={() => void search()}
        suggestions={suggestions}
        suggestionsOpen={suggestionsOpen}
        suggestionsLoading={suggestionsLoading}
        suggestionsError={suggestionsError}
        onSuggestionsOpenChange={setSuggestionsOpen}
        onSuggestionSelect={selectSuggestion}
      />
      <InlineError message={error} />
      {loading ? (
        <Loading label="주변 장소 검색 중" />
      ) : (
        <>
          <MapCanvas
            places={places}
            selectedId={selected?.id}
            onSelect={setSelected}
          />
          {places.length ? (
            <section className="map-results" aria-label="검색된 장소">
              <div className="map-results__heading">
                <strong>검색 결과 {places.length}</strong>
                <span>좌우로 넘겨보세요</span>
              </div>
              <ul className="map-result-carousel" ref={resultCarouselRef}>
                {places.map((place) => (
                  <li key={place.id}>
                    <button
                      type="button"
                      className={`map-result-card ${selected?.id === place.id ? "is-selected" : ""}`}
                      data-place-id={place.id}
                      aria-pressed={selected?.id === place.id}
                      onClick={() => setSelected(place)}
                    >
                      <PlaceThumbnail place={place} />
                      <span className="map-result-card__body">
                        <strong>{place.name}</strong>
                        <small>{place.category}</small>
                        <span>{place.roadAddress || place.address}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {selected ? (
            <section className="place-detail-card">
              <PlaceThumbnail place={selected} large />
              <PlaceMeta place={selected} />
              <p>{selected.roadAddress}</p>
              {selectedSaved ? (
                <SecondaryButton type="button" onClick={() => setUnregisterOpen(true)}>
                  장소 등록 해제
                </SecondaryButton>
              ) : (
                <PrimaryButton type="button" onClick={() => setRegisterOpen(true)}>
                  내 장소 등록하기
                </PrimaryButton>
              )}
            </section>
          ) : (
            <EmptyState
              title="검색 결과가 없어요"
              description="다른 역 이름이나 장소명을 입력해 보세요."
            />
          )}
        </>
      )}

      <Modal
        open={registerOpen}
        title="어떤 모임에 어울리나요?"
        description={selected ? `${selected.name}의 목적과 성격을 하나씩 선택해 주세요.` : undefined}
        onClose={() => setRegisterOpen(false)}
      >
        <PurposeMoodFields
          purpose={purpose}
          mood={mood}
          onPurpose={setPurpose}
          onMood={setMood}
        />
        <PrimaryButton type="button" onClick={() => void register()}>
          확인하고 저장
        </PrimaryButton>
      </Modal>

      <Modal
        open={unregisterOpen}
        title="내 장소에서 지울까요?"
        description="투표 생성 전 모임에 제출한 후보도 함께 취소할지 선택해 주세요."
        onClose={() => setUnregisterOpen(false)}
      >
        <div className="modal-actions modal-actions--stack">
          <SecondaryButton type="button" onClick={() => void unregister(false)}>
            내 장소에서만 해제
          </SecondaryButton>
          <PrimaryButton type="button" onClick={() => void unregister(true)}>
            이번 투표 후보도 취소
          </PrimaryButton>
        </div>
      </Modal>

      <Modal
        open={candidatePrompt === "ASK"}
        title="내 장소에 추가되었어요."
        description="현재 모임에도 후보로 등록할까요?"
        onClose={returnToCandidates}
      >
        <div className="modal-actions">
          <SecondaryButton type="button" onClick={returnToCandidates}>
            다음에
          </SecondaryButton>
          <PrimaryButton type="button" onClick={() => void addToCurrentMeeting()}>
            추가하기
          </PrimaryButton>
        </div>
      </Modal>

      <Modal
        open={candidatePrompt === "LIMIT"}
        title="이미 후보 2개가 등록되어 있어요."
        description="모임 페이지에서 후보를 변경해 주세요."
        onClose={returnToCandidates}
      >
        <PrimaryButton type="button" onClick={returnToCandidates}>
          확인
        </PrimaryButton>
      </Modal>
    </div>
  );
}

export function MyPlacesPage() {
  const { showToast } = useShell();
  const [items, setItems] = useState<UserPlace[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionsFor, setActionsFor] = useState("");
  const [editing, setEditing] = useState<UserPlace | null>(null);
  const [removing, setRemoving] = useState<UserPlace | null>(null);
  const [purpose, setPurpose] = useState<Purpose>("CAFE");
  const [mood, setMood] = useState<Mood>("FUN");
  const [candidateMeetings, setCandidateMeetings] = useState<
    CandidateMeetingTarget[]
  >([]);
  const [selectedMeetingIds, setSelectedMeetingIds] = useState<string[]>([]);
  const [selectingMeetings, setSelectingMeetings] = useState(false);
  const [meetingOptionsLoading, setMeetingOptionsLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await api<UserPlace[]>("/me/places"));
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openEdit = (item: UserPlace) => {
    setEditing(item);
    setPurpose(item.purpose);
    setMood(item.mood);
    setCandidateMeetings([]);
    setSelectedMeetingIds([]);
    setSelectingMeetings(false);
  };

  const closeEdit = () => {
    setEditing(null);
    setSelectingMeetings(false);
    setCandidateMeetings([]);
    setSelectedMeetingIds([]);
  };

  const openMeetingSelection = async () => {
    if (!editing) return;
    setSelectingMeetings(true);
    setMeetingOptionsLoading(true);
    try {
      const targets = await api<CandidateMeetingTarget[]>(
        `/me/places/${editing.id}/candidate-meetings`
      );
      setCandidateMeetings(targets);
      setSelectedMeetingIds([]);
    } catch (reason) {
      setError(errorMessage(reason));
      setSelectingMeetings(false);
    } finally {
      setMeetingOptionsLoading(false);
    }
  };

  const toggleMeetingTarget = (meetingId: string) => {
    setSelectedMeetingIds((current) =>
      current.includes(meetingId)
        ? current.filter((id) => id !== meetingId)
        : [...current, meetingId]
    );
  };

  const saveEdit = async (meetingIds: string[]) => {
    if (!editing) return;
    try {
      await api(`/me/places/${editing.id}`, {
        method: "PATCH",
        body: JSON.stringify({ purpose, mood, applyToMeetingIds: meetingIds })
      });
      closeEdit();
      await load();
      showToast(
        meetingIds.length
          ? `내 장소와 선택한 모임 ${meetingIds.length}개의 후보를 변경했어요.`
          : "내 장소만 변경했어요."
      );
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };

  const unregister = async (apply: boolean) => {
    if (!removing) return;
    try {
      await api(`/me/places/${removing.id}/unregister`, {
        method: "POST",
        body: JSON.stringify({ applyToActiveMeetings: apply })
      });
      setRemoving(null);
      await load();
      showToast("장소 등록을 해제했어요.");
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };

  return (
    <div className="page">
      <ScreenHeader title="내 장소" description="후보로 꺼내 쓸 관심 장소를 관리해요." back={false} />
      <InlineError message={error} />
      {loading ? (
        <Loading label="내 장소 불러오는 중" />
      ) : items.length ? (
        <>
          <p className="gesture-hint">장소를 누르면 변경·등록 해제 메뉴가 열려요.</p>
          <div className="saved-place-list">
            {items.map((item) => (
              <div className="saved-place-item" key={item.id}>
                <button
                  type="button"
                  className="saved-place-item__main"
                  onClick={() => setActionsFor(actionsFor === item.id ? "" : item.id)}
                >
                  <PlaceThumbnail place={item.place} />
                  <div className="place-meta">
                    <strong>{item.place.name}</strong>
                    <span>
                      {PURPOSE_LABELS[item.purpose]} · {MOOD_LABELS[item.mood]}
                    </span>
                    <small>{item.place.roadAddress}</small>
                  </div>
                  <CircleEllipsis size={21} />
                </button>
                {actionsFor === item.id ? (
                  <div className="saved-place-item__actions is-open">
                    <button type="button" onClick={() => openEdit(item)}>변경</button>
                    <button type="button" onClick={() => setRemoving(item)}>등록 해제</button>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </>
      ) : (
        <EmptyState
          title="아직 저장한 장소가 없어요"
          description="지도에서 마음에 드는 장소를 먼저 저장해 보세요."
          action={<Link className="button button--primary" to="/map">지도에서 장소 찾기</Link>}
        />
      )}

      <Modal
        open={Boolean(editing)}
        title={selectingMeetings ? "반영할 모임 선택" : "장소 분류 변경"}
        description={
          selectingMeetings
            ? "아직 투표가 시작되지 않았고 이 장소가 후보로 등록된 모임만 보여요."
            : editing?.place.name
        }
        onClose={closeEdit}
      >
        {selectingMeetings ? (
          <>
            {meetingOptionsLoading ? (
              <Loading label="반영할 수 있는 모임 확인 중" />
            ) : candidateMeetings.length ? (
              <div className="meeting-target-list">
                {candidateMeetings.map((target) => {
                  const selected = selectedMeetingIds.includes(target.id);
                  return (
                    <button
                      type="button"
                      key={target.id}
                      className={selected ? "is-selected" : ""}
                      onClick={() => toggleMeetingTarget(target.id)}
                      aria-pressed={selected}
                    >
                      <span>
                        <strong>{target.name}</strong>
                        <small>
                          {formatMeetingAt(target.meetingAt)} ·{" "}
                          {PURPOSE_LABELS[target.purpose]} ·{" "}
                          {MOOD_LABELS[target.mood]}
                        </small>
                      </span>
                      {selected ? <Check size={18} /> : null}
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="empty-inline">
                <strong>반영할 수 있는 모임이 없어요.</strong>
                <p>이 장소가 후보인 투표 전 모임이 있을 때 선택할 수 있어요.</p>
              </div>
            )}
            <div className="modal-actions modal-actions--stack">
              <SecondaryButton
                type="button"
                onClick={() => setSelectingMeetings(false)}
              >
                분류 변경으로 돌아가기
              </SecondaryButton>
              <PrimaryButton
                type="button"
                disabled={selectedMeetingIds.length === 0}
                onClick={() => void saveEdit(selectedMeetingIds)}
              >
                선택한 모임에 반영
              </PrimaryButton>
            </div>
          </>
        ) : (
          <>
            <PurposeMoodFields
              purpose={purpose}
              mood={mood}
              onPurpose={setPurpose}
              onMood={setMood}
            />
            <div className="modal-actions modal-actions--stack">
              <SecondaryButton
                type="button"
                onClick={() => void saveEdit([])}
              >
                내 장소만 변경
              </SecondaryButton>
              <PrimaryButton
                type="button"
                onClick={() => void openMeetingSelection()}
              >
                이번 투표에도 반영
              </PrimaryButton>
            </div>
          </>
        )}
      </Modal>

      <Modal
        open={Boolean(removing)}
        title="장소 등록을 해제할까요?"
        description="투표가 생성된 모임의 고정 후보에는 영향을 주지 않아요."
        onClose={() => setRemoving(null)}
      >
        <div className="modal-actions modal-actions--stack">
          <SecondaryButton type="button" onClick={() => void unregister(false)}>
            내 장소에서만 해제
          </SecondaryButton>
          <PrimaryButton type="button" onClick={() => void unregister(true)}>
            투표 전 후보도 취소
          </PrimaryButton>
        </div>
      </Modal>
    </div>
  );
}

const toDateInput = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const MINUTE_OPTIONS = Array.from({ length: 60 }, (_, value) =>
  String(value).padStart(2, "0")
);

export function CreateMeetingPage() {
  const navigate = useNavigate();
  const { refreshHome } = useShell();
  const defaultDate = useMemo(() => {
    const value = new Date();
    value.setDate(value.getDate() + 7);
    return toDateInput(value);
  }, []);
  const [name, setName] = useState("성수 주말 모임");
  const [capacity, setCapacity] = useState(6);
  const [date, setDate] = useState(defaultDate);
  const [meridiem, setMeridiem] = useState<"AM" | "PM">("PM");
  const [hour, setHour] = useState(7);
  const [minute, setMinute] = useState<"00" | "30">("30");
  const [purpose, setPurpose] = useState<Purpose>("MEAL");
  const [mood, setMood] = useState<Mood>("FUN");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    if (!name.trim()) {
      setError("모임 이름을 입력해 주세요.");
      return;
    }
    setSubmitting(true);
    try {
      const hour24 =
        meridiem === "AM" ? (hour === 12 ? 0 : hour) : hour === 12 ? 12 : hour + 12;
      const meetingAt = `${date}T${String(hour24).padStart(2, "0")}:${minute}:00+09:00`;
      const input: CreateMeetingInput = {
        name: name.trim(),
        capacity: Math.max(2, capacity),
        meetingAt,
        purpose,
        mood
      };
      const meeting = await api<MeetingDetail>("/meetings", {
        method: "POST",
        body: JSON.stringify(input)
      });
      await refreshHome();
      navigate(`/meetings/${meeting.id}/candidates`, {
        state: { justCreated: true }
      });
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="page">
      <ScreenHeader title="모임 만들기" description="기본 정보만 정하면 바로 사람을 초대할 수 있어요." />
      <form className="form-card meeting-form" onSubmit={submit}>
        <label className="field">
          <span>모임 이름 <small>{name.length}/20</small></span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={20}
            required
          />
        </label>

        <fieldset className="capacity-field">
          <legend>정원</legend>
          <div>
            <button
              type="button"
              onClick={() => setCapacity((value) => Math.max(2, value - 1))}
              aria-label="정원 1명 줄이기"
            >
              <Minus size={21} />
            </button>
            <label>
              <input
                type="number"
                min={2}
                value={capacity}
                onChange={(event) => setCapacity(Math.max(2, Number(event.target.value)))}
              />
              <span>명</span>
            </label>
            <button
              type="button"
              onClick={() => setCapacity((value) => value + 1)}
              aria-label="정원 1명 늘리기"
            >
              <Plus size={21} />
            </button>
          </div>
        </fieldset>

        <label className="field">
          <span>만나는 날짜</span>
          <span className="input-with-icon">
            <CalendarDays size={19} />
            <input type="date" value={date} onChange={(event) => setDate(event.target.value)} required />
          </span>
        </label>

        <fieldset className="time-field">
          <legend>만나는 시각</legend>
          <div className="time-grid">
            <select value={meridiem} onChange={(event) => setMeridiem(event.target.value as "AM" | "PM")}>
              <option value="AM">오전</option>
              <option value="PM">오후</option>
            </select>
            <select value={hour} onChange={(event) => setHour(Number(event.target.value))}>
              {Array.from({ length: 12 }, (_, index) => index + 1).map((value) => (
                <option key={value} value={value}>{value}시</option>
              ))}
            </select>
            <select value={minute} onChange={(event) => setMinute(event.target.value as "00" | "30")}>
              <option value="00">00분</option>
              <option value="30">30분</option>
            </select>
          </div>
          <small>오전 12시는 자정, 오후 12시는 정오예요.</small>
        </fieldset>

        <PurposeMoodFields
          purpose={purpose}
          mood={mood}
          onPurpose={setPurpose}
          onMood={setMood}
        />
        <InlineError message={error} />
        <PrimaryButton type="submit" disabled={submitting}>
          {submitting ? "모임 만드는 중…" : "모임 생성하기"}
        </PrimaryButton>
      </form>
    </div>
  );
}

// 모임 생성 폼과 동일한 필드 구성으로, 기존 모임의 값을 기본값으로 채워서 보여준다.
// RECRUITING 상태에서만 수정할 수 있다 — join/leave/kick/후보변경과 같은 규칙.
export function MeetingEditPage() {
  const { meetingId = "" } = useParams();
  const navigate = useNavigate();
  const { refreshHome } = useShell();
  const [name, setName] = useState("");
  const [capacity, setCapacity] = useState(2);
  const [date, setDate] = useState("");
  const [meridiem, setMeridiem] = useState<"AM" | "PM">("PM");
  const [hour, setHour] = useState(7);
  const [minute, setMinute] = useState<"00" | "30">("30");
  const [purpose, setPurpose] = useState<Purpose>("MEAL");
  const [mood, setMood] = useState<Mood>("FUN");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const load = async () => {
      try {
        const detail = await api<MeetingDetail>(`/meetings/${meetingId}`);
        setName(detail.name);
        setCapacity(detail.capacity);
        setPurpose(detail.purpose);
        setMood(detail.mood);

        const koreaTime = new Date(
          new Date(detail.meetingAt).getTime() + 9 * 60 * 60 * 1000
        );
        setDate(toDateInput(koreaTime));
        const sourceHour = koreaTime.getUTCHours();
        setMeridiem(sourceHour < 12 ? "AM" : "PM");
        setHour(sourceHour % 12 || 12);
        setMinute(koreaTime.getUTCMinutes() < 30 ? "00" : "30");
      } catch (reason) {
        setError(errorMessage(reason));
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, [meetingId]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    if (!name.trim()) {
      setError("모임 이름을 입력해 주세요.");
      return;
    }
    setSubmitting(true);
    try {
      const hour24 =
        meridiem === "AM" ? (hour === 12 ? 0 : hour) : hour === 12 ? 12 : hour + 12;
      const meetingAt = `${date}T${String(hour24).padStart(2, "0")}:${minute}:00+09:00`;
      const input: UpdateMeetingInput = {
        name: name.trim(),
        capacity: Math.max(2, capacity),
        meetingAt,
        purpose,
        mood
      };
      await api<MeetingDetail>(`/meetings/${meetingId}`, {
        method: "PATCH",
        body: JSON.stringify(input)
      });
      await refreshHome();
      navigate(`/meetings/${meetingId}`);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <Loading label="모임 정보 불러오는 중" />;

  return (
    <div className="page">
      <ScreenHeader title="모임 편집" description="모임 만들기와 같은 항목을 수정할 수 있어요." />
      <form className="form-card meeting-form" onSubmit={submit}>
        <label className="field">
          <span>모임 이름 <small>{name.length}/20</small></span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={20}
            required
          />
        </label>

        <fieldset className="capacity-field">
          <legend>정원</legend>
          <div>
            <button
              type="button"
              onClick={() => setCapacity((value) => Math.max(2, value - 1))}
              aria-label="정원 1명 줄이기"
            >
              <Minus size={21} />
            </button>
            <label>
              <input
                type="number"
                min={2}
                value={capacity}
                onChange={(event) => setCapacity(Math.max(2, Number(event.target.value)))}
              />
              <span>명</span>
            </label>
            <button
              type="button"
              onClick={() => setCapacity((value) => value + 1)}
              aria-label="정원 1명 늘리기"
            >
              <Plus size={21} />
            </button>
          </div>
        </fieldset>

        <label className="field">
          <span>만나는 날짜</span>
          <span className="input-with-icon">
            <CalendarDays size={19} />
            <input type="date" value={date} onChange={(event) => setDate(event.target.value)} required />
          </span>
        </label>

        <fieldset className="time-field">
          <legend>만나는 시각</legend>
          <div className="time-grid">
            <select value={meridiem} onChange={(event) => setMeridiem(event.target.value as "AM" | "PM")}>
              <option value="AM">오전</option>
              <option value="PM">오후</option>
            </select>
            <select value={hour} onChange={(event) => setHour(Number(event.target.value))}>
              {Array.from({ length: 12 }, (_, index) => index + 1).map((value) => (
                <option key={value} value={value}>{value}시</option>
              ))}
            </select>
            <select value={minute} onChange={(event) => setMinute(event.target.value as "00" | "30")}>
              <option value="00">00분</option>
              <option value="30">30분</option>
            </select>
          </div>
          <small>오전 12시는 자정, 오후 12시는 정오예요.</small>
        </fieldset>

        <PurposeMoodFields
          purpose={purpose}
          mood={mood}
          onPurpose={setPurpose}
          onMood={setMood}
        />
        <InlineError message={error} />
        <PrimaryButton type="submit" disabled={submitting}>
          {submitting ? "저장하는 중…" : "저장하기"}
        </PrimaryButton>
      </form>
    </div>
  );
}

export function RepeatMeetingPage() {
  const { meetingId = "" } = useParams();
  const navigate = useNavigate();
  const { refreshHome } = useShell();
  const defaultDate = useMemo(() => {
    const value = new Date();
    value.setDate(value.getDate() + 7);
    return toDateInput(value);
  }, []);
  const [meeting, setMeeting] = useState<MeetingDetail | null>(null);
  const [name, setName] = useState("");
  const [capacity, setCapacity] = useState(2);
  const [date, setDate] = useState(defaultDate);
  const [meridiem, setMeridiem] = useState<"AM" | "PM">("PM");
  const [hour, setHour] = useState(7);
  const [minute, setMinute] = useState("30");
  const [purpose, setPurpose] = useState<Purpose>("MEAL");
  const [mood, setMood] = useState<Mood>("FUN");
  const [selectedMemberIds, setSelectedMemberIds] = useState<string[]>([]);
  const [recurring, setRecurring] = useState(false);
  const [recurrenceType, setRecurrenceType] =
    useState<RecurrenceType>("WEEKLY");
  const [customNextDate, setCustomNextDate] = useState(() => {
    const value = new Date();
    value.setDate(value.getDate() + 14);
    return toDateInput(value);
  });
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const load = async () => {
      try {
        const detail = await api<MeetingDetail>(`/meetings/${meetingId}`);
        setMeeting(detail);
        setName(detail.name);
        setCapacity(detail.capacity);
        setPurpose(detail.purpose);
        setMood(detail.mood);
        setSelectedMemberIds(detail.members.map((member) => member.id));

        const koreaTime = new Date(
          new Date(detail.meetingAt).getTime() + 9 * 60 * 60 * 1000
        );
        const sourceHour = koreaTime.getUTCHours();
        setMeridiem(sourceHour < 12 ? "AM" : "PM");
        setHour(sourceHour % 12 || 12);
        setMinute(String(koreaTime.getUTCMinutes()).padStart(2, "0"));
      } catch (reason) {
        setError(errorMessage(reason));
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, [meetingId]);

  useEffect(() => {
    if (recurrenceType !== "CUSTOM" || customNextDate > date) return;
    const value = new Date(`${date}T00:00:00`);
    value.setDate(value.getDate() + 7);
    setCustomNextDate(toDateInput(value));
  }, [customNextDate, date, recurrenceType]);

  const toggleMember = (memberId: string) => {
    if (!meeting) return;
    const member = meeting.members.find((item) => item.id === memberId);
    if (!member || member.role === "HOST") return;
    setSelectedMemberIds((current) => {
      const next = current.includes(memberId)
        ? current.filter((id) => id !== memberId)
        : [...current, memberId];
      if (next.length > capacity) setCapacity(next.length);
      return next;
    });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    if (!name.trim()) {
      setError("모임 이름을 입력해 주세요.");
      return;
    }
    if (capacity < selectedMemberIds.length) {
      setError("선택한 모임원 수보다 정원을 작게 설정할 수 없습니다.");
      return;
    }

    const hour24 =
      meridiem === "AM"
        ? hour === 12
          ? 0
          : hour
        : hour === 12
          ? 12
          : hour + 12;
    const time = `${String(hour24).padStart(2, "0")}:${minute}:00+09:00`;
    const input: RepeatMeetingInput = {
      name: name.trim(),
      capacity: Math.max(2, capacity),
      meetingAt: `${date}T${time}`,
      purpose,
      mood,
      memberIds: selectedMemberIds,
      recurrence: recurring
        ? {
            type: recurrenceType,
            customNextMeetingAt:
              recurrenceType === "CUSTOM"
                ? `${customNextDate}T${time}`
                : null
          }
        : null
    };

    setSubmitting(true);
    try {
      const nextMeeting = await api<MeetingDetail>(
        `/meetings/${meetingId}/repeat`,
        { method: "POST", body: JSON.stringify(input) }
      );
      await refreshHome();
      navigate(`/meetings/${nextMeeting.id}`);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <Loading label="이전 모임 불러오는 중" />;
  if (!meeting) {
    return (
      <div className="page">
        <ScreenHeader title="다시 만나기" />
        <InlineError message={error} />
      </div>
    );
  }

  return (
    <div className="page">
      <ScreenHeader
        title="다시 만나기"
        description="지난 모임의 기본 정보와 가입 코드를 그대로 이어가요."
      />
      <form className="form-card meeting-form repeat-meeting-form" onSubmit={submit}>
        <div className="repeat-code-note">
          <span>유지되는 가입 코드</span>
          <strong>{meeting.joinCode}</strong>
        </div>

        <label className="field">
          <span>모임 이름 <small>{name.length}/20</small></span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={20}
            required
          />
        </label>

        <fieldset className="capacity-field">
          <legend>정원</legend>
          <div>
            <button
              type="button"
              onClick={() =>
                setCapacity((value) =>
                  Math.max(2, selectedMemberIds.length, value - 1)
                )
              }
              aria-label="정원 1명 줄이기"
            >
              <Minus size={21} />
            </button>
            <label>
              <input
                type="number"
                min={Math.max(2, selectedMemberIds.length)}
                value={capacity}
                onChange={(event) =>
                  setCapacity(
                    Math.max(
                      2,
                      selectedMemberIds.length,
                      Number(event.target.value)
                    )
                  )
                }
              />
              <span>명</span>
            </label>
            <button
              type="button"
              onClick={() => setCapacity((value) => value + 1)}
              aria-label="정원 1명 늘리기"
            >
              <Plus size={21} />
            </button>
          </div>
        </fieldset>

        <label className="field">
          <span>만나는 날짜</span>
          <span className="input-with-icon">
            <CalendarDays size={19} />
            <input
              type="date"
              value={date}
              min={toDateInput(new Date())}
              onChange={(event) => setDate(event.target.value)}
              required
            />
          </span>
        </label>

        <fieldset className="time-field">
          <legend>만나는 시각</legend>
          <div className="time-grid">
            <select
              value={meridiem}
              onChange={(event) =>
                setMeridiem(event.target.value as "AM" | "PM")
              }
            >
              <option value="AM">오전</option>
              <option value="PM">오후</option>
            </select>
            <select
              value={hour}
              onChange={(event) => setHour(Number(event.target.value))}
            >
              {Array.from({ length: 12 }, (_, index) => index + 1).map(
                (value) => (
                  <option key={value} value={value}>{value}시</option>
                )
              )}
            </select>
            <select
              value={minute}
              onChange={(event) => setMinute(event.target.value)}
              aria-label="분"
            >
              {MINUTE_OPTIONS.map((value) => (
                <option key={value} value={value}>{value}분</option>
              ))}
            </select>
          </div>
        </fieldset>

        <PurposeMoodFields
          purpose={purpose}
          mood={mood}
          onPurpose={setPurpose}
          onMood={setMood}
        />

        <fieldset className="repeat-members">
          <legend>함께할 모임원</legend>
          <p>기본으로 모두 선택되어 있어요. 참여하지 않는 사람을 눌러 빼주세요.</p>
          <div>
            {meeting.members.map((member) => {
              const selected = selectedMemberIds.includes(member.id);
              return (
                <button
                  type="button"
                  key={member.id}
                  className={selected ? "is-selected" : ""}
                  disabled={member.role === "HOST"}
                  onClick={() => toggleMember(member.id)}
                >
                  <span>{member.meetingNickname.slice(0, 1)}</span>
                  <strong>{member.meetingNickname}</strong>
                  <small>{member.role === "HOST" ? "모임장" : selected ? "참여" : "제외"}</small>
                  {selected ? <Check size={17} /> : null}
                </button>
              );
            })}
          </div>
        </fieldset>

        <label className="recurrence-toggle">
          <input
            type="checkbox"
            checked={recurring}
            onChange={(event) => setRecurring(event.target.checked)}
          />
          <span>
            <strong>정기적으로 만나기</strong>
            <small>현재 회차가 완료되면 다음 회차 하나를 자동으로 만들어요.</small>
          </span>
        </label>

        {recurring ? (
          <fieldset className="recurrence-options">
            <legend>반복 주기</legend>
            <div>
              {([
                ["WEEKLY", "매주"],
                ["MONTHLY", "매달"],
                ["CUSTOM", "직접 입력"]
              ] as const).map(([value, label]) => (
                <button
                  type="button"
                  key={value}
                  className={recurrenceType === value ? "is-selected" : ""}
                  onClick={() => setRecurrenceType(value)}
                >
                  {label}
                </button>
              ))}
            </div>
            {recurrenceType === "CUSTOM" ? (
              <label className="field">
                <span>그다음 회차 날짜</span>
                <input
                  type="date"
                  value={customNextDate}
                  min={date}
                  onChange={(event) => setCustomNextDate(event.target.value)}
                  required
                />
              </label>
            ) : (
              <p>
                {recurrenceType === "WEEKLY"
                  ? "같은 요일과 시각으로 다음 회차를 만들어요."
                  : "같은 날짜와 시각으로 다음 달 회차를 만들어요."}
              </p>
            )}
          </fieldset>
        ) : null}

        <InlineError message={error} />
        <PrimaryButton type="submit" disabled={submitting}>
          <Repeat2 size={18} />
          {submitting ? "새 회차 만드는 중" : "새 회차 만들기"}
        </PrimaryButton>
      </form>
    </div>
  );
}

export function MeetingRecurrencePage() {
  const { meetingId = "" } = useParams();
  const navigate = useNavigate();
  const { refreshHome, showToast } = useShell();
  const [meeting, setMeeting] = useState<MeetingDetail | null>(null);
  const [recurrenceType, setRecurrenceType] =
    useState<RecurrenceType>("WEEKLY");
  const [customDate, setCustomDate] = useState("");
  const [meridiem, setMeridiem] = useState<"AM" | "PM">("PM");
  const [hour, setHour] = useState(7);
  const [minute, setMinute] = useState("00");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const load = async () => {
      try {
        const detail = await api<MeetingDetail>(`/meetings/${meetingId}`);
        setMeeting(detail);
        setRecurrenceType(detail.recurrence?.type ?? "WEEKLY");

        const source = detail.recurrence?.customNextMeetingAt
          ? new Date(detail.recurrence.customNextMeetingAt)
          : new Date(
              new Date(detail.meetingAt).getTime() +
                7 * 24 * 60 * 60 * 1000
            );
        const koreaTime = new Date(source.getTime() + 9 * 60 * 60 * 1000);
        setCustomDate(
          `${koreaTime.getUTCFullYear()}-${String(
            koreaTime.getUTCMonth() + 1
          ).padStart(2, "0")}-${String(koreaTime.getUTCDate()).padStart(2, "0")}`
        );
        const sourceHour = koreaTime.getUTCHours();
        setMeridiem(sourceHour < 12 ? "AM" : "PM");
        setHour(sourceHour % 12 || 12);
        setMinute(String(koreaTime.getUTCMinutes()).padStart(2, "0"));
      } catch (reason) {
        setError(errorMessage(reason));
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, [meetingId]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!meeting) return;
    const hour24 =
      meridiem === "AM"
        ? hour === 12
          ? 0
          : hour
        : hour === 12
          ? 12
          : hour + 12;
    const time = `${String(hour24).padStart(2, "0")}:${minute}:00+09:00`;
    const input: ConfigureMeetingRecurrenceInput = {
      recurrence: {
        type: recurrenceType,
        customNextMeetingAt:
          recurrenceType === "CUSTOM" ? `${customDate}T${time}` : null
      }
    };

    setSubmitting(true);
    setError("");
    try {
      await api(`/meetings/${meetingId}/recurrence`, {
        method: "PUT",
        body: JSON.stringify(input)
      });
      await refreshHome();
      showToast("정기 모임 설정을 저장했어요.");
      navigate(`/meetings/${meetingId}`);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <Loading label="정기 모임 설정 불러오는 중" />;
  if (!meeting) {
    return (
      <div className="page">
        <ScreenHeader title="정기적으로 만나기" />
        <InlineError message={error} />
      </div>
    );
  }

  return (
    <div className="page">
      <ScreenHeader
        title="정기적으로 만나기"
        description="현재 모임은 그대로 두고, 종료 시 같은 가입 코드로 다음 회차를 만들어요."
      />
      <form
        className="form-card meeting-form recurrence-settings-form"
        onSubmit={submit}
      >
        <div className="repeat-code-note">
          <span>유지되는 가입 코드</span>
          <strong>{meeting.joinCode}</strong>
        </div>
        <div className="recurrence-source-summary">
          <strong>{meeting.name}</strong>
          <span>{formatMeetingAt(meeting.meetingAt)}</span>
          <small>
            {PURPOSE_LABELS[meeting.purpose]} · {MOOD_LABELS[meeting.mood]} ·
            정원 {meeting.capacity}명
          </small>
        </div>

        <fieldset className="recurrence-options">
          <legend>반복 주기</legend>
          <div>
            {([
              ["WEEKLY", "매주"],
              ["MONTHLY", "매달"],
              ["CUSTOM", "직접 입력"]
            ] as const).map(([value, label]) => (
              <button
                type="button"
                key={value}
                className={recurrenceType === value ? "is-selected" : ""}
                onClick={() => setRecurrenceType(value)}
              >
                {label}
              </button>
            ))}
          </div>
          {recurrenceType === "CUSTOM" ? (
            <>
              <label className="field">
                <span>다음 회차 날짜</span>
                <input
                  type="date"
                  value={customDate}
                  min={toDateInput(new Date(meeting.meetingAt))}
                  onChange={(event) => setCustomDate(event.target.value)}
                  required
                />
              </label>
              <fieldset className="time-field">
                <legend>다음 회차 시각</legend>
                <div className="time-grid">
                  <select
                    value={meridiem}
                    onChange={(event) =>
                      setMeridiem(event.target.value as "AM" | "PM")
                    }
                  >
                    <option value="AM">오전</option>
                    <option value="PM">오후</option>
                  </select>
                  <select
                    value={hour}
                    onChange={(event) => setHour(Number(event.target.value))}
                  >
                    {Array.from({ length: 12 }, (_, index) => index + 1).map(
                      (value) => (
                        <option key={value} value={value}>{value}시</option>
                      )
                    )}
                  </select>
                  <select
                    value={minute}
                    onChange={(event) => setMinute(event.target.value)}
                    aria-label="분"
                  >
                    {MINUTE_OPTIONS.map((value) => (
                      <option key={value} value={value}>{value}분</option>
                    ))}
                  </select>
                </div>
              </fieldset>
            </>
          ) : (
            <p>
              {recurrenceType === "WEEKLY"
                ? "현재 회차와 같은 요일·시각으로 다음 주 모임을 만들어요."
                : "현재 회차와 같은 날짜·시각으로 다음 달 모임을 만들어요."}
            </p>
          )}
        </fieldset>

        <InlineError message={error} />
        <PrimaryButton type="submit" disabled={submitting}>
          <Repeat2 size={18} />
          {submitting ? "저장하는 중" : "정기 모임으로 설정"}
        </PrimaryButton>
      </form>
    </div>
  );
}

interface LookupMeeting {
  id: string;
  name: string;
  purpose: Purpose;
  mood: Mood;
  meetingAt: string;
  currentMembers: number;
  capacity: number;
  canJoin: boolean;
}

export function JoinMeetingPage() {
  const { user } = useAuth();
  const { refreshHome } = useShell();
  const navigate = useNavigate();
  const [joinCode, setJoinCode] = useState("");
  const [meeting, setMeeting] = useState<LookupMeeting | null>(null);
  const [nickname, setNickname] = useState(user?.nickname ?? "");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const lookup = async (event?: FormEvent) => {
    event?.preventDefault();
    setError("");
    if (!/^\d{4}$/.test(joinCode)) {
      setError("4자리 숫자 코드를 입력해 주세요.");
      return;
    }
    setLoading(true);
    try {
      setMeeting(
        await api<LookupMeeting>("/meetings/lookup", {
          method: "POST",
          body: JSON.stringify({ joinCode })
        })
      );
    } catch (reason) {
      setMeeting(null);
      setError(errorMessage(reason));
    } finally {
      setLoading(false);
    }
  };

  const join = async () => {
    if (!meeting) return;
    setLoading(true);
    try {
      await api(`/meetings/${meeting.id}/join`, {
        method: "POST",
        body: JSON.stringify({ joinCode, meetingNickname: nickname })
      });
      await refreshHome();
      navigate(`/meetings/${meeting.id}/candidates`);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="page">
      <ScreenHeader title="모임 가입하기" description="카카오톡으로 받은 4자리 코드를 입력하세요." />
      <form className="join-code-card" onSubmit={lookup}>
        <span>가입 코드</span>
        <input
          value={joinCode}
          onChange={(event) => {
            setJoinCode(event.target.value.replace(/\D/g, "").slice(0, 4));
            setMeeting(null);
          }}
          inputMode="numeric"
          pattern="\d{4}"
          maxLength={4}
          placeholder="_ _ _ _"
          autoComplete="one-time-code"
          aria-label="4자리 가입 코드"
        />
        <PrimaryButton type="submit" disabled={loading || joinCode.length !== 4}>
          {loading ? "확인 중…" : "모임 확인"}
        </PrimaryButton>
      </form>
      <InlineError message={error} />

      {meeting ? (
        <section className="join-preview">
          <span className="eyebrow">가입할 모임</span>
          <h2>{meeting.name}</h2>
          <div className="meeting-card__tags">
            <span>{PURPOSE_LABELS[meeting.purpose]}</span>
            <span>{MOOD_LABELS[meeting.mood]}</span>
          </div>
          <p>{formatMeetingAt(meeting.meetingAt)}</p>
          <p className="member-count"><UsersRound size={17} /> {meeting.currentMembers}/{meeting.capacity}명</p>
          <label className="field">
            <span>이 모임에서 사용할 닉네임 <small>{nickname.length}/20</small></span>
            <input
              value={nickname}
              onChange={(event) => setNickname(event.target.value)}
              maxLength={20}
            />
          </label>
          <PrimaryButton type="button" disabled={!meeting.canJoin || !nickname.trim()} onClick={() => void join()}>
            {meeting.canJoin ? "가입하고 후보 고르기" : "정원이 모두 찼어요"}
          </PrimaryButton>
        </section>
      ) : null}
    </div>
  );
}

export function CandidateSelectPage() {
  const { meetingId = "" } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { showToast, refreshHome } = useShell();
  const [meeting, setMeeting] = useState<MeetingDetail | null>(null);
  const [places, setPlaces] = useState<EligiblePlace[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    void Promise.all([
      api<MeetingDetail>(`/meetings/${meetingId}`),
      api<EligiblePlace[]>(`/meetings/${meetingId}/eligible-places`)
    ])
      .then(([detail, eligible]) => {
        setMeeting(detail);
        setPlaces(eligible);
        setSelectedIds(eligible.filter((item) => item.selected).map((item) => item.id));
      })
      .catch((reason) => setError(errorMessage(reason)))
      .finally(() => setLoading(false));
  }, [meetingId]);

  const toggle = (id: string) => {
    setError("");
    setSelectedIds((current) => {
      if (current.includes(id)) return current.filter((value) => value !== id);
      if (current.length >= 2) {
        setError("후보는 한 사람당 최대 2개까지 선택할 수 있어요.");
        return current;
      }
      return [...current, id];
    });
  };

  const save = async () => {
    try {
      await api(`/meetings/${meetingId}/candidates/me`, {
        method: "PUT",
        body: JSON.stringify({ userPlaceIds: selectedIds })
      });
      await refreshHome();
      showToast(
        selectedIds.length
          ? `${selectedIds.length}곳을 후보로 반영했어요.`
          : "후보 없이 모임에 참여했어요."
      );
      navigate(`/meetings/${meetingId}`, { replace: true });
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };

  if (loading) return <Loading label="선택 가능한 내 장소 확인 중" />;

  return (
    <div className="page">
      <ScreenHeader
        title="후보 장소 선택"
        description={meeting ? `${meeting.name} · 최대 2곳` : "최대 2곳"}
      />
      {location.state && (location.state as { justCreated?: boolean }).justCreated ? (
        <SummaryBanner
          title={`가입 코드 ${meeting?.joinCode ?? ""}`}
          description="코드는 모임 상세 화면에서 언제든 다시 복사할 수 있어요."
        />
      ) : null}
      <div className="selection-summary">
        <div>
          <strong>{selectedIds.length}</strong>
          <span>/ 2곳 선택</span>
        </div>
        <p>
          해당 모임은 [{meeting ? PURPOSE_LABELS[meeting.purpose] : ""}]
          [{meeting ? MOOD_LABELS[meeting.mood] : ""}] 성격의 모임이에요.
        </p>
      </div>
      <InlineError message={error} />
      {places.length ? (
        <Link
          className="button button--secondary candidate-map-link"
          to={`/map?meetingId=${encodeURIComponent(meetingId)}`}
        >
          <MapPin size={18} /> 지도에서 새 장소 찾기
        </Link>
      ) : null}
      {places.length ? (
        <div className="candidate-select-list">
          {places.map((item) => {
            return (
              <div
                key={item.id}
                className={`eligible-place ${
                  item.matchCount === 0 ? "eligible-place--mismatch" : ""
                }`}
              >
                <UserPlaceRow
                  item={item}
                  selected={selectedIds.includes(item.id)}
                  onClick={() => toggle(item.id)}
                />
                <div className="match-reasons">
                  {item.purposeMatch ? <span>목적 일치 · {PURPOSE_LABELS[item.purpose]}</span> : null}
                  {item.moodMatch ? <span>성격 일치 · {MOOD_LABELS[item.mood]}</span> : null}
                  {item.matchCount === 0 ? <span className="match-reasons__mismatch">조건 불일치</span> : null}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <EmptyState
          title="저장된 내 장소가 없어요"
          description="지도에서 장소를 저장한 뒤 현재 모임 후보로 바로 추가할 수 있어요."
          action={
            <Link
              className="button button--secondary"
              to={`/map?meetingId=${encodeURIComponent(meetingId)}`}
            >
              지도에서 새 장소 찾기
            </Link>
          }
        />
      )}
      <div className="sticky-page-action">
        <PrimaryButton type="button" onClick={() => void save()}>
          {selectedIds.length ? "선택 완료" : "후보 없이 넘어가기"}
        </PrimaryButton>
      </div>
    </div>
  );
}

export function CandidateMapPage() {
  const { meetingId = "", candidateId = "" } = useParams();
  const [meeting, setMeeting] = useState<MeetingDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    void api<MeetingDetail>(`/meetings/${meetingId}`)
      .then(setMeeting)
      .catch((reason) => setError(errorMessage(reason)))
      .finally(() => setLoading(false));
  }, [meetingId]);

  if (loading) return <Loading label="후보 위치 불러오는 중" />;

  const candidate = meeting?.candidates.find((item) => item.id === candidateId);
  if (!candidate) {
    return (
      <div className="page">
        <ScreenHeader title="후보 위치" />
        <InlineError message={error || "후보 장소를 찾을 수 없습니다."} />
      </div>
    );
  }

  return (
    <div className="page page--candidate-map">
      <ScreenHeader
        title="후보 위치"
        description={meeting?.name}
        back
      />
      <InlineError message={error} />
      <MapCanvas
        places={[candidate.place]}
        selectedId={candidate.place.id}
      />
      <section className="candidate-map-detail" aria-label={`${candidate.place.name} 상세정보`}>
        <PlaceThumbnail place={candidate.place} large />
        <div className="candidate-map-detail__body">
          <span>{candidate.place.category}</span>
          <h2>{candidate.place.name}</h2>
          <p>{candidate.place.roadAddress || candidate.place.address}</p>
          <small>
            {candidate.place.station} · {candidate.place.distanceText}
          </small>
          <div className="candidate-map-detail__recommendation">
            추천한 사람 {candidate.recommendationCount}명
            {candidate.recommenderNames.length
              ? ` · ${candidate.recommenderNames.join(", ")}`
              : ""}
          </div>
        </div>
      </section>
    </div>
  );
}

export function MeetingDetailPage() {
  const { meetingId = "" } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { refreshHome, showToast } = useShell();
  const [meeting, setMeeting] = useState<MeetingDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [startOpen, setStartOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [kickMemberId, setKickMemberId] = useState("");
  const [membersExpanded, setMembersExpanded] = useState(false);

  const load = useCallback(async () => {
    try {
      setMeeting(await api<MeetingDetail>(`/meetings/${meetingId}`));
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setLoading(false);
    }
  }, [meetingId]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(timer);
  }, [load]);

  if (loading) return <Loading label="모임 정보 불러오는 중" />;
  if (!meeting) {
    return (
      <div className="page">
        <ScreenHeader title="모임" />
        <InlineError message={error} />
      </div>
    );
  }

  const isHost = meeting.role === "HOST";
  const canRepeatMeeting =
    meeting.status === "COMPLETED" || meeting.isPastDue;
  const visibleMembers = membersExpanded
    ? meeting.members
    : meeting.members.slice(0, 3);

  const copyInvite = async () => {
    const shareUrl = `${window.location.origin}/meetings/join?meetingId=${meetingId}`;
    const text = `${meeting.name}\n가입 코드: ${meeting.joinCode}\n${shareUrl}`;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      window.prompt("아래 초대 정보를 복사해 주세요.", text);
    }
    showToast("초대 링크와 코드를 복사했어요.");
  };

  const createVote = async () => {
    try {
      await api(`/meetings/${meetingId}/vote`, { method: "POST", body: "{}" });
      setStartOpen(false);
      await refreshHome();
      navigate(`/meetings/${meetingId}/vote`);
    } catch (reason) {
      setError(errorMessage(reason));
      setStartOpen(false);
    }
  };

  const leave = async () => {
    try {
      await api(`/meetings/${meetingId}/leave`, { method: "POST", body: "{}" });
      await refreshHome();
      navigate("/");
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };

  const kick = async () => {
    if (!kickMemberId) return;
    try {
      setMeeting(
        await api<MeetingDetail>(
          `/meetings/${meetingId}/members/${kickMemberId}/kick`,
          { method: "POST", body: "{}" }
        )
      );
      setKickMemberId("");
      showToast("모임원을 내보냈어요.");
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };

  const removeMeeting = async () => {
    try {
      await api(`/meetings/${meetingId}`, { method: "DELETE" });
      await refreshHome();
      navigate("/");
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };

  return (
    <div className="page page--detail">
      <ScreenHeader
        title={meeting.name}
        description={STATUS_LABELS[meeting.status]}
        action={
          isHost ? (
            <button type="button" className="icon-button" onClick={() => setMenuOpen(true)} aria-label="모임 메뉴">
              <CircleEllipsis size={22} />
            </button>
          ) : undefined
        }
      />
      <InlineError message={error} />
      <section
        className={`meeting-hero ${
          isHost ? "meeting-hero--with-invite" : ""
        }`}
      >
        <div className="meeting-hero__summary">
          <div className="meeting-hero__tags">
            <span>{PURPOSE_LABELS[meeting.purpose]}</span>
            <span>{MOOD_LABELS[meeting.mood]}</span>
          </div>
          <p><CalendarDays size={17} /> {formatMeetingAt(meeting.meetingAt)}</p>
          <p><UsersRound size={17} /> 현재 {meeting.currentMembers}/{meeting.capacity}명</p>
        </div>
        {isHost ? (
          <div className="invite-code">
            <div>
              <span>가입 코드</span>
              <strong>{meeting.joinCode}</strong>
            </div>
            <button type="button" onClick={() => void copyInvite()}>
              <Share2 size={18} /> 초대 복사
            </button>
          </div>
        ) : null}
      </section>

      <section>
        <SectionTitle
          title="후보 장소"
          count={meeting.candidates.length}
          action={
            meeting.status === "RECRUITING" ? (
              <Link
                className="section-title__link"
                to={`/meetings/${meetingId}/candidates`}
              >
                내 장소에서 가져오기
              </Link>
            ) : undefined
          }
        />
        <div
          className={`candidate-list ${
            meeting.candidates.length >= 4 ? "candidate-list--scrollable" : ""
          }`}
          aria-label="등록된 후보 장소"
        >
          {meeting.candidates.length ? (
            meeting.candidates.map((candidate) => (
              <CandidateRow
                key={candidate.id}
                candidate={candidate}
                onClick={() =>
                  navigate(
                    `/meetings/${meetingId}/candidates/${candidate.id}/map`
                  )
                }
              />
            ))
          ) : (
            <EmptyState title="아직 후보가 없어요" description="각자의 내 장소에서 최대 2곳까지 고를 수 있어요." />
          )}
        </div>
      </section>

      <section>
        <SectionTitle title="모임원" count={meeting.members.length} />
        <div className="member-list" id="meeting-members">
          {visibleMembers.map((member) => (
            <div className="member-row" key={member.id}>
              <span className="member-row__avatar">{member.meetingNickname.slice(0, 1)}</span>
              <div>
                <strong>{member.meetingNickname}</strong>
                <span>{member.role === "HOST" ? "모임장" : "모임원"}</span>
              </div>
              {isHost && member.role !== "HOST" && meeting.status === "RECRUITING" ? (
                <button type="button" onClick={() => setKickMemberId(member.id)} aria-label={`${member.meetingNickname} 내보내기`}>
                  <UserMinus size={18} />
                </button>
              ) : member.userId === user?.id ? (
                <span className="me-label">나</span>
              ) : null}
            </div>
          ))}
        </div>
        {meeting.members.length > 3 ? (
          <button
            type="button"
            className="member-toggle"
            aria-controls="meeting-members"
            aria-expanded={membersExpanded}
            onClick={() => setMembersExpanded((expanded) => !expanded)}
          >
            {membersExpanded ? "접어보기" : "펼쳐보기"}
          </button>
        ) : null}
      </section>

      <div className="detail-actions">
        {meeting.status === "RECRUITING" && isHost ? (
          <PrimaryButton
            type="button"
            disabled={meeting.candidates.length < 2}
            onClick={() => setStartOpen(true)}
          >
            <Vote size={18} />
            {meeting.candidates.length < 2 ? "2곳 이상의 후보가 필요해요" : "투표 시작"}
          </PrimaryButton>
        ) : null}
        {meeting.status === "RECRUITING" && !isHost ? (
          <SecondaryButton type="button" onClick={() => void leave()}>
            모임 탈퇴
          </SecondaryButton>
        ) : null}
        {meeting.status === "VOTING" ? (
          <>
            <PrimaryButton type="button" onClick={() => navigate(`/meetings/${meetingId}/vote`)}>
              {meeting.myVoteCompleted ? "투표 결과 보기" : "투표 이어서 하기"}
            </PrimaryButton>
            {isHost ? (
              <SecondaryButton type="button" onClick={() => navigate(`/meetings/${meetingId}/results`)}>
                투표 현황·종료
              </SecondaryButton>
            ) : null}
          </>
        ) : null}
        {meeting.status === "FINAL_SELECTION" || meeting.status === "COMPLETED" ? (
          <PrimaryButton type="button" onClick={() => navigate(`/meetings/${meetingId}/results`)}>
            결과 확인
          </PrimaryButton>
        ) : null}
      </div>

      <Modal
        open={startOpen}
        title="투표를 시작할까요?"
        description={`후보 ${meeting.candidates.length}곳이 고정되고 모든 모임원에게 투표 알림이 표시돼요.`}
        onClose={() => setStartOpen(false)}
      >
        <div className="modal-actions">
          <SecondaryButton type="button" onClick={() => setStartOpen(false)}>취소</SecondaryButton>
          <PrimaryButton type="button" onClick={() => void createVote()}>투표 생성</PrimaryButton>
        </div>
      </Modal>

      <Modal
        open={menuOpen}
        title="모임 관리"
        description="삭제는 되돌릴 수 없으므로 메뉴 안에 작게 배치했어요."
        onClose={() => setMenuOpen(false)}
      >
        <div className="modal-actions modal-actions--stack">
          <SecondaryButton
            type="button"
            onClick={() => {
              setMenuOpen(false);
              navigate(`/meetings/${meetingId}/edit`);
            }}
          >
            <Pencil size={18} /> 모임 편집
          </SecondaryButton>
          {canRepeatMeeting ? (
            <SecondaryButton
              type="button"
              onClick={() => navigate(`/meetings/${meetingId}/repeat`)}
            >
              <Plus size={18} /> 다시 만나기
            </SecondaryButton>
          ) : (
            <SecondaryButton
              type="button"
              onClick={() => navigate(`/meetings/${meetingId}/recurrence`)}
            >
              <Repeat2 size={18} /> 정기적으로 만나기
            </SecondaryButton>
          )}
          <SecondaryButton
            type="button"
            className="button--danger-text"
            onClick={() => {
              setMenuOpen(false);
              setDeleteOpen(true);
            }}
          >
            <Trash2 size={18} /> 모임 삭제
          </SecondaryButton>
        </div>
      </Modal>

      <Modal
        open={deleteOpen}
        title="모임을 정말 삭제할까요?"
        description="공유 링크와 가입 코드는 즉시 사용할 수 없게 돼요. 참여자와 투표 기록도 화면에서 사라져요."
        onClose={() => setDeleteOpen(false)}
      >
        <div className="danger-box">
          <AlertTriangle size={20} />
          <span>{meeting.name}을 삭제하면 되돌릴 수 없어요.</span>
        </div>
        <div className="modal-actions">
          <SecondaryButton type="button" onClick={() => setDeleteOpen(false)}>취소</SecondaryButton>
          <PrimaryButton type="button" className="button--danger" onClick={() => void removeMeeting()}>
            삭제
          </PrimaryButton>
        </div>
      </Modal>

      <Modal
        open={Boolean(kickMemberId)}
        title="모임원을 내보낼까요?"
        description="이 모임원이 추천한 장소도 후보에서 빠져요. 다른 추천자가 남아 있으면 후보는 유지돼요."
        onClose={() => setKickMemberId("")}
      >
        <div className="modal-actions">
          <SecondaryButton type="button" onClick={() => setKickMemberId("")}>취소</SecondaryButton>
          <PrimaryButton type="button" onClick={() => void kick()}>내보내기</PrimaryButton>
        </div>
      </Modal>
    </div>
  );
}

export function VotePage() {
  const { meetingId = "" } = useParams();
  const navigate = useNavigate();
  const { refreshHome } = useShell();
  const [meeting, setMeeting] = useState<MeetingDetail | null>(null);
  const [session, setSession] = useState<VoteSessionView | null>(null);
  const [loading, setLoading] = useState(true);
  const [choosing, setChoosing] = useState("");
  const [showCandidateIntro, setShowCandidateIntro] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const [detail, currentSession] = await Promise.all([
        api<MeetingDetail>(`/meetings/${meetingId}`),
        api<VoteSessionView>(`/meetings/${meetingId}/vote/session`)
      ]);
      setMeeting(detail);
      setSession(currentSession);
      setShowCandidateIntro(
        currentSession.status === "NOT_STARTED" &&
          localStorage.getItem(`damo.voteIntroSeen.${currentSession.sessionId}`) !==
            "true"
      );
      if (currentSession.status === "COMPLETED") {
        navigate(`/meetings/${meetingId}/results`, { replace: true });
      }
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setLoading(false);
    }
  }, [meetingId, navigate]);

  useEffect(() => {
    void load();
  }, [load]);

  const choose = async (candidate: Candidate) => {
    if (!session?.round || choosing) return;
    setChoosing(candidate.id);
    setError("");
    try {
      const next = await api<VoteSessionView>(`/meetings/${meetingId}/vote/choices`, {
        method: "POST",
        body: JSON.stringify({
          roundNumber: session.round.roundNumber,
          selectedCandidateId: candidate.id
        })
      });
      if (next.status === "COMPLETED") {
        setSession(next);
        void refreshHome();
        navigate(`/meetings/${meetingId}/results`, { replace: true });
      } else {
        setSession(next);
        setChoosing("");
      }
    } catch (reason) {
      setError(errorMessage(reason));
      setChoosing("");
    }
  };

  if (loading) return <Loading label="투표 불러오는 중" />;
  if (!session?.round || !meeting) {
    return (
      <div className="page">
        <ScreenHeader title="투표" />
        <InlineError message={error || "진행할 투표가 없습니다."} />
      </div>
    );
  }

  const { round } = session;
  const progress = (round.completedRounds / round.totalRounds) * 100;

  if (showCandidateIntro) {
    return (
      <div className="page page--vote-intro">
        <ScreenHeader
          title={meeting.name}
          description={`투표할 후보 ${meeting.candidates.length}곳을 먼저 확인해 보세요.`}
        />
        <div className="vote-intro-heading">
          <div>
            <span>전체 후보</span>
            <strong>{meeting.candidates.length}</strong>
          </div>
          <p>선택한 장소는 다음 후보와 계속 비교돼요.</p>
        </div>
        <div
          className={`candidate-list vote-candidate-overview ${
            meeting.candidates.length >= 4 ? "candidate-list--scrollable" : ""
          }`}
        >
          {meeting.candidates.map((candidate) => (
            <CandidateRow
              key={candidate.id}
              candidate={candidate}
              onClick={() =>
                navigate(
                  `/meetings/${meetingId}/candidates/${candidate.id}/map`
                )
              }
            />
          ))}
        </div>
        <div className="sticky-page-action">
          <PrimaryButton
            type="button"
            onClick={() => {
              localStorage.setItem(
                `damo.voteIntroSeen.${session.sessionId}`,
                "true"
              );
              setShowCandidateIntro(false);
            }}
          >
            A/B 투표 시작
          </PrimaryButton>
        </div>
      </div>
    );
  }

  return (
    <div className="page page--vote">
      <ScreenHeader title={meeting.name} description="더 마음에 드는 장소를 골라주세요." />
      <div className="vote-progress">
        <div><span style={{ width: `${progress}%` }} /></div>
        <strong>{round.roundNumber} / {round.totalRounds}</strong>
      </div>
      <InlineError message={error} />
      <MapCanvas
        compact
        places={[round.candidateA.place, round.candidateB.place]}
        selectedId={choosing ? (choosing === round.candidateA.id ? round.candidateA.place.id : round.candidateB.place.id) : undefined}
      />
      <div className="versus-label"><span>A</span><b>둘 중 어디가 좋나요?</b><span>B</span></div>
      <div className="vote-choice-list">
        {[round.candidateA, round.candidateB].map((candidate, index) => (
          <button
            type="button"
            key={candidate.id}
            className={`vote-choice ${choosing === candidate.id ? "is-selected" : ""} ${
              choosing && choosing !== candidate.id ? "is-muted" : ""
            }`}
            onClick={() => void choose(candidate)}
            disabled={Boolean(choosing)}
          >
            <span className="vote-choice__letter">{index === 0 ? "A" : "B"}</span>
            <PlaceThumbnail place={candidate.place} large />
            <div>
              <h2>{candidate.place.name}</h2>
              <p>{candidate.place.category}</p>
              <small>{candidate.place.roadAddress}</small>
              <span className="recommend-count">추천한 사람 {candidate.recommendationCount}명</span>
            </div>
            <Check className="vote-choice__check" size={22} />
          </button>
        ))}
      </div>
      <p className="vote-helper">
        선택된 장소는 다음 후보와 계속 비교돼요. 브라우저를 닫아도 다음 라운드부터 이어집니다.
      </p>
    </div>
  );
}

export function ResultsPage() {
  const { meetingId = "" } = useParams();
  const navigate = useNavigate();
  const { refreshHome, showToast } = useShell();
  const [meeting, setMeeting] = useState<MeetingDetail | null>(null);
  const [results, setResults] = useState<VoteResults | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [forceCloseOpen, setForceCloseOpen] = useState(false);
  const [closing, setClosing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [detail, voteResults] = await Promise.all([
        api<MeetingDetail>(`/meetings/${meetingId}`),
        api<VoteResults>(`/meetings/${meetingId}/vote/results`)
      ]);
      setMeeting(detail);
      setResults(voteResults);
      setError("");
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setLoading(false);
    }
  }, [meetingId]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(timer);
  }, [load]);

  const closeVote = async (force: boolean) => {
    setClosing(true);
    try {
      const next = await api<VoteResults>(`/meetings/${meetingId}/vote/close`, {
        method: "POST",
        body: JSON.stringify({ force })
      });
      setResults(next);
      setForceCloseOpen(false);
      await Promise.all([load(), refreshHome()]);
      showToast(
        next.meetingStatus === "COMPLETED"
          ? "1위 장소가 최종 확정됐어요."
          : "공동 1위 중 최종 장소를 선택해 주세요."
      );
    } catch (reason) {
      if (reason instanceof ApiError && reason.code === "VOTE_HAS_INCOMPLETE_MEMBERS") {
        setForceCloseOpen(true);
      } else {
        setError(errorMessage(reason));
      }
    } finally {
      setClosing(false);
    }
  };

  const finalSelect = async (candidateId: string) => {
    try {
      const next = await api<VoteResults>(
        `/meetings/${meetingId}/vote/final-selection`,
        { method: "POST", body: JSON.stringify({ candidateId }) }
      );
      setResults(next);
      await Promise.all([load(), refreshHome()]);
      showToast("최종 장소를 확정했어요.");
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };

  if (loading) return <Loading label="실시간 결과 집계 중" />;
  if (!meeting || !results) {
    return (
      <div className="page">
        <ScreenHeader title="투표 결과" />
        <InlineError message={error} />
      </div>
    );
  }

  const isHost = meeting.role === "HOST";
  const canSeeScores = results.myVoteCompleted || results.voteStatus !== "OPEN";
  const finalResult = results.results.find((item) => item.isFinal);
  const highestVoteCount = Math.max(
    1,
    ...results.results.map((item) => item.voteCount)
  );

  return (
    <div className="page page--results">
      <ScreenHeader title="투표 결과" description={meeting.name} />
      <InlineError message={error} />

      {finalResult ? (
        <section className="winner-card">
          <span><Trophy size={22} /> 최종 장소</span>
          <PlaceThumbnail place={finalResult.candidate.place} large />
          <h2>{finalResult.candidate.place.name}</h2>
          <p>{finalResult.candidate.place.roadAddress}</p>
          <strong>{finalResult.voteCount}표 · 추천 {finalResult.recommendationCount}명</strong>
        </section>
      ) : (
        <section className="result-status-card">
          <div className="result-status-card__ring">
            <strong className="result-status-card__completed">
              {results.completedMembers}
            </strong>
            <span className="result-status-card__capacity">
              /
              <strong>{results.totalMembers}</strong>
              <small>명</small>
            </span>
          </div>
          <div>
            <span
              className={`eyebrow ${
                results.voteStatus === "OPEN" ? "eyebrow--live" : ""
              }`}
            >
              {results.voteStatus === "OPEN" ? "실시간 참여 현황" : "집계 완료"}
            </span>
            <h2>
              {results.incompleteMembers
                ? `${results.incompleteMembers}명이 아직 선택 중이에요`
                : "모두 투표를 마쳤어요"}
            </h2>
            <p>결과는 5초마다 자동으로 갱신돼요.</p>
          </div>
        </section>
      )}

      {!canSeeScores ? (
        <section className="scores-locked">
          <Vote size={24} />
          <h2>내 투표를 마치면 득표수가 보여요</h2>
          <p>다른 사람의 선택에 영향을 받지 않도록 결과를 잠시 가렸어요.</p>
          <PrimaryButton type="button" onClick={() => navigate(`/meetings/${meetingId}/vote`)}>
            내 투표 이어서 하기
          </PrimaryButton>
        </section>
      ) : finalResult && results.results.length === 1 ? null : (
        <section>
          <SectionTitle
            title={
              finalResult
                ? "다른 후보"
                : results.voteStatus === "OPEN"
                  ? "현재 순위"
                  : "최종 순위"
            }
            action={
              results.voteStatus === "OPEN" ? (
                <button className="refresh-button" type="button" onClick={() => void load()}>
                  <RotateCcw size={16} /> 새로고침
                </button>
              ) : undefined
            }
          />
          <div className="ranking-list">
            {finalResult
              ? results.results
                  .filter((item) => !item.isFinal)
                  .map((item) => (
                    <div className="compact-result-row" key={item.candidate.id}>
                      <div className="compact-result-row__heading">
                        <span>{item.isJointRank ? "공동 " : ""}{item.rank}위</span>
                        <strong>{item.candidate.place.name}</strong>
                        <em>{item.voteCount}표</em>
                      </div>
                      <div
                        className="compact-result-row__track"
                        aria-label={`${item.candidate.place.name} ${item.voteCount}표`}
                      >
                        <span
                          style={{
                            width: `${Math.max(
                              item.voteCount > 0 ? 8 : 0,
                              (item.voteCount / highestVoteCount) * 100
                            )}%`
                          }}
                        />
                      </div>
                    </div>
                  ))
              : results.results.map((item) => (
                  <div
                    className={`ranking-row ${item.rank === 1 ? "ranking-row--first" : ""}`}
                    key={item.candidate.id}
                  >
                    <span className="ranking-row__rank">
                      {item.isJointRank ? "공동 " : ""}{item.rank}위
                    </span>
                    <CandidateRow candidate={item.candidate} showVotes={item.voteCount} />
                    {meeting.status === "FINAL_SELECTION" &&
                    isHost &&
                    results.tiedFirstCandidateIds.includes(item.candidate.id) ? (
                      <PrimaryButton type="button" onClick={() => void finalSelect(item.candidate.id)}>
                        이 장소로 확정
                      </PrimaryButton>
                    ) : null}
                  </div>
                ))}
          </div>
        </section>
      )}

      {meeting.status === "COMPLETED" ? (
        <div className="result-navigation">
          <Link to="/" className="button button--secondary">홈으로</Link>
          <Link
            to={`/meetings/${meetingId}`}
            className="button button--primary"
          >
            모임으로
          </Link>
        </div>
      ) : null}

      {isHost && results.voteStatus === "OPEN" ? (
        <div className="sticky-page-action">
          <PrimaryButton
            type="button"
            disabled={closing}
            onClick={() => void closeVote(false)}
          >
            {closing ? "확인 중…" : "투표 종료"}
          </PrimaryButton>
        </div>
      ) : null}

      <Modal
        open={forceCloseOpen}
        title="아직 투표를 완료하지 않은 인원이 있어요"
        description={`현재 ${results.incompleteMembers}명이 미완료 상태예요. 저장된 선택까지만 집계하고 종료할까요?`}
        onClose={() => setForceCloseOpen(false)}
      >
        <div className="modal-actions modal-actions--stack">
          <SecondaryButton type="button" onClick={() => setForceCloseOpen(false)}>
            기다릴게요
          </SecondaryButton>
          <PrimaryButton type="button" onClick={() => void closeVote(true)}>
            그래도 종료
          </PrimaryButton>
        </div>
      </Modal>
    </div>
  );
}

export function NotFoundPage() {
  return (
    <div className="center-page">
      <Logo />
      <h1>페이지를 찾을 수 없어요</h1>
      <p>링크가 만료됐거나 주소가 변경됐을 수 있어요.</p>
      <Link className="button button--primary" to="/">홈으로 이동</Link>
    </div>
  );
}
