import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleUserRound,
  Home,
  Map,
  MapPin,
  Plus,
  Repeat2,
  Search,
  Sparkles,
  UsersRound,
  X
} from "lucide-react";
import {
  type ButtonHTMLAttributes,
  type PropsWithChildren,
  useEffect,
  useId,
  useRef,
  useState
} from "react";
import { Link, NavLink, useNavigate } from "react-router-dom";
import type {
  Candidate,
  MeetingSummary,
  Mood,
  Place,
  Purpose,
  RecurrenceType,
  UserPlace
} from "@damo/contracts";
import {
  MOOD_LABELS,
  PURPOSE_LABELS,
  STATUS_LABELS
} from "@damo/contracts";

const RECURRENCE_SUMMARY_LABELS: Record<RecurrenceType, string> = {
  WEEKLY: "매주 만나요",
  MONTHLY: "매달 만나요",
  CUSTOM: "정기 모임이에요"
};

export const formatMeetingAt = (value: string) =>
  new Intl.DateTimeFormat("ko-KR", {
    month: "long",
    day: "numeric",
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true
  }).format(new Date(value));

export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <Link to="/" className={`logo ${compact ? "logo--compact" : ""}`} aria-label="DAMO 홈">
      <span className="logo__mark" aria-hidden="true">
        <span />
        <span />
      </span>
      <span className="logo__word">DAMO</span>
    </Link>
  );
}

export function ScreenHeader({
  title,
  description,
  back = true,
  action
}: {
  title: string;
  description?: string;
  back?: boolean;
  action?: React.ReactNode;
}) {
  const navigate = useNavigate();
  return (
    <header className="screen-header">
      <div className="screen-header__row">
        {back ? (
          <button
            className="icon-button"
            type="button"
            onClick={() => navigate(-1)}
            aria-label="뒤로 가기"
          >
            <ArrowLeft size={22} strokeWidth={2.25} />
          </button>
        ) : (
          <Logo compact />
        )}
        <div className="screen-header__copy">
          <h1>{title}</h1>
          {description ? <p>{description}</p> : null}
        </div>
        <div className="screen-header__action">{action}</div>
      </div>
    </header>
  );
}

export function BottomNav({ hasVoteAlert }: { hasVoteAlert: boolean }) {
  return (
    <nav className="bottom-nav" aria-label="주요 메뉴">
      <NavLink to="/" end>
        <span className="bottom-nav__icon">
          <Home size={23} />
          {hasVoteAlert ? <i className="notification-dot" aria-label="새 투표 있음" /> : null}
        </span>
        <span>홈</span>
      </NavLink>
      <NavLink to="/map">
        <Map size={23} />
        <span>지도</span>
      </NavLink>
      <NavLink to="/places">
        <MapPin size={23} />
        <span>내 장소</span>
      </NavLink>
    </nav>
  );
}

export function Loading({ label = "불러오는 중" }: { label?: string }) {
  return (
    <div className="loading" role="status">
      <span className="loading__spinner" />
      <span>{label}</span>
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-state__icon">
        <MapPin size={24} />
      </span>
      <strong>{title}</strong>
      <p>{description}</p>
      {action}
    </div>
  );
}

export function Modal({
  open,
  title,
  description,
  children,
  onClose
}: PropsWithChildren<{
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
}>) {
  const titleId = useId();
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, open]);
  if (!open) return null;
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="modal-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-sheet__grab" />
        <button className="modal-sheet__close" type="button" onClick={onClose} aria-label="닫기">
          <X size={20} />
        </button>
        <h2 id={titleId}>{title}</h2>
        {description ? <p className="modal-sheet__description">{description}</p> : null}
        {children}
      </section>
    </div>
  );
}

export function Toast({
  message,
  onDone
}: {
  message: string;
  onDone: () => void;
}) {
  useEffect(() => {
    const timer = window.setTimeout(onDone, 2600);
    return () => window.clearTimeout(timer);
  }, [onDone]);
  return (
    <div className="toast" role="status">
      <Check size={18} />
      {message}
    </div>
  );
}

