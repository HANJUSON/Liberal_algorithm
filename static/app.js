// ──────────────────────────────────────────
// 상태
// ──────────────────────────────────────────
let accessToken = null;
let clientId = '';
let userInfo = null;
let allChannels = [];
let tasteGraph = null; // { communities:[...], edges:[MST...] } — /api/analyze·/api/demo 응답
let activeFilter = 'all';
// Takeout 업로드로 산출한 채널별 댓글 수. null = 미업로드 → API 근사로 폴백
let takeoutCommentsByChannel = null;
// Takeout 시청 기록 → { [channelId]: { count, lastDate, firstDate, name, videoTitles } }
let takeoutWatchByChannel = null;
// 내 YouTube 채널 ID (분석 시 설정) — 추천에서 본인 채널 제외 등에 사용
let myChannelId = null;
// 상태 카드용 요약
const takeoutSummary = { comments: null, watch: null };

// 백엔드 API 베이스 (Flask 서버가 같은 도메인에서 정적 파일 + API를 모두 제공)
const API_BASE = '';

// ──────────────────────────────────────────
// 백엔드 분석 API 호출
// ──────────────────────────────────────────
async function analyzeChannelsRemote(channels) {
  const res = await fetch(`${API_BASE}/api/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channels }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `분석 서버 오류 (${res.status})`);
  }
  const data = await res.json();
  tasteGraph = data.graph || null;
  return data.channels;
}

async function fetchDemoRemote() {
  const res = await fetch(`${API_BASE}/api/demo`);
  if (!res.ok) throw new Error(`데모 서버 오류 (${res.status})`);
  const data = await res.json();
  tasteGraph = data.graph || null;
  return data.channels;
}

// LLM 추천 호출 (Upstage Solar). count=요청 개수, exclude=제외할 채널명 배열
async function fetchRecommendationsRemote(channels, count = 10, exclude = []) {
  const res = await fetch(`${API_BASE}/api/recommend`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channels, count, exclude }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `추천 서버 오류 (${res.status})`);
  return data.recommendations || [];
}

// 관심사 키워드 추출 호출 (영상 우선 발굴용 검색어)
async function fetchKeywordsRemote(interests) {
  const res = await fetch(`${API_BASE}/api/interest_keywords`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ interests }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `키워드 서버 오류 (${res.status})`);
  return data.keywords || [];
}

// 후보 큐레이션 호출 (발굴된 실제 채널 풀에서 선별·순위)
async function fetchCurateRemote(candidates, interests, count) {
  const res = await fetch(`${API_BASE}/api/curate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ candidates, interests, count }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `큐레이션 서버 오류 (${res.status})`);
  return data.results || [];
}

// LLM 시청 취향 페르소나 호출 (Upstage Solar)
async function fetchPersonaRemote(channels) {
  const res = await fetch(`${API_BASE}/api/persona`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channels }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `페르소나 서버 오류 (${res.status})`);
  return data.persona;
}

