# DAMO 로컬 개발 가이드

DAMO 프로토타입은 모바일 웹 프론트엔드와 Express API 서버로 구성됩니다. Supabase 연결 정보가 있으면 PostgreSQL에 영구 저장하고, 연결 정보가 없으면 임시 메모리 저장소로 실행됩니다.

## 1. 준비 사항

- Node.js 20.12 이상
- pnpm 11 이상

프로젝트 루트에서 의존성을 설치합니다.

```bash
pnpm install
```

## 2. 실행

프론트엔드와 목 API를 함께 실행합니다.

```bash
pnpm db:setup
pnpm dev
```

`pnpm db:setup`은 처음 한 번 실행해 마이그레이션을 적용하고, 데이터베이스가 비어 있을 때만 샘플 데이터를 입력합니다.

기본 접속 주소는 다음과 같습니다.

- 모바일 웹: `http://127.0.0.1:5173`
- 목 API: `http://127.0.0.1:4010`
- API 상태 확인: `http://127.0.0.1:4010/health`

5173 포트를 이미 다른 프로그램이 사용 중이면 Vite가 5174 같은 다음 포트를 자동으로 선택합니다. 터미널에 표시된 `Local` 주소로 접속하면 됩니다.

## 3. 테스트 계정

로그인 화면에서 다음 계정을 바로 사용할 수 있습니다.

| 아이디 | 비밀번호 | 닉네임 |
| --- | --- | --- |
| `damo` | `1234` | 가은 |
| `minsu` | `1234` | 민수 |
| `jiyun` | `1234` | 지윤 |

카카오, 네이버, 구글 버튼도 프로토타입용 OAuth 흐름으로 동작합니다. 실제 제공자 인증이나 계정 통합은 아직 연결하지 않았습니다.

## 4. 지도 설정

지도 키를 설정하지 않으면 샘플 장소가 표시되는 로컬 목 지도를 사용합니다. 따라서 기본 기능 확인에는 별도 토큰이 필요하지 않습니다.

실제 네이버 지도와 장소 검색에는 용도가 다른 두 애플리케이션의 인증 정보가 필요합니다.

1. 네이버 클라우드 플랫폼 Maps Application에서 `Dynamic Map`을 선택하고 Client ID를 발급합니다.
2. `apps/web/.env.example`을 `apps/web/.env.local`로 복사해 지도 Client ID를 입력합니다.

   ```env
   VITE_API_URL=/api/v1
   VITE_NAVER_MAP_CLIENT_ID=네이버_클라우드_지도_Client_ID
   ```

3. 네이버 Developers에서 애플리케이션을 만들고 `검색` API 사용 권한을 추가합니다.
4. `apps/mock-api/.env.example`을 `apps/mock-api/.env.local`로 복사해 검색 API 인증 정보를 입력합니다.

   ```env
   NAVER_SEARCH_CLIENT_ID=네이버_검색_API_Client_ID
   NAVER_SEARCH_CLIENT_SECRET=네이버_검색_API_Client_Secret
   ```

`VITE_NAVER_MAP_CLIENT_ID`는 브라우저에서 지도를 그리는 공개용 식별자입니다. `NAVER_SEARCH_CLIENT_SECRET`은 서버에서만 사용되며 `VITE_` 접두사를 붙이거나 프론트엔드 파일에 입력하면 안 됩니다. 환경변수를 바꾼 뒤에는 개발 서버를 다시 시작해야 합니다.

지도 화면에서 검색하면 서버가 네이버 지역 검색 API의 결과를 최대 5개 받아 지도 마커로 표시합니다. 결과를 선택해 목적과 성격을 저장하면 즉시 `내 장소` 화면에 반영됩니다. 검색 API 키가 없으면 기존 샘플 장소 검색으로 자동 전환됩니다.

## 5. 샘플 데이터

Supabase PostgreSQL을 사용하면 서버를 재시작해도 데이터가 유지됩니다. `pnpm db:seed`는 사용자 데이터가 하나도 없을 때만 샘플 데이터를 입력합니다.

메모리 저장소를 사용할 때는 서버를 재시작하거나 아래 요청을 보내면 최초 샘플 상태로 돌아갑니다.

```bash
curl -X POST http://127.0.0.1:4010/api/v1/__mock/reset
```

초기 샘플에는 후보 선택 중인 모임, 투표 중인 모임, 완료된 모임이 각각 포함되어 있습니다. 가입 화면을 확인할 때는 코드 `4821`을 사용할 수 있습니다.

PostgreSQL 환경에서는 데이터 유실을 방지하기 위해 `/api/v1/__mock/reset` 경로를 기본적으로 차단합니다.

