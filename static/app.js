// ──────────────────────────────────────────
// 상태
// ──────────────────────────────────────────
let accessToken = null;
let clientId = '';
let userInfo = null;
let allChannels = [];
let activeFilter = 'all';
// Takeout 업로드로 산출한 채널별 댓글 수. null = 미업로드 → API 근사로 폴백
let takeoutCommentsByChannel = null;
// Takeout 시청 기록 → { [channelId]: { count, lastDate, firstDate } }
let takeoutWatchByChannel = null;
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
  return data.channels;
}

async function fetchDemoRemote() {
  const res = await fetch(`${API_BASE}/api/demo`);
  if (!res.ok) throw new Error(`데모 서버 오류 (${res.status})`);
  const data = await res.json();
  return data.channels;
}

// LLM 추천 호출 (Upstage Solar)
async function fetchRecommendationsRemote(channels) {
  const res = await fetch(`${API_BASE}/api/recommend`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channels }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `추천 서버 오류 (${res.status})`);
  return data.recommendations || [];
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
      });
    }
    pageToken = data.nextPageToken || '';
  } while (pageToken);

  if (subs.length === 0) throw new Error('구독 채널이 없거나 데이터를 가져올 수 없습니다.');

  // 내 채널 ID (댓글 작성자 매칭용)
  let myChannelId = null;
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
        } else {
          // HTML 포맷 → 시각 미상. 구독 기간만큼 dormant 보수적 추정
          ch.lastWatchDays = (ch.subMonths || 0) * 30;
        }
      } else {
        // Takeout이 있는데 이 채널은 시청 0건 → 구독 전체 기간 휴면
        ch.watchCount = 0;
        ch.lastWatchDays = (ch.subMonths || 0) * 30;
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
  renderFilterBar(channels);
  renderList(channels);
  resetRecommendations();
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
// LLM 추천 (Upstage Solar)
// ──────────────────────────────────────────
function resetRecommendations() {
  document.getElementById('recommendList').innerHTML = '';
  document.getElementById('recommendError').style.display = 'none';
  document.getElementById('recommendLoading').style.display = 'none';
  const fab = document.getElementById('recommendFab');
  fab.disabled = false;
  fab.querySelector('.recommend-fab-label').textContent = 'AI 추천';
}

async function requestRecommendations() {
  if (!allChannels.length) return;
  const fab = document.getElementById('recommendFab');
  const fabLabel = fab.querySelector('.recommend-fab-label');
  const loading = document.getElementById('recommendLoading');
  const errBox = document.getElementById('recommendError');
  const list = document.getElementById('recommendList');

  fab.disabled = true;
  fabLabel.textContent = '생성 중';
  loading.style.display = 'flex';
  errBox.style.display = 'none';
  list.innerHTML = '';

  // 추천 섹션으로 부드럽게 스크롤
  document.getElementById('recommendSection').scrollIntoView({ behavior: 'smooth', block: 'start' });

  try {
    let recs = await fetchRecommendationsRemote(allChannels);
    // 1차 렌더(이니셜 + 검색 링크) → 사용자가 결과를 바로 볼 수 있게
    renderRecommendations(recs);
    // 백그라운드로 YouTube search 호출해서 썸네일/채널 URL 채워 넣기
    recs = await enrichRecommendations(recs);
    renderRecommendations(recs);
    fabLabel.textContent = '다시 추천';
  } catch (e) {
    errBox.textContent = '⚠️ ' + e.message;
    errBox.style.display = 'block';
    fabLabel.textContent = '다시 시도';
  } finally {
    fab.disabled = false;
    loading.style.display = 'none';
  }
}

// LLM 추천 결과에 YouTube 실제 채널 정보(썸네일, channelId)를 덧붙인다.
// accessToken이 없으면(데모 모드 등) 원본 그대로 반환.
async function enrichRecommendations(recs) {
  if (!accessToken || !recs?.length) return recs;
  const BASE = 'https://www.googleapis.com/youtube/v3';
  const headers = { Authorization: 'Bearer ' + accessToken };
  return Promise.all(recs.map(async (r) => {
    if (!r?.name) return r;
    try {
      const url = `${BASE}/search?part=snippet&type=channel&maxResults=1&q=${encodeURIComponent(r.name)}`;
      const res = await fetch(url, { headers });
      if (!res.ok) return r;
      const data = await res.json();
      const item = data.items?.[0];
      if (!item) return r;
      return {
        ...r,
        channelId: item.id?.channelId || null,
        thumbnail: item.snippet?.thumbnails?.default?.url || null,
        actualName: item.snippet?.title || r.name,
      };
    } catch {
      return r;
    }
  }));
}

function renderRecommendations(recs) {
  const list = document.getElementById('recommendList');
  if (!recs || !recs.length) {
    list.innerHTML = `<div class="recommend-empty">추천 결과가 없습니다.</div>`;
    return;
  }
  list.innerHTML = recs.map((r) => {
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
      </div>
    `;
  }).join('');
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
            <span class="meta-tag"><span class="dot"></span>댓글 ${ch.comments}개</span>
            <span class="meta-tag"><span class="dot"></span>좋아요 ${ch.likes}개</span>
            <span class="meta-tag"><span class="dot"></span>구독 ${ch.subMonths}개월</span>
          </div>
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
    if (!result[cid]) result[cid] = { count: 0, lastDate: null, firstDate: null };
    result[cid].count++;
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