// LLM 구독 정리 코치 호출 (Upstage Solar)
async function fetchCleanupRemote(channels) {
  const res = await fetch(`${API_BASE}/api/cleanup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channels }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `정리 코치 서버 오류 (${res.status})`);
  return data; // { summary, items }
}

// ──────────────────────────────────────────
// OAuth 2.0 (Google Identity Services)
// ──────────────────────────────────────────
let tokenClient = null;

function waitForGIS(timeout = 10000) {
  return new Promise((resolve, reject) => {
    if (typeof google !== 'undefined' && google.accounts) { resolve(); return; }
    const start = Date.now();
    const check = setInterval(() => {
      if (typeof google !== 'undefined' && google.accounts) {
        clearInterval(check); resolve();
      } else if (Date.now() - start > timeout) {
        clearInterval(check);
        reject(new Error('Google 라이브러리 로드 시간 초과.\n페이지를 새로고침(F5) 후 다시 시도해주세요.'));
      }
    }, 100);
  });
}

async function initOAuth(idOverride) {
  const id = idOverride || document.getElementById('clientId')?.value?.trim() || '';
  if (!id) { showError('OAuth 클라이언트 ID를 입력해주세요.'); return; }
  clientId = id;

  hideError();
  const btn = document.querySelector('#keySection .btn');
  const origText = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = 'Google 라이브러리 로드 중...'; }

  try {
    await waitForGIS();

    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: 'https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/userinfo.email',
      callback: handleTokenResponse,
    });

    document.getElementById('keySection').style.display = 'none';
    document.getElementById('oauthSection').style.display = 'block';
    setProgress(2);

  } catch(e) {
    showError(e.message);
    if (btn) { btn.disabled = false; btn.textContent = origText; }
  }
}

function startOAuth() {
  if (!tokenClient) { showError('먼저 키를 입력하고 준비 버튼을 눌러주세요.'); return; }
  tokenClient.requestAccessToken();
}

async function handleTokenResponse(resp) {
  if (resp.error) {
    showError('로그인 실패: ' + resp.error + '\n\n💡 OAuth 동의 화면에서 테스트 사용자로 본인 Gmail을 추가했는지 확인해주세요.');
    return;
  }
  accessToken = resp.access_token;

  try {
    const r = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: 'Bearer ' + accessToken }
    });
    userInfo = await r.json();
    renderUserProfile(userInfo);
  } catch(e) { /* 프로필 실패는 무시 */ }

  const status = document.getElementById('oauthStatus');
  status.className = 'oauth-status connected';
  status.innerHTML = '<span class="status-dot"></span><span>Google 계정 연결됨</span>';
  document.getElementById('oauthBtns').style.display = 'none';

  document.getElementById('analyzeSection').style.display = 'block';
  setProgress(3);
  hideError();
}

function renderUserProfile(info) {
  const el = document.getElementById('userProfile');
  el.style.display = 'flex';
  el.innerHTML = `
    <div class="user-profile">
      ${info.picture ? `<img class="user-avatar" src="${info.picture}" alt="프로필">` : '<div class="user-avatar" style="background:var(--surface2);display:flex;align-items:center;justify-content:center">👤</div>'}
      <div>
        <div class="user-name">${info.name || '사용자'}</div>
        <div class="user-email">${info.email || ''}</div>
      </div>
      <button class="btn-logout" onclick="logout()">로그아웃</button>
    </div>
  `;
}

function logout() {
  accessToken = null;
  userInfo = null;
  takeoutCommentsByChannel = null;
  takeoutWatchByChannel = null;
  takeoutSummary.comments = null;
  takeoutSummary.watch = null;
  resetTakeoutUI();
  document.getElementById('analyzeSection').style.display = 'none';
  document.getElementById('results').classList.remove('active');
  document.getElementById('userProfile').style.display = 'none';
  hideError();

  // OAuth 섹션 UI 리셋
  const status = document.getElementById('oauthStatus');
  status.className = 'oauth-status disconnected';
  status.innerHTML = '<span class="status-dot"></span><span>아직 연결되지 않았습니다.</span>';
  document.getElementById('oauthBtns').style.display = 'flex';

  if (window.__APP_CONFIG__?.clientId) {
    // 서버 주입 모드: 1단계 건너뛰고 OAuth 단계 유지
    document.getElementById('oauthSection').style.display = 'block';
    setProgress(2);
  } else {
    // 수동 모드: 1단계로 복귀
    document.getElementById('oauthSection').style.display = 'none';
    document.getElementById('keySection').style.display = 'block';
    setProgress(1);
  }
}

function resetTakeoutUI() {
  const f = document.getElementById('takeoutFile');
  const drop = document.getElementById('takeoutDrop');
  const label = document.getElementById('takeoutLabel');
  const status = document.getElementById('takeoutStatus');
  if (f) f.value = '';
  if (drop) drop.classList.remove('has-file');
  if (label) label.textContent = '📂 파일 선택';
  if (status) { status.textContent = ''; status.className = 'takeout-status'; }
}

// ──────────────────────────────────────────
// YouTube API 호출 (OAuth 토큰은 브라우저 측에서만 사용)
// ──────────────────────────────────────────
async function fetchWithRetry(url, opts, retries=3) {
  for (let i=0; i<retries; i++) {
    const res = await fetch(url, opts);
    if (res.status === 429) { await delay(Math.pow(2,i)*1000); continue; }
    return res;
  }
  throw new Error('요청 한도 초과. 잠시 후 다시 시도해주세요.');
}

async function fetchYouTubeData() {
  const headers = { Authorization: 'Bearer ' + accessToken };
  const BASE = 'https://www.googleapis.com/youtube/v3';

  // 1. 구독 목록 수집 (페이지네이션)
  stepActive(1);
  let subs = [], pageToken = '';
  do {
    const url = `${BASE}/subscriptions?part=snippet&mine=true&maxResults=50${pageToken ? '&pageToken='+pageToken : ''}`;
    const res = await fetchWithRetry(url, {headers});
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error?.message || `구독 목록 요청 실패 (${res.status})`);
    }
    const data = await res.json();
    for (const item of (data.items || [])) {
      subs.push({
        id: item.snippet.resourceId.channelId,
        name: item.snippet.title,
        emoji: '📺',
        thumb: item.snippet.thumbnails?.default?.url || null,
        subMonths: Math.max(1, Math.floor((Date.now() - new Date(item.snippet.publishedAt)) / (1000*60*60*24*30))),
        comments: 0,
        likes: 0,
        category: '채널',
        // 채널 설명 일부 → LLM이 채널 성격을 추측(환각)하지 않도록 근거 제공
        description: (item.snippet.description || '').slice(0, 200),
      });
    }
    pageToken = data.nextPageToken || '';
  } while (pageToken);

  if (subs.length === 0) throw new Error('구독 채널이 없거나 데이터를 가져올 수 없습니다.');

  // 내 채널 ID (댓글 작성자 매칭용 + 추천에서 본인 채널 제외용). 전역에 보관.
  myChannelId = null;
  try {
    const meRes = await fetchWithRetry(`${BASE}/channels?part=id&mine=true`, {headers});
    if (meRes.ok) {
      const meData = await meRes.json();
      myChannelId = meData.items?.[0]?.id || null;
    }
  } catch(e) { /* 매칭 불가 시 comments=0 유지 */ }

  // 2. 좋아요 누른 영상 → 채널별 해시맵 집계 (사실상 전량: 100페이지 = 5000개 안전 캡)
  stepDone(1); stepActive(2);
  const likeMap = {};
  try {
    let likePage = '';
    let likePageCount = 0;
    do {
      const url = `${BASE}/videos?part=snippet&myRating=like&maxResults=50${likePage ? '&pageToken='+likePage : ''}`;
      const res = await fetchWithRetry(url, {headers});
      if (!res.ok) break;
      const data = await res.json();
      for (const item of (data.items || [])) {
        const cid = item.snippet.channelId;
        likeMap[cid] = (likeMap[cid] || 0) + 1;
      }
      likePage = data.nextPageToken || '';
      likePageCount++;
      if (likePageCount >= 100) break;
    } while (likePage);
  } catch(e) { /* 좋아요 실패는 무시하고 계속 */ }

  // 3. 좋아요 병합 + 채널별 내 댓글 + (있다면) 시청 기록 병합
  stepDone(2); stepActive(3);
  for (const ch of subs) {
    ch.likes = likeMap[ch.id] || 0;
  }

  // Takeout 시청 기록 우선 적용
  if (takeoutWatchByChannel) {
    const todayMs = Date.now();
    for (const ch of subs) {
      const w = takeoutWatchByChannel[ch.id];
      if (w && w.count > 0) {
        ch.watchCount = w.count;
        if (w.lastDate) {
          ch.lastWatchDays = Math.max(0, Math.floor((todayMs - w.lastDate.getTime()) / 86400000));
          ch.lastWatchEstimated = false; // 실제 시청 타임스탬프에서 측정
        } else {
          // HTML 포맷 → 시각 미상. 구독 기간만큼 dormant 보수적 추정
          ch.lastWatchDays = (ch.subMonths || 0) * 30;
          ch.lastWatchEstimated = true;
        }
      } else {
        // Takeout이 있는데 이 채널은 시청 0건 → 구독 전체 기간 휴면(추정)
        ch.watchCount = 0;
        ch.lastWatchDays = (ch.subMonths || 0) * 30;
        ch.lastWatchEstimated = true;
      }
    }
  }

  if (takeoutCommentsByChannel) {
    setStepLabel(3, '채널별 활동 매핑 중... (Takeout 댓글 + 시청)');
    for (const ch of subs) {
      ch.comments = takeoutCommentsByChannel[ch.id] || 0;
    }
  } else if (myChannelId) {
    // 폴백: commentThreads.list로 최근 100개 안에서 본인 작성 매칭
    setStepLabel(3, '채널별 댓글 수 집계 중... (API 근사 · 최근 100개 스캔)');
    const commentMap = {};
    const BATCH = 10;
    for (let i = 0; i < subs.length; i += BATCH) {
      const slice = subs.slice(i, i + BATCH);
      await Promise.all(slice.map(async (ch) => {
        try {
          const url = `${BASE}/commentThreads?part=snippet&allThreadsRelatedToChannel=${ch.id}&maxResults=100`;
          const res = await fetchWithRetry(url, {headers});
          if (!res.ok) return; // 댓글 비활성/권한 없음 등은 0으로 둠
          const data = await res.json();
          let cnt = 0;
          for (const item of (data.items || [])) {
            const author = item.snippet?.topLevelComment?.snippet?.authorChannelId?.value;
            if (author === myChannelId) cnt++;
          }
          if (cnt) commentMap[ch.id] = cnt;
        } catch(e) { /* 채널 단위 실패는 무시 */ }
      }));
    }
    for (const ch of subs) {
      ch.comments = commentMap[ch.id] || 0;
    }
  }
  stepDone(3);
  return subs;
}

// ──────────────────────────────────────────
// 분석 실행 (수집 → 서버 분석)
// ──────────────────────────────────────────
async function startAnalysis() {
  if (!accessToken) { showError('먼저 Google 로그인을 완료해주세요.'); return; }
  hideError();
  document.getElementById('results').classList.remove('active');
  document.getElementById('loading').classList.add('active');
  restoreLoadingSteps();
  resetSteps();

  try {
    const raw = await fetchYouTubeData();

    // 4·5. 백엔드: 정규화 + 지수 평활 → 힙 정렬 (단일 호출이므로 시각 단계만 분리)
    stepActive(4);
    const sorted = await analyzeChannelsRemote(raw);
    stepDone(4);
    stepActive(5);
    stepDone(5);

    document.getElementById('loading').classList.remove('active');
    setProgress(4);
    showResults(sorted);
  } catch(e) {
    document.getElementById('loading').classList.remove('active');
    showError('오류: ' + e.message);
  }
}

async function loadDemo() {
  hideError();
  document.getElementById('results').classList.remove('active');
  document.getElementById('loading').classList.add('active');
  setDemoLoadingMessage();

  try {
    const sorted = await fetchDemoRemote();
    document.getElementById('loading').classList.remove('active');
    setProgress(4);
    showResults(sorted);
  } catch(e) {
    document.getElementById('loading').classList.remove('active');
    showError('오류: ' + e.message);
  } finally {
    restoreLoadingSteps();
  }
}

// ──────────────────────────────────────────
// 로딩 스텝 헬퍼
// ──────────────────────────────────────────
let _defaultStepsHTML = null;

function _cacheDefaultStepsHTML() {
  if (_defaultStepsHTML !== null) return;
  const el = document.getElementById('loadingSteps');
  if (el) _defaultStepsHTML = el.innerHTML;
}

function setDemoLoadingMessage() {
  _cacheDefaultStepsHTML();
  const el = document.getElementById('loadingSteps');
  if (el) el.innerHTML = '<div class="loading-step active">📦 데모 데이터로 알고리즘 시연 중...</div>';
}

function restoreLoadingSteps() {
  _cacheDefaultStepsHTML();
  const el = document.getElementById('loadingSteps');
  if (el && _defaultStepsHTML) el.innerHTML = _defaultStepsHTML;
}

function resetSteps() {
  for (let i=1; i<=5; i++) {
    const el = document.getElementById('step'+i);
    if (el) el.classList.remove('active','done');
  }
}
function setStepLabel(n, text) {
  const el = document.getElementById('step'+n);
  if (el) el.textContent = text;
}
function stepActive(n) {
  const el = document.getElementById('step'+n);
  if (el) el.classList.add('active');
}
function stepDone(n) {
  const el = document.getElementById('step'+n);
  if (el) { el.classList.remove('active'); el.classList.add('done'); }
}

// ──────────────────────────────────────────
// 진행 단계 UI
// ──────────────────────────────────────────
function setProgress(step) {
  for (let i=1; i<=4; i++) {
    const c = document.getElementById('pc'+i);
    const l = document.getElementById('pl'+i);
    c.className = 'step-circle' + (i<step?' done': i===step?' active':'');
    l.className = 'step-label' + (i<step?' done': i===step?' active':'');
    if (i < step) c.textContent = '✓';
    else c.textContent = i;
  }
}

// ──────────────────────────────────────────
// 결과 렌더링
// ──────────────────────────────────────────
function showResults(channels) {
  allChannels = channels;
  activeFilter = 'all';
  renderSummary(channels);
  renderTasteGraph(channels, tasteGraph);
  renderFilterBar(channels);
  renderList(channels);
  resetAiSection();
  document.getElementById('results').classList.add('active');
  document.getElementById('recommendFab').classList.add('visible');
  startFabInertia();
  document.getElementById('results').scrollIntoView({behavior:'smooth', block:'start'});
}

// ──────────────────────────────────────────
// 플로팅 추천 버튼 - 부드러운 관성 따라오기
//   target = 스크롤이 멈춘 최종 위치(원래 fixed 자리)
//   current = 실제 그려지는 위치 (lerp로 천천히 수렴)
//   둘의 차이를 translateY로 표현 → 스크롤 중엔 살짝 뒤따라오고, 멈추면 부드럽게 정착
// ──────────────────────────────────────────
let fabInertiaStarted = false;
function startFabInertia() {
  if (fabInertiaStarted) return;
  fabInertiaStarted = true;
  const fab = document.getElementById('recommendFab');
  let targetY = window.scrollY;
  let currentY = targetY;
  window.addEventListener('scroll', () => { targetY = window.scrollY; }, { passive: true });
  function tick() {
    // 0.12 = 관성 강도 (작을수록 더 느리고 부드럽게 따라옴)
    currentY += (targetY - currentY) * 0.12;
    const lag = targetY - currentY;
    // 스크롤 방향과 반대로 살짝 끌리는 효과 + 한도 제한(±28px)
    const offset = Math.max(-28, Math.min(28, lag));
    fab.style.transform = `translateY(${offset}px)`;
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

// ──────────────────────────────────────────
// AI 분석 도구 (Solar LLM): 페르소나 / 구독 정리 / 채널 추천
// ──────────────────────────────────────────
let currentAiMode = null;

function resetAiSection() {
  currentAiMode = null;
  document.getElementById('aiOutput').innerHTML = '';
  document.getElementById('aiError').style.display = 'none';
  document.getElementById('aiLoading').style.display = 'none';
  document.querySelectorAll('.ai-mode-card').forEach(c => c.classList.remove('active'));
  const fab = document.getElementById('recommendFab');
  if (fab) fab.disabled = false;
}

// FAB 클릭: AI 섹션으로 스크롤. 모드 미선택 상태면 카드들을 잠깐 강조.
function scrollToAiSection() {
  document.getElementById('aiSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (!currentAiMode) {
    const grid = document.getElementById('aiModeGrid');
    grid.classList.remove('pulse');
    void grid.offsetWidth; // reflow → 애니메이션 재시작
    grid.classList.add('pulse');
  }
}

// 모드 선택 → 해당 분석 실행
function selectAiMode(mode) {
  if (!allChannels.length) return;
  currentAiMode = mode;
  document.querySelectorAll('.ai-mode-card').forEach(c => {
    c.classList.toggle('active', c.dataset.mode === mode);
  });
  if (mode === 'persona') return runPersona();
  if (mode === 'cleanup') return runCleanup();
  if (mode === 'recommend') return runRecommend();
}

// 공통 출력 영역 제어 헬퍼
function aiStart(loadingText) {
  document.getElementById('recommendFab').disabled = true;
  document.getElementById('aiLoadingText').textContent = loadingText;
  document.getElementById('aiLoading').style.display = 'flex';
  document.getElementById('aiError').style.display = 'none';
  document.getElementById('aiOutput').innerHTML = '';
  document.getElementById('aiSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function aiEnd() {
  document.getElementById('recommendFab').disabled = false;
  document.getElementById('aiLoading').style.display = 'none';
}
function showAiError(msg) {
  const e = document.getElementById('aiError');
  e.textContent = '⚠️ ' + msg;
  e.style.display = 'block';
}

const RECOMMEND_TARGET = 10; // 최종 확정 추천 개수

// 비구독·최근시청 채널 추천 임계값 (노이즈 컷). 시청기록 JSON 업로드 시에만 동작.
//   maxDays: 최근 N일 내 시청해야 후보 / minCount: 최소 시청 횟수 / limit: 최대 노출 수
const WATCHED_REC_OPTS = { maxDays: 90, minCount: 2, limit: 12 };

// 신규 추천을 확정 목록(confirmed)에 중복 없이 병합. limit 도달 시 멈춘다.
// 기준: 이미 구독 중인 channelId, confirmed의 channelId, 정규화된 이름.
function mergeRecommendations(confirmed, incoming, limit) {
  const subscribedIds = new Set(allChannels.map(c => c.id).filter(Boolean));
  const norm = r => (r.actualName || r.name || '').trim().toLowerCase().replace(/\s+/g, '');
  const ids = new Set(confirmed.map(r => r.channelId).filter(Boolean));
  const names = new Set(confirmed.map(norm).filter(Boolean));
  for (const r of incoming) {
    if (confirmed.length >= limit) break;
    if (!r) continue;
    const id = r.channelId || null;
    if (id && subscribedIds.has(id)) continue;
    if (id && ids.has(id)) continue;
    const key = norm(r);
    if (key && names.has(key)) continue;
    if (id) ids.add(id);
    if (key) names.add(key);
    confirmed.push(r);
  }
  return confirmed;
}

// ──────────────────────────────────────────
// 새 채널 추천 — 영상 우선 발굴 (video-first discovery)
//   ① 관심사 키워드 추출 → ② 키워드로 '영상' 검색 → 그 영상의 채널을 역수집(실존 보장)
//   → ③ 빈도 집계로 진짜 그 주제 채널만 추림 → ④ 싼 엔드포인트로 프로파일링
//   → ⑤ LLM은 발굴이 아니라 '큐레이션'만. 채널명 환각·메타데이터 불일치를 원천 차단.
// ──────────────────────────────────────────
async function runRecommend() {
  aiStart('관심사 키워드를 분석하는 중...');
  try {
    // (B) 비구독·최근시청 채널 — 취향 기반 추천을 '대체'하지 않고 항상 '추가' 섹션으로 함께 노출한다.
    //     (시청기록 JSON 업로드 시에만 채워짐. 미업로드/HTML 포맷이면 빈 배열 → 기존과 동일 동작)
    let watchedSeeds = [];
    let watchedRecs = [];
    let watchedExclude = new Set();
    if (accessToken && takeoutWatchByChannel) {
      watchedSeeds = collectWatchedNotSubscribed(WATCHED_REC_OPTS);
      watchedExclude = new Set(watchedSeeds.map(w => w.channelId));
      if (watchedSeeds.length) {
        document.getElementById('aiLoadingText').textContent = '최근 본 비구독 채널을 정리하는 중...';
        watchedRecs = await profileWatchedChannels(watchedSeeds);
      }
    }

    // 비로그인(데모 등)은 영상 검색 토큰이 없으므로 기존 LLM-이름 방식으로 (watchedRecs 함께 전달)
    if (!accessToken) { await runRecommendByLLMNames(watchedRecs); return; }

    // ① 관심사 키워드 추출 (상위 구독 채널 + (A) 비구독·최근시청 채널의 영상 제목 기반)
    document.getElementById('aiLoadingText').textContent = '관심사 키워드를 분석하는 중...';
    const keywords = await extractInterestKeywords(watchedSeeds);

    // 키워드가 부족하면 발굴 불가 → LLM-이름 폴백 (비구독·시청 추천은 함께 노출)
    if (keywords.length < 2) { await runRecommendByLLMNames(watchedRecs); return; }

    // ②~③ 영상 우선 탐색 → channelId 빈도 집계 → 실제 후보 발굴 (기구독 + 비구독·시청 채널 제외)
    document.getElementById('aiLoadingText').textContent =
      `'${keywords.slice(0, 3).map(k => k.keyword).join(', ')} …' 주제의 영상을 올리는 채널을 찾는 중...`;
    let candidates = await discoverCandidatesByVideo(keywords, watchedExclude);

    // 발굴이 빈약하면 LLM-이름 폴백 (비구독·시청 추천은 함께 노출)
    if (candidates.length < 3) { await runRecommendByLLMNames(watchedRecs); return; }

    // ④ 후보 프로파일링 — 실제 제목/설명/영상 제목 (전부 1유닛짜리 싼 엔드포인트)
    document.getElementById('aiLoadingText').textContent = '후보 채널의 실제 영상을 확인하는 중...';
    candidates = await profileCandidates(candidates);

    // ⑤ LLM 큐레이션 — 실제 정보 기반 순위·이유·적합성 (+ 관심 카테고리별 최소 1개 보장)
    document.getElementById('aiLoadingText').textContent = 'Solar LLM이 추천을 선별하는 중... (10~20초)';
    const curated = await curateCandidates(candidates, RECOMMEND_TARGET, topInterestCategories(4));

    renderRecommendations(curated, watchedRecs);
  } catch (e) {
    showAiError(e.message);
  } finally {
    aiEnd();
  }
}

// (A)+(B) 공용: 비구독이면서 최근 시청한 채널을 시청기록에서 추려 빈도×최근성으로 순위.
//   takeoutWatchByChannel 은 구독 여부와 무관한 전체 시청 채널 맵 → 여기서 비구독만 분리한다.
function collectWatchedNotSubscribed({ maxDays = 90, minCount = 2, limit = 12 } = {}) {
  if (!takeoutWatchByChannel) return [];
  const subscribed = new Set(allChannels.map(c => c.id).filter(Boolean));
  const todayMs = Date.now();
  const out = [];
  for (const [cid, w] of Object.entries(takeoutWatchByChannel)) {
    if (!cid || subscribed.has(cid) || cid === myChannelId) continue;
    const lastWatchDays = w.lastDate
      ? Math.max(0, Math.floor((todayMs - w.lastDate.getTime()) / 86400000))
      : null;
    // 노이즈 컷: '최근 maxDays 이내' + '최소 minCount회' 둘 다 만족해야 후보
    // (시각 없는 HTML 포맷은 lastWatchDays=null → 자동 제외, JSON 포맷에서만 동작)
    if (lastWatchDays === null || lastWatchDays > maxDays) continue;
    if ((w.count || 0) < minCount) continue;
    out.push({
      channelId: cid,
      count: w.count || 0,
      lastWatchDays,
      name: w.name || '',
      videoTitles: w.videoTitles || [],
    });
  }
  // 빈도를 최근성으로 가중 (최근일수록·자주 볼수록 상위). 60일 반감기 수준의 완만한 감쇠.
  const rank = s => s.count * Math.exp(-s.lastWatchDays / 60);
  out.sort((a, b) => rank(b) - rank(a));
  return out.slice(0, limit);
}

// (B) 비구독·시청 채널을 channels.list 로 프로파일링(이름·썸네일) → 추천 카드 형태로 변환.
async function profileWatchedChannels(seeds) {
  if (!seeds.length || !accessToken) return [];
  const headers = { Authorization: 'Bearer ' + accessToken };
  let meta = {};
  try { meta = await fetchChannelMeta(seeds.map(s => s.channelId), headers); } catch { /* 메타 실패 시 이름만 사용 */ }
  return seeds.map(s => {
    const m = meta[s.channelId] || {};
    const d = s.lastWatchDays;
    const when = d <= 1 ? '최근' : (d <= 7 ? '이번 주' : `${d}일 전`);
    return {
      channelId: s.channelId,
      name: m.title || s.name || '',
      actualName: m.title || s.name || '',
      thumbnail: m.thumbnail || null,
      category: '최근 시청 · 미구독',
      reason: `${when} 시청 · 총 ${s.count}회 봤지만 아직 구독 안 함`,
    };
  }).filter(r => r.actualName);
}

// 구독 채널의 분류 결과(category)로 사용자의 '관심 카테고리'를 점수 가중 상위 N개 도출.
//   예: { 요리: 큰 가중, 경제: 중간, 게임: 중간 } → [요리, 경제, 게임]
//   추천이 요리에 쏠리지 않고 경제·게임도 최소 1개씩 나오게 하는 다양성의 기준이 된다.
function topInterestCategories(maxCats = 4) {
  const weight = {};
  for (const c of allChannels) {
    const cat = c.category;
    if (!cat || cat === '기타' || cat === '채널') continue;
    if ((c.score || 0) < 10) continue; // 휴면(0점)·무관심 채널은 관심 카테고리에서 제외
    weight[cat] = (weight[cat] || 0) + (c.score || 0);
  }
  return Object.entries(weight).sort((a, b) => b[1] - a[1]).slice(0, maxCats).map(([c]) => c);
}

// 관심사 키워드 추출 — 카테고리별로 분리·균형 추출해 각 키워드에 '출처 카테고리'를 태깅한다.
//   반환: [{ keyword, category }]  (category가 ''면 카테고리 미상/폴백)
//   요리가 구독의 대부분이어도 경제·게임 키워드가 검색에 반드시 포함되도록 라운드로빈으로 인터리브.
async function extractInterestKeywords(watchedSeeds = []) {
  const withTitles = await attachVideoTitles(allChannels, 18);
  const cats = topInterestCategories(4);

  // 카테고리별 키워드 추출 (병렬). 키워드 수는 카테고리당 상한을 둬 한 카테고리 독식 방지.
  const perCat = cats.length <= 2 ? 4 : 3;
  const lists = await Promise.all(cats.map(async (cat) => {
    const interests = withTitles
      .filter(c => c.category === cat && (c.score || 0) >= 10)
      .slice(0, 6)
      .map(c => ({ name: c.name, videoTitles: (c.videoTitles || []).slice(0, 6) }));
    if (!interests.length) return { cat, kws: [] };
    try { return { cat, kws: (await fetchKeywordsRemote(interests)).slice(0, perCat) }; }
    catch { return { cat, kws: [] }; }
  }));

  // (A) 비구독·최근시청 채널도 한 그룹으로 (카테고리 미상 → '최근시청' 태그)
  const watchedInterests = watchedSeeds
    .filter(w => w.name || (w.videoTitles && w.videoTitles.length))
    .slice(0, 6)
    .map(w => ({ name: w.name || '최근 시청 채널', videoTitles: (w.videoTitles || []).slice(0, 6) }));
  if (watchedInterests.length) {
    try { lists.push({ cat: '최근시청', kws: (await fetchKeywordsRemote(watchedInterests)).slice(0, 3) }); }
    catch { /* 무시 */ }
  }

  // 폴백: 카테고리 분류가 빈약해 키워드가 하나도 안 나오면 기존 방식(상위 채널 평면 키워드)
  if (!lists.some(l => l.kws.length)) {
    const interests = withTitles.filter(c => (c.score || 0) >= 50).slice(0, 12)
      .map(c => ({ name: c.name, videoTitles: (c.videoTitles || []).slice(0, 6) }));
    if (!interests.length) return [];
    try { return (await fetchKeywordsRemote(interests)).map(k => ({ keyword: k, category: '' })); }
    catch { return []; }
  }

  // 라운드로빈 인터리브 → 이후 8개로 잘려도 모든 카테고리가 최소 1개씩 검색에 포함된다.
  const tagged = [];
  for (let i = 0, added = true; added; i++) {
    added = false;
    for (const l of lists) {
      if (l.kws[i]) { tagged.push({ keyword: l.kws[i], category: l.cat }); added = true; }
    }
  }
  return tagged;
}

// 영상 우선 탐색: (카테고리 태깅된) 키워드별 영상 검색 → channelId 빈도 집계. 비싼 search(100u)는 키워드당 1회만.
//   taggedKeywords: [{ keyword, category }] — 각 후보가 어느 관심 카테고리에서 발굴됐는지 추적한다.
async function discoverCandidatesByVideo(taggedKeywords, excludeIds = new Set()) {
  const headers = { Authorization: 'Bearer ' + accessToken };
  const BASE = 'https://www.googleapis.com/youtube/v3';
  // 기구독 채널 + (B)로 따로 노출할 비구독·시청 채널을 발굴 대상에서 제외 → 중복 방지
  const subscribed = new Set([...allChannels.map(c => c.id).filter(Boolean), ...excludeIds]);
  const freq = new Map();         // channelId → 등장한 키워드 수
  const searchTitles = new Map(); // channelId → 검색에서 본 영상 제목 일부
  const candCats = new Map();      // channelId → Set(출처 카테고리)

  const KW = taggedKeywords.slice(0, 8); // 쿼터 보호: 최대 8개 키워드(=800유닛)
  for (const { keyword, category } of KW) {
    try {
      const url = `${BASE}/search?part=snippet&type=video&order=relevance&maxResults=50&q=${encodeURIComponent(keyword)}`;
      const res = await fetchWithRetry(url, { headers });
      if (!res.ok) continue;
      const data = await res.json();
      const seenThisKw = new Set(); // 같은 키워드 내 동일 채널 중복 카운트 방지
      for (const item of (data.items || [])) {
        const cid = item.snippet?.channelId;
        if (!cid || subscribed.has(cid)) continue;
        if (!seenThisKw.has(cid)) { freq.set(cid, (freq.get(cid) || 0) + 1); seenThisKw.add(cid); }
        if (category && category !== '최근시청') {
          const s = candCats.get(cid) || new Set(); s.add(category); candCats.set(cid, s);
        }
        const t = item.snippet?.title;
        if (t) { const arr = searchTitles.get(cid) || []; if (arr.length < 5) { arr.push(t); searchTitles.set(cid, arr); } }
      }
    } catch { /* 키워드 단위 실패는 무시 */ }
  }

  // 풀 구성: ① 각 카테고리에서 빈도 상위 2개씩 먼저 확보(경제·게임 같은 소수 취향도 후보 보존)
  //          ② 나머지는 빈도순으로 30개까지 채움. → 큐레이션이 카테고리 커버리지를 만들 수 있게 한다.
  const entries = [...freq.entries()].sort((a, b) => b[1] - a[1]);
  const byCat = {};
  for (const [cid, n] of entries) {
    for (const cat of (candCats.get(cid) || [])) (byCat[cat] = byCat[cat] || []).push([cid, n]);
  }
  const picked = new Set();
  const pool = [];
  for (const cat of Object.keys(byCat)) {
    for (const [cid, n] of byCat[cat].slice(0, 2)) {
      if (!picked.has(cid)) { picked.add(cid); pool.push([cid, n]); }
    }
  }
  for (const [cid, n] of entries) {
    if (pool.length >= 30) break;
    if (!picked.has(cid)) { picked.add(cid); pool.push([cid, n]); }
  }
  return pool.map(([cid, n]) => ({
    channelId: cid,
    frequency: n,
    searchTitles: searchTitles.get(cid) || [],
    categories: [...(candCats.get(cid) || [])],
  }));
}

// 후보 프로파일링: 실제 제목/설명/썸네일(channels.list) + 최근 영상 제목(uploads) — 전부 싼 엔드포인트.
async function profileCandidates(candidates) {
  const headers = { Authorization: 'Bearer ' + accessToken };
  const ids = candidates.map(c => c.channelId);
  const meta = await fetchChannelMeta(ids, headers);
  const titles = await fetchRecentVideoTitles(ids, headers, 8);
  return candidates.map(c => {
    const m = meta[c.channelId] || {};
    return {
      ...c,
      name: m.title || '',
      actualName: m.title || '',
      realDescription: m.description || '',
      thumbnail: m.thumbnail || null,
      realVideoTitles: (titles[c.channelId] && titles[c.channelId].length) ? titles[c.channelId] : (c.searchTitles || []),
    };
  }).filter(c => c.actualName); // 메타 해석 실패분 제외
}

// LLM 큐레이션: 발굴된 실제 후보 중에서 선별·순위. fit=false 제외, 부족하면 빈도순 보강으로 목표치 채움.
//   interestCats: 사용자의 관심 카테고리(요리·경제·게임…) — 각 카테고리마다 최소 1개를 보장(다양성).
async function curateCandidates(profiled, count, interestCats = []) {
  const interests = allChannels
    .filter(c => (c.score || 0) >= 50)
    .slice(0, 15)
    .map(c => ({ name: c.name, description: (c.description || '').slice(0, 200) }));
  const candidates = profiled.map(c => ({
    name: c.actualName || c.name,
    description: c.realDescription,
    videoTitles: c.realVideoTitles,
    frequency: c.frequency,
  }));

  let results;
  try {
    results = await fetchCurateRemote(candidates, interests, count);
  } catch {
    return profiled.slice(0, count); // 큐레이션 실패 → 빈도순 상위로 폴백
  }

  const byName = {};
  profiled.forEach(p => { byName[p.actualName || p.name] = p; });
  const rejected = new Set(results.filter(r => r.fit === false).map(r => r.name));

  const out = [];
  const chosen = new Set();
  for (const r of results) {
    if (out.length >= count) break;
    if (r.fit === false) continue;
    const p = byName[r.name];
    if (!p || chosen.has(p.channelId)) continue;
    chosen.add(p.channelId);
    out.push({ ...p, category: r.category || '', reason: r.reason || '' });
  }
  // 목표치 미달이면 빈도순 후보로 보강 (LLM이 부적합 판정한 것은 제외)
  if (out.length < count) {
    const rest = profiled
      .filter(p => !chosen.has(p.channelId) && !rejected.has(p.actualName || p.name))
      .sort((a, b) => (b.frequency || 0) - (a.frequency || 0));
    for (const p of rest) {
      if (out.length >= count) break;
      chosen.add(p.channelId);
      out.push({ ...p, category: p.category || '', reason: p.reason || '관심사 키워드에서 반복 등장한 채널' });
    }
  }

  // 카테고리 다양성: 결과가 한 카테고리(예: 요리)에 쏠리면, 사용자의 다른 관심 카테고리(경제·게임 등)도
  //   '최소 1개씩' 보장한다. 해당 카테고리 후보가 발굴됐을 때만 적용(없으면 조용히 건너뜀).
  if (interestCats.length) {
    const catsOf = p => (p.categories || []);
    for (const cat of interestCats) {
      if (out.some(p => catsOf(p).includes(cat))) continue; // 이미 커버됨
      const chosenIds = new Set(out.map(p => p.channelId));
      const cand = profiled.find(p =>
        !chosenIds.has(p.channelId) &&
        !rejected.has(p.actualName || p.name) &&
        catsOf(p).includes(cat));
      if (!cand) continue; // 그 카테고리 후보가 발굴 안 됨 → 보장 불가, 건너뜀
      const pick = { ...cand, category: cand.category || cat, reason: cand.reason || `'${cat}' 관심사에 맞춘 추천` };
      if (out.length < count) {
        out.push(pick);
      } else {
        // 슬롯이 꽉 참: '같은 카테고리가 2개 이상 중복된' 항목 중 빈도 최저를 교체(단일 대표는 보호).
        const catCount = {};
        out.forEach(p => catsOf(p).forEach(c => { catCount[c] = (catCount[c] || 0) + 1; }));
        let idx = -1, minF = Infinity;
        out.forEach((p, i) => {
          const redundant = catsOf(p).length > 0 && catsOf(p).every(c => catCount[c] > 1);
          if (redundant && (p.frequency || 0) < minF) { minF = p.frequency || 0; idx = i; }
        });
        if (idx >= 0) out[idx] = pick; // 보호 대상뿐이면 강제 교체하지 않음
      }
    }
  }
  return out;
}

// 폴백: 기존 LLM-이름 생성 → 해석 → 검증 방식 (비로그인/발굴 빈약 시)
//   watchedRecs: 비구독·최근시청 채널 추천 — 모든 렌더에 함께 얹어 '대체'가 아니라 '추가'로 노출한다.
async function runRecommendByLLMNames(watchedRecs = []) {
  document.getElementById('aiLoadingText').textContent = 'Solar LLM이 새 채널을 추천하는 중... (10~20초)';
  {
    const confirmed = [];          // 검증을 통과한 최종 추천 (최대 RECOMMEND_TARGET)
    const excludeNames = new Set(); // 이미 추천/거부된 이름 → 다음 라운드 제외
    const MAX_ROUNDS = 3;          // 보충 라운드 상한 (무한루프 방지)

    for (let round = 0; round < MAX_ROUNDS && confirmed.length < RECOMMEND_TARGET; round++) {
      const need = RECOMMEND_TARGET - confirmed.length;
      // 검증·중복으로 줄어드는 걸 감안해 넉넉히 요청
      const askCount = round === 0 ? RECOMMEND_TARGET + 5 : need + 4;

      let recs = await fetchRecommendationsRemote(allChannels, askCount, [...excludeNames]);
      recs.forEach(r => { if (r?.name) excludeNames.add(r.name); });
      recs = dedupeRecommendations(recs);

      // 첫 라운드는 빠른 1차 렌더(미검증, 검색 링크) → 사용자가 바로 볼 수 있게
      if (round === 0) {
        renderRecommendations(mergeRecommendations([], recs, RECOMMEND_TARGET), watchedRecs);
      }

      // 실제 YouTube 채널로 해석 → channelId + 실제 설명/영상 제목/썸네일
      document.getElementById('aiLoadingText').textContent = '실제 YouTube 채널 정보를 확인하는 중...';
      recs = await enrichRecommendations(recs);
      recs = dedupeRecommendations(recs);
      recs.forEach(r => { if (r?.actualName) excludeNames.add(r.actualName); }); // 실제 이름도 누적 제외

      // 실제 설명·영상으로 분류·사유 재검증 (오분류 교정 + 취향 부적합 제외)
      document.getElementById('aiLoadingText').textContent =
        round === 0 ? '실제 설명·영상으로 추천 분류를 검증하는 중...'
                    : `추천을 ${RECOMMEND_TARGET}개로 채우는 중... (보충 ${round}차)`;
      recs = await verifyRecommendations(recs);

      mergeRecommendations(confirmed, recs, RECOMMEND_TARGET);
      renderRecommendations(confirmed, watchedRecs);
    }

    if (confirmed.length < RECOMMEND_TARGET) {
      // 취향 폭이 좁아 더 못 채운 경우: 가진 만큼만 노출 (best-effort)
      renderRecommendations(confirmed, watchedRecs);
    }
  }
  // 예외는 호출부(runRecommend)의 try/catch/finally가 처리한다 (aiEnd 중복 방지)
}

// 상위 채널(점수 50+, 최대 topN)에 최근 영상 제목을 첨부한 채널 배열을 반환.
// 로그인 상태에서만 동작하며, 실패 시 원본을 그대로 돌려준다.
async function attachVideoTitles(channels, topN = 15) {
  if (!accessToken) return channels;
  const top = channels.filter(c => (c.score || 0) >= 50).slice(0, topN);
  const ids = top.map(c => c.id).filter(Boolean);
  if (!ids.length) return channels;
  const headers = { Authorization: 'Bearer ' + accessToken };
  let titlesById = {};
  try {
    titlesById = await fetchRecentVideoTitles(ids, headers, 6);
  } catch {
    return channels;
  }
  return channels.map(c => (titlesById[c.id] ? { ...c, videoTitles: titlesById[c.id] } : c));
}

async function runPersona() {
  aiStart('Solar LLM이 취향 페르소나를 분석하는 중... (10~20초)');
  try {
    let channels = allChannels;
    // 상위 채널의 최근 영상 제목을 근거로 첨부 (로그인 상태에서만)
    if (accessToken) {
      document.getElementById('aiLoadingText').textContent = '상위 채널의 최근 영상을 살펴보는 중...';
      channels = await attachVideoTitles(allChannels);
      document.getElementById('aiLoadingText').textContent = 'Solar LLM이 취향 페르소나를 분석하는 중... (10~20초)';
    }
    const persona = await fetchPersonaRemote(channels);
    renderPersona(persona);
  } catch (e) {
    showAiError(e.message);
  } finally {
    aiEnd();
  }
}

async function runCleanup() {
  aiStart('Solar LLM이 구독 정리를 분석하는 중... (10~20초)');
  try {
    const data = await fetchCleanupRemote(allChannels);
    renderCleanup(data);
  } catch (e) {
    showAiError(e.message);
  } finally {
    aiEnd();
  }
}

// LLM 추천 결과에 YouTube 실제 채널 정보(썸네일, channelId)를 덧붙인다.
// accessToken이 없으면(데모 모드 등) 원본 그대로 반환.
// 2단계 해석: ① 채널 직접 검색 → ② (실패 시) 영상 검색 후 그 영상의 채널로 폴백.
// 이렇게 하면 사실상 모든 추천이 channelId를 얻어 "채널로 바로 이동" 링크가 된다.
async function resolveRecommendChannel(name, headers) {
  const BASE = 'https://www.googleapis.com/youtube/v3';
  // ① 채널 검색
  try {
    const url = `${BASE}/search?part=snippet&type=channel&maxResults=1&q=${encodeURIComponent(name)}`;
    const res = await fetch(url, { headers });
    if (res.ok) {
      const item = (await res.json()).items?.[0];
      if (item?.id?.channelId) {
        return {
          channelId: item.id.channelId,
          thumbnail: item.snippet?.thumbnails?.default?.url || null,
          actualName: item.snippet?.title || name,
        };
      }
    }
  } catch { /* 폴백으로 진행 */ }
  // ② 영상 검색 → 해당 영상의 채널 (채널 검색이 비는 이름 보강). 썸네일은 영상 것이라 생략.
  try {
    const url = `${BASE}/search?part=snippet&type=video&maxResults=1&q=${encodeURIComponent(name)}`;
    const res = await fetch(url, { headers });
    if (res.ok) {
      const item = (await res.json()).items?.[0];
      if (item?.snippet?.channelId) {
        return {
          channelId: item.snippet.channelId,
          thumbnail: null,
          actualName: item.snippet?.channelTitle || name,
        };
      }
    }
  } catch { /* 해석 실패 → 원본 유지 */ }
  return null;
}

// channelId 배치 → 실제 제목/설명/썸네일 (channels.list, 50개당 1 unit으로 저렴)
async function fetchChannelMeta(ids, headers) {
  const BASE = 'https://www.googleapis.com/youtube/v3';
  const out = {};
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    try {
      const url = `${BASE}/channels?part=snippet&id=${batch.join(',')}&maxResults=50`;
      const res = await fetch(url, { headers });
      if (!res.ok) continue;
      const data = await res.json();
      for (const item of (data.items || [])) {
        out[item.id] = {
          title: item.snippet?.title || '',
          description: (item.snippet?.description || '').slice(0, 300),
          thumbnail: item.snippet?.thumbnails?.default?.url || null,
        };
      }
    } catch { /* 배치 실패는 무시 */ }
  }
  return out;
}

// channelId 배치 → 최근 영상 제목. 검색(100 units) 대신 업로드 재생목록 경유로 채널당 ~2 units.
//   ① channels.list?contentDetails 로 '업로드 재생목록' ID 확보 (50개당 1 unit)
//   ② playlistItems.list 로 최근 영상 제목 수집 (재생목록당 1 unit)
async function fetchRecentVideoTitles(ids, headers, perChannel = 8) {
  const BASE = 'https://www.googleapis.com/youtube/v3';
  const out = {}; // { channelId: [title, ...] }
  const uploads = {}; // channelId → uploadsPlaylistId

  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    try {
      const url = `${BASE}/channels?part=contentDetails&id=${batch.join(',')}&maxResults=50`;
      const res = await fetch(url, { headers });
      if (!res.ok) continue;
      const data = await res.json();
      for (const item of (data.items || [])) {
        const pl = item.contentDetails?.relatedPlaylists?.uploads;
        if (pl) uploads[item.id] = pl;
      }
    } catch { /* 배치 실패는 무시 */ }
  }

  const entries = Object.entries(uploads);
  const BATCH = 10; // 동시 호출 제한
  for (let i = 0; i < entries.length; i += BATCH) {
    const slice = entries.slice(i, i + BATCH);
    await Promise.all(slice.map(async ([cid, pl]) => {
      try {
        const url = `${BASE}/playlistItems?part=snippet&playlistId=${pl}&maxResults=${perChannel}`;
        const res = await fetch(url, { headers });
        if (!res.ok) return;
        const data = await res.json();
        const titles = (data.items || [])
          .map(it => it.snippet?.title)
          .filter(t => t && t !== 'Private video' && t !== 'Deleted video');
        if (titles.length) out[cid] = titles;
      } catch { /* 채널 단위 실패는 무시 */ }
    }));
  }
  return out;
}

async function enrichRecommendations(recs) {
  if (!accessToken || !recs?.length) return recs;
  const headers = { Authorization: 'Bearer ' + accessToken };
  // 1) 추천 이름 → 실제 channelId 해석
  const resolved = await Promise.all(recs.map(async (r) => {
    if (!r?.name) return r;
    const hit = await resolveRecommendChannel(r.name, headers);
    return hit ? { ...r, ...hit } : r;
  }));
  // 2) 해석된 채널의 '실제 설명/제목/썸네일' + '최근 영상 제목'을 확보 (검증·표시의 근거)
  const ids = resolved.map(r => r.channelId).filter(Boolean);
  if (ids.length) {
    const meta = await fetchChannelMeta(ids, headers);
    const titles = await fetchRecentVideoTitles(ids, headers, 8);
    for (const r of resolved) {
      const m = r.channelId && meta[r.channelId];
      if (m) {
        r.actualName = m.title || r.actualName || r.name;
        r.realDescription = m.description || '';
        if (m.thumbnail) r.thumbnail = m.thumbnail;
      }
      if (r.channelId && titles[r.channelId]) r.realVideoTitles = titles[r.channelId];
    }
  }
  return resolved;
}

// 추천 중복 제거: ① 이미 구독 중인 채널(channelId) 제외, ② channelId 중복 제거,
// ③ 정규화된 이름 중복 제거(channelId 미해석분 보강). 먼저 등장한 항목을 유지한다.
function dedupeRecommendations(recs) {
  const subscribedIds = new Set(allChannels.map(c => c.id).filter(Boolean));
  const seenIds = new Set();
  const seenNames = new Set();
  const out = [];
  for (const r of recs) {
    if (!r) continue;
    const id = r.channelId || null;
    if (id && subscribedIds.has(id)) continue;           // 이미 구독 중 → 제외
    if (id) {
      if (seenIds.has(id)) continue;                     // 같은 채널 중복 → 제외
      seenIds.add(id);
    }
    const nameKey = (r.actualName || r.name || '').trim().toLowerCase().replace(/\s+/g, '');
    if (nameKey) {
      if (seenNames.has(nameKey)) continue;              // 같은 이름 중복 → 제외
      seenNames.add(nameKey);
    }
    out.push(r);
  }
  return out;
}

// 추천 검증 호출 (실제 설명 기반 분류·사유 교정)
async function fetchVerifyRemote(candidates, interests) {
  const res = await fetch(`${API_BASE}/api/verify_recommend`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ candidates, interests }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `검증 서버 오류 (${res.status})`);
  return data.results || [];
}

// 실제 설명이 확보된 추천을 재검증: 카테고리/사유를 실제 설명에 맞게 교정하고,
// 취향과 명백히 안 맞는 추천(fit=false)은 제외한다. 실패 시 원본을 그대로 유지(안전).
async function verifyRecommendations(recs) {
  // 실제 설명 또는 최근 영상 제목이 확보된 추천만 검증 가능
  const verifiable = recs.filter(r => r.realDescription || (r.realVideoTitles && r.realVideoTitles.length));
  if (!verifiable.length) return recs;

  // 사용자 취향 컨텍스트: 상위 채널 이름 + 설명
  const interests = allChannels
    .filter(c => (c.score || 0) >= 50)
    .slice(0, 15)
    .map(c => ({ name: c.name, description: (c.description || '').slice(0, 200) }));

  let corrected;
  try {
    corrected = await fetchVerifyRemote(
      verifiable.map(r => ({
        name: r.actualName || r.name,
        description: r.realDescription || '',
        videoTitles: r.realVideoTitles || [],
      })),
      interests,
    );
  } catch {
    return recs; // 검증 실패 시 원본 유지
  }

  const byName = {};
  for (const c of corrected) byName[c.name] = c;

  const result = [];
  for (const r of recs) {
    const c = byName[r.actualName || r.name];
    if (!c) { result.push(r); continue; }          // 검증 결과 없으면 원본 유지
    if (c.fit === false) continue;                  // 취향과 명백히 불일치 → 제외
    result.push({ ...r, category: c.category || r.category, reason: c.reason || r.reason });
  }
  // 전부 걸러졌다면(과도한 제외) 원본 유지로 폴백
  return result.length ? result : recs;
}

// 단일 추천 카드 HTML (발굴 추천·비구독 시청 추천 양쪽에서 공용)
function recommendCardHtml(r) {
  const displayName = escapeHtml(r.actualName || r.name || '이름 없음');
  const category = escapeHtml(r.category || '');
  const reason = escapeHtml(r.reason || '');
  const initial = escapeHtml((r.actualName || r.name || '?').trim().charAt(0).toUpperCase());

  // channelId 있으면 채널로 바로 이동, 없으면 검색 결과로 폴백
  const linkUrl = r.channelId
    ? `https://www.youtube.com/channel/${encodeURIComponent(r.channelId)}`
    : `https://www.youtube.com/results?search_query=${encodeURIComponent(r.name || '')}`;
  const linkLabel = r.channelId ? '채널로 이동 →' : '유튜브에서 찾기 →';

  const thumbHtml = r.thumbnail
    ? `<img class="recommend-thumb" src="${escapeHtml(r.thumbnail)}" alt="${displayName}" loading="lazy"
          onerror="this.outerHTML='<div class=&quot;recommend-thumb recommend-thumb-fallback&quot;>${initial}</div>'"/>`
    : `<div class="recommend-thumb recommend-thumb-fallback">${initial}</div>`;

  return `
    <div class="recommend-card">
      ${thumbHtml}
      <div class="recommend-body">
        <div class="recommend-name">${displayName}</div>
        ${category ? `<div class="recommend-cat">${category}</div>` : ''}
        <div class="recommend-reason">${reason}</div>
      </div>
      <a class="recommend-link" href="${linkUrl}" target="_blank" rel="noopener">${linkLabel}</a>
    </div>`;
}

// recs        : 취향 기반으로 새로 발굴한 채널 (A 경로)
// watchedRecs : 구독 안 했지만 최근 본 채널 (B 경로) — 있으면 별도 섹션을 위에 노출
function renderRecommendations(recs, watchedRecs = []) {
  const out = document.getElementById('aiOutput');
  recs = recs || [];
  if (!recs.length && !watchedRecs.length) {
    out.innerHTML = `<div class="recommend-empty">추천 결과가 없습니다.</div>`;
    return;
  }
  const sectionTitle = (txt, color) =>
    `<div style="font-weight:700;color:${color};margin:2px 2px 10px;font-size:15px;">${txt}</div>`;

  let html = '';
  if (watchedRecs.length) {
    html += sectionTitle('📺 최근 보지만 구독 안 한 채널', 'var(--accent2)');
    html += `<div class="recommend-list">${watchedRecs.map(recommendCardHtml).join('')}</div>`;
  }
  if (recs.length) {
    if (watchedRecs.length) html += sectionTitle('✨ 취향 기반 새 채널 추천', 'var(--accent)');
    html += `<div class="recommend-list">${recs.map(recommendCardHtml).join('')}</div>`;
  }
  out.innerHTML = html;
}

// 시청 취향 페르소나 렌더
function renderPersona(p) {
  const out = document.getElementById('aiOutput');
  if (!p) {
    out.innerHTML = `<div class="recommend-empty">페르소나를 생성하지 못했습니다.</div>`;
    return;
  }
  const interests = (p.topInterests || [])
    .map(i => `<span class="persona-chip">${escapeHtml(i)}</span>`).join('');
  const traits = (p.traits || []).map(t => `
    <div class="persona-trait">
      <div class="persona-trait-label">${escapeHtml(t.label || '')}</div>
      <div class="persona-trait-desc">${escapeHtml(t.desc || '')}</div>
    </div>`).join('');

  out.innerHTML = `
    <div class="persona-card">
      <div class="persona-head">
        <div class="persona-emoji">${escapeHtml(p.emoji || '🎭')}</div>
        <div class="persona-head-text">
          <div class="persona-title">${escapeHtml(p.title || '나의 시청 페르소나')}</div>
          ${interests ? `<div class="persona-chips">${interests}</div>` : ''}
        </div>
      </div>
      ${p.summary ? `<p class="persona-summary">${escapeHtml(p.summary)}</p>` : ''}
      ${traits ? `<div class="persona-traits">${traits}</div>` : ''}
    </div>`;
}

// 구독 정리 코치 렌더
function renderCleanup(data) {
  const out = document.getElementById('aiOutput');
  const items = (data && data.items) || [];
  if (!items.length) {
    out.innerHTML = `<div class="recommend-empty">정리할 휴면·저관심 채널이 없습니다. 깔끔하네요! ✨</div>`;
    return;
  }
  // action 라벨 → 색상 클래스
  const actionCls = { '해제 추천': 'cleanup-drop', '보류 권장': 'cleanup-hold', '유지': 'cleanup-keep' };
  const rows = items.map(it => {
    const cls = actionCls[it.action] || 'cleanup-hold';
    return `
      <div class="cleanup-item ${cls}">
        <div class="cleanup-item-main">
          <div class="cleanup-name">${escapeHtml(it.name || '')}</div>
          <div class="cleanup-reason">${escapeHtml(it.reason || '')}</div>
        </div>
        <div class="cleanup-action">${escapeHtml(it.action || '')}</div>
      </div>`;
  }).join('');
  out.innerHTML = `
    ${data.summary ? `<p class="cleanup-summary">${escapeHtml(data.summary)}</p>` : ''}
    <div class="cleanup-list">${rows}</div>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}

function renderSummary(channels) {
  const top = channels[0];
  const activeCount = channels.filter(c => c.score >= 50).length;
  document.getElementById('summaryGrid').innerHTML = `
    <div class="stat-card">
      <div class="stat-value">${channels.length}</div>
      <div class="stat-label">총 구독 채널</div>
    </div>
    <div class="stat-card">
      <div class="stat-value" style="color:var(--accent)">${top?.name?.slice(0,8) ?? '-'}</div>
      <div class="stat-label">최고 관심도</div>
    </div>
    <div class="stat-card">
      <div class="stat-value" style="color:var(--accent2)">${activeCount}</div>
      <div class="stat-label">적극 교류 채널 (50점+)</div>
    </div>
  `;
}

// ──────────────────────────────────────────
// 취향 커뮤니티(Union-Find 연결요소) + 취향 지도(Kruskal MST) 렌더
// ──────────────────────────────────────────
const CAT_PALETTE = ['#ff4444','#ff8800','#ffcc00','#66cc66','#33bbdd','#7c6cff','#ff66aa','#22aa88','#bb88ff','#88aa44'];
function catColor(cat) {
  const s = String(cat || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return CAT_PALETTE[h % CAT_PALETTE.length];
}

function renderTasteGraph(channels, graph) {
  const section = document.getElementById('tasteGraphSection');
  if (!section) return;
  const comms = (graph && graph.communities) || [];
  const edges = (graph && graph.edges) || [];
  if (!comms.length) { section.style.display = 'none'; return; } // 묶일 커뮤니티가 없으면 숨김
  section.style.display = 'block';

  // 커뮤니티 카드
  document.getElementById('communityList').innerHTML = comms.map(c => `
    <div class="community-card" style="border-left-color:${catColor(c.label)}">
      <div class="community-head">
        <span class="community-label" style="color:${catColor(c.label)}">${escapeHtml(c.label)}</span>
        <span class="community-size">${c.size}개 채널</span>
      </div>
      <div class="community-members">${c.members.map(m => escapeHtml(m)).join(' · ')}</div>
    </div>
  `).join('');

  drawTasteMap(channels, edges); // MST 취향 지도
}

// MST 엣지를 force-directed SVG로 그린다. 커뮤니티에 속한 채널만, 많으면 점수 상위로 캡.
function drawTasteMap(channels, edges) {
  const svg = document.getElementById('tasteMap');
  if (!svg) return;
  const W = 660, H = 460, cx = W / 2, cy = H / 2;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

  const inGraph = channels.filter(c => c.community !== null && c.community !== undefined);
  const CAP = 70;
  let nodes = inGraph, truncated = 0;
  if (nodes.length > CAP) { truncated = nodes.length - CAP; nodes = [...nodes].sort((a,b)=>(b.score||0)-(a.score||0)).slice(0, CAP); }
  const idset = new Set(nodes.map(n => n.id));
  const E = edges.filter(e => idset.has(e.source) && idset.has(e.target));
  if (nodes.length < 2 || !E.length) { svg.innerHTML = ''; return; }

  const N = nodes.length;
  const idx = new Map(nodes.map((n, i) => [n.id, i]));
  // 초기 위치: 원형 배치(결정론적 — 새로고침해도 같은 그림)
  const pos = nodes.map((n, i) => ({
    x: cx + Math.cos(2*Math.PI*i/N) * 170,
    y: cy + Math.sin(2*Math.PI*i/N) * 150, vx: 0, vy: 0,
  }));
  const links = E.map(e => ({ s: idx.get(e.source), t: idx.get(e.target), w: e.weight }));

  // 간단 force 시뮬레이션: 노드 반발(O(n²)) + 엣지 스프링 + 중심 끌림
  for (let it = 0; it < 200; it++) {
    for (let a = 0; a < N; a++) for (let b = a+1; b < N; b++) {
      let dx = pos[a].x-pos[b].x, dy = pos[a].y-pos[b].y;
      let d2 = dx*dx + dy*dy || 0.01, d = Math.sqrt(d2);
      let f = 2600 / d2, fx = f*dx/d, fy = f*dy/d;
      pos[a].vx += fx; pos[a].vy += fy; pos[b].vx -= fx; pos[b].vy -= fy;
    }
    for (const l of links) {
      let A = pos[l.s], B = pos[l.t];
      let dx = B.x-A.x, dy = B.y-A.y, d = Math.sqrt(dx*dx+dy*dy) || 0.01;
      let f = (d - 62) * 0.06, fx = f*dx/d, fy = f*dy/d;
      A.vx += fx; A.vy += fy; B.vx -= fx; B.vy -= fy;
    }
    for (let a = 0; a < N; a++) {
      pos[a].vx += (cx-pos[a].x)*0.004; pos[a].vy += (cy-pos[a].y)*0.004;
      pos[a].x += pos[a].vx*0.82; pos[a].y += pos[a].vy*0.82;
      pos[a].vx *= 0.82; pos[a].vy *= 0.82;
    }
  }
  const pad = 26;
  for (const p of pos) { p.x = Math.max(pad, Math.min(W-pad, p.x)); p.y = Math.max(pad, Math.min(H-pad, p.y)); }

  const svgEdges = links.map(l => {
    const A = pos[l.s], B = pos[l.t];
    return `<line x1="${A.x.toFixed(1)}" y1="${A.y.toFixed(1)}" x2="${B.x.toFixed(1)}" y2="${B.y.toFixed(1)}" stroke="#555" stroke-width="${(0.6 + l.w*1.6).toFixed(2)}" stroke-opacity="0.5"/>`;
  }).join('');
  const svgNodes = nodes.map((n, i) => {
    const p = pos[i], r = 5 + Math.min(10, (n.score||0)/12);
    const showLabel = r >= 8 || N <= 24;
    const name = escapeHtml((n.name||'').slice(0, 10));
    return `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r.toFixed(1)}" fill="${catColor(n.category)}" fill-opacity="0.85" stroke="#0b0b0b" stroke-width="1"><title>${escapeHtml(n.name||'')}</title></circle>`
      + (showLabel ? `<text x="${p.x.toFixed(1)}" y="${(p.y + r + 9).toFixed(1)}" text-anchor="middle" class="taste-map-label">${name}</text>` : '');
  }).join('');
  const note = truncated ? `<text x="${W-8}" y="${H-8}" text-anchor="end" class="taste-map-note">상위 ${CAP}개만 표시 (+${truncated})</text>` : '';
  svg.innerHTML = svgEdges + svgNodes + note;
}