export function ChipGroup<T extends string>({
  label,
  values,
  labels,
  value,
  onChange
}: {
  label: string;
  values: readonly T[];
  labels: Record<T, string>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className="chip-field">
      <legend>{label}</legend>
      <div className="chip-group">
        {values.map((item) => (
          <button
            key={item}
            type="button"
            className={value === item ? "is-selected" : ""}
            aria-pressed={value === item}
            onClick={() => onChange(item)}
          >
            {labels[item]}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

export function PurposeMoodFields({
  purpose,
  mood,
  onPurpose,
  onMood
}: {
  purpose: Purpose;
  mood: Mood;
  onPurpose: (value: Purpose) => void;
  onMood: (value: Mood) => void;
}) {
  return (
    <>
      <ChipGroup
        label="목적"
        values={["STUDY", "CAFE", "MEAL", "DRINK"] as const}
        labels={PURPOSE_LABELS}
        value={purpose}
        onChange={onPurpose}
      />
      <ChipGroup
        label="성격"
        values={["FUN", "QUIET", "BUSINESS", "TIPSY"] as const}
        labels={MOOD_LABELS}
        value={mood}
        onChange={onMood}
      />
    </>
  );
}

export function PrimaryButton({
  children,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button className={`button button--primary ${className}`} {...props}>
      {children}
    </button>
  );
}

export function SecondaryButton({
  children,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button className={`button button--secondary ${className}`} {...props}>
      {children}
    </button>
  );
}

export function PlaceThumbnail({ place, large = false }: { place: Place; large?: boolean }) {
  return (
    <span className={`place-thumbnail ${large ? "place-thumbnail--large" : ""}`}>
      {place.imageUrl ? <img src={place.imageUrl} alt="" /> : <MapPin size={22} />}
    </span>
  );
}

export function PlaceMeta({ place }: { place: Place }) {
  return (
    <div className="place-meta">
      <strong>{place.name}</strong>
      <span>{place.category}</span>
      <small>
        {place.station} · {place.distanceText}
      </small>
    </div>
  );
}

export function CandidateRow({
  candidate,
  selected,
  onClick,
  showVotes
}: {
  candidate: Candidate;
  selected?: boolean;
  onClick?: () => void;
  showVotes?: number;
}) {
  const content = (
    <>
      <PlaceThumbnail place={candidate.place} />
      <PlaceMeta place={candidate.place} />
      <div className="candidate-row__side">
        {showVotes !== undefined ? <strong>{showVotes}표</strong> : null}
        <span>추천 {candidate.recommendationCount}명</span>
        {selected ? <Check size={18} /> : onClick ? <ChevronRight size={18} /> : null}
      </div>
    </>
  );
  return onClick ? (
    <button
      type="button"
      className={`candidate-row ${selected ? "is-selected" : ""}`}
      onClick={onClick}
      aria-pressed={selected}
    >
      {content}
    </button>
  ) : (
    <div className="candidate-row">{content}</div>
  );
}

export function UserPlaceRow({
  item,
  selected,
  onClick
}: {
  item: UserPlace;
  selected?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      className={`candidate-row ${selected ? "is-selected" : ""}`}
      onClick={onClick}
      aria-pressed={selected}
    >
      <PlaceThumbnail place={item.place} />
      <div className="place-meta">
        <strong>{item.place.name}</strong>
        <span>
          {PURPOSE_LABELS[item.purpose]} · {MOOD_LABELS[item.mood]}
        </span>
        <small>{item.place.roadAddress}</small>
      </div>
      <div className="candidate-row__side">
        {selected ? <Check size={18} /> : <ChevronRight size={18} />}
      </div>
    </button>
  );
}

export function MeetingCard({ meeting }: { meeting: MeetingSummary }) {
  const target =
    meeting.status === "VOTING"
      ? meeting.myVoteCompleted
        ? `/meetings/${meeting.id}/results`
        : `/meetings/${meeting.id}/vote`
      : meeting.status === "FINAL_SELECTION" || meeting.status === "COMPLETED"
        ? `/meetings/${meeting.id}/results`
        : `/meetings/${meeting.id}`;
  return (
    <Link
      to={target}
      className={`meeting-card meeting-card--${meeting.status.toLowerCase()} ${
        meeting.voteAlert ? "meeting-card--alert" : ""
      } ${meeting.isPastDue && meeting.status !== "COMPLETED" ? "meeting-card--past-due" : ""}`}
    >
      <div className="meeting-card__top">
        <div>
          <span className="eyebrow">
            {meeting.role === "HOST" ? "내가 만든 모임" : "참여 중인 모임"}
          </span>
          <h3>{meeting.name}</h3>
        </div>
        <ChevronRight size={20} />
      </div>
      <div className="meeting-card__tags">
        <span>{PURPOSE_LABELS[meeting.purpose]}</span>
        <span>{MOOD_LABELS[meeting.mood]}</span>
        <span className={meeting.status === "VOTING" ? "tag--pink" : ""}>
          {meeting.isPastDue && meeting.status !== "COMPLETED"
            ? "일정 지남"
            : STATUS_LABELS[meeting.status]}
        </span>
      </div>
      <p className="meeting-card__date">{formatMeetingAt(meeting.meetingAt)}</p>
      <div className="meeting-card__bottom">
        <span>
          <UsersRound size={16} />
          {meeting.currentMembers}/{meeting.capacity}명
        </span>
        {meeting.finalPlace ? (
          <strong>
            <MapPin size={16} />
            {meeting.finalPlace.name}
          </strong>
        ) : (
          <strong>{meeting.role === "HOST" ? "모임장" : "모임원"}</strong>
        )}
      </div>
      {meeting.recurrence ? (
        <p className="meeting-card__recurrence">
          <Repeat2 size={14} />
          {RECURRENCE_SUMMARY_LABELS[meeting.recurrence.type]}
        </p>
      ) : null}
    </Link>
  );
}

type NaverWindow = Window & {
  naver?: {
    maps: {
      Map: new (element: HTMLElement, options: Record<string, unknown>) => unknown;
      LatLng: new (lat: number, lng: number) => unknown;
      Marker: new (options: Record<string, unknown>) => unknown;
      InfoWindow: new (options: Record<string, unknown>) => {
        close: () => void;
        open: (map: unknown, anchor: unknown) => void;
        setContent: (content: string) => void;
      };
      Event: { addListener: (target: unknown, event: string, callback: () => void) => void };
    };
  };
};

const escapeMapText = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      })[character] ?? character
  );

const mapInfoContent = (place: Place) => `
  <article class="naver-info-window">
    <strong>${escapeMapText(place.name)}</strong>
    <span>${escapeMapText(place.category)}</span>
    <p>${escapeMapText(place.roadAddress || place.address)}</p>
    <small>아래에서 상세정보와 저장 여부를 확인하세요.</small>
  </article>
`;

export function MapCanvas({
  places,
  selectedId,
  onSelect,
  compact = false
}: {
  places: Place[];
  selectedId?: string;
  onSelect?: (place: Place) => void;
  compact?: boolean;
}) {
  const mapRef = useRef<HTMLDivElement>(null);
  const [mapLoadFailed, setMapLoadFailed] = useState(false);
  const clientId = import.meta.env.VITE_NAVER_MAP_CLIENT_ID as string | undefined;

  useEffect(() => {
    if (!clientId || !mapRef.current || places.length === 0) return;
    let cancelled = false;
    const renderMap = () => {
      if (cancelled || !mapRef.current) return;
      const naver = (window as NaverWindow).naver;
      if (!naver) {
        setMapLoadFailed(true);
        return;
      }
      try {
        const center =
          places.find((place) => place.id === selectedId) ?? places[0]!;
        const map = new naver.maps.Map(mapRef.current, {
          center: new naver.maps.LatLng(center.latitude, center.longitude),
          zoom: 14
        });
        const infoWindow = new naver.maps.InfoWindow({
          content: mapInfoContent(center),
          borderWidth: 0,
          backgroundColor: "transparent",
          disableAnchor: true,
          maxWidth: 240
        });
        let selectedMarker: unknown;
        for (const place of places) {
          const marker = new naver.maps.Marker({
            map,
            position: new naver.maps.LatLng(place.latitude, place.longitude),
            title: place.name,
            zIndex: selectedId === place.id ? 100 : 1
          });
          if (selectedId === place.id) selectedMarker = marker;
          naver.maps.Event.addListener(marker, "click", () => {
            infoWindow.setContent(mapInfoContent(place));
            infoWindow.open(map, marker);
            onSelect?.(place);
          });
        }
        if (selectedMarker) infoWindow.open(map, selectedMarker);
        naver.maps.Event.addListener(map, "click", () => infoWindow.close());
        setMapLoadFailed(false);
      } catch {
        setMapLoadFailed(true);
      }
    };
    const handleScriptError = () => {
      if (!cancelled) setMapLoadFailed(true);
    };
    const existing = document.querySelector<HTMLScriptElement>(
      "script[data-damo-naver-map]"
    );
    if (existing) {
      if ((window as NaverWindow).naver) renderMap();
      else existing.addEventListener("load", renderMap, { once: true });
      existing.addEventListener("error", handleScriptError, { once: true });
      return () => {
        cancelled = true;
        existing.removeEventListener("error", handleScriptError);
      };
    }
    const script = document.createElement("script");
    script.dataset.damoNaverMap = "true";
    script.src = `https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=${clientId}`;
    script.async = true;
    script.addEventListener("load", renderMap, { once: true });
    script.addEventListener("error", handleScriptError, { once: true });
    document.head.append(script);
    return () => {
      cancelled = true;
      script.removeEventListener("error", handleScriptError);
    };
  }, [clientId, onSelect, places, selectedId]);

  if (clientId && !mapLoadFailed) {
    return <div className={`map-canvas ${compact ? "map-canvas--compact" : ""}`} ref={mapRef} />;
  }

  const lats = places.map((place) => place.latitude);
  const lngs = places.map((place) => place.longitude);
  const minLat = Math.min(...lats, 37.54);
  const maxLat = Math.max(...lats, 37.56);
  const minLng = Math.min(...lngs, 127.04);
  const maxLng = Math.max(...lngs, 127.07);
  return (
    <div className={`map-canvas map-canvas--mock ${compact ? "map-canvas--compact" : ""}`}>
      <span className="map-canvas__road map-canvas__road--a" />
      <span className="map-canvas__road map-canvas__road--b" />
      <span className="map-canvas__road map-canvas__road--c" />
      <span className="map-canvas__station">
        <span />
        성수역
      </span>
      <span className="map-canvas__mode">
        {clientId && mapLoadFailed ? "지도 연결 실패 · 목 지도" : "목 지도"}
      </span>
      {places.map((place, index) => {
        const left =
          12 + ((place.longitude - minLng) / Math.max(maxLng - minLng, 0.001)) * 72;
        const top =
          15 + (1 - (place.latitude - minLat) / Math.max(maxLat - minLat, 0.001)) * 66;
        return (
          <button
            key={place.id}
            type="button"
            className={`map-pin ${selectedId === place.id ? "is-selected" : ""}`}
            style={{ left: `${left}%`, top: `${top}%` }}
            onClick={() => onSelect?.(place)}
            aria-label={`${place.name} 선택`}
          >
            <MapPin size={selectedId === place.id ? 24 : 20} fill="currentColor" />
            {!compact && selectedId === place.id ? <span>{place.name}</span> : null}
            {!compact && !selectedId && index === 0 ? <span>{place.name}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

export function SearchInput({
  value,
  onChange,
  onSubmit,
  suggestions = [],
  suggestionsOpen = false,
  suggestionsLoading = false,
  suggestionsError = false,
  onSuggestionsOpenChange,
  onSuggestionSelect,
  placeholder = "역 이름 또는 장소 검색"
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  suggestions?: Place[];
  suggestionsOpen?: boolean;
  suggestionsLoading?: boolean;
  suggestionsError?: boolean;
  onSuggestionsOpenChange?: (open: boolean) => void;
  onSuggestionSelect?: (place: Place) => void;
  placeholder?: string;
}) {
  const suggestionsId = useId();
  return (
    <div
      className="search-combobox"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          onSuggestionsOpenChange?.(false);
        }
      }}
    >
      <form
        className="search-input"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          onSuggestionsOpenChange?.(false);
          onSubmit();
        }}
      >
        <Search size={20} />
        <input
          value={value}
          onChange={(event) => {
            onChange(event.target.value);
            onSuggestionsOpenChange?.(true);
          }}
          onFocus={() => onSuggestionsOpenChange?.(true)}
          placeholder={placeholder}
          aria-label={placeholder}
          aria-autocomplete="list"
          aria-controls={suggestionsId}
          aria-expanded={suggestionsOpen}
          role="combobox"
        />
        <button type="submit">검색</button>
      </form>
      {suggestionsOpen && value.trim().length >= 2 ? (
        <div className="search-suggestions" id={suggestionsId} role="listbox">
          {suggestionsLoading ? (
            <p className="search-suggestions__status">장소를 찾고 있어요.</p>
          ) : suggestionsError ? (
            <p className="search-suggestions__status">미리보기를 불러오지 못했어요.</p>
          ) : suggestions.length ? (
            suggestions.map((place) => (
              <button
                key={place.id}
                type="button"
                role="option"
                aria-selected={false}
                onClick={() => onSuggestionSelect?.(place)}
              >
                <MapPin size={17} />
                <span>
                  <strong>{place.name}</strong>
                  <small>{place.category} · {place.roadAddress || place.address}</small>
                </span>
              </button>
            ))
          ) : (
            <p className="search-suggestions__status">일치하는 장소가 없어요.</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function SummaryBanner({
  title,
  description,
  alert = false
}: {
  title: string;
  description: string;
  alert?: boolean;
}) {
  const [expanded, setExpanded] = useState(true);
  return (
    <button
      type="button"
      className={`summary-banner${alert ? " summary-banner--alert" : ""}${
        expanded ? "" : " summary-banner--collapsed"
      }`}
      onClick={() => setExpanded((current) => !current)}
      aria-expanded={expanded}
    >
      <span>
        <Sparkles size={20} />
      </span>
      <div>
        <strong>{title}</strong>
        {expanded ? <p>{description}</p> : null}
      </div>
      <span className="summary-banner__chevron" aria-hidden="true">
        {expanded ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
      </span>
    </button>
  );
}

export function ProfileButton({ nickname }: { nickname: string }) {
  return (
    <span className="profile-button" aria-label={`${nickname} 계정`}>
      <CircleUserRound size={22} />
      <span title={nickname}>{nickname}</span>
    </span>
  );
}

export function FloatingCreateButton({ to, label }: { to: string; label: string }) {
  return (
    <Link to={to} className="floating-mini-button">
      <Plus size={18} />
      {label}
    </Link>
  );
}
