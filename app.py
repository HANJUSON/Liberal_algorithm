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
import logging
import math
import os
import re
import requests
import yaml

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
def _rank_key(ch):
    """정렬 우선순위 키.
    1차: 점수 내림차순, 2차: 구독 기간 내림차순(= 구독 시작일이 빠른 순),
    3차: 원래 입력 순서 보존(heap_sort_desc가 _order를 부여) → 동점도 결정론적 = 안정 정렬.
    """
    return (ch["score"], ch.get("subMonths", 0), -ch.get("_order", 0))


def _heapify(arr, n, i):
    largest = i
    l, r = 2 * i + 1, 2 * i + 2
    if l < n and _rank_key(arr[l]) > _rank_key(arr[largest]):
        largest = l
    if r < n and _rank_key(arr[r]) > _rank_key(arr[largest]):
        largest = r
    if largest != i:
        arr[i], arr[largest] = arr[largest], arr[i]
        _heapify(arr, n, largest)


def heap_sort_desc(channels):
    a = list(channels)
    n = len(a)
    # 안정 정렬 보장용 입력 순서 인덱스 — 점수·구독기간이 모두 같아도 원래 순서를 유지한다.
    for idx, ch in enumerate(a):
        ch["_order"] = idx
    for i in range(n // 2 - 1, -1, -1):
        _heapify(a, n, i)
    for i in range(n - 1, 0, -1):
        a[0], a[i] = a[i], a[0]
        _heapify(a, i, 0)
    a.reverse()
    for ch in a:
        ch.pop("_order", None)  # 응답 객체에 내부용 인덱스를 남기지 않는다
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
# 카테고리 분류 (키워드 매칭 기반·결정론적)
#   채널의 name + description(+ 최근 영상 제목)에 category_list.yaml의
#   키워드를 매칭해 "카테고리"(대분류)와 "상세"(소분류)를 판정한다.
#   추가 API/LLM 호출 없음 → 같은 입력이면 항상 같은 결과, 비용 0.
# ──────────────────────────────────────────
CATEGORY_LIST_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "category_list.yaml")
# 어느 카테고리에도 매칭되지 않은 채널에 부여할 라벨
UNCLASSIFIED_CATEGORY = "기타"


def load_category_list(path=CATEGORY_LIST_PATH):
    """category_list.yaml을 읽어 분류기가 바로 쓸 수 있는 형태로 컴파일한다.

    반환: {version, top_n, rules:[(category, detail, keyword, weight, pattern)]}
      - pattern is None  → 한국어 키워드: 부분 문자열 매칭
      - pattern is regex → 영어/숫자 키워드: 단어 경계 매칭(오탐 방지)
    """
    with open(path, encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}

    weights = data.get("weights") or {}
    w_core = float(weights.get("core", 3))
    w_general = float(weights.get("general", 1))
    top_n = int(data.get("top_n", 3))
    stopwords = {str(s).strip().lower() for s in (data.get("stopwords") or []) if str(s).strip()}

    rules = []
    for category, details in (data.get("categories") or {}).items():
        for detail, kw_groups in (details or {}).items():
            for group, weight in (("core", w_core), ("general", w_general)):
                for kw in ((kw_groups or {}).get(group) or []):
                    k = str(kw).strip().lower()
                    if not k or k in stopwords:
                        continue
                    if k.isascii():
                        # 영어/숫자는 단어 경계로만 매칭("ai"가 "email"에 걸리지 않도록)
                        pattern = re.compile(r"(?<![a-z0-9])" + re.escape(k) + r"(?![a-z0-9])")
                    else:
                        pattern = None  # 한국어는 부분 문자열 매칭
                    rules.append((category, detail, k, weight, pattern))

    return {"version": data.get("version", 0), "top_n": top_n, "rules": rules}


# 서버 시작 시 1회 로드 (이후 매 분석 요청은 메모리의 컴파일 결과만 사용)
CATEGORY_LIST = load_category_list()
CATEGORY_VERSION = CATEGORY_LIST["version"]
logging.getLogger(__name__).info(
    "[classify] 카테고리 목록 v%s 로드 (규칙 %d개)", CATEGORY_VERSION, len(CATEGORY_LIST["rules"])
)