function renderFilterBar() {
  const groups = ['all','🔥 최애 채널','😊 자주 보는 채널','👋 가끔 보는 채널','🌱 구독만 한 채널'];
  const labels = ['전체','🔥 최애','😊 자주','👋 가끔','🌱 구독만'];
  document.getElementById('filterBar').innerHTML = groups.map((g,i) => `
    <button class="filter-tab ${activeFilter===g?'active':''}" onclick="setFilter('${g}')">${labels[i]}</button>
  `).join('');
}

function setFilter(f) {
  activeFilter = f;
  renderFilterBar();
  renderList(allChannels);
}

function renderList(channels) {
  const filtered = activeFilter==='all'
    ? channels
    : channels.filter(c => c.group && c.group.label === activeFilter);
  const list = document.getElementById('channelList');
  if (!filtered.length) {
    list.innerHTML = `<div style="padding:40px;text-align:center;font-family:var(--mono);font-size:12px;color:var(--text3)">해당 그룹에 채널이 없습니다.</div>`;
    return;
  }
  let html='', lastGroup=null;
  filtered.forEach((ch, i) => {
    const g = ch.group || { label:'-', cls:'score-low', bar:'bar-low' };
    if (activeFilter==='all' && g.label!==lastGroup) {
      lastGroup=g.label;
      html+=`<div class="group-header">${g.label}</div>`;
    }
    const d = Math.min(i*40, 400);
    html+=`
      <div class="channel-item" style="animation-delay:${d}ms">
        <div class="rank ${i<3?'top':''}">#${channels.indexOf(ch)+1}</div>
        <div class="channel-thumb">${ch.thumb?`<img src="${ch.thumb}" alt="${ch.name}">`:(ch.emoji||'📺')}</div>
        <div class="channel-info">
          <div class="channel-name">${ch.name}</div>
          <div class="channel-meta">
            ${(ch.category && ch.category !== '채널' && ch.category !== '기타')
              ? `<span class="meta-tag meta-cat"><span class="dot"></span>🏷️ ${escapeHtml(ch.detail || ch.category)}</span>` : ''}
            ${(typeof ch.representativeness === 'number' && ch.representativeness > 0)
              ? `<span class="meta-tag"><span class="dot"></span>🎯 취향 대표성 ${Math.round(ch.representativeness * 100)}%</span>` : ''}
            <span class="meta-tag"><span class="dot"></span>댓글 ${ch.comments}개</span>
            <span class="meta-tag"><span class="dot"></span>좋아요 ${ch.likes}개</span>
            <span class="meta-tag"><span class="dot"></span>구독 ${ch.subMonths}개월</span>
          </div>
          ${(ch.similar && ch.similar.length)
            ? `<div class="channel-similar">🔗 비슷한 채널: ${ch.similar.map(s => escapeHtml(s.name)).join(', ')}</div>` : ''}
        </div>
        <div class="score-section">
          <div class="score-value ${g.cls}">${ch.score}</div>
          <div class="score-bar-wrap"><div class="score-bar ${g.bar}" style="width:${ch.score}%"></div></div>
        </div>
      </div>
    `;
  });
  list.innerHTML = html;
}

