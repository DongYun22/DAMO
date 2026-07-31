# DAMO Supabase 데이터베이스

## 1. 구성

DAMO의 React 웹앱은 기존 Express API만 호출한다. Express API가 `DATABASE_URL`을 이용해 Supabase PostgreSQL에 연결한다.

- 프론트엔드에는 데이터베이스 비밀번호나 Supabase Secret Key를 전달하지 않는다.
- Supabase Data API를 사용하지 않으며 모든 데이터 변경은 DAMO API를 통한다.
- 공개 스키마의 DAMO 테이블에는 RLS를 활성화하고 `anon`, `authenticated` 역할의 직접 접근 권한을 제거한다.
- 모임과 관련된 쓰기 작업은 모임별 advisory lock(`pg_advisory_xact_lock(hashtext('meeting:' || meetingId))`)으로 직렬화한다. 서로 다른 모임의 쓰기는 서로 막지 않는다.
- 중요한 데이터 변경은 PostgreSQL 트랜잭션 안에서 처리한다.

## 2. 환경변수

로컬 `apps/mock-api/.env.local`과 Render 환경변수에 다음 값을 등록한다.

```env
DATABASE_URL=postgresql://...
```

이 값은 Supabase `Connect → Direct → Connection string → Session pooler`에서 발급받는다. 비밀번호가 포함되므로 Git과 문서에 실제 값을 기록하지 않는다.

## 3. 명령어

최초 설정:

```bash
pnpm db:setup
```

마이그레이션만 적용:

```bash
pnpm db:migrate
```

데이터베이스가 비어 있을 때만 샘플 데이터 입력:

```bash
pnpm db:seed
```

Render는 시작할 때 마이그레이션과 조건부 시드를 실행한 뒤 API 서버를 시작한다.

## 4. 테이블

- `users`, `auth_sessions`
- `places`, `user_places`
- `meetings`, `meeting_members`
- `meeting_candidates`, `candidate_recommendations`
- `votes`, `vote_sessions`, `vote_choices`
- `damo_schema_migrations`

초기 스키마는 `apps/mock-api/migrations/0001_initial.sql`에서 관리한다. Dashboard에서 직접 테이블 구조를 변경하지 않고 새 마이그레이션 파일을 추가한다.

## 5. 개발과 테스트

- `DATABASE_URL`이 있으면 API는 PostgreSQL 저장소를 사용한다.
- `DATABASE_URL`이 없거나 `DAMO_STORAGE=memory`이면 메모리 저장소를 사용한다.
- 자동 테스트는 실제 Supabase 데이터를 변경하지 않도록 항상 메모리 저장소를 사용한다.
- PostgreSQL 환경에서는 `/api/v1/__mock/reset`을 기본적으로 차단한다.