def classify_channel(ch, model=CATEGORY_LIST):
    """채널 1개를 분류해 {category, detail, categoryScores}를 반환한다.

    categoryScores는 0이 아닌 상위 N개 카테고리를 합이 1이 되도록 정규화한 벡터
    (예: {"개발/IT": 0.62, "교육": 0.38}). category는 그 argmax, detail은
    대표 카테고리 안에서 점수가 가장 높은 상세다. 매칭이 전혀 없으면 "기타".
    """
    parts = [ch.get("name") or "", ch.get("description") or ""]
    titles = ch.get("videoTitles")
    if isinstance(titles, list):
        parts.extend(str(t) for t in titles)
    text = " ".join(parts).lower()

    cat_scores = {}
    detail_scores = {}
    for category, detail, kw, weight, pattern in model["rules"]:
        hit = (kw in text) if pattern is None else (pattern.search(text) is not None)
        if not hit:
            continue
        cat_scores[category] = cat_scores.get(category, 0) + weight
        dkey = (category, detail)
        detail_scores[dkey] = detail_scores.get(dkey, 0) + weight

    if not cat_scores:
        return {"category": UNCLASSIFIED_CATEGORY, "detail": "", "categoryScores": {}}

    # 대표 카테고리: argmax. 동점이면 목록(파일) 정의 순서가 앞선 쪽이 이긴다(삽입순 유지).
    top_cat = max(cat_scores, key=lambda c: cat_scores[c])

    # 대표 상세: 대표 카테고리 안에서 점수가 가장 높은 상세
    top_detail, best = "", -1
    for (category, detail), score in detail_scores.items():
        if category == top_cat and score > best:
            best, top_detail = score, detail

    # 0이 아닌 상위 N개를 합이 1이 되도록 정규화
    top_items = sorted(cat_scores.items(), key=lambda x: -x[1])[: model["top_n"]]
    total = sum(s for _, s in top_items)
    vector = {c: round(s / total, 2) for c, s in top_items} if total else {}
    return {"category": top_cat, "detail": top_detail, "categoryScores": vector}


# 분류 결과 캐시. 키에 CATEGORY_VERSION을 포함 → 목록(파일)을 고쳐 version을 올리면 자동 무효화.
classify_cache = LRUCache(1000)


def classify_cached(ch):
    titles = ch.get("videoTitles")
    key = (
        CATEGORY_VERSION,
        ch.get("id"),
        ch.get("name") or "",
        ch.get("description") or "",
        tuple(titles) if isinstance(titles, list) else (),
    )
    cached = classify_cache.get(key)
    if cached is not None:
        return cached
    val = classify_channel(ch)
    classify_cache.set(key, val)
    return val


# ──────────────────────────────────────────
# 코사인 유사도 + 그래프 알고리즘 (카테고리 벡터 기반)
#   분류 결과 categoryScores 벡터를 재사용 → 추가 API 호출 없이:
#     - representativeness: 취향 중심(centroid) 대비 채널 대표성 (0~1)
#     - similar: 카테고리적으로 가장 비슷한 채널 Top N
#     - 방법1) Union-Find 연결요소 → "취향 커뮤니티"
#     - 방법2) Kruskal 최대 신장 포레스트 → "취향 지도"(MST 엣지)
#   유사도가 threshold 이상인 채널쌍을 가중 그래프의 엣지로 본다.
# ──────────────────────────────────────────
SIMILARITY_EDGE_THRESHOLD = 0.35  # 그래프 엣지로 인정할 최소 코사인 유사도


def cosine_similarity(v1, v2):
    """두 희소 카테고리 벡터(dict)의 코사인 유사도. 빈 벡터/무교집합이면 0."""
    if not v1 or not v2:
        return 0.0
    dot = sum(w * v2[k] for k, w in v1.items() if k in v2)
    if dot == 0.0:
        return 0.0
    n1 = math.sqrt(sum(w * w for w in v1.values()))
    n2 = math.sqrt(sum(w * w for w in v2.values()))
    if n1 == 0.0 or n2 == 0.0:
        return 0.0
    return dot / (n1 * n2)


class UnionFind:
    """서로소 집합 — 경로 압축(path halving) + 랭크 합치기. 거의 O(α(n))≈O(1)."""
    def __init__(self, n):
        self.parent = list(range(n))
        self.rank = [0] * n

    def find(self, x):
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra == rb:
            return False
        if self.rank[ra] < self.rank[rb]:
            ra, rb = rb, ra
        self.parent[rb] = ra
        if self.rank[ra] == self.rank[rb]:
            self.rank[ra] += 1
        return True