// ──────────────────────────────────────────
// Google Takeout 파서 (comments / watch-history) & 채널 해석
// ──────────────────────────────────────────
function detectTakeoutType(filename, sample) {
  const name = (filename || '').toLowerCase();
  if (name.includes('watch') || name.includes('history') || name.includes('시청')) return 'watch';
  if (name.includes('comment') || name.includes('댓글')) return 'comments';
  // 내용 기반 추정
  const head = sample.slice(0, 4000);
  if (head.includes('"titleUrl"') && head.includes('"subtitles"')) return 'watch';
  if (head.match(/Watched\s+<a\s+href=/i)) return 'watch';
  return 'comments';
}

// comments 파일: 영상 ID 추출 → videos.list로 영상→채널 해석
function extractVideoCounts(text) {
  const counts = new Map();
  const urlRe = /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/g;
  let m;
  while ((m = urlRe.exec(text)) !== null) {
    counts.set(m[1], (counts.get(m[1]) || 0) + 1);
  }
  if (counts.size === 0) {
    const cellRe = /(?:^|,|"|\t)([A-Za-z0-9_-]{11})(?=,|"|\t|$|\r|\n)/gm;
    while ((m = cellRe.exec(text)) !== null) {
      counts.set(m[1], (counts.get(m[1]) || 0) + 1);
    }
  }
  return counts;
}