## 6. 검사 명령

```bash
pnpm typecheck
pnpm test:api
pnpm build
```

- `typecheck`: 프론트엔드, 목 API, 공용 타입 검사
- `test:api`: 홈 조회, 모임 생성, N-1회 투표와 알림 해제를 포함한 API 테스트
- `build`: 배포용 프론트엔드와 서버 코드 빌드

## 7. Postgres 통합 테스트용 데이터베이스

`apps/mock-api/src/postgres-store.test.ts`는 실제 Postgres에 대해 도는 통합 테스트다. Render/프로덕션이 쓰는 `DATABASE_URL`과는 별개로, 테스트 전용 DB를 `TEST_DATABASE_URL`로 등록한다.

**로컬 Postgres 사용 (권장, 계정 제한 없음):**

```bash
brew install postgresql@16
brew services start postgresql@16
export PATH="/opt/homebrew/opt/postgresql@16/bin:$PATH"  # postgresql@16 is keg-only, not linked onto PATH by default
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

```bash
DATABASE_URL="$TEST_DATABASE_URL" pnpm --filter @damo/mock-api db:migrate
```

`TEST_DATABASE_URL`이 없으면 `pnpm test:api`는 해당 스위트를 자동으로 건너뛴다. 이 값이 Render/프로덕션이 쓰는 `DATABASE_URL`과 절대 같은 값이면 안 된다 — 테스트가 `store.reset()`으로 데이터를 계속 지운다.

## 8. 현재 프로토타입의 범위

- 로그인 정보, 모임, 내 장소와 투표 결과는 Supabase PostgreSQL에 영구 저장됩니다.
- 테스트 계정 비밀번호는 bcrypt로 해시해 저장합니다.
- 자동 테스트는 실제 Supabase 데이터를 변경하지 않도록 메모리 저장소를 사용합니다.
- 실제 배포 서버에서는 OAuth 제공자 검증, 안전한 접근·갱신 토큰, 요청 제한과 운영 로그 처리가 추가로 필요합니다.
- 결과 화면은 현재 5초 간격 조회 방식입니다. 사용량이 늘면 WebSocket 또는 Server-Sent Events로 교체할 수 있습니다.
- API 계약의 기준 문서는 `docs/openapi.yaml`이며, 화면·규칙의 기준은 `docs/flow.md`와 `docs/data-model.md`입니다.

## 9. Render 통합 테스트 배포

루트의 `render.yaml`은 Vite 웹 빌드와 Express 목 API를 하나의 Render Web Service로 배포합니다. 배포 환경에서는 웹과 API가 동일한 도메인을 사용하므로 별도의 CORS 주소 설정이 필요하지 않습니다.

1. 변경사항을 GitHub에 푸시합니다.
2. Render Dashboard에서 `New > Blueprint`를 선택합니다.
3. GitHub의 `Riverwon2/DAMO` 저장소를 연결합니다.
4. 테스트 중에는 배포하려는 기능 브랜치, PR 병합 후에는 `main` 브랜치를 선택합니다.
5. Blueprint Path가 `render.yaml`인지 확인합니다.
6. 생성될 서비스와 요금제를 확인한 뒤 `Deploy Blueprint`를 선택합니다.
7. 배포가 끝나면 Render가 발급한 `https://...onrender.com` 주소를 모바일 브라우저에서 엽니다.

Blueprint 생성 중 `VITE_NAVER_MAP_CLIENT_ID`, `NAVER_SEARCH_CLIENT_ID`, `NAVER_SEARCH_CLIENT_SECRET`, `DATABASE_URL`을 입력합니다. 네이버 클라우드 Maps Application의 Web 서비스 URL에도 Render에서 발급된 호스트 주소를 등록해야 합니다. 검색 API Client Secret과 데이터베이스 연결 문자열은 Render 환경 변수에만 저장합니다.

통합 배포를 로컬에서 미리 확인하려면 다음 순서로 실행합니다.

```bash
pnpm build:render
```

Windows PowerShell:

```powershell
$env:DAMO_SERVE_WEB = "true"
$env:DAMO_HOST = "127.0.0.1"
$env:PORT = "4010"
pnpm start
```

macOS 또는 Linux:

```bash
DAMO_SERVE_WEB=true DAMO_HOST=127.0.0.1 PORT=4010 pnpm start
```

이 모드에서는 웹과 API를 모두 `http://127.0.0.1:4010`에서 확인합니다. 목 데이터는 Render 인스턴스가 재시작되거나 새 버전이 배포될 때 초기화됩니다.