def attach_similarity_and_graph(scored, top_k=3, threshold=SIMILARITY_EDGE_THRESHOLD):
    """채널에 representativeness/similar/community를 얹고, 취향 그래프를 반환한다.
    반환: {"communities": [...], "edges": [MST 엣지...]} — 점수·정렬엔 영향 없음.
    """
    n = len(scored)
    vecs = [ch.get("categoryScores") or {} for ch in scored]

    # 취향 중심(centroid): 활동 점수로 가중 합산. 전부 0점이면 균등 가중으로 폴백.
    centroid = {}
    for ch, v in zip(scored, vecs):
        w = ch.get("score", 0)
        if w <= 0 or not v:
            continue
        for k, val in v.items():
            centroid[k] = centroid.get(k, 0.0) + w * val
    if not centroid:
        for v in vecs:
            for k, val in v.items():
                centroid[k] = centroid.get(k, 0.0) + val
    for ch, v in zip(scored, vecs):
        ch["representativeness"] = round(cosine_similarity(v, centroid), 2) if v else 0.0

    # 단일 O(n²) 패스: per-node 유사도 + 그래프 엣지(>= threshold) 동시 수집
    sims = [[] for _ in range(n)]
    edges = []  # (sim, i, j)
    for i in range(n):
        vi = vecs[i]
        if not vi:
            continue
        for j in range(i + 1, n):
            vj = vecs[j]
            if not vj:
                continue
            s = cosine_similarity(vi, vj)
            if s <= 0:
                continue
            sims[i].append((s, j))
            sims[j].append((s, i))
            if s >= threshold:
                edges.append((s, i, j))

    for i, ch in enumerate(scored):
        top = sorted(sims[i], key=lambda x: (-x[0], scored[x[1]].get("name") or ""))[:top_k]
        ch["similar"] = [
            {"id": scored[j].get("id"), "name": scored[j].get("name"), "similarity": round(s, 2)}
            for s, j in top
        ]

    # ── 방법 1: Union-Find 연결요소 → 취향 커뮤니티 ──
    uf = UnionFind(n)
    for s, i, j in edges:
        uf.union(i, j)
    comp_map = {}
    for idx in range(n):
        comp_map.setdefault(uf.find(idx), []).append(idx)
    comps = sorted((m for m in comp_map.values() if len(m) >= 2), key=len, reverse=True)

    for ch in scored:
        ch["community"] = None  # 단독(같은 취향 이웃 없음) 채널은 커뮤니티 없음
    communities = []
    for cid, members in enumerate(comps):
        cat_count = {}
        for m in members:
            c = scored[m].get("category") or UNCLASSIFIED_CATEGORY
            cat_count[c] = cat_count.get(c, 0) + 1
            scored[m]["community"] = cid
        label = max(cat_count, key=lambda c: cat_count[c])  # 대표 카테고리 = 최빈값
        top_idx = max(members, key=lambda m: scored[m].get("score", 0))
        communities.append({
            "id": cid,
            "label": label,
            "size": len(members),
            "topChannel": scored[top_idx].get("name"),
            "members": [scored[m].get("name") for m in members],
        })

    # ── 방법 2: Kruskal 최대 신장 포레스트 → 취향 지도(MST 엣지) ──
    # 유사도 내림차순으로 강한 엣지부터 채택, 사이클이면 버림 → 커뮤니티별 트리.
    uf2 = UnionFind(n)
    mst_edges = []
    for s, i, j in sorted(edges, key=lambda e: -e[0]):
        if uf2.union(i, j):
            mst_edges.append({
                "source": scored[i].get("id"),
                "target": scored[j].get("id"),
                "weight": round(s, 2),
            })

    return {"communities": communities, "edges": mst_edges}


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
    unclassified = 0
    for i, ch in enumerate(channels):
        s = normalized[i]
        # 키워드 매칭 분류 결과를 채널 객체에 얹는다(점수/정렬 로직은 그대로).
        # category/detail/categoryScores가 기존 하드코딩 '채널'을 대체한다.
        cls = classify_cached(ch)
        if cls["category"] == UNCLASSIFIED_CATEGORY:
            unclassified += 1
        scored.append({**ch, "score": s, "group": get_group(s), **cls})

    # 미분류 비율을 로그로 — 높으면 category_list.yaml 키워드 보강이 필요하다는 신호.
    if channels:
        ratio = unclassified / len(channels) * 100
        app.logger.info(
            "[classify] 미분류 %d/%d (%.1f%%) · 카테고리 목록 v%s",
            unclassified, len(channels), ratio, CATEGORY_VERSION,
        )

    # 카테고리 벡터 기반 코사인 유사도 + 그래프(취향 커뮤니티/지도)를 얹는다.
    graph = attach_similarity_and_graph(scored)
    if channels:
        app.logger.info(
            "[graph] 취향 커뮤니티 %d개 · MST 엣지 %d개",
            len(graph["communities"]), len(graph["edges"]),
        )
    return heap_sort_desc(scored), graph


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
    sorted_ch, graph = analyze_channels(channels)
    return jsonify({"channels": sorted_ch, "graph": graph})


@app.route("/api/demo", methods=["GET"])
def api_demo():
    sorted_ch, graph = analyze_channels(DEMO_CHANNELS)
    return jsonify({"channels": sorted_ch, "graph": graph})