async function resolveVideosToChannels(videoIds) {
  const headers = { Authorization: 'Bearer ' + accessToken };
  const BASE = 'https://www.googleapis.com/youtube/v3';
  const channelByVideo = {};
  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    const url = `${BASE}/videos?part=snippet&id=${batch.join(',')}`;
    try {
      const res = await fetchWithRetry(url, {headers});
      if (!res.ok) continue;
      const data = await res.json();
      for (const item of (data.items || [])) {
        if (item?.id && item?.snippet?.channelId) {
          channelByVideo[item.id] = item.snippet.channelId;
        }
      }
    } catch(e) { /* 배치 단위 실패는 무시 */ }
    setTakeoutStatus('processing', `영상 → 채널 해석 중... (${Math.min(i+50, videoIds.length)} / ${videoIds.length})`);
  }
  return channelByVideo;
}

// watch-history JSON: subtitles[0].url에 channelId가 들어 있어 API 호출 불필요
function parseWatchHistoryJSON(text) {
  const data = JSON.parse(text);
  if (!Array.isArray(data)) throw new Error('watch-history JSON 형식이 아닙니다.');
  const result = {};
  const channelRe = /\/channel\/([A-Za-z0-9_-]+)/;
  for (const entry of data) {
    if (entry?.header && entry.header !== 'YouTube') continue;
    const sub = entry?.subtitles?.[0];
    if (!sub?.url) continue;
    const m = sub.url.match(channelRe);
    if (!m) continue;
    const cid = m[1];
    const t = entry.time ? new Date(entry.time) : null;
    if (!result[cid]) result[cid] = { count: 0, lastDate: null, firstDate: null, name: '', videoTitles: [] };
    result[cid].count++;
    // 채널명(subtitles[0].name) + 시청한 영상 제목(entry.title)을 추가 API 비용 없이 확보
    // → 비구독·최근시청 채널을 추천 근거로 활용 (취향 씨앗 + 직접 추천)
    if (!result[cid].name && sub.name) result[cid].name = sub.name;
    if (entry.title && result[cid].videoTitles.length < 6) {
      const vt = String(entry.title).replace(/\s*을\(를\)\s*시청함\s*$/, '').replace(/^Watched\s+/, '').trim();
      if (vt && !result[cid].videoTitles.includes(vt)) result[cid].videoTitles.push(vt);
    }
    if (t && !isNaN(t.getTime())) {
      if (!result[cid].lastDate || t > result[cid].lastDate) result[cid].lastDate = t;
      if (!result[cid].firstDate || t < result[cid].firstDate) result[cid].firstDate = t;
    }
  }
  return result;
}

