# -*- coding: utf-8 -*-
"""
YouTube 채널 관심도 분석기 - 백엔드 서버 (Flask)

알고리즘 적용:
  - LRU Cache         : 채널 점수 캐싱
  - Heap Sort         : 점수 기준 내림차순 정렬
  - Binary Search     : 점수 → 그룹 라벨 매핑
  - Exponential Decay : 시간 가중치 (지수 평활)
  - Min-Max Normalize : 0~100 점수 정규화

엔드포인트:
  GET  /                → youtube-analyzer.html
  POST /api/analyze     → 채널 배열을 받아 점수/정렬/그룹 분류
  GET  /api/demo        → 샘플 데이터 분석 결과
"""

from flask import Flask, request, jsonify, render_template
from collections import OrderedDict
from dotenv import load_dotenv
import json
import math
import os
import requests

# .env 파일이 있으면 환경변수로 로드 (없으면 조용히 무시)
load_dotenv()

app = Flask(__name__, static_folder="static", static_url_path="", template_folder="static")

# OAuth 클라이언트 ID는 .env 또는 OS 환경변수에서만 읽는다.
# 미설정 시 빈 문자열이 되어 프론트엔드가 자동으로 "사용자 직접 입력" 모드로 폴백한다.
GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "").strip()

# Upstage Solar LLM API
UPSTAGE_API_KEY = os.environ.get("UPSTAGE_API_KEY", "").strip()
UPSTAGE_API_URL = "https://api.upstage.ai/v1/chat/completions"
UPSTAGE_MODEL = "solar-pro2"


# ──────────────────────────────────────────
# LRU Cache (해시맵 + 순서 유지)
# ──────────────────────────────────────────
class LRUCache:
    def __init__(self, capacity):
        self.capacity = capacity
        self.cache = OrderedDict()

    def get(self, key):
        if key not in self.cache:
            return None
        self.cache.move_to_end(key)
        return self.cache[key]

    def set(self, key, value):
        if key in self.cache:
            self.cache.move_to_end(key)
        elif len(self.cache) >= self.capacity:
            self.cache.popitem(last=False)
        self.cache[key] = value


score_cache = LRUCache(500)


# ──────────────────────────────────────────
# 점수 계산 알고리즘
# ──────────────────────────────────────────
def calc_raw_score(ch):
    """활동(댓글·좋아요·시청) 기반 원시 점수.
    활동이 전혀 없으면 0점 → "구독만 해둔 휴면 채널" 자동 강등.
    """
    comments = ch.get("comments", 0)
    likes = ch.get("likes", 0)
    watches = ch.get("watchCount", 0)
    activity = (comments * 5) + (likes * 2) + (watches * 3)
    if activity == 0:
        return 0
    # 장기 구독 보너스: 최대 2년까지만 인정, 가중치 0.5
    sub_bonus = min(ch.get("subMonths", 0), 24) * 0.5
    return activity + sub_bonus


def apply_recency_decay(score, last_watch_days, lambda_r=0.005):
    """마지막 시청 후 경과일에 비례한 지수 감쇠.
    last_watch_days=None → Takeout 시청 기록 없음 → 감쇠 미적용(현 상태 유지).
    """
    if score == 0 or last_watch_days is None:
        return score
    if last_watch_days < 0:
        last_watch_days = 0
    return score * math.exp(-lambda_r * last_watch_days)


def normalize(scores):
    if not scores:
        return []
    mn, mx = min(scores), max(scores)
    if mx == mn:
        return [50] * len(scores)
    return [round((s - mn) / (mx - mn) * 100) for s in scores]


# ──────────────────────────────────────────
# Heap Sort (점수 내림차순)
# ──────────────────────────────────────────
def _heapify(arr, n, i):
    largest = i
    l, r = 2 * i + 1, 2 * i + 2
    if l < n and arr[l]["score"] > arr[largest]["score"]:
        largest = l
    if r < n and arr[r]["score"] > arr[largest]["score"]:
        largest = r
    if largest != i:
        arr[i], arr[largest] = arr[largest], arr[i]
        _heapify(arr, n, largest)