# ──────────────────────────────────────────
# LLM 추천 (Upstage Solar)
# ──────────────────────────────────────────
RECOMMEND_SYSTEM_PROMPT = """당신은 YouTube 채널 큐레이터입니다.
사용자가 좋아하는 채널 목록을 받으면, 그 사용자의 취향에 맞는 새로운 YouTube 채널을 요청한 개수만큼 추천합니다.

규칙:
1. 사용자가 이미 구독 중인 채널은 절대 포함하지 마세요.
2. 다양한 카테고리를 섞되, 사용자의 상위 관심사를 우선 반영하세요.
3. 가능한 한 실제로 존재하는 채널을 추천하세요.
4. **각 채널의 성격은 제공된 '설명'에만 근거해 파악하세요.** 설명이 없으면 채널의 장르·콘텐츠를
   임의로 추측하지 말고, 채널명에서 확실히 드러나는 정보만 사용하세요.
5. **추천 이유에서 사용자의 기존 채널을 언급할 때, 설명에 근거가 없는 장르·콘텐츠를 단정하지 마세요**
   (예: 설명에 자동차 언급이 없는데 "자동차 리뷰 채널"이라고 규정 금지). 확신이 없으면 그 채널을 언급하지 마세요.
6. 추천 이유는 한 줄(40자 내외)로 구체적으로 작성하세요.
7. 반드시 JSON 형식으로만 응답하세요.

응답 형식:
{
  "recommendations": [
    {"name": "채널명", "category": "카테고리", "reason": "추천 이유"}
  ]
}"""


def build_recommend_user_prompt(top_channels, all_subscribed_names, count=10, extra_exclude=None):
    top_lines = []
    for c in top_channels:
        cat = (c.get("category") or "").strip()
        desc = (c.get("description") or "").strip().replace("\n", " ")
        if len(desc) > 120:
            desc = desc[:120] + "…"
        meta = []
        if cat and cat != "채널":  # OAuth 수집 기본값 '채널'은 정보가 없으므로 제외
            meta.append(cat)
        meta.append(f"점수 {c.get('score', '?')}")
        line = f"- {c['name']} ({', '.join(meta)})"
        if desc:
            line += f"\n    설명: {desc}"
        else:
            line += "\n    설명: (없음 — 콘텐츠를 추측하지 말 것)"
        top_lines.append(line)

    # 구독 채널 + 추가 제외(이전 추천/거부분)를 합쳐 추천에서 빼도록 전달
    exclude_names = list(all_subscribed_names)
    if extra_exclude:
        exclude_names += [n for n in extra_exclude if n]
    # 토큰 절약을 위해 이름만, 너무 많으면 잘라낸다
    subscribed_preview = ", ".join(exclude_names[:150])
    if len(exclude_names) > 150:
        subscribed_preview += f" 외 {len(exclude_names) - 150}개"

    return f"""[사용자가 좋아하는 상위 채널]
{chr(10).join(top_lines)}

[이미 구독 중이거나 이미 추천된 채널 (추천에서 제외)]
{subscribed_preview}

위 사용자의 취향에 맞는 새로운 YouTube 채널 {count}개를 추천해주세요. 위 제외 목록에 있는 채널은 절대 포함하지 마세요."""


def call_solar_json(system_prompt, user_prompt, temperature=0.7):
    """Upstage Solar에 JSON 응답을 요청하는 공통 헬퍼.
    성공 시 (parsed_dict, None), 실패 시 (None, error_message) 반환.
    """
    if not UPSTAGE_API_KEY:
        return None, "UPSTAGE_API_KEY가 설정되지 않았습니다. .env 파일을 확인하세요."

    payload = {
        "model": UPSTAGE_MODEL,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "response_format": {"type": "json_object"},
        "temperature": temperature,
    }
    headers = {
        "Authorization": f"Bearer {UPSTAGE_API_KEY}",
        "Content-Type": "application/json",
    }

    try:
        resp = requests.post(UPSTAGE_API_URL, headers=headers, json=payload, timeout=60)
    except requests.RequestException as e:
        return None, f"Solar API 호출 실패: {e}"

    if resp.status_code != 200:
        return None, f"Solar API 오류 ({resp.status_code}): {resp.text[:200]}"

    try:
        data = resp.json()
        content = data["choices"][0]["message"]["content"]
        return json.loads(content), None
    except (KeyError, json.JSONDecodeError, IndexError) as e:
        return None, f"Solar 응답 파싱 실패: {e}"


def call_solar_recommend(top_channels, all_subscribed_names, count=10, exclude=None):
    parsed, err = call_solar_json(
        RECOMMEND_SYSTEM_PROMPT,
        build_recommend_user_prompt(top_channels, all_subscribed_names, count=count, extra_exclude=exclude),
    )
    if err:
        return None, err
    return parsed.get("recommendations", []), None