// watch-history HTML: 채널 링크만 카운트 (시각 파싱은 locale 의존 → 생략)
function parseWatchHistoryHTML(text) {
  const result = {};
  const channelRe = /href="https:\/\/www\.youtube\.com\/channel\/([A-Za-z0-9_-]+)"/g;
  let m;
  while ((m = channelRe.exec(text)) !== null) {
    const cid = m[1];
    if (!result[cid]) result[cid] = { count: 0, lastDate: null, firstDate: null };
    result[cid].count++;
  }
  return result;
}

function renderTakeoutSummary() {
  const parts = [];
  if (takeoutSummary.comments) {
    const s = takeoutSummary.comments;
    parts.push(`💬 댓글 ${s.total.toLocaleString()}개 → ${s.channels.toLocaleString()}개 채널`);
  }
  if (takeoutSummary.watch) {
    const s = takeoutSummary.watch;
    const dateStr = s.latestDate ? ` · 최근 ${s.latestDate.toISOString().slice(0,10)}` : '';
    parts.push(`📺 시청 ${s.total.toLocaleString()}건 → ${s.channels.toLocaleString()}개 채널${dateStr}`);
  }
  setTakeoutStatus('success', '✅ ' + parts.join('  /  '));
}

async function handleTakeoutFile(input) {
  const file = input?.files?.[0];
  if (!file) return;

  if (!accessToken) {
    setTakeoutStatus('error', '먼저 Google 로그인을 완료해주세요.');
    input.value = '';
    return;
  }

  // 파일 사이즈 가드 (watch-history는 크기 때문에 200MB까지 허용)
  if (file.size > 200 * 1024 * 1024) {
    setTakeoutStatus('error', '파일이 너무 큽니다 (200MB 초과).');
    input.value = '';
    return;
  }

  document.getElementById('takeoutLabel').textContent = `📄 ${file.name}`;
  setTakeoutStatus('processing', '파일 읽는 중...');

  try {
    const text = await file.text();
    const kind = detectTakeoutType(file.name, text);

    if (kind === 'watch') {
      setTakeoutStatus('processing', '시청 기록 파싱 중...');
      const isJson = file.name.toLowerCase().endsWith('.json') || text.trim().startsWith('[');
      const parsed = isJson ? parseWatchHistoryJSON(text) : parseWatchHistoryHTML(text);
      const total = Object.values(parsed).reduce((a, v) => a + v.count, 0);
      const channels = Object.keys(parsed).length;
      if (total === 0) throw new Error('시청 기록 항목을 찾지 못했습니다. watch-history.json/html 이 맞는지 확인해주세요.');

      takeoutWatchByChannel = parsed;
      let latest = null;
      for (const v of Object.values(parsed)) {
        if (v.lastDate && (!latest || v.lastDate > latest)) latest = v.lastDate;
      }
      takeoutSummary.watch = { total, channels, latestDate: latest };
    } else {
      setTakeoutStatus('processing', '영상 ID 추출 중...');
      const videoCounts = extractVideoCounts(text);
      if (videoCounts.size === 0) {
        throw new Error('파일에서 YouTube 영상 ID를 찾지 못했습니다. comments.csv / my-comments.html 이 맞는지 확인해주세요.');
      }
      const videoIds = [...videoCounts.keys()];
      const totalComments = [...videoCounts.values()].reduce((a,b)=>a+b, 0);
      const channelByVideo = await resolveVideosToChannels(videoIds);

      const channelCounts = {};
      for (const [vid, cnt] of videoCounts) {
        const cid = channelByVideo[vid];
        if (cid) channelCounts[cid] = (channelCounts[cid] || 0) + cnt;
      }
      takeoutCommentsByChannel = channelCounts;
      takeoutSummary.comments = { total: totalComments, channels: Object.keys(channelCounts).length };
    }

    document.getElementById('takeoutDrop').classList.add('has-file');
    document.getElementById('takeoutLabel').textContent = '📂 다른 파일 추가';
    renderTakeoutSummary();
    input.value = '';
  } catch(e) {
    document.getElementById('takeoutLabel').textContent = '📂 파일 선택';
    input.value = '';
    setTakeoutStatus('error', '⚠ ' + e.message);
  }
}