def heap_sort_desc(channels):
    a = list(channels)
    n = len(a)
    for i in range(n // 2 - 1, -1, -1):
        _heapify(a, n, i)
    for i in range(n - 1, 0, -1):
        a[0], a[i] = a[i], a[0]
        _heapify(a, i, 0)
    a.reverse()
    return a


# ──────────────────────────────────────────
# Binary Search 기반 그룹 분류
# ──────────────────────────────────────────
GROUP_BOUNDARIES = [20, 50, 80]
GROUP_LABELS = [
    {"label": "🌱 구독만 한 채널", "cls": "score-low",  "bar": "bar-low"},
    {"label": "👋 가끔 보는 채널", "cls": "score-mid",  "bar": "bar-mid"},
    {"label": "😊 자주 보는 채널", "cls": "score-high", "bar": "bar-high"},
    {"label": "🔥 최애 채널",      "cls": "score-top",  "bar": "bar-top"},
]


def get_group(score):
    lo, hi = 0, len(GROUP_BOUNDARIES)
    while lo < hi:
        mid = (lo + hi) // 2
        if score < GROUP_BOUNDARIES[mid]:
            hi = mid
        else:
            lo = mid + 1
    return GROUP_LABELS[lo]


# ──────────────────────────────────────────
# 분석 파이프라인
# ──────────────────────────────────────────
def analyze_channels(channels):
    # 캐시 키는 채널 ID에 활동·최근성 신호를 합쳐 생성 — 입력값 바뀌면 자동 무효화
    raw_scores = []
    for ch in channels:
        key = (
            ch["id"],
            ch.get("comments", 0),
            ch.get("likes", 0),
            ch.get("watchCount", 0),
            ch.get("subMonths", 0),
            ch.get("lastWatchDays"),
        )
        cached = score_cache.get(key)
        if cached is not None:
            raw_scores.append(cached)
        else:
            val = apply_recency_decay(calc_raw_score(ch), ch.get("lastWatchDays"))
            score_cache.set(key, val)
            raw_scores.append(val)

    normalized = normalize(raw_scores)
    scored = []
    for i, ch in enumerate(channels):
        s = normalized[i]
        scored.append({**ch, "score": s, "group": get_group(s)})
    return heap_sort_desc(scored)


# ──────────────────────────────────────────
# 샘플 데이터
# ──────────────────────────────────────────
DEMO_CHANNELS = [
    {"id": "UC1",  "name": "코딩하는 오리",       "emoji": "🦆", "thumb": None, "subMonths": 38, "comments": 47, "likes": 183, "category": "개발"},
    {"id": "UC2",  "name": "테크 인사이드",       "emoji": "💡", "thumb": None, "subMonths": 22, "comments": 12, "likes": 76,  "category": "IT"},
    {"id": "UC3",  "name": "알고리즘 마스터",      "emoji": "🧮", "thumb": None, "subMonths": 48, "comments": 63, "likes": 201, "category": "개발"},
    {"id": "UC4",  "name": "드로잉 다이어리",      "emoji": "🎨", "thumb": None, "subMonths": 14, "comments": 3,  "likes": 22,  "category": "아트"},
    {"id": "UC5",  "name": "일상 브이로그",       "emoji": "📷", "thumb": None, "subMonths": 6,  "comments": 1,  "likes": 8,   "category": "라이프"},
    {"id": "UC6",  "name": "CS 강의실",          "emoji": "📚", "thumb": None, "subMonths": 60, "comments": 88, "likes": 312, "category": "개발"},
    {"id": "UC7",  "name": "음악 작업실",         "emoji": "🎵", "thumb": None, "subMonths": 8,  "comments": 0,  "likes": 14,  "category": "음악"},
    {"id": "UC8",  "name": "요리 연구소",         "emoji": "🍳", "thumb": None, "subMonths": 18, "comments": 5,  "likes": 31,  "category": "요리"},
    {"id": "UC9",  "name": "사이드 프로젝트 TV",   "emoji": "🚀", "thumb": None, "subMonths": 30, "comments": 29, "likes": 97,  "category": "개발"},
    {"id": "UC10", "name": "경제 읽는 남자",      "emoji": "📈", "thumb": None, "subMonths": 24, "comments": 7,  "likes": 44,  "category": "경제"},
    {"id": "UC11", "name": "독서 클럽",          "emoji": "📖", "thumb": None, "subMonths": 10, "comments": 2,  "likes": 11,  "category": "교육"},
    {"id": "UC12", "name": "여행 스케치",         "emoji": "✈️", "thumb": None, "subMonths": 4,  "comments": 0,  "likes": 5,   "category": "여행"},
    {"id": "UC13", "name": "리액트 깊이 파기",    "emoji": "⚛️", "thumb": None, "subMonths": 36, "comments": 41, "likes": 158, "category": "개발"},
    {"id": "UC14", "name": "헬스 루틴",          "emoji": "💪", "thumb": None, "subMonths": 7,  "comments": 1,  "likes": 9,   "category": "건강"},
    {"id": "UC15", "name": "스타트업 이야기",     "emoji": "🏢", "thumb": None, "subMonths": 20, "comments": 15, "likes": 52,  "category": "비즈니스"},
]


# ──────────────────────────────────────────
# 라우트
# ──────────────────────────────────────────
@app.route("/")
def index():
    return render_template("youtube-analyzer.html", client_id=GOOGLE_CLIENT_ID)


@app.route("/api/analyze", methods=["POST"])
def api_analyze():
    data = request.get_json(silent=True) or {}
    channels = data.get("channels", [])
    if not isinstance(channels, list):
        return jsonify({"error": "channels must be a list"}), 400
    return jsonify({"channels": analyze_channels(channels)})


@app.route("/api/demo", methods=["GET"])
def api_demo():
    return jsonify({"channels": analyze_channels(DEMO_CHANNELS)})


# ──────────────────────────────────────────
# LLM 추천 (Upstage Solar)
# ──────────────────────────────────────────
RECOMMEND_SYSTEM_PROMPT = """당신은 YouTube 채널 큐레이터입니다.
사용자가 좋아하는 채널 목록을 받으면, 그 사용자의 취향에 맞는 새로운 YouTube 채널 10개를 추천합니다.

규칙:
1. 사용자가 이미 구독 중인 채널은 절대 포함하지 마세요.
2. 다양한 카테고리를 섞되, 사용자의 상위 관심사를 우선 반영하세요.
3. 가능한 한 실제로 존재하는 채널을 추천하세요.
4. 추천 이유는 한 줄(40자 내외)로 구체적으로 작성하세요.
5. 반드시 JSON 형식으로만 응답하세요.

응답 형식:
{
  "recommendations": [
    {"name": "채널명", "category": "카테고리", "reason": "추천 이유"}
  ]
}"""


def build_recommend_user_prompt(top_channels, all_subscribed_names):
    top_lines = [
        f"- {c['name']} ({c.get('category', '분류 없음')}, 점수 {c.get('score', '?')})"
        for c in top_channels
    ]
    # 토큰 절약을 위해 구독 채널은 이름만, 너무 많으면 잘라낸다
    subscribed_preview = ", ".join(all_subscribed_names[:100])
    if len(all_subscribed_names) > 100:
        subscribed_preview += f" 외 {len(all_subscribed_names) - 100}개"

    return f"""[사용자가 좋아하는 상위 채널]
{chr(10).join(top_lines)}

[이미 구독 중인 채널 (추천에서 제외)]
{subscribed_preview}

위 사용자의 취향에 맞는 새로운 YouTube 채널 10개를 추천해주세요."""


def call_solar_recommend(top_channels, all_subscribed_names):
    if not UPSTAGE_API_KEY:
        return None, "UPSTAGE_API_KEY가 설정되지 않았습니다. .env 파일을 확인하세요."

    payload = {
        "model": UPSTAGE_MODEL,
        "messages": [
            {"role": "system", "content": RECOMMEND_SYSTEM_PROMPT},
            {"role": "user", "content": build_recommend_user_prompt(top_channels, all_subscribed_names)},
        ],
        "response_format": {"type": "json_object"},
        "temperature": 0.7,
    }
    headers = {
        "Authorization": f"Bearer {UPSTAGE_API_KEY}",
        "Content-Type": "application/json",
    }

    try:
        resp = requests.post(UPSTAGE_API_URL, headers=headers, json=payload, timeout=30)
    except requests.RequestException as e:
        return None, f"Solar API 호출 실패: {e}"

    if resp.status_code != 200:
        return None, f"Solar API 오류 ({resp.status_code}): {resp.text[:200]}"

    try:
        data = resp.json()
        content = data["choices"][0]["message"]["content"]
        parsed = json.loads(content)
        recs = parsed.get("recommendations", [])
        return recs, None
    except (KeyError, json.JSONDecodeError, IndexError) as e:
        return None, f"Solar 응답 파싱 실패: {e}"


@app.route("/api/recommend", methods=["POST"])
def api_recommend():
    data = request.get_json(silent=True) or {}
    channels = data.get("channels", [])
    if not isinstance(channels, list) or not channels:
        return jsonify({"error": "channels 배열이 비어있습니다."}), 400

    # 점수 50 이상 채널만 LLM에 전달 (최애 + 자주 보는 채널)
    top_channels = [c for c in channels if c.get("score", 0) >= 50]
    if not top_channels:
        return jsonify({"error": "점수 50 이상인 채널이 없어 추천을 생성할 수 없습니다."}), 400

    all_names = [c.get("name", "") for c in channels if c.get("name")]

    recs, err = call_solar_recommend(top_channels, all_names)
    if err:
        return jsonify({"error": err}), 502
    return jsonify({"recommendations": recs})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    if GOOGLE_CLIENT_ID:
        print(f"[config] GOOGLE_CLIENT_ID 감지됨 (...{GOOGLE_CLIENT_ID[-16:]}) -> 자동 OAuth 모드")
    else:
        print("[config] GOOGLE_CLIENT_ID 미설정 -> 사용자가 직접 클라이언트 ID 입력")

    # 외부 브라우저(Edge/Chrome 등 OS 기본 브라우저) 자동 실행.
    # reloader 부모 프로세스에서만 → python app.py 호출당 단 1회만 열림 (파일 저장 시 reload돼도 새 탭 안 열림).
    if os.environ.get("WERKZEUG_RUN_MAIN") != "true":
        import threading, webbrowser
        threading.Timer(1.5, lambda: webbrowser.open(f"http://localhost:{port}")).start()

    # 자식(실제 서버) 시작 시점에 수동 클릭용 URL 한 줄도 출력 (자동 실행 실패 대비 폴백).
    if os.environ.get("WERKZEUG_RUN_MAIN") == "true":
        import threading
        threading.Timer(
            0.5,
            lambda: print(f"   >> 브라우저에서 열기 (Ctrl+클릭): http://localhost:{port}", flush=True),
        ).start()

    app.run(host="127.0.0.1", port=port, debug=True)