@app.route("/api/recommend", methods=["POST"])
def api_recommend():
    data = request.get_json(silent=True) or {}
    channels = data.get("channels", [])
    if not isinstance(channels, list) or not channels:
        return jsonify({"error": "channels 배열이 비어있습니다."}), 400

    # 요청 개수 (1~20으로 제한), 추가 제외 목록(이전 추천/거부분)
    try:
        count = max(1, min(20, int(data.get("count", 10))))
    except (TypeError, ValueError):
        count = 10
    exclude = data.get("exclude", [])
    if not isinstance(exclude, list):
        exclude = []

    # 점수 50 이상 채널만 LLM에 전달 (최애 + 자주 보는 채널)
    top_channels = [c for c in channels if c.get("score", 0) >= 50]
    if not top_channels:
        return jsonify({"error": "점수 50 이상인 채널이 없어 추천을 생성할 수 없습니다."}), 400

    all_names = [c.get("name", "") for c in channels if c.get("name")]

    recs, err = call_solar_recommend(top_channels, all_names, count=count, exclude=exclude)
    if err:
        return jsonify({"error": err}), 502
    return jsonify({"recommendations": recs})


# ──────────────────────────────────────────
# LLM 추천 검증 (실제 채널 설명 기반 분류·사유 교정)
#   프론트가 추천 채널을 실제 YouTube 채널로 해석해 '진짜 설명'을 얻은 뒤 호출.
#   LLM이 추측한 카테고리/사유를 실제 설명에 맞게 다시 쓰고, 취향 부적합은 걸러낸다.
# ──────────────────────────────────────────
VERIFY_SYSTEM_PROMPT = """당신은 채널 추천 검증자입니다.
후보 채널들의 '실제 채널 설명'과 '최근 영상 제목', 그리고 사용자의 취향 채널 목록을 받습니다.
각 후보에 대해, 실제 정보에 근거해 올바른 카테고리와 추천 이유를 다시 작성하고, 사용자 취향에 실제로 맞는지 판정합니다.

규칙:
1. category와 reason은 반드시 '실제 채널 설명'과 '최근 영상 제목'에만 근거해 작성하세요. 주어진 정보에 없는 장르·콘텐츠를 절대 지어내지 마세요.
   (예: 설명·영상 제목에 자동차 언급이 없으면 "자동차" 분류 금지. 게스트 초대 토크 영상 제목이 많으면 "토크쇼/예능"으로 분류.)
2. **설명이 비어 있거나 추상적이면 최근 영상 제목을 우선 근거로 삼아 채널의 실제 성격을 판단하세요.**
3. 후보의 실제 콘텐츠가 사용자 취향과 명백히 동떨어지면 fit=false 로 표시하세요. 맞으면 fit=true.
4. reason은 한 줄(40자 내외)로, 사용자의 어떤 취향과 연결되는지 실제 정보에 근거해 구체적으로.
5. category는 실제 콘텐츠에 맞는 한국어 분류 한두 개(예: "토크쇼/예능", "자동차", "IT/개발").
6. 입력된 후보만 다루고, name은 입력값을 그대로 사용하세요. 없는 후보를 추가하지 마세요.
7. 반드시 JSON 형식으로만 응답하세요.

응답 형식:
{
  "results": [
    {"name": "후보 채널명", "category": "분류", "reason": "이유", "fit": true}
  ]
}"""


def build_verify_user_prompt(candidates, interests):
    cand_lines = []
    for c in candidates:
        desc = (c.get("description") or "").strip().replace("\n", " ")
        if len(desc) > 200:
            desc = desc[:200] + "…"
        titles = [str(t).strip() for t in (c.get("videoTitles") or []) if str(t).strip()][:8]
        block = f"- {c.get('name', '')}\n    실제 설명: {desc or '(설명 없음)'}"
        if titles:
            title_str = " | ".join(titles)
            block += f"\n    최근 영상 제목: {title_str}"
        cand_lines.append(block)

    int_lines = []
    for c in interests:
        desc = (c.get("description") or "").strip().replace("\n", " ")
        if len(desc) > 100:
            desc = desc[:100] + "…"
        line = f"- {c.get('name', '')}"
        if desc:
            line += f": {desc}"
        int_lines.append(line)

    return f"""[사용자의 취향 채널]
{chr(10).join(int_lines) if int_lines else '- (정보 없음)'}

[검증할 후보 채널 — 실제 설명 기준]
{chr(10).join(cand_lines)}

각 후보의 올바른 카테고리와 추천 이유를 실제 설명에 근거해 다시 작성하고, 취향 적합 여부(fit)를 판정해주세요."""


@app.route("/api/verify_recommend", methods=["POST"])
def api_verify_recommend():
    data = request.get_json(silent=True) or {}
    candidates = data.get("candidates", [])
    interests = data.get("interests", [])
    if not isinstance(candidates, list) or not candidates:
        return jsonify({"error": "candidates 배열이 비어있습니다."}), 400

    # 분류 교정이 목적이므로 창의성을 낮춰(temperature 0.3) 설명에 충실하게
    parsed, err = call_solar_json(
        VERIFY_SYSTEM_PROMPT,
        build_verify_user_prompt(candidates, interests),
        temperature=0.3,
    )
    if err:
        return jsonify({"error": err}), 502
    return jsonify({"results": parsed.get("results", [])})


