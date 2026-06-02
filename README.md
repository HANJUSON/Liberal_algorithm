# 📺 YouTube 채널 관심도 분석기

Google OAuth로 본인 계정에 연결한 뒤, 구독 채널을 **댓글·좋아요·구독 기간**을 종합해 관심도 점수(0~100)로 환산하고 4그룹(🔥/😊/👋/🌱)으로 자동 분류해 보여주는 단일 페이지 웹 애플리케이션입니다.

서버는 Flask, 프런트는 Vanilla JS, 인증은 Google Identity Services(GIS) 토큰 클라이언트를 사용합니다.

---

## 목차

- [실행 흐름](#실행-흐름)
- [설치 및 실행](#설치-및-실행)
- [Google Cloud Console 설정](#google-cloud-console-설정)
- [두 가지 운영 모드](#두-가지-운영-모드)
- [폴더 구조](#폴더-구조)
- [API 엔드포인트](#api-엔드포인트)
- [점수 산정 알고리즘](#점수-산정-알고리즘)
- [Takeout 활용 전략 (댓글 + 시청 기록)](#takeout-활용-전략-댓글--시청-기록-하이브리드)
- [실제 사용 알고리즘 목록](#실제-사용-알고리즘-목록)
- [할당량(Quota) 및 제약](#할당량quota-및-제약)
- [라이선스](#라이선스)

---

## 실행 흐름

```
[사용자]
   │
   ├── 1단계 OAuth 클라이언트 ID 입력 (또는 서버 env 주입으로 생략)
   ├── 2단계 Google 계정 로그인 (GIS 토큰 클라이언트)
   │       └─ scope: youtube.readonly, userinfo.profile, userinfo.email
   ├── 3단계 (선택) Google Takeout 업로드
   │       ├─ comments.csv         → 정확한 채널별 댓글 수
   │       └─ watch-history.json   → 채널별 시청 횟수 + 마지막 시청일
   └── 4단계 분석 시작
              ↓
      [브라우저]   YouTube Data API v3
              ↓
        - subscriptions.list?mine=true         (구독 목록)
        - channels.list?mine=true              (내 채널 ID)
        - videos.list?myRating=like            (좋아요 영상)
        - commentThreads.list?allThreadsRelatedToChannel  (댓글 미업로드 시 API 근사)
        - videos.list?id=...                   (comments.csv 업로드 시 영상→채널 해석)
              ↓
      [Flask /api/analyze]
              ↓
        LRU 캐시 (입력 의존 키) → 활동 합산 (휴면 0점 단락)
              → Recency Decay (시청 기록 있을 때)
              → Min-Max 정규화 → Binary Search 4그룹 분류
              → Heap Sort 내림차순
              ↓
      [브라우저]  결과 렌더링 + 필터/요약
```

---

## 설치 및 실행

### 사전 요구 사항

- Python 3.10+ (실제 검증된 환경: 3.14)
- 인터넷 접근 가능한 브라우저
- 본인의 Google Cloud Console 프로젝트 (OAuth 클라이언트 1개)

### 패키지 설치

```powershell
python -m pip install flask
```

### 서버 실행 (수동 모드)

```powershell
cd "Liberal_algorithm"
python app.py
```

기본 포트는 5000. http://127.0.0.1:5000/ 접속.

### 서버 실행 (자동 모드: 클라이언트 ID 미리 주입)

PowerShell 한 줄 (세션 한정):

```powershell
$env:GOOGLE_CLIENT_ID = "당신의ID.apps.googleusercontent.com"
python app.py
```

영구 설정:

```powershell
[System.Environment]::SetEnvironmentVariable('GOOGLE_CLIENT_ID', '당신의ID.apps.googleusercontent.com', 'User')
```

서버 시작 로그에서 자동/수동 모드를 확인할 수 있습니다.

```
[config] GOOGLE_CLIENT_ID 감지됨 (...lastchars) -> 자동 OAuth 모드
[config] GOOGLE_CLIENT_ID 미설정 -> 사용자가 직접 클라이언트 ID 입력
```

---

## Google Cloud Console 설정

1. [Google Cloud Console](https://console.cloud.google.com) 접속 → 새 프로젝트 생성
2. **API 및 서비스 → 라이브러리 → YouTube Data API v3** 활성화
3. **OAuth 동의 화면** 설정
   - 범위에 `https://www.googleapis.com/auth/youtube.readonly`, `userinfo.profile`, `userinfo.email` 추가
   - 테스트 사용자에 본인 Gmail 추가 (또는 프로덕션 게시)
4. **사용자 인증 정보 → OAuth 클라이언트 ID 만들기**
   - 유형: **웹 애플리케이션**
   - **승인된 JavaScript 출처**에 다음 두 개 모두 추가
     - `http://localhost:5000`
     - `http://127.0.0.1:5000`
   - (배포할 경우 운영 도메인도 추가)
   - 클라이언트 ID 복사

> 💡 GIS 토큰 클라이언트 방식이므로 **클라이언트 시크릿은 필요하지 않으며 등록·노출하면 안 됩니다**. API 키도 사용하지 않습니다 (OAuth Bearer 토큰만으로 모든 YouTube Data API 호출이 가능).

---

## 두 가지 운영 모드

| 모드 | 사용자 입력 | 트리거 | UX |
|---|---|---|---|
| 수동 | 클라이언트 ID 1개 | env 미설정 | 1단계 입력 카드 표시 |
| 자동 | 0개 | env `GOOGLE_CLIENT_ID` 설정 | 1단계 자동 생략, 바로 Google 로그인 버튼 |

자동 모드는 Flask가 Jinja2로 `window.__APP_CONFIG__.clientId`를 HTML에 인라인 주입합니다 ([app.py:172](app.py#L172), [youtube-analyzer.html:163](static/youtube-analyzer.html#L163)).

---

## 폴더 구조

```
Liberal_algorithm/
├── app.py                       # Flask 서버 + 점수 계산 알고리즘
├── README.md
└── static/
    ├── youtube-analyzer.html    # SPA 마크업 (Jinja2 템플릿으로도 사용)
    ├── style.css                # 다크 테마 + 그리드 배경
    └── app.js                   # OAuth, API 수집, Takeout 파싱, 렌더링
```

Flask는 `static_folder="static"` + `template_folder="static"` 으로 동일 폴더를 정적 자산과 템플릿 양쪽 용도로 사용합니다.

---

## API 엔드포인트

| Method | Path | 설명 |
|---|---|---|
| GET | `/` | 메인 SPA (`youtube-analyzer.html`, `client_id` 인라인 주입) |
| POST | `/api/analyze` | 채널 배열을 받아 점수·정렬·그룹 분류 |
| GET | `/api/demo` | 15개 샘플 채널로 동일 파이프라인 시연 |
| POST | `/api/interest_keywords` | (LLM) 상위 채널·최근 영상 제목 → 새 채널 발굴용 검색 키워드 추출 |
| POST | `/api/curate` | (LLM) **영상 검색으로 발굴한 실제 채널 풀**에서 취향에 맞는 채널 선별·순위 |
| POST | `/api/recommend` | (LLM) 채널명 직접 생성 추천 — 발굴 실패/비로그인 시 폴백 경로 |
| POST | `/api/verify_recommend` | (LLM) 폴백 추천 채널의 **실제 설명·영상 제목**으로 분류·사유 교정 및 취향 부적합 제외 |
| POST | `/api/persona` | (LLM) 점수·카테고리 분포를 시청 취향 페르소나 리포트로 해석 |
| POST | `/api/cleanup` | (LLM) 점수 20 미만 휴면·저관심 채널의 정리 여부 제안 |

> 위 LLM 엔드포인트는 Upstage Solar(`solar-pro2`)를 호출하므로 `.env` 의 `UPSTAGE_API_KEY` 가 필요합니다. 분석 결과 화면의 **🤖 AI 분석 도구** 섹션(또는 우하단 플로팅 버튼)에서 세 모드를 선택해 사용합니다.

### 새 채널 추천 — 영상 우선 발굴(video-first discovery)

LLM이 채널명을 직접 지어내면 **존재하지 않는 채널(환각)** 이나 **설명과 실제 업로드가 다른 채널**을 추천하는 함정에 빠진다. 그래서 추천은 "채널을 이름으로 찾지 않고, 관심사 영상을 검색해 그 영상을 올린 실제 채널을 역수집"하는 방식으로 동작한다 ([app.js](static/app.js) `runRecommend`).

```
① 관심사 키워드 추출        /api/interest_keywords  (상위 채널 + 최근 영상 제목)
② 키워드별 영상 검색         search.list?type=video  → 각 영상의 channelId 수집 (키워드당 100 units)
③ channelId 빈도 집계        2개 이상 키워드에 등장 = 진짜 그 주제 채널 (기구독 제외)
④ 후보 프로파일링            channels.list + uploads playlistItems  (전부 1 unit, 실제 설명·영상 제목)
⑤ LLM 큐레이션              /api/curate  → 실제 정보로 순위·이유·적합성(fit) 판정, 부족 시 빈도순 보강
```

비싼 `search.list`(100 units)는 ②에서 키워드당 1회만 쓰고(최대 8개=800 units), 깊은 프로파일링(④)은 1 unit짜리 엔드포인트로 처리해 쿼터를 아낀다. 비로그인(데모)이거나 발굴 후보가 빈약하면 LLM이 채널명을 직접 생성하는 폴백 경로(`/api/recommend` → `/api/verify_recommend`)로 전환한다.

POST 요청 본문 예:
```json
{
  "channels": [
    {
      "id": "UC...", "name": "...",
      "subMonths": 36,
      "comments": 50,
      "likes": 200,
      "watchCount": 120,
      "lastWatchDays": 5
    }
  ]
}
```

`watchCount`와 `lastWatchDays`는 선택 필드 (Takeout `watch-history` 업로드 시에만 채워짐).

응답:
```json
{ "channels": [{ ..., "score": 92, "group": { "label": "🔥 최애 채널", "cls": "score-top", "bar": "bar-top" } }] }
```

---

## 점수 산정 알고리즘

5단계 파이프라인이 [app.py:145-167](app.py#L145-L167)의 `analyze_channels()`에서 순서대로 적용됩니다.

### 1) 활동 기반 원시 점수 (가중치 합산 + 휴면 0점 단락)

[app.py:57-67](app.py#L57-L67):

```python
def calc_raw_score(ch):
    activity = (ch.get("comments", 0) * 5) \
             + (ch.get("likes", 0)    * 2) \
             + (ch.get("watchCount", 0) * 3)
    if activity == 0:
        return 0  # 활동 0 → 휴면 채널 즉시 0점
    sub_bonus = min(ch.get("subMonths", 0), 24) * 0.5
    return activity + sub_bonus
```

| 신호 | 가중치 | 근거 |
|---|---:|---|
| 댓글 수 | ×5 | 글쓰기는 가장 적극적 교류 |
| 시청 횟수 (Takeout) | ×3 | 실제 시청은 강한 선호 신호 |
| 좋아요 수 | ×2 | 클릭 한 번, 중간 신호 |
| 장기 구독 보너스 | +`min(개월, 24) × 0.5` | 최대 12점, 활동이 있을 때만 가산 |

핵심 변화:
- **활동(댓글+좋아요+시청) 합이 0이면 다른 어떤 값과도 무관하게 0점.** "10년 구독했지만 안 보는" 채널이 휴면으로 강등됨
- **구독 개월수가 더 이상 raw에 직접 추가되지 않음.** 활동 채널에만 보너스로 작용, 그것도 2년 캡

### 2) 최근성 지수 감쇠 (Recency Decay)

[app.py:72-77](app.py#L72-L77):

```python
def apply_recency_decay(score, last_watch_days, lambda_r=0.005):
    if score == 0 or last_watch_days is None:
        return score
    return score * math.exp(-lambda_r * max(0, last_watch_days))
```

Takeout `watch-history`로부터 받은 "마지막 시청 후 경과일"에 비례한 감쇠. 시청 기록 미업로드 시 미적용 (`lastWatchDays=None`).

| 마지막 시청 | 감쇠 계수 $e^{-0.005 d}$ |
|---:|---:|
| 7일 전 | 0.966 |
| 30일 전 | 0.861 |
| 90일 전 | 0.638 |
| 365일 전 | 0.161 |
| 1,095일 (3년) 전 | 0.004 (사실상 0) |

Takeout이 있는데 어떤 구독 채널이 시청 기록에 한 건도 없으면 `lastWatchDays = subMonths × 30`으로 설정해 "전체 구독 기간 휴면"으로 처리.

### 3) Min-Max 정규화 → 0~100

[app.py:83-89](app.py#L83-L89):

```python
def normalize(scores):
    mn, mx = min(scores), max(scores)
    if mx == mn:
        return [50] * len(scores)
    return [round((s - mn) / (mx - mn) * 100) for s in scores]
```

**상대 평가**입니다. 같은 사용자의 분석 안에서만 비교 가능하며, 사용자 간 점수 비교는 의미 없음.

### 4) 4그룹 분류 (Binary Search)

[app.py:122-139](app.py#L122-L139):

| 점수 구간 | 라벨 |
|:---:|---|
| 0 ~ 19 | 🌱 구독만 한 채널 |
| 20 ~ 49 | 👋 가끔 보는 채널 |
| 50 ~ 79 | 😊 자주 보는 채널 |
| 80 ~ 100 | 🔥 최애 채널 |

경계가 3개라 사실상 선형 탐색으로도 충분하지만, 알고리즘 시연 목적으로 이진 탐색을 구현 (`O(log k)`).

### 5) 힙 정렬 내림차순

[app.py:95-118](app.py#L95-L118). Python `sorted()` 대신 직접 구현한 max-heap 기반 정렬.

### 6) LRU 캐시 (입력 의존 키)

[app.py:32-49](app.py#L32-L49), [app.py:147-156](app.py#L147-L156). 캐시 키를 `(id, comments, likes, watchCount, subMonths, lastWatchDays)` 튜플로 잡아 **입력이 바뀌면 자동 무효화**. 동일 분석 내 반복 호출은 즉시 캐시 히트.

### 통합 예시 (검증된 케이스)

| 채널 | 구독개월 | 댓글 | 좋아요 | 시청 | 마지막시청 | **최종 점수** |
|---|---:|---:|---:|---:|---:|---:|
| 3일 전 150회 시청 | 24 | 0 | 0 | 150 | 3일 | **100** |
| 5년 활발 (댓글·좋아요만) | 60 | 20 | 80 | 0 | — | 60 |
| 6개월 활발 | 6 | 5 | 20 | 0 | — | 15 |
| **10년 잠수** | **120** | **0** | **0** | **0** | — | **0** |
| 1,000일 전 50회 시청 | 60 | 0 | 0 | 50 | 1000일 | 0 |

이전 산식에서는 10년 잠수 채널이 6개월 활발 채널보다 높았으나, 새 산식에서는 **활동 0 → 0점**으로 정확히 강등됩니다.

---

## Takeout 활용 전략 (댓글 + 시청 기록 하이브리드)

YouTube Data API에는 "내가 단 댓글 전체" / "내가 본 영상 전체"를 직접 조회하는 엔드포인트가 없습니다 (Google이 2016년에 시청 기록 API를 제거). 그래서 [Google Takeout](https://takeout.google.com/) 익스포트 데이터를 보조 입력으로 받습니다. 한 번의 업로드 박스에 **두 종류 모두** 받을 수 있고, 파일명·내용으로 자동 식별합니다.

### 1) 댓글 카운트

**기본 (API 근사) ─ [app.js:271-296](static/app.js#L271-L296):**
- `channels.list?mine=true`로 내 채널 ID 조회
- 구독 채널마다 `commentThreads.list?allThreadsRelatedToChannel=<id>&maxResults=100` 호출 (10개 병렬)
- 응답에서 `authorChannelId.value == myId`인 top-level 댓글만 카운트
- **한계:** 채널당 최근 100개만 스캔 → 인기 채널에선 본인 댓글이 밀려나 0이 될 수 있음. 답글은 미반영.

**Takeout 덮어쓰기 ─ [app.js:521-535](static/app.js#L521-L535), [537-557](static/app.js#L537-L557):**
- `comments.csv` (또는 `my-comments.html`) 업로드
- 정규식으로 영상 ID 추출 → `videos.list?id=ID1,…,ID50&part=snippet` 50개 배치로 영상→채널 해석
- 채널별 카운트 집계 → `takeoutCommentsByChannel` 에 저장 후 분석 시 자동 우선

### 2) 시청 기록 (점수 산식 v2의 핵심 신호)

**필수 입력은 아니지만 정확도가 크게 올라갑니다.** 업로드하면 `watchCount` + `lastWatchDays`가 채워져 [최근성 감쇠](#2-최근성-지수-감쇠-recency-decay)가 활성화됩니다.

**JSON 형식 ─ [app.js:560-582](static/app.js#L560-L582):**
- `watch-history.json` 의 각 엔트리 `subtitles[0].url`에 channelId가 박혀 있음 → **API 호출 불필요**
- `time` 필드의 ISO8601 타임스탬프로 채널별 최초/최근 시청일 추적
- 채널별 `{ count, lastDate, firstDate }` 산출

**HTML 형식 (구버전) ─ [app.js:584-594](static/app.js#L584-L594):**
- `watch-history.html` 의 `<a href="https://www.youtube.com/channel/...">`를 regex로 카운트
- 시각 정보는 로케일 의존이라 미파싱 → `lastDate=null` → `lastWatchDays`는 구독기간으로 보수적 추정

### 3) 통합 분기 로직 ([app.js:215-265](static/app.js#L215-L265))

```text
[fetchYouTubeData]
  ├─ Takeout watch가 있다? ──── yes ─► ch.watchCount, ch.lastWatchDays 채움
  │                              │      ch가 watch에 없으면 lastWatchDays = subMonths * 30 (휴면)
  │                              no ─► watchCount=0, lastWatchDays=null (감쇠 미적용)
  │
  └─ Takeout comments가 있다? ── yes ─► ch.comments = takeoutCommentsByChannel[ch.id]
                                 no ─► API 근사로 commentThreads 스캔
```

### 4) 자동 파일 감지 ([app.js:509-519](static/app.js#L509-L519))

`detectTakeoutType(filename, sample)` 우선순위:
1. 파일명에 `watch`/`history`/`시청` 포함 → watch
2. 파일명에 `comment`/`댓글` 포함 → comments
3. 내용 첫 4KB에 `"titleUrl"`+`"subtitles"` → watch JSON
4. 내용에 `Watched <a href=…>` 패턴 → watch HTML
5. 기본 → comments

### 5) 비용·정확도 비교

| 모드 | 사용자 부담 | API 비용 | 정확도 |
|---|---|---|---|
| 둘 다 미업로드 | 없음 | commentThreads × 채널 수 | 댓글 근사값, 시청 미반영 |
| `comments.csv` 만 | 1회 업로드 | `videos.list` × 영상 수 / 50 | 댓글 정확, 시청 미반영 |
| `watch-history.json` 만 | 1회 업로드 | **0** (subtitles에 channelId) | 댓글은 API 근사, 시청 정확 |
| **둘 다 ⭐** | 2회 업로드 | comments 영상 해석만 | **모두 정확** |

---

## 실제 사용 알고리즘 목록

코드 내에서 실제로 실행되는 알고리즘만 정리한 표입니다.

| 영역 | 알고리즘 | 위치 | 복잡도 | 역할 |
|---|---|---|---|---|
| 캐시 | LRU Cache (OrderedDict, 입력 의존 키) | [app.py:47-66](app.py#L47-L66) | O(1) get/set | 채널별 점수 캐싱, 입력 변경 시 자동 무효화 |
| 점수 | 활동 가중치 합산 + 휴면 0점 단락 | [app.py:72-84](app.py#L72-L84) | O(1) | 댓글·시청·좋아요 기반 raw 점수 |
| 점수 | **Recency Decay** (`exp(-λ·d)`) | [app.py:87-95](app.py#L87-L95) | O(1) | 마지막 시청 후 경과일 기반 감쇠 |
| 점수 | Min-Max 정규화 | [app.py:98-104](app.py#L98-L104) | O(n) | 0~100 스코어 매핑 |
| 분류 | **카테고리 분류** (키워드 매칭 · core/general 가중치 · 한글 부분일치/영문 단어경계) | [app.py:223-262](app.py#L223-L262) · [category_list.yaml](category_list.yaml) | O(R) (R=키워드 규칙 수) | name+설명+영상제목 → 카테고리/상세 + 정규화 벡터 |
| 유사도 | **코사인 유사도** (취향 centroid 대비 대표성 + 비슷한 채널 Top 3) | [app.py:292-303](app.py#L292-L303) | O(n²)·희소 벡터 | 카테고리 벡터 기반 채널 간 유사도 |
| 그래프 | **Union-Find** 연결요소 (경로압축·랭크) → 취향 커뮤니티 | [app.py:312-409](app.py#L312-L409) | ~O(n²·α(n)) | 유사도 그래프를 군집으로 분할 |
| 그래프 | **Kruskal 최대 신장 포레스트** (MST) → 취향 지도 | [app.py:411-426](app.py#L411-L426) | O(E log E) | 강한 유사도 우선으로 채널을 트리로 연결 |
| 시각화 | Force-directed 그래프 레이아웃 (SVG) | [app.js:1220](static/app.js#L1220) | O(iter·n²) | 취향 지도 노드 배치·렌더 |
| 정렬 | **Heap Sort** (재귀 heapify) + 2차 정렬키(구독기간)·안정 정렬 | [app.py:110-146](app.py#L110-L146) | O(n log n) | 점수 내림차순 정렬, 동점은 결정론적 |
| 그룹 | Binary Search | [app.py:159-167](app.py#L159-L167) | O(log k) | 점수 → 4그룹 매핑 |
| 수집 | Cursor 페이지네이션 (`nextPageToken`) | [app.js:257-281](static/app.js#L257-L281) | O(n) | 구독·좋아요 전량 수집 |
| 수집 | Promise.all 병렬 배치 (10개) | [app.js:356-372](static/app.js#L356-L372) | O(n/p) | commentThreads 다채널 동시 |
| 수집 | 지수 백오프 재시도 (429) | [app.js:242-248](static/app.js#L242-L248) | — | 일시 한도 초과 자동 재시도 |
| 집계 | Hash Map | 전반 | O(1) avg | likeMap, commentMap, channelByVideo, watchByChannel |
| 파싱 | Regex 토큰화 (Takeout comments) | [app.js:1256-1269](static/app.js#L1256-L1269) | O(n) | URL/셀에서 영상 ID 추출 |
| 파싱 | **JSON 스트림 (watch-history)** | [app.js:1295-1315](static/app.js#L1295-L1315) | O(n) | 시청 엔트리에서 channelId·timestamp 직접 추출 |
| 파싱 | **자동 파일 종류 식별** | [app.js:1244-1252](static/app.js#L1244-L1252) | O(1) | 파일명 + 내용 첫 4KB로 분기 |
| 인증 | GIS 토큰 클라이언트 | [app.js:136-140](static/app.js#L136-L140) | — | OAuth 2.0 access token 발급 |
| 템플릿 | Jinja2 변수 주입 | [app.py:421-422](app.py#L421-L422) | — | `client_id`를 HTML에 인라인 |

> 이전 버전 README에 적혀 있던 BFS, Z-score, K-means, 허프만, 블룸 필터, 가상 스크롤 등은 **실제 코드에 없습니다**. (코사인 유사도·카테고리 분류·안정 정렬 2차키·Union-Find 연결요소·Kruskal MST·그래프 시각화는 이후 추가되어 위 표에 반영됨. 단 그래프 시각화는 Reingold-Tilford가 아니라 **force-directed** 방식.)

---

## 할당량(Quota) 및 제약

### YouTube Data API v3

- 일일 한도: **10,000 units / 프로젝트** (기본값)
- 1 호출 = 1 unit (대부분의 list 메서드)
- 예상 사용량 (구독 250채널 기준)
  - 구독 페이지네이션: ~5 units
  - 좋아요 페이지네이션: 최대 100 units (5,000개 캡)
  - `channels.list?mine`: 1 unit
  - **댓글 — API 근사 모드:** 250 units (채널당 1회)
  - **댓글 — Takeout 모드:** 영상 1만 개 → ~200 units (50개 배치)
  - **시청 — Takeout `watch-history.json`:** **0 units** (subtitles에 channelId 포함)
- 합계: 한 번 분석에 ~150~500 units, 일일 20~50회 분석 가능

### OAuth 토큰

- access_token 유효기간 **1시간** — 분석이 1시간을 넘기면 토큰 만료로 실패
- 갱신 로직 없음 (단발성 토큰 클라이언트 사용)

### 자동 모드 운영 시 추가 고려

- 단일 GCP 프로젝트의 quota를 모든 사용자가 **공유**
- OAuth 동의 화면 미게시 상태에서는 테스트 사용자 100명 제한 + "확인되지 않은 앱" 경고
- 프로덕션 게시 시 개인정보처리방침 URL 등록 + Google 검수 (1~6주)

---

## 라이선스

MIT License