function setTakeoutStatus(kind, msg) {
  const el = document.getElementById('takeoutStatus');
  if (!el) return;
  el.className = 'takeout-status ' + (kind || '');
  el.textContent = msg || '';
}

// 페이지 로드 후크: 서버 주입 ID 자동 초기화 + Takeout 드래그&드롭
document.addEventListener('DOMContentLoaded', () => {
  // 1) 서버가 클라이언트 ID를 주입했으면 OAuth 자동 준비
  const cfg = window.__APP_CONFIG__ || {};
  if (cfg.clientId) {
    const pl1 = document.getElementById('pl1');
    if (pl1) pl1.textContent = '설정 완료';
    initOAuth(cfg.clientId);
  }

  // 2) Takeout 박스 드래그&드롭
  const drop = document.getElementById('takeoutDrop');
  const input = document.getElementById('takeoutFile');
  if (!drop || !input) return;
  ['dragenter','dragover'].forEach(ev => drop.addEventListener(ev, e => {
    e.preventDefault(); e.stopPropagation(); drop.classList.add('dragging');
  }));
  ['dragleave','drop'].forEach(ev => drop.addEventListener(ev, e => {
    e.preventDefault(); e.stopPropagation(); drop.classList.remove('dragging');
  }));
  drop.addEventListener('drop', e => {
    const f = e.dataTransfer?.files?.[0];
    if (f) { input.files = e.dataTransfer.files; handleTakeoutFile(input); }
  });
});

// ──────────────────────────────────────────
// 유틸
// ──────────────────────────────────────────
function delay(ms) { return new Promise(r=>setTimeout(r,ms)); }
function showError(msg) { const e=document.getElementById('errorBox'); e.textContent=msg; e.classList.add('active'); }
function hideError() { document.getElementById('errorBox').classList.remove('active'); }
function showGuide() { document.getElementById('modal').classList.add('active'); }
function closeModal() { document.getElementById('modal').classList.remove('active'); }

// 발급 가이드의 도메인 칩 클릭 → 클립보드 복사 + 시각 피드백
async function copyOrigin(el) {
  const text = (el?.textContent || '').trim();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    // 권한 거부/비-HTTPS 폴백: 선택 표시만
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges(); sel.addRange(range);
  }
  const orig = el.textContent;
  el.classList.add('copied');
  el.textContent = '✓ 복사됨';
  setTimeout(() => { el.classList.remove('copied'); el.textContent = orig; }, 1200);
}