# ──────────────────────────────────────────
# LLM 관심사 키워드 추출 (영상 우선 발굴용 검색어 생성)
#   사용자의 상위 채널 + 최근 영상 제목 → 새 채널을 찾기 위한 YouTube 검색 키워드.
#   "채널을 이름으로 찾지 말고 관심사 영상을 검색"하기 위한 1단계.
# ──────────────────────────────────────────
KEYWORDS_SYSTEM_PROMPT = """당신은 YouTube 검색 전략가입니다.
사용자가 좋아하는 채널과 그 채널들의 최근 영상 제목을 받아, 사용자의 관심사를 대표하는 'YouTube 검색 키워드'를 만듭니다.
이 키워드로 영상을 검색해 사용자가 좋아할 만한 새 채널을 발굴합니다.

규칙:
1. 키워드는 8~12개. 실제 YouTube 검색에 바로 쓸 수 있는 자연스러운 한국어 검색어로.
2. 너무 일반적인 단어(예: "영상", "유튜브")는 피하고, 구체적 주제·장르로.
3. 사용자의 여러 관심사를 골고루 반영하되, 상위 관심사를 더 많이 포함.
4. 최근 영상 제목에서 드러나는 실제 주제를 우선 활용하세요(채널명만으로 추측 금지).
5. 반드시 JSON 형식으로만 응답하세요.

응답 형식:
{ "keywords": ["검색어1", "검색어2"] }"""


def build_keywords_user_prompt(interests):
    lines = []
    for c in interests:
        titles = [str(t).strip() for t in (c.get("videoTitles") or []) if str(t).strip()][:6]
        line = f"- {c.get('name', '')}"
        if titles:
            line += f"\n    최근 영상: {' | '.join(titles)}"
        lines.append(line)
    return f"""[사용자가 좋아하는 채널과 최근 영상]
{chr(10).join(lines) if lines else '- (정보 없음)'}

위 취향을 바탕으로, 새 채널을 발굴하기 위한 YouTube 검색 키워드를 만들어주세요."""


@app.route("/api/interest_keywords", methods=["POST"])
def api_interest_keywords():
    data = request.get_json(silent=True) or {}
    interests = data.get("interests", [])
    if not isinstance(interests, list) or not interests:
        return jsonify({"error": "interests 배열이 비어있습니다."}), 400

    parsed, err = call_solar_json(
        KEYWORDS_SYSTEM_PROMPT,
        build_keywords_user_prompt(interests),
        temperature=0.5,
    )
    if err:
        return jsonify({"error": err}), 502
    kws = [str(k).strip() for k in (parsed.get("keywords") or []) if str(k).strip()]
    return jsonify({"keywords": kws[:12]})


# ──────────────────────────────────────────
# LLM 후보 큐레이션 (영상 검색으로 발굴한 실제 채널 풀에서 선별·순위)
#   후보는 모두 '실제로 존재하며 그 주제 영상을 올린' 채널 → 환각 위험 없음.
#   LLM은 발굴이 아니라 순위·이유·적합성 판정(큐레이션)만 담당.
# ──────────────────────────────────────────
CURATE_SYSTEM_PROMPT = """당신은 YouTube 채널 큐레이터입니다.
'사용자의 취향 채널'과, 사용자의 관심사 영상을 검색해 발굴한 '실제 후보 채널 목록'(각 채널의 실제 설명·최근 영상 제목·검색 매칭 빈도 포함)을 받습니다.
이 후보들 중에서 사용자에게 가장 잘 맞는 채널을 골라 순위를 매깁니다.

규칙:
1. 반드시 주어진 후보 목록 안에서만 고르세요. 목록에 없는 채널을 새로 만들지 마세요.
2. category와 reason은 후보의 '실제 설명·최근 영상 제목'에만 근거해 작성하세요. 없는 내용을 지어내지 마세요.
3. '검색 매칭 빈도'가 높을수록 그 주제를 꾸준히 다루는 채널이라는 강한 신호입니다. 순위에 참고하세요.
4. 후보의 실제 콘텐츠가 사용자 취향과 명백히 동떨어지면 fit=false. 맞으면 fit=true.
5. reason은 한 줄(40자 내외)로, 사용자의 어떤 취향과 연결되는지 구체적으로.
6. 가능하면 다양한 주제를 섞되 상위 관심사를 우선하세요. 좋은 순서대로 정렬해 반환하세요.
7. 반드시 JSON 형식으로만 응답하세요.

응답 형식:
{
  "results": [
    {"name": "후보 채널명", "category": "분류", "reason": "이유", "fit": true}
  ]
}"""


def build_curate_user_prompt(candidates, interests, count):
    int_lines = []
    for c in interests:
        desc = (c.get("description") or "").strip().replace("\n", " ")
        if len(desc) > 100:
            desc = desc[:100] + "…"
        line = f"- {c.get('name', '')}"
        if desc:
            line += f": {desc}"
        int_lines.append(line)

    cand_lines = []
    for c in candidates:
        desc = (c.get("description") or "").strip().replace("\n", " ")
        if len(desc) > 160:
            desc = desc[:160] + "…"
        titles = [str(t).strip() for t in (c.get("videoTitles") or []) if str(t).strip()][:8]
        block = f"- {c.get('name', '')} (검색 매칭 빈도 {c.get('frequency', 1)})"
        block += f"\n    실제 설명: {desc or '(설명 없음)'}"
        if titles:
            block += f"\n    최근 영상 제목: {' | '.join(titles)}"
        cand_lines.append(block)

    return f"""[사용자의 취향 채널]
{chr(10).join(int_lines) if int_lines else '- (정보 없음)'}

[발굴된 실제 후보 채널 — 이 안에서만 선택]
{chr(10).join(cand_lines)}

위 후보 중에서 사용자에게 가장 잘 맞는 채널 최대 {count}개를 좋은 순서대로 골라주세요."""


@app.route("/api/curate", methods=["POST"])
def api_curate():
    data = request.get_json(silent=True) or {}
    candidates = data.get("candidates", [])
    interests = data.get("interests", [])
    if not isinstance(candidates, list) or not candidates:
        return jsonify({"error": "candidates 배열이 비어있습니다."}), 400
    try:
        count = max(1, min(20, int(data.get("count", 10))))
    except (TypeError, ValueError):
        count = 10
    if not isinstance(interests, list):
        interests = []

    parsed, err = call_solar_json(
        CURATE_SYSTEM_PROMPT,
        build_curate_user_prompt(candidates, interests, count),
        temperature=0.4,
    )
    if err:
        return jsonify({"error": err}), 502
    return jsonify({"results": parsed.get("results", [])})


# ──────────────────────────────────────────
# LLM 시청 취향 페르소나 (Upstage Solar)
# ──────────────────────────────────────────
PERSONA_SYSTEM_PROMPT = """당신은 사용자의 YouTube 시청 데이터를 해석하는 취향 분석가입니다.
구독 채널의 관심도 점수와 카테고리 분포를 받아, 그 사람의 시청 페르소나를 한 편의 짧은 리포트로 작성합니다.

규칙:
1. 반드시 주어진 데이터에 근거해 구체적으로 작성하세요. 일반론·추측성 문구는 피하세요.
2. **상위 채널에 '최근 영상' 제목이 주어지면, 그 제목들에서 드러나는 실제 콘텐츠를 근거로 취향을 구체적으로 묘사하세요.** 제목에 없는 내용을 지어내지 마세요.
3. summary는 2~4문장으로, 사용자를 '당신'이라고 부르는 따뜻하고 친근한 어조로 작성하세요.
4. title은 사용자의 시청 성향을 압축한 한 줄 별명입니다 (예: "개발 심화 + 가벼운 휴식형").
5. traits는 3~4개를 만들고, 각 항목은 짧은 라벨과 한 줄 설명으로 구성하세요.
6. topInterests는 데이터에서 두드러진 관심사 2~4개입니다.
7. 반드시 JSON 형식으로만 응답하세요.

응답 형식:
{
  "title": "한 줄 별명",
  "emoji": "성향을 나타내는 단일 이모지",
  "summary": "2~4문장 서술",
  "topInterests": ["관심사1", "관심사2"],
  "traits": [
    {"label": "특성 라벨", "desc": "한 줄 설명"}
  ]
}"""


def build_persona_user_prompt(channels):
    cat_counts = {}
    group_counts = {}
    for c in channels:
        cat = c.get("category") or "기타"
        cat_counts[cat] = cat_counts.get(cat, 0) + 1
        label = (c.get("group") or {}).get("label", "기타")
        group_counts[label] = group_counts.get(label, 0) + 1

    top = [c for c in channels if c.get("score", 0) >= 50][:15]
    top_lines = []
    for c in top:
        cat = (c.get("category") or "").strip()
        line = f"- {c['name']} (점수 {c.get('score', '?')}"
        if cat and cat != "채널":  # OAuth 수집 기본값 '채널'은 정보가 없으므로 생략
            line += f", {cat}"
        line += ")"
        titles = [str(t).strip() for t in (c.get("videoTitles") or []) if str(t).strip()][:6]
        if titles:
            line += f"\n    최근 영상: {' | '.join(titles)}"
        top_lines.append(line)
    cat_line = ", ".join(
        f"{k} {v}개" for k, v in sorted(cat_counts.items(), key=lambda x: -x[1])
    )
    group_line = ", ".join(f"{k} {v}개" for k, v in group_counts.items())

    return f"""[전체 구독 채널 수] {len(channels)}개

[관심도 그룹 분포]
{group_line or '데이터 없음'}

[카테고리 분포]
{cat_line or '데이터 없음'}

[관심도 높은 채널 (상위)]
{chr(10).join(top_lines) if top_lines else '- (점수 50 이상 채널 없음)'}

위 데이터를 바탕으로 이 사용자의 YouTube 시청 페르소나를 작성해주세요."""


@app.route("/api/persona", methods=["POST"])
def api_persona():
    data = request.get_json(silent=True) or {}
    channels = data.get("channels", [])
    if not isinstance(channels, list) or not channels:
        return jsonify({"error": "channels 배열이 비어있습니다."}), 400

    parsed, err = call_solar_json(PERSONA_SYSTEM_PROMPT, build_persona_user_prompt(channels))
    if err:
        return jsonify({"error": err}), 502
    return jsonify({"persona": parsed})


# ──────────────────────────────────────────
# LLM 구독 정리 코치 (Upstage Solar)
# ──────────────────────────────────────────
CLEANUP_SYSTEM_PROMPT = """당신은 사용자의 YouTube 구독 목록을 정리해주는 코치입니다.
관심도가 낮거나 휴면 상태인 채널 목록을 받아, 각 채널을 정리할지 판단하고 이유를 제시합니다.

규칙:
1. action은 반드시 다음 셋 중 하나로만 작성하세요: "해제 추천", "보류 권장", "유지".
   - 활동(댓글·좋아요·시청)이 0이고 오래 방치된 채널 → "해제 추천"
   - 활동은 적지만 최근성이 있거나 시즌성·자료성 가치가 있어 보이면 → "보류 권장"
   - 정리하지 않는 편이 나으면 → "유지"
2. **"마지막 시청"이 "추정"으로 표시된 채널은 실제로는 시청했지만 기록에 안 남았을 수 있습니다.**
   이 경우 미활동 기간을 단정하지 말고, 해제보다 "보류 권장"을 우선 고려하세요.
   reason에도 "측정값"이 아니라 "추정"임을 드러내세요(예: "시청 기록 없음(추정)").
   반대로 "실제 시청 기록 기반"으로 표시된 값은 신뢰해 판단해도 됩니다.
3. reason은 한 줄(40자 내외)로, 주어진 데이터(점수·활동·마지막 시청)에 근거해 구체적으로 작성하세요.
4. summary는 전체 정리 방향을 1~2문장으로 요약하세요.
5. 입력으로 받은 채널만 다루세요. 목록에 없는 채널을 지어내지 마세요.
6. 반드시 JSON 형식으로만 응답하세요.

응답 형식:
{
  "summary": "전체 요약 1~2문장",
  "items": [
    {"name": "채널명", "action": "해제 추천", "reason": "한 줄 이유"}
  ]
}"""


def build_cleanup_user_prompt(channels):
    lines = []
    for c in channels:
        last = c.get("lastWatchDays")
        if isinstance(last, (int, float)):
            if c.get("lastWatchEstimated"):
                # 시청 기록에 없어 구독기간으로 보수적 추정한 값 → 실제 미시청 보장 아님
                last_str = f"약 {last}일 전(시청 기록 없어 구독기간으로 추정, 실제 시청 여부 불확실)"
            else:
                last_str = f"{last}일 전(실제 시청 기록 기반)"
        else:
            last_str = "기록 없음"
        lines.append(
            f"- {c['name']} (카테고리 {c.get('category', '없음')}, 점수 {c.get('score', '?')}, "
            f"구독 {c.get('subMonths', 0)}개월, 댓글 {c.get('comments', 0)}개, "
            f"좋아요 {c.get('likes', 0)}개, 시청 {c.get('watchCount', 0)}회, 마지막 시청 {last_str})"
        )
    return f"""[정리 검토 대상 — 관심도 낮음 / 휴면 채널]
{chr(10).join(lines)}

위 채널들을 하나씩 정리할지 판단해주세요."""


@app.route("/api/cleanup", methods=["POST"])
def api_cleanup():
    data = request.get_json(silent=True) or {}
    channels = data.get("channels", [])
    if not isinstance(channels, list) or not channels:
        return jsonify({"error": "channels 배열이 비어있습니다."}), 400

    # 점수 20 미만(🌱 구독만 한 채널 그룹)만 정리 대상
    low = [c for c in channels if c.get("score", 0) < 20]
    if not low:
        return jsonify({"summary": "", "items": []})

    # 너무 많으면 토큰 절약: 점수 낮은 순으로 최대 30개만 검토
    low = sorted(low, key=lambda c: c.get("score", 0))[:30]

    parsed, err = call_solar_json(CLEANUP_SYSTEM_PROMPT, build_cleanup_user_prompt(low))
    if err:
        return jsonify({"error": err}), 502
    return jsonify({"summary": parsed.get("summary", ""), "items": parsed.get("items", [])})


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
